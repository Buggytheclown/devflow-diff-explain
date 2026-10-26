import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import type { LocalVcsKind } from '@sherpa/protocol';
import { localPrKeyPrefix } from '@sherpa/protocol';

import { CliError } from './errors.js';
import type { CommandOutcome, CommandRunner } from './pr-discovery.js';
import { runArcCommand } from './pr-discovery.js';

/**
 * Локальное ревью из каталога проекта (`devflow-diff-explain up --local <path>`): какая VCS, какой каталог,
 * какая ветка и под каким ключом это живёт. Всё это выясняется здесь, а не в сервере: каталог
 * знает только тот, кто запустил команду, а вид VCS уезжает серверу префиксом ключа.
 */

const ARC_BIN = 'arc';
const GIT_BIN = 'git';

/** Сколько символов отпечатка попадает в ключ: 32 бита развести соседние ветки хватает с запасом. */
const KEY_HASH_CHARS = 8;

/** Запасное имя каталога в ключе, когда от базового имени не осталось ни одного разрешённого символа. */
const FALLBACK_DIR_NAME = 'dir';

export interface LocalTarget {
    /** Ключ ревью: он же имя каталога стейта и манифеста. */
    readonly prKey: string;
    /** Чем этот каталог версионируется. */
    readonly vcs: LocalVcsKind;
    /** Каталог проекта, приведённый к абсолютному пути через realpath. */
    readonly repo: string;
    readonly branch: string;
    /** Явная база из `--base`; undefined — базу по умолчанию считает сервер. */
    readonly base: string | undefined;
}

/**
 * Каталог проекта → ключ ревью. Вид VCS определяется здесь же: сначала спрашиваем `arc`,
 * потом `git` — внутри чекаута Аркадии отвечают оба, и ревью там всё равно про arc. Исключение —
 * каталог с собственным `.git`: это git-репозиторий, даже если лежит внутри arc-чекаута, и arc
 * показал бы весь клон неотслеживаемым.
 * Каталога нет, он не каталог или не чекаут — понятная ошибка: дальше по цепочке это
 * превратилось бы в «сервер не поднялся».
 */
export async function resolveLocalTarget(
    rawPath: string,
    base: string | undefined,
    run: CommandRunner = runArcCommand,
): Promise<LocalTarget> {
    const repo = await realDirectory(rawPath);

    let gitRoot: CommandOutcome | null = null;
    if (await hasOwnGitDir(repo)) {
        gitRoot = await run(GIT_BIN, ['rev-parse', '--show-toplevel'], { cwd: repo });
        if (succeeded(gitRoot)) {
            return targetOf('git', repo, await gitBranch(repo, run), base);
        }
    }

    const arcRoot = await run(ARC_BIN, ['root'], { cwd: repo });
    if (succeeded(arcRoot)) {
        return targetOf('arc', repo, await arcBranch(repo, run), base);
    }

    gitRoot ??= await run(GIT_BIN, ['rev-parse', '--show-toplevel'], { cwd: repo });
    if (succeeded(gitRoot)) {
        return targetOf('git', repo, await gitBranch(repo, run), base);
    }

    throw new CliError(notACheckout(repo, arcRoot, gitRoot));
}

/** В каталоге лежит `.git` (каталог или файл ворктри) — репозиторий начинается здесь. */
async function hasOwnGitDir(repo: string): Promise<boolean> {
    return (await fs.stat(path.join(repo, '.git')).catch(() => null)) !== null;
}

/**
 * Ключ локального ревью: вид VCS и имя каталога ради читаемости плюс отпечаток пути, ветки
 * и явной базы ради различимости. Все трое вместе и есть ревью: на другой ветке или относительно
 * другой базы это другой дифф, и живой сервер прежнего ключа отдавал бы не то, о чём просят.
 */
export function localPrKey(vcs: LocalVcsKind, repo: string, branch: string, base?: string): string {
    const digest = createHash('sha256')
        .update(`${repo}\n${branch}\n${base ?? ''}`)
        .digest('hex');
    return `${localPrKeyPrefix(vcs)}${keyNameOf(path.basename(repo))}-${digest.slice(0, KEY_HASH_CHARS)}`;
}

function targetOf(vcs: LocalVcsKind, repo: string, branch: string, base: string | undefined): LocalTarget {
    return { prKey: localPrKey(vcs, repo, branch, base), vcs, repo, branch, base };
}

/** Ветка arc-чекаута: её печатает `arc info --json` вместе с остальным про чекаут. */
async function arcBranch(repo: string, run: CommandRunner): Promise<string> {
    const info = await run(ARC_BIN, ['info', '--json'], { cwd: repo });
    if (!succeeded(info)) {
        throw new CliError(
            `devflow-diff-explain: \`arc info --json\` failed in ${repo}${detailOf(ARC_BIN, info)}.\n` +
                'Local review reads the working tree with `arc`; check that the command works in this directory.',
        );
    }

    const branch = parseBranch(info.stdout);
    if (branch === null) {
        throw new CliError(
            'devflow-diff-explain: `arc info --json` printed something Sherpa cannot read — it needs the branch name.\n' +
                'Check that `arc info --json` works in this directory.',
        );
    }
    return branch;
}

/** Ветка git-репозитория; отсоединённая голова — отказ: ревью заведено на ветку. */
async function gitBranch(repo: string, run: CommandRunner): Promise<string> {
    const head = await run(GIT_BIN, ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repo });
    const branch = succeeded(head) ? head.stdout.trim() : '';
    if (branch === '') {
        throw new CliError(
            `devflow-diff-explain: cannot read the current branch of ${repo}${detailOf(GIT_BIN, head)}.\n` +
                'Local review is keyed by the branch; check that `git rev-parse --abbrev-ref HEAD` works there.',
        );
    }
    if (branch === 'HEAD') {
        throw new CliError(
            `devflow-diff-explain: ${repo} is on a detached HEAD.\n` +
                'Local review is keyed by the branch: check out a branch and run `devflow-diff-explain up --local <path>` again.',
        );
    }
    return branch;
}

function succeeded(outcome: CommandOutcome): boolean {
    return outcome.failure === null && outcome.exitCode === 0;
}

async function realDirectory(rawPath: string): Promise<string> {
    const candidate = path.resolve(rawPath);

    let real: string;
    try {
        real = await fs.realpath(candidate);
    } catch {
        throw new CliError(
            `devflow-diff-explain: there is no directory ${candidate}.\n` +
                'Pass the path of the project directory to review: `devflow-diff-explain up --local <path>`.',
        );
    }

    const stats = await fs.stat(real).catch(() => null);
    if (stats?.isDirectory() !== true) {
        throw new CliError(
            `devflow-diff-explain: ${candidate} is not a directory.\n` +
                'Pass the path of the project directory to review: `devflow-diff-explain up --local <path>`.',
        );
    }
    return real;
}

/** Ни arc, ни git: в отказе причины обоих — по ним видно, чего именно не хватает. */
function notACheckout(repo: string, arc: CommandOutcome, git: CommandOutcome): string {
    return (
        `devflow-diff-explain: ${repo} is not inside an arc or git checkout` +
        ` (${reasonOf(ARC_BIN, arc)}; ${reasonOf(GIT_BIN, git)}).\n` +
        'Local review reads the working tree with `arc` or `git`; ' +
        'run it from a checkout or pass `--pr <pr key>`.'
    );
}

/** Имя каталога в алфавите `prKeySchema`: всё лишнее — дефис, пустое имя — `dir`. */
function keyNameOf(basename: string): string {
    const sanitized = basename.replace(/[^A-Za-z0-9._-]/gu, '-');
    return sanitized === '' ? FALLBACK_DIR_NAME : sanitized;
}

/** Ветка чекаута из `arc info --json`; null — поля нет или вывод не разобрался. */
function parseBranch(stdout: string): string | null {
    let parsed: unknown;
    try {
        parsed = JSON.parse(stdout);
    } catch {
        return null;
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        return null;
    }

    const branch = (parsed as Record<string, unknown>).branch;
    return typeof branch === 'string' && branch !== '' ? branch : null;
}

/** Почему команда не ответила: нет бинарника или первая содержательная строка чужого stderr. */
function reasonOf(bin: string, outcome: CommandOutcome): string {
    if (outcome.failure === 'not-found') {
        return `\`${bin}\` is not in PATH`;
    }
    const line = firstLine(outcome.stderr);
    return line === null ? `\`${bin}\` failed` : `${bin}: ${line}`;
}

function detailOf(bin: string, outcome: CommandOutcome): string {
    const line = firstLine(outcome.stderr);
    if (outcome.failure === 'not-found') {
        return ` — \`${bin}\` is not in PATH`;
    }
    return line === null ? '' : ` (${bin}: ${line})`;
}

function firstLine(stderr: string): string | null {
    return (
        stderr
            .split('\n')
            .map((candidate) => candidate.trim())
            .find((candidate) => candidate !== '') ?? null
    );
}

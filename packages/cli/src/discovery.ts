import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import type { ServerManifest } from '@sherpa/protocol';
import { githubPrKey, parseGithubPrUrl, serverManifestSchema } from '@sherpa/protocol';

import { CliError } from './errors.js';
import { assertValidPrKey, manifestPathFor, sherpaDirFrom, workerIdPathFor } from './paths.js';
import type { CommandRunner } from './pr-discovery.js';
import { discoverPrKeyFromCheckout, runArcCommand } from './pr-discovery.js';

/** Всё, что нужно знать CLI, чтобы обратиться к серверу PR. */
export interface ServerConnection {
    readonly prKey: string;
    readonly port: number;
    readonly token: string;
    readonly workerId: string;
}

/** Права файла с идентичностью воркера — как у остального стейта (`docs/architecture.md §6`). */
const WORKER_ID_FILE_MODE = 0o600;
const STATE_DIR_MODE = 0o700;

/** Discovery целиком (`docs/protocol.md §8`): PR → манифест → порт и токен, плюс идентичность воркера. */
export async function connect(
    prKeyArg: string | undefined,
    env: Readonly<Record<string, string | undefined>>,
    run?: CommandRunner,
): Promise<ServerConnection> {
    const prKey = await resolvePrKey(prKeyArg, env, run);
    const sherpaDir = sherpaDirFrom(env);
    const workerId = await resolveWorkerId(sherpaDir, prKey, env);

    return openConnection(sherpaDir, prKey, workerId);
}

/**
 * Подключение с явной идентичностью — для `worker register`: id объявляет сессия, а в файл стейта
 * его записывает сервер, приняв регистрацию, — иначе две параллельные сессии писали бы туда наперегонки.
 */
export async function connectAs(
    prKeyArg: string | undefined,
    env: Readonly<Record<string, string | undefined>>,
    workerId: string,
    run?: CommandRunner,
): Promise<ServerConnection> {
    const prKey = await resolvePrKey(prKeyArg, env, run);
    return openConnection(sherpaDirFrom(env), prKey, workerId);
}

async function openConnection(sherpaDir: string, prKey: string, workerId: string): Promise<ServerConnection> {
    const manifest = await readServerManifest(sherpaDir, prKey);
    return { prKey, port: manifest.port, token: manifest.token, workerId };
}

/**
 * Ключ PR: `--pr` → `SHERPA_PR` → PR текущей ветки arc-чекаута (`pr-discovery.ts`).
 * Явные источники старше discovery: сессия могла быть запущена не из того каталога,
 * и молча подменять переданный PR найденным нельзя.
 */
export async function resolvePrKey(
    prKeyArg: string | undefined,
    env: Readonly<Record<string, string | undefined>>,
    run: CommandRunner = runArcCommand,
): Promise<string> {
    const explicit = (prKeyArg ?? env.SHERPA_PR ?? '').trim();
    if (explicit !== '') {
        return assertValidPrKey(normalizePrKey(explicit));
    }

    const discovered = await discoverPrKeyFromCheckout(run);
    if (discovered.kind === 'found') {
        return assertValidPrKey(discovered.prKey);
    }
    throw new CliError(unclearWhichPr(discovered.hint));
}

/**
 * Ссылка на PR github.com — тоже способ назвать PR: она приводится к ключу до всех проверок,
 * и дальше по сессии едет уже нормализованный ключ.
 */
function normalizePrKey(value: string): string {
    try {
        const url = new URL(value);
        const review = /^\/review\/([1-9]\d*)(?:\/.*)?$/.exec(url.pathname);
        if (url.protocol === 'https:' && url.username === '' && url.password === '' && url.port === '' &&
            ['a.yandex-team.ru', 'arcanum.yandex-team.ru'].includes(url.hostname) && review !== null) {
            return `arcanum-${review[1] ?? ''}`;
        }
    } catch { /* Готовый ключ не является URL. */ }
    const github = parseGithubPrUrl(value);
    return github === null ? value : githubPrKey(github);
}

/** Провал discovery — не сбой, а вопрос человеку: строка причины и три способа ответить. */
function unclearWhichPr(hint: string): string {
    return (
        'devflow-diff-explain: it is unclear which PR to connect to.\n' +
        `Tried to detect it from the current directory: ${hint}.\n` +
        'Run the command through the Sherpa skill (it fills the PR in), pass `--pr <pr key>`, ' +
        'or run it from an arc checkout with the PR branch checked out.'
    );
}

/**
 * Манифест сервера. Любая беда с ним — одна и та же человеческая ошибка: манифеста нет,
 * он битый или не про этот PR. Чистка протухших манифестов — работа скилла, не CLI.
 */
export async function readServerManifest(sherpaDir: string, prKey: string): Promise<ServerManifest> {
    const manifest = await readManifestFile(manifestPathFor(sherpaDir, prKey));
    if (manifest?.prKey !== prKey) {
        throw new CliError(serverUnavailable(prKey));
    }
    return manifest;
}

/** Манифест по пути; отсутствующий, битый и не прошедший схему — одинаково `null` (fail-closed). */
export async function readManifestFile(manifestPath: string): Promise<ServerManifest | null> {
    let raw: string;
    try {
        raw = await fs.readFile(manifestPath, 'utf8');
    } catch {
        return null;
    }

    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return null;
    }

    const manifest = serverManifestSchema.safeParse(parsed);
    return manifest.success ? manifest.data : null;
}

/**
 * Идентичность новой сессии для `worker register`: реконнект — это новый воркер, id прошлой сессии
 * из файла не переиспользуется. Отладочный `SHERPA_WORKER_ID` остаётся сильнее: иначе register
 * зарегистрировал бы один id, а следующие команды ходили бы под другим.
 */
export function freshWorkerId(env: Readonly<Record<string, string | undefined>>): string {
    return workerIdOverride(env) ?? randomUUID();
}

/**
 * Отладочный пин идентичности из `SHERPA_WORKER_ID`; null — не задан.
 * Пин сильнее любых догадок CLI: под ним пойдут все команды сессии.
 */
export function workerIdOverride(env: Readonly<Record<string, string | undefined>>): string | null {
    const override = env.SHERPA_WORKER_ID?.trim();
    return override === undefined || override === '' ? null : override;
}

/**
 * Идентичность сессии-воркера: отладочный оверрайд из env, иначе файл стейта PR.
 * Файла нет — создаём: сессия могла начать работу без `worker register`.
 */
export async function resolveWorkerId(
    sherpaDir: string,
    prKey: string,
    env: Readonly<Record<string, string | undefined>>,
): Promise<string> {
    const override = workerIdOverride(env);
    if (override !== null) {
        return override;
    }

    const filePath = workerIdPathFor(sherpaDir, prKey);
    const stored = await readWorkerIdFile(filePath);
    if (stored !== null) {
        return stored;
    }

    try {
        return await createWorkerIdFile(filePath);
    } catch (error) {
        throw new CliError(workerIdNotWritable(filePath, error));
    }
}

function workerIdNotWritable(filePath: string, error: unknown): string {
    const detail = error instanceof Error ? error.message : String(error);
    return (
        `devflow-diff-explain: could not write ${filePath} — ${detail}.\n` +
        'Check the permissions on the Sherpa state directory and run the command again.'
    );
}

/** null — файла нет либо он пуст (недописанный хвост прошлого запуска). */
async function readWorkerIdFile(filePath: string): Promise<string | null> {
    try {
        const stored = (await fs.readFile(filePath, 'utf8')).trim();
        return stored === '' ? null : stored;
    } catch {
        return null;
    }
}

/**
 * Создаём файл эксклюзивно (`wx`): на первом запуске несколько сессий могут не найти файла разом,
 * и без этого каждая ушла бы со своим id, а на диске остался бы последний — задачи брал бы один
 * workerId, а сдавал другой. Проигравший в гонке берёт id победителя.
 */
async function createWorkerIdFile(filePath: string): Promise<string> {
    const workerId = randomUUID();
    await fs.mkdir(path.dirname(filePath), { recursive: true, mode: STATE_DIR_MODE });

    try {
        await fs.writeFile(filePath, `${workerId}\n`, { mode: WORKER_ID_FILE_MODE, flag: 'wx' });
    } catch (error) {
        if (!isAlreadyExists(error)) {
            throw error;
        }
        const winner = await readWorkerIdFile(filePath);
        if (winner !== null) {
            return winner;
        }
        await fs.writeFile(filePath, `${workerId}\n`, { mode: WORKER_ID_FILE_MODE });
    }

    // writeFile применяет mode только при создании файла и с оглядкой на umask — досоздаём права явно.
    await fs.chmod(filePath, WORKER_ID_FILE_MODE);
    return workerId;
}

function isAlreadyExists(error: unknown): boolean {
    return error instanceof Error && (error as NodeJS.ErrnoException).code === 'EEXIST';
}

export function serverUnavailable(prKey: string): string {
    return (
        `devflow-diff-explain: the Sherpa server for PR ${prKey} is not found or not responding.\n` +
        'Run the Sherpa skill again — it will start the server and write the manifest.'
    );
}

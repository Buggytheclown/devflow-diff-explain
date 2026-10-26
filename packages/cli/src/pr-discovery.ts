import { execFile } from 'node:child_process';

import { ARCANUM_PR_KEY_PREFIX } from '@sherpa/protocol';

/**
 * Резолюция PR из каталога запуска (`docs/protocol.md §8`): arc-чекаут → текущая ветка → PR ветки.
 * Явные `--pr` и `SHERPA_PR` старше — сюда доходит только вызов без них.
 *
 * Ни один шаг не имеет права уронить CLI: провал любого — это `unavailable` с однострочной
 * причиной, а решение «что сказать человеку» принимает `resolvePrKey`.
 */

/** Почему у команды нет кода возврата. */
export type CommandFailure = 'not-found' | 'timeout' | 'failed';

/** Итог запуска внешней команды; `exitCode: null` вместе с `failure` — процесс кода не дал. */
export interface CommandOutcome {
    readonly exitCode: number | null;
    readonly stdout: string;
    readonly stderr: string;
    readonly failure: CommandFailure | null;
}

/**
 * Исполнитель внешних команд: инъекция ради тестов — живой `arc` в них не зовётся.
 * `cwd` нужен локальному ревью: вопрос там задаётся не про каталог запуска, а про названный.
 */
export type CommandRunner = (
    command: string,
    args: readonly string[],
    options?: { readonly cwd?: string },
) => Promise<CommandOutcome>;

export type PrDiscovery =
    | { readonly kind: 'found'; readonly prKey: string }
    /** Однострочная причина для подсказки человеку; без завершающей точки. */
    | { readonly kind: 'unavailable'; readonly hint: string };

const ARC_BIN = 'arc';
const INFO_ARGS = ['info', '--json'] as const;
const PR_STATUS_ARGS = ['pr', 'status', '--json'] as const;

/** `arc pr status` ходит в сеть (замер 1.3 с); локальный `arc info` укладывается в 0.1 с. */
const COMMAND_TIMEOUT_MS = 10_000;

/**
 * Потолок вывода команды. `arc pr status --json` печатает PR целиком, вместе с description
 * (на живом PR — 54 КБ), так что запас нужен; перебор потолка равносилен провалу команды.
 */
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

/** Сколько символов чужого текста ошибки попадает в подсказку. */
const DETAIL_MAX_CHARS = 120;

/**
 * PR текущей ветки arc-чекаута. Две команды, обе read-only, суммарно ~1.4 с на живом чекауте
 * (замеры 2026-08-22: `arc info --json` 0.07–0.09 с, `arc pr status --json` 1.3 с с PR
 * и 0.66 с без него).
 *
 * `arc info` тут не ради ветки как таковой, а ради различения «не arc-чекаут» и «у ветки нет PR»:
 * иначе пришлось бы опознавать это по тексту stderr, который arc волен менять.
 */
export async function discoverPrKeyFromCheckout(run: CommandRunner): Promise<PrDiscovery> {
    const info = await run(ARC_BIN, INFO_ARGS);
    if (info.failure !== null) {
        return { kind: 'unavailable', hint: failureHint(info.failure, 'arc info --json') };
    }
    if (info.exitCode !== 0) {
        // Вне чекаута: код 1 и stderr «Not a mounted arc repository. Did you forget to mount arcadia?».
        return { kind: 'unavailable', hint: `not an arc checkout${detailOf(info.stderr)}` };
    }

    const branch = parseBranch(info.stdout);

    const status = await run(ARC_BIN, PR_STATUS_ARGS);
    if (status.failure !== null) {
        return { kind: 'unavailable', hint: failureHint(status.failure, 'arc pr status --json') };
    }
    if (status.exitCode !== 0) {
        // У ветки без PR: код 1 и stderr «No pull request in arcanum for branch '<branch>'».
        return { kind: 'unavailable', hint: `${branchLabel(branch)} has no PR${detailOf(status.stderr)}` };
    }

    const prId = parsePrId(status.stdout);
    if (prId === null) {
        return { kind: 'unavailable', hint: '`arc pr status --json` printed something Sherpa cannot read' };
    }
    return { kind: 'found', prKey: `${ARCANUM_PR_KEY_PREFIX}${String(prId)}` };
}

/**
 * Ветка чекаута из `arc info --json`; null — поля нет или вывод не разобрался.
 * Синтетический пример, одним объектом без обёртки:
 * `{"repository":"arcadia","remote":"users/alice/EXAMPLE-42","author":"alice",…,"branch":"EXAMPLE-42",…}`.
 * Ветка нужна только подсказке, поэтому её отсутствие само по себе discovery не ломает.
 */
function parseBranch(stdout: string): string | null {
    const info = parseJsonObject(stdout);
    const branch = info?.branch;
    return typeof branch === 'string' && branch !== '' ? branch : null;
}

/**
 * Номер PR из `arc pr status --json`; null — вывод не разобрался или в нём нет числового `id`.
 * Синтетический пример: `{"id":4242,"url":"https://a.yandex-team.ru/review/4242",
 * "author":"alice","summary":…,"description":…,"status":"conflicts","issues":…,"merge_allowed":…,
 * "from_branch":…,"to_branch":…,"reviewers":…,"created_at":…}`.
 * `--short` дал бы одну короткую строку вместо десятков килобайт, но с `--json` он несовместим,
 * а разбирать свободный текст хуже, чем поле объекта.
 */
function parsePrId(stdout: string): number | null {
    const status = parseJsonObject(stdout);
    const id = status?.id;
    return typeof id === 'number' && Number.isInteger(id) && id > 0 ? id : null;
}

function parseJsonObject(raw: string): Record<string, unknown> | null {
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return null;
    }
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : null;
}

function failureHint(failure: CommandFailure, label: string): string {
    switch (failure) {
        case 'not-found':
            return '`arc` is not in PATH — Sherpa detects the PR of the current branch with it';
        case 'timeout':
            return `\`${label}\` did not answer within ${String(Math.round(COMMAND_TIMEOUT_MS / 1000))} s`;
        case 'failed':
            return `\`${label}\` could not be run`;
    }
}

function branchLabel(branch: string | null): string {
    return branch === null ? 'the current branch' : `branch \`${branch}\``;
}

/** Первая содержательная строка чужого stderr — она объясняет отказ точнее наших догадок. */
function detailOf(stderr: string): string {
    const line = stderr
        .split('\n')
        .map((candidate) => candidate.trim())
        .find((candidate) => candidate !== '');
    if (line === undefined) {
        return '';
    }
    const capped = line.length > DETAIL_MAX_CHARS ? `${line.slice(0, DETAIL_MAX_CHARS)}…` : line;
    return ` (arc: ${capped})`;
}

/**
 * Живой исполнитель: бинарь ищется в PATH, окружение наследуется от вызова CLI. Без `cwd`
 * наследуется и каталог запуска — discovery отвечает на вопрос «какой PR у каталога, из
 * которого меня запустили».
 */
export const runArcCommand: CommandRunner = async (command, args, options) =>
    new Promise<CommandOutcome>((resolve) => {
        execFile(
            command,
            [...args],
            {
                timeout: COMMAND_TIMEOUT_MS,
                maxBuffer: MAX_OUTPUT_BYTES,
                encoding: 'utf8',
                windowsHide: true,
                ...(options?.cwd === undefined ? {} : { cwd: options.cwd }),
            },
            (error, stdout, stderr) => {
                resolve(
                    error === null
                        ? { exitCode: 0, stdout, stderr, failure: null }
                        : { ...outcomeOfError(error), stdout, stderr },
                );
            },
        );
    });

/** Разбор ошибки execFile: код возврата, отсутствие бинаря, таймаут и всё остальное. */
function outcomeOfError(error: Error): Pick<CommandOutcome, 'exitCode' | 'failure'> {
    const code = (error as NodeJS.ErrnoException).code;
    if (typeof code === 'number') {
        return { exitCode: code, failure: null };
    }
    if (code === 'ENOENT') {
        return { exitCode: null, failure: 'not-found' };
    }
    // Переполнение maxBuffer тоже прибивает процесс, но таймаутом это называть нельзя.
    if (code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
        return { exitCode: null, failure: 'failed' };
    }
    return { exitCode: null, failure: 'killed' in error && error.killed === true ? 'timeout' : 'failed' };
}

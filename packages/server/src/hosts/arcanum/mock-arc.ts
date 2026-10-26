import type { ArcCliOptions, ArcCommand, ArcFailure, ArcOutcome, ArcRunner } from './arc-cli.js';
import { ArcCli } from './arc-cli.js';
import { mockFile } from './mock-transport.js';
import { splitPatchByFile } from './patch.js';

/**
 * Локальный `arc` на записанных ответах (`./mocks/arc`). Живые вызовы в тестах запрещены:
 * и контрактный набор, и юниты гоняются только через этот раннер.
 *
 * Формы сняты с живого `arc` (2026-09-12): `--git`-патч без строки `index` и без кавычек вокруг
 * путей, `mount --list --json` списком объектов с `status`/`mount`, `arc root` строкой с корнем
 * маунта и кодом 1 вне маунта, `Error:  NoSuchObject: …` в stderr у неизвестного хэша. Как и живой `arc`, раннер печатает только те файлы, о которых
 * его спросили: адаптер обязан называть пути сам.
 *
 * Репозиторий маунта раннер берёт из записи списка (`tenant`), иначе из общей опции: так один
 * мок играет и чекаут Аркадии, и чекаут Cloudia, и смесь из двух.
 */

/** Чекаут, который мок считает живым: он же первым идёт в записанном списке маунтов. */
export const MOCK_ARC_ROOT = '/home/alice/arc/wt/EXAMPLE-1';

/** Ревьюируемые коммиты записанного PR: по паре «база → голова» мок выбирает патч. */
const MOCK_BASE_COMMIT = '001a722674f219d8096bbff02e1240aa9cffba97';
const MOCK_MERGE_COMMIT = '6589b540d27df17e0ce3a9dc0b569a1c2f0999ac';
const MOCK_PREVIOUS_MERGE_COMMIT = '9f3c1ab77c0f4a2d9b6e51c8d3a7f4b210e6c845';
/** Merge-коммит итерации, которая появляется после «пуша» мока Арканума. */
const MOCK_PUSHED_MERGE_COMMIT = 'a71d4e29b3c05f8e17d64a920cb3e5f8710d4c63';

/** Какой патч отвечает на какую пару коммитов; пара вне списка — ошибка теста. */
const DIFFS: Readonly<Record<string, string>> = {
    [`${MOCK_BASE_COMMIT}..${MOCK_MERGE_COMMIT}`]: 'diff-iteration.txt',
    [`${MOCK_BASE_COMMIT}..${MOCK_PUSHED_MERGE_COMMIT}`]: 'diff-iteration.txt',
    [`${MOCK_PREVIOUS_MERGE_COMMIT}..${MOCK_MERGE_COMMIT}`]: 'diff-interdiff.txt',
    [`${MOCK_MERGE_COMMIT}..${MOCK_PUSHED_MERGE_COMMIT}`]: 'diff-interdiff.txt',
};

/** Команда, разобранная по существу: тестам интересны именно эти виды. */
export type MockArcKind = 'root' | 'mount' | 'info' | 'diff' | 'show';

export interface MockArcCall {
    readonly kind: MockArcKind;
    readonly args: readonly string[];
    readonly cwd: string;
}

/** Запись списка маунтов: `tenant` появился не во всех версиях `arc` (см. `legacyMountList`). */
export interface MockArcMount {
    readonly status: string;
    readonly mount: string;
    readonly tenant?: string;
}

export interface MockArcOptions {
    /** Отказ вместо ответа: код возврата со stderr либо провал запуска. */
    readonly failing?: Readonly<Partial<Record<MockArcKind, ArcFailure | number>>>;
    /** Патч вместо записанного: им отвечает любая пара коммитов. */
    readonly patch?: string;
    /** Список маунтов вместо записанного. */
    readonly mounts?: readonly MockArcMount[];
    /** Репозиторий маунтов без своего `tenant`: им отвечает `arc info`. */
    readonly tenant?: string;
    /** Прежний формат `arc`: в списке маунтов поля `tenant` нет, репозиторий знает только `arc info`. */
    readonly legacyMountList?: boolean;
    /** Маунты, в которых `arc info` отвечает; по умолчанию живы все со статусом `mounted`. */
    readonly alive?: readonly string[];
    /** Каталог запуска сервера — от него начинается поиск чекаута. */
    readonly cwd?: string;
    /** Журнал вызовов: тест проверяет по нему батчирование путей и повторные чтения. */
    readonly calls?: MockArcCall[];
    /** Куда уходит строка про выбранный чекаут; по умолчанию — в никуда. */
    readonly log?: (line: string) => void;
}

/** Строку про выбранный чекаут тесты по умолчанию не показывают. */
function silentLog(): void {
    return undefined;
}

export function makeMockArcRunner(options: MockArcOptions = {}): ArcRunner {
    return (command) => {
        const kind = kindOf(command.args);
        options.calls?.push({ kind, args: [...command.args], cwd: command.cwd });

        const failure = options.failing?.[kind];
        if (typeof failure === 'string') {
            return Promise.resolve(outcome({ exitCode: null, failure }));
        }
        if (typeof failure === 'number') {
            return Promise.resolve(
                outcome({ exitCode: failure, stderr: `Error:  mock arc failure (${kind})` }),
            );
        }
        return Promise.resolve(handle(kind, command, options));
    };
}

/** Готовый `ArcCli` поверх мока: его и получает адаптер в тестах. */
export function makeMockArcCli(options: MockArcOptions = {}): ArcCli {
    const cliOptions: ArcCliOptions = {
        runner: makeMockArcRunner(options),
        cwd: options.cwd ?? '/home/alice',
        log: options.log ?? silentLog,
    };
    return new ArcCli(cliOptions);
}

function kindOf(args: readonly string[]): MockArcKind {
    const command = args[0];
    if (
        command === 'root' ||
        command === 'mount' ||
        command === 'info' ||
        command === 'diff' ||
        command === 'show'
    ) {
        return command;
    }
    throw new Error(`мок arc не знает команду: ${args.join(' ')}`);
}

function handle(kind: MockArcKind, command: ArcCommand, options: MockArcOptions): ArcOutcome {
    switch (kind) {
        case 'root':
            return root(command.cwd, options);
        case 'mount':
            return mountList(options);
        case 'info':
            return info(command.cwd, options);
        case 'diff':
            return diff(command.args, options.patch);
        case 'show':
            return show(command.args[1] ?? '');
    }
}

/**
 * `arc root`: корень маунта, внутри которого запущена команда. Живой `arc` отвечает по каталогу,
 * а не по списку маунтов, поэтому мок ищет корень среди всех записей — включая протухшие.
 */
function root(cwd: string, options: MockArcOptions): ArcOutcome {
    const mount = knownMounts(options)
        .map((entry) => entry.mount)
        .find((candidate) => cwd === candidate || cwd.startsWith(`${candidate}/`));
    if (mount === undefined) {
        return outcome({
            exitCode: 1,
            stderr: 'Not a mounted arc repository. Did you forget to mount arcadia?\n',
        });
    }
    return outcome({ stdout: `${mount}\n` });
}

function mountList(options: MockArcOptions): ArcOutcome {
    const mounts: unknown = options.legacyMountList === true
        ? knownMounts(options).map(({ tenant: _tenant, ...rest }) => rest)
        : knownMounts(options);
    // Живой `arc` сыплет в stderr отладку даже на успешном вызове — мок обязан делать так же.
    return outcome({
        stdout: JSON.stringify(mounts),
        stderr: '2026-09-12T18:38:36.116085Z [DEBUG] trace=uESolo Read lock acquired\n',
    });
}

function info(cwd: string, options: MockArcOptions): ArcOutcome {
    if (aliveMounts(options).includes(cwd)) {
        const recorded = JSON.parse(mockFile('arc/info.json')) as Record<string, unknown>;
        return outcome({ stdout: JSON.stringify({ ...recorded, repository: repositoryOf(cwd, options) }) });
    }
    return outcome({
        exitCode: 1,
        stderr: 'Not a mounted arc repository. Did you forget to mount arcadia?\n',
    });
}

function aliveMounts(options: MockArcOptions): string[] {
    if (options.alive !== undefined) {
        return [...options.alive];
    }
    return knownMounts(options)
        .filter((mount) => mount.status === 'mounted')
        .map((mount) => mount.mount);
}

/** Все записи списка маунтов — и живые, и протухшие. */
function knownMounts(options: MockArcOptions): readonly MockArcMount[] {
    return options.mounts ?? (JSON.parse(mockFile('arc/mounts.json')) as MockArcMount[]);
}

/** Репозиторий маунта: из его записи в списке, иначе общий для всего мока. */
function repositoryOf(mount: string, options: MockArcOptions): string {
    const known = knownMounts(options).find((candidate) => candidate.mount === mount);
    return known?.tenant ?? options.tenant ?? 'arcadia';
}

/**
 * `arc diff --git <base> <head> -- <пути…>`: из записанного патча отдаются куски только
 * запрошенных путей, в порядке самого патча. Путь, которого в патче нет, — законный ответ
 * (файл между коммитами не менялся), а вот незнакомая пара коммитов — ошибка теста.
 */
function diff(args: readonly string[], override: string | undefined): ArcOutcome {
    const separator = args.indexOf('--');
    if (args[1] !== '--git' || separator === -1) {
        throw new Error(`мок arc не знает вызов diff: ${args.join(' ')}`);
    }
    const key = `${String(args[2])}..${String(args[3])}`;
    const file = DIFFS[key];
    if (override === undefined && file === undefined) {
        throw new Error(`мок arc не знает дифф между коммитами: ${key}`);
    }

    const paths = args.slice(separator + 1);
    const chunks = splitPatchByFile(override ?? mockFile(`arc/${String(file)}`), paths);
    const asked = new Set(paths);
    const printed = new Set<string>();
    let stdout = '';
    for (const [path, chunk] of chunks) {
        if (asked.has(path) && !printed.has(chunk)) {
            printed.add(chunk);
            stdout += chunk;
        }
    }
    return outcome({ stdout });
}

function show(id: string): ArcOutcome {
    const blobs = JSON.parse(mockFile('arc/blobs.json')) as Record<
        string,
        { text?: string; base64?: string } | undefined
    >;
    const blob = blobs[id];
    if (blob === undefined) {
        return outcome({
            exitCode: 1,
            stderr: `Error:  NoSuchObject: Can't load object with id ${id}\n`,
        });
    }
    return outcome({
        stdout:
            blob.base64 === undefined
                ? blob.text ?? ''
                : Uint8Array.from(Buffer.from(blob.base64, 'base64')),
    });
}

function outcome(
    parts: {
        exitCode?: number | null;
        stdout?: string | Uint8Array;
        stderr?: string;
        failure?: ArcFailure;
    } = {},
): ArcOutcome {
    const stdout = parts.stdout ?? '';
    return {
        exitCode: parts.exitCode === undefined ? 0 : parts.exitCode,
        stdout: typeof stdout === 'string' ? new TextEncoder().encode(stdout) : stdout,
        stderr: parts.stderr ?? '',
        failure: parts.failure ?? null,
    };
}

import { execFile } from 'node:child_process';

import type { FileChangeType, LocalVcsKind } from '@sherpa/protocol';

/**
 * Граница между снимком рабочего дерева и системой контроля версий: интерфейс `LocalVcs`
 * и общий исполнитель команд. Всё, что снимок спрашивает у VCS, перечислено здесь, а разбор
 * вывода живёт внутри бэкенда (`arc-vcs.ts`, `git-vcs.ts`) — наружу едут разобранные структуры.
 */

/** Потолок вывода одной команды: патч рабочего дерева бывает мегабайтным. */
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

/** Команда работает локально: секунды хватает с запасом, но чекаут на FUSE бывает медленным. */
const COMMAND_TIMEOUT_MS = 30_000;

/** Какая VCS стоит за локальным ревью: она же половина префикса ключа (`local-arc-`/`local-git-`). */
export type { LocalVcsKind };

/** Итог запуска команды. stdout — байты: через `show` приезжает и двоичное содержимое. */
export interface CommandOutcome {
    readonly code: number | null;
    readonly stdout: Buffer;
    readonly stderr: string;
}

/**
 * Исполнитель команд VCS с зашитыми бинарником и рабочим каталогом (каталог проекта).
 * Инъекция ради тестов: живой `arc` в них не зовётся.
 */
export type CommandRunner = (args: readonly string[]) => Promise<CommandOutcome>;

/** Живой исполнитель: бинарник из PATH, рабочий каталог — каталог проекта. */
export function commandRunnerIn(bin: LocalVcsKind, cwd: string): CommandRunner {
    return async (args) =>
        new Promise<CommandOutcome>((resolve) => {
            execFile(
                bin,
                [...args],
                { cwd, timeout: COMMAND_TIMEOUT_MS, maxBuffer: MAX_OUTPUT_BYTES, encoding: 'buffer' },
                (error, stdout, stderr) => {
                    const code = error === null ? 0 : numericCode(error);
                    resolve({ code, stdout, stderr: stderr.toString('utf8') });
                },
            );
        });
}

function numericCode(error: Error): number | null {
    const code = (error as NodeJS.ErrnoException).code;
    return typeof code === 'number' ? code : null;
}

/** Байты успешной команды; ненулевой код — ошибка с первой содержательной строкой чужого stderr. */
export async function commandBytes(
    run: CommandRunner,
    bin: LocalVcsKind,
    args: readonly string[],
): Promise<Buffer> {
    const outcome = await run(args);
    if (outcome.code !== 0) {
        throw new Error(`\`${bin} ${args.join(' ')}\` failed${detailOf(outcome.stderr)}`);
    }
    return outcome.stdout;
}

/** Вывод успешной команды текстом. */
export async function commandText(
    run: CommandRunner,
    bin: LocalVcsKind,
    args: readonly string[],
): Promise<string> {
    return (await commandBytes(run, bin, args)).toString('utf8');
}

/** Единственная непустая строка вывода: пустой ответ там, где ждут коммит, — отказ. */
export async function commandLine(
    run: CommandRunner,
    bin: LocalVcsKind,
    args: readonly string[],
): Promise<string> {
    const line = (await commandText(run, bin, args)).trim();
    if (line === '') {
        throw new Error(`\`${bin} ${args.join(' ')}\` printed nothing`);
    }
    return line;
}

function detailOf(stderr: string): string {
    const line = stderr
        .split('\n')
        .map((candidate) => candidate.trim())
        .find((candidate) => candidate !== '');
    return line === undefined ? '' : `: ${line}`;
}

/** Что VCS рассказывает про чекаут; всё остальное адаптеру не нужно. */
export interface VcsInfo {
    readonly branch: string;
    readonly head: string;
    readonly login: string;
}

/** Одна изменённая запись статуса. */
export interface VcsStatusEntry {
    readonly status: string;
    /** Путь от корня чекаута. */
    readonly path: string;
}

export interface VcsStatus {
    readonly changed: readonly VcsStatusEntry[];
    /** Неотслеживаемые файлы путями от корня чекаута; игнорируемое уже вырезано VCS. */
    readonly untracked: readonly string[];
}

/** Строка `--name-status`: тип правки и пути файла. */
export interface NameStatusEntry {
    readonly changeType: FileChangeType;
    readonly path: string;
    /** Прежний путь переименования; null — статус его не назвал. */
    readonly oldPath: string | null;
}

/** Всё, что снимок рабочего дерева спрашивает у VCS. */
export interface LocalVcs {
    readonly kind: LocalVcsKind;

    /** Абсолютный корень чекаута; не чекаут — ошибка. */
    root(): Promise<string>;

    info(): Promise<VcsInfo>;

    /** Ref базы по умолчанию, когда `--base` не назван. */
    defaultBaseRef(): Promise<string>;

    /** Коммит `merge-base <ref> HEAD`. */
    mergeBase(ref: string): Promise<string>;

    /** Коммит по ref. */
    revParse(ref: string): Promise<string>;

    /** Изменения и неотслеживаемые файлы каталога проекта (`projectDir` абсолютный). */
    status(projectDir: string): Promise<VcsStatus>;

    /** Патч git-формата рабочего дерева относительно `base`, пути относительно каталога проекта. */
    diff(base: string): Promise<string>;

    nameStatus(base: string): Promise<NameStatusEntry[]>;

    /** Байты файла `rootPath` (от корня чекаута) в ревизии `ref`; отказ — ошибка, а не пустая сторона. */
    show(ref: string, rootPath: string): Promise<Buffer>;
}

/** Буква статуса `--name-status` → тип правки. */
export function changeTypeOf(letter: string): FileChangeType {
    switch (letter) {
        case 'A':
            return 'add';
        case 'D':
            return 'delete';
        case 'R':
            return 'move';
        case 'C':
            return 'copy';
        case 'U':
            return 'conflict';
        default:
            return 'modify';
    }
}

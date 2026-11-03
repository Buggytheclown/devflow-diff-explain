import { execFile } from 'node:child_process';

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

const COMMAND_TIMEOUT_MS = 10_000;
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

export const runVcsCommand: CommandRunner = async (command, args, options) =>
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

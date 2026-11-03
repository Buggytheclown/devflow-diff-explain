import path from 'node:path';


import { ServerAlreadyRunningError } from './errors.js';
import { formatIdlePeriod, readIdleSeconds } from './idle.js';
import { readOption } from './launch.js';
import { readListenHost } from './listen-host.js';
import { DEFAULT_SHERPA_DIR, manifestPathFor } from './paths.js';
import { checkNodeVersion } from './runtime.js';
import type { SherpaServer } from './server.js';
import { startServer } from './server.js';
import { bundledAssets } from './static.js';
import { UI_ASSETS } from './ui-assets.js';

// Вывод подкоманды CLI `sherpa` может прочитать модель — поэтому по-английски.
const USAGE =
    'Usage: devflow-diff-explain server --pr <PR key> [--sherpa-dir <path>] ' +
    '(started by `devflow-diff-explain up`, not meant to be run by hand)';

/**
 * Форграунд-процесс сервера одного PR. Модуль `devflow-diff-explain-server.mjs` при импорте ничего не исполняет:
 * `runServer` зовёт CLI в `devflow-diff-explain server`, процессе, который демонизирует `devflow-diff-explain up`. Логом и
 * ожиданием манифеста занимается `up` — здесь только сам сервер, который живёт до SIGINT/SIGTERM или
 * до порога простоя (`idle.ts`). UI зашит в бандл и раздаётся из памяти (docs/protocol.md §2).
 *
 * Код возврата — 0 после старта: процесс держит открытый сервер. Токена в stdout нет: вывод уходит
 * в лог-файл, который переживает сервер, а ссылку с токеном печатает CLI, прочитав манифест.
 */
export async function runServer(argv: readonly string[]): Promise<number> {
    const versionError = checkNodeVersion(process.versions.node);
    if (versionError !== null) {
        process.stderr.write(`${versionError}\n`);
        return 1;
    }

    const prKey = readOption(argv, '--pr');
    if (prKey === null) {
        process.stderr.write(`${USAGE}\n`);
        return 1;
    }

    // Процесс наследует cwd того, кто его запустил, — относительный путь стейта приводим к абсолютному.
    const sherpaDir = path.resolve(readOption(argv, '--sherpa-dir') ?? DEFAULT_SHERPA_DIR);

    const idleSeconds = readIdleSeconds(process.env);
    const host = readListenHost(process.env);

    let server: SherpaServer;
    try {
        server = await startServer({
            prKey,
            sherpaDir,
            assets: bundledAssets(UI_ASSETS),
            idleSeconds,
            host,
            onIdleStop: (seconds) => {
                writeLog(`остановка по простою: ${formatIdlePeriod(seconds)} без запросов и открытых соединений`);
            },
        });
    } catch (error) {
        // Гонка двух запусков: чужой сервер уже занял манифест — этот процесс просто уходит.
        const prefix = error instanceof ServerAlreadyRunningError ? 'не стартую' : 'ошибка старта';
        writeLog(`${prefix}: ${messageOf(error)}`);
        return 1;
    }

    writeLog(
        `старт: PR ${server.prKey}, порт ${String(server.port)}, PID ${String(process.pid)}, ` +
            `манифест ${manifestPathFor(sherpaDir, server.prKey)}`,
    );

    const stop = (signal: NodeJS.Signals): void => {
        writeLog(`${signal}: останавливаюсь`);
        void server
            .close()
            .then(() => {
                process.exitCode = 0;
            })
            .catch((error: unknown) => {
                writeLog(`ошибка при остановке: ${messageOf(error)}`);
                process.exitCode = 1;
            });
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);

    return 0;
}

function writeLog(text: string): void {
    process.stdout.write(`${new Date().toISOString()} sherpa-server: ${text}\n`);
}

function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

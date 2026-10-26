import path from 'node:path';

import { localVcsOfPrKey, verdictsInstructionSchema } from '@sherpa/protocol';

import { ServerAlreadyRunningError } from './errors.js';
import { feedbackOptionsFor } from './feedback-launch.js';
import { readLocalHostState } from './hosts/local/index.js';
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
    'Usage: devflow-diff-explain server --pr <PR key> [--sherpa-dir <path>] [--install-dir <path>] ' +
    '[--repo <project dir>] [--base <ref>] [--branch <branch>] [--verdicts <instruction>] ' +
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

    // Откуда установлен дистрибутив, знает только CLI; сервер сравнивает эту версию с trunk.
    const installDir = readOption(argv, '--install-dir');

    // Локальное ревью: каталог проекта, база сравнения, ветка ключа и поручение на исход ревью. Их
    // называет `devflow-diff-explain up --local`, а перезапуск демона поднимается уже на сохранённом состоянии ключа.
    const repo = readOption(argv, '--repo');
    const base = readOption(argv, '--base');
    const branch = readOption(argv, '--branch');
    const verdicts = readOption(argv, '--verdicts');
    // Поручение не по схеме легло бы в local-host.json, и следующий перезапуск остался бы без хоста.
    if (verdicts !== null && !verdictsInstructionSchema.safeParse(verdicts).success) {
        writeLog('ошибка старта: поручение --verdicts пустое или длиннее допустимого');
        return 1;
    }
    if (repo === null && localReviewUnconfigured(prKey, sherpaDir)) {
        writeLog(
            `ревью-хоста нет: ключ ${prKey} локальный, но ни --repo, ни сохранённого local-host.json — ` +
                'запусти `devflow-diff-explain up --local <path>` из каталога проекта',
        );
    }

    const idleSeconds = readIdleSeconds(process.env);
    const host = readListenHost(process.env);

    let server: SherpaServer;
    try {
        server = await startServer({
            presentation: 'story',
            prKey,
            sherpaDir,
            assets: bundledAssets(UI_ASSETS),
            idleSeconds,
            host,
            ...(repo === null ? {} : { repo: path.resolve(repo) }),
            ...(base === null ? {} : { base }),
            ...(branch === null ? {} : { branch }),
            ...(verdicts === null ? {} : { verdicts }),
            updateCheck: installDir === null ? {} : { installDir },
            feedback: feedbackOptionsFor(installDir),
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

/** Локальный ключ без каталога проекта: хоста не будет, и человеку нужно объяснить почему. */
function localReviewUnconfigured(prKey: string, sherpaDir: string): boolean {
    return localVcsOfPrKey(prKey) !== null && readLocalHostState(sherpaDir, prKey) === null;
}

function writeLog(text: string): void {
    process.stdout.write(`${new Date().toISOString()} sherpa-server: ${text}\n`);
}

function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

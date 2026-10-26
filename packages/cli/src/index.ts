import { loadSherpaEnv } from './env.js';
import { run } from './cli.js';
import { checkNodeVersion } from './runtime.js';

/**
 * Флаги Node демона сервера. Сервер ходит в Арканум и Трекер, чьи сертификаты подписаны внутренним
 * CA: он есть в системном хранилище, но Node из коробки доверяет только своему бандлу и падает на
 * `SELF_SIGNED_CERT_IN_CHAIN`. Флаг появился в 22.15/23.8 — более старый рантайм его не получит.
 */
const DAEMON_NODE_FLAGS = ['--use-system-ca'];

/** Точка входа CLI `sherpa`: проверка рантайма, запуск команды, код возврата. */
async function main(): Promise<number> {
    const versionError = checkNodeVersion(process.versions.node);
    if (versionError !== null) {
        process.stderr.write(`${versionError}\n`);
        return 1;
    }

    try { loadSherpaEnv(); } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        process.stderr.write(`devflow-diff-explain: could not load ~/.sherpa/.env - ${detail}\n`);
        return 1;
    }
    return run(process.argv.slice(2), {
        env: process.env,
        out: (text) => {
            process.stdout.write(`${text}\n`);
        },
        err: (text) => {
            process.stderr.write(`${text}\n`);
        },
        daemonNodeFlags: DAEMON_NODE_FLAGS,
    });
}

process.exitCode = await main();

import { loadSherpaEnv } from './env.js';
import { run } from './cli.js';
import { checkNodeVersion } from './runtime.js';

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
    });
}

process.exitCode = await main();

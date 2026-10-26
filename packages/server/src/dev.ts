import path from 'node:path';

import { ServerAlreadyRunningError } from './errors.js';
import { feedbackOptionsFor } from './feedback-launch.js';
import { formatUiUrl, readOption, resolveUiDir, UI_BUILD_HINT } from './launch.js';
import { readListenHost } from './listen-host.js';
import { DEFAULT_SHERPA_DIR, manifestPathFor } from './paths.js';
import type { SherpaServer } from './server.js';
import { startServer } from './server.js';
import { directoryAssets } from './static.js';

/**
 * Дев-запуск сервера: `pnpm --filter @sherpa/server dev --pr <key> [--sherpa-dir <path>] [--ui <path>]`.
 * Печатает порт, путь манифеста и готовую ссылку на UI; висит до SIGINT/SIGTERM.
 */
async function main(argv: readonly string[]): Promise<number> {
    const prKey = readOption(argv, '--pr');
    if (prKey === null) {
        process.stderr.write(
            'Использование: dev --pr <ключ PR> [--sherpa-dir <путь>] [--ui <путь к dist>] ' +
                '[--install-dir <путь>] [--repo <каталог проекта>] [--base <ref>] [--branch <ветка>]\n',
        );
        return 1;
    }

    const sherpaDir = readOption(argv, '--sherpa-dir') ?? DEFAULT_SHERPA_DIR;
    const uiDir = await resolveUiDir(readOption(argv, '--ui'));
    // Как в бандле: классификация установки для тоста обновления нужна и галерее, и e2e.
    const installDir = readOption(argv, '--install-dir');
    const host = readListenHost(process.env);
    // Локальное ревью: каталог проекта, база сравнения и ветка — те же аргументы, что у бандла.
    const repo = readOption(argv, '--repo');
    const reviewBase = readOption(argv, '--base');
    const reviewBranch = readOption(argv, '--branch');

    // Самоостановка по простою выключена: дев-сервер держит открытый терминал разработчика,
    // и внезапная смерть посреди работы над кодом ему только мешает — останавливает Ctrl+C.
    const options = {
        presentation: 'story' as const,
        prKey,
        sherpaDir,
        host,
        idleSeconds: 0,
        ...(repo === null ? {} : { repo: path.resolve(repo) }),
        ...(reviewBase === null ? {} : { base: reviewBase }),
        ...(reviewBranch === null ? {} : { branch: reviewBranch }),
        updateCheck: installDir === null ? {} : { installDir },
        feedback: feedbackOptionsFor(installDir),
    };

    let server: SherpaServer;
    try {
        server = await startServer(uiDir === null ? options : { ...options, assets: directoryAssets(uiDir) });
    } catch (error) {
        if (error instanceof ServerAlreadyRunningError) {
            process.stderr.write(`${error.message}\n`);
            return 1;
        }
        throw error;
    }

    process.stdout.write(
        [
            `sherpa-server: PR ${server.prKey}`,
            `порт:    ${String(server.port)}`,
            `манифест: ${manifestPathFor(sherpaDir, server.prKey)}`,
            uiDir === null
                ? `UI: не собран — ${UI_BUILD_HINT}, затем перезапусти с \`--ui <путь>\``
                : formatUiUrl(server.port, server.token, server.uiHost),
            'Ctrl+C — остановить.',
            '',
        ].join('\n'),
    );

    const stop = (signal: NodeJS.Signals): void => {
        process.stdout.write(`\nsherpa-server: ${signal}, останавливаюсь…\n`);
        void server
            .close()
            .then(() => {
                process.exitCode = 0;
            })
            .catch((error: unknown) => {
                process.stderr.write(`sherpa-server: ошибка при остановке: ${String(error)}\n`);
                process.exitCode = 1;
            });
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);

    return 0;
}

const code = await main(process.argv.slice(2));
if (code !== 0) {
    process.exitCode = code;
}

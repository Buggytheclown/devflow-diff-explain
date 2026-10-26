import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, posix, relative, resolve, sep } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';

const root = dirname(fileURLToPath(import.meta.url));
// Версия поставки одна на весь дистрибутив — поле `version` корневого package.json.
const version = JSON.parse(readFileSync(resolve(root, '../../package.json'), 'utf8')).version;
const uiDist = resolve(root, '../ui/dist');
const assetsModule = resolve(root, 'src/ui-assets.ts');
const outfile = resolve(root, 'dist/devflow-diff-explain-server.mjs');

let assets;
try {
    assets = collectUiAssets(uiDist);
} catch (error) {
    // Отсутствующий UI — не поломка сборки, а забытый шаг: человеку нужен текст, а не stack trace.
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
}

/**
 * Модуль сервера: один самодостаточный ESM-файл с зашитой статикой UI. Нативных зависимостей нет —
 * хранилище стоит на встроенном `node:sqlite`, поэтому весь сервер собирается в файл (docs/protocol.md §2).
 * Файл не исполняемый: его грузит `import()` CLI в `devflow-diff-explain server` и зовёт экспорт `runServer`.
 */
await build({
    entryPoints: [resolve(root, 'src/bundle.ts')],
    outfile,
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node22.13',
    packages: 'bundle',
    define: { __SHERPA_VERSION__: JSON.stringify(version) },
    plugins: [inlineUiAssets(assetsModule, assets)],
    logLevel: 'info',
});

/**
 * Подмена модуля `src/ui-assets.ts`: в исходниках карта пуста, в бандле — содержимое `ui/dist`.
 * Так дев-запуск раздаёт UI с диска, а дистрибутив — из памяти, и в коде нет ветвлений по режиму.
 */
function inlineUiAssets(modulePath, files) {
    return {
        name: 'sherpa-ui-assets',
        setup(pluginBuild) {
            pluginBuild.onLoad({ filter: /src[\\/]ui-assets\.ts$/ }, (args) => {
                if (resolve(args.path) !== modulePath) {
                    return null;
                }
                return {
                    contents: `export const UI_ASSETS = ${JSON.stringify(files)};\n`,
                    loader: 'ts',
                };
            });
        },
    };
}

/** Карта «путь внутри сборки → base64»; пустая сборка UI — ошибка с готовой инструкцией. */
function collectUiAssets(distDir) {
    const files = {};
    for (const file of walk(distDir)) {
        const pathname = `/${relative(distDir, file).split(sep).join(posix.sep)}`;
        files[pathname] = readFileSync(file).toString('base64');
    }

    if (files['/index.html'] === undefined) {
        throw new Error(
            `@sherpa/server: в ${distDir} нет собранного UI — сначала \`pnpm --filter @sherpa/ui build\`, ` +
                'потом сборка сервер-бандла.',
        );
    }
    return files;
}

function walk(dir) {
    let entries;
    try {
        entries = readdirSync(dir);
    } catch {
        return [];
    }

    const files = [];
    for (const entry of entries) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) {
            files.push(...walk(full));
        } else {
            files.push(full);
        }
    }
    return files;
}

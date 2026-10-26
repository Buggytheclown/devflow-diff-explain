import { chmodSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';

const root = dirname(fileURLToPath(import.meta.url));
// Версия поставки одна на весь дистрибутив — поле `version` корневого package.json.
// Версии пакетов источником не являются.
const version = JSON.parse(readFileSync(resolve(root, '../../package.json'), 'utf8')).version;
const outfile = resolve(root, 'dist/devflow-diff-explain.mjs');

// Единственный артефакт CLI — самодостаточный ESM-файл: всё заинлайнено,
// в рантайме доступны только встроенные модули Node (docs/protocol.md §11 п.1).
await build({
    entryPoints: [resolve(root, 'src/index.ts')],
    outfile,
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node22.13',
    packages: 'bundle',
    banner: { js: '#!/usr/bin/env node' },
    define: { __SHERPA_VERSION__: JSON.stringify(version) },
    logLevel: 'info',
});

chmodSync(outfile, 0o755);

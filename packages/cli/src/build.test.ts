import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { describe, expect, it } from 'vitest';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const bundlePath = join(packageRoot, 'dist', 'devflow-diff-explain.mjs');
/** Версия поставки — из корневого package.json: единственный источник на все три бандла. */
const releaseVersion = (
    JSON.parse(readFileSync(join(packageRoot, '../../package.json'), 'utf8')) as { version: string }
).version;

// Бандл собран один раз в globalSetup (`src/bundle.global-setup.ts`).
describe('сборка CLI', () => {
    it('не оставляет внешних импортов, кроме встроенных модулей Node', () => {
        const bundle = readFileSync(bundlePath, 'utf8');
        const specifiers = [...bundle.matchAll(/(?:^|\n)\s*import\s[^\n]*?["']([^"']+)["']/g)].map(
            (match) => match[1],
        );

        expect(specifiers.filter((s) => s !== undefined && !s.startsWith('node:'))).toEqual([]);
    });

    // Запуск из временного каталога: рядом нет node_modules, значит бандл самодостаточен.
    it('запускается голым node и печатает версию', () => {
        const isolated = join(mkdtempSync(join(tmpdir(), 'sherpa-cli-')), 'devflow-diff-explain.mjs');
        copyFileSync(bundlePath, isolated);

        const stdout = execFileSync(process.execPath, [isolated, '--version'], {
            cwd: tmpdir(),
            encoding: 'utf8',
        });

        expect(stdout.trim()).toBe(releaseVersion);
    });

    // Старый Node запустить неоткуда, поэтому подменяем process.versions.node в обёртке над бандлом.
    it('на устаревшем Node печатает понятную ошибку и падает с ненулевым кодом', () => {
        const isolated = join(mkdtempSync(join(tmpdir(), 'sherpa-cli-')), 'devflow-diff-explain.mjs');
        copyFileSync(bundlePath, isolated);

        const driver = join(dirname(isolated), 'old-node.mjs');
        writeFileSync(
            driver,
            [
                "Object.defineProperty(process.versions, 'node', { value: '22.12.0' });",
                `await import(${JSON.stringify(pathToFileURL(isolated).href)});`,
                '',
            ].join('\n'),
        );

        const result = spawnSync(process.execPath, [driver], { cwd: tmpdir(), encoding: 'utf8' });

        expect(result.status).toBe(1);
        expect(result.stderr).toContain('22.12.0');
        expect(result.stderr).toContain('Node 22.13');
    });

    // Петля воркера дёргает CLI на каждый вызов: в бандл не должны просочиться ни сервер, ни UI.
    it('остаётся тонким: без сервера и без ассетов UI', () => {
        const bundle = readFileSync(bundlePath, 'utf8');

        expect(bundle).not.toContain('node:sqlite');
        expect(bundle).not.toContain('<!doctype html');
        // Модуль сервера CLI грузит `import()` по пути, вычисленному в рантайме, — в бандл он не попадает.
        expect(bundle).not.toContain('function startServer(');
        expect(statSync(bundlePath).size).toBeLessThan(1024 * 1024);
    });
});

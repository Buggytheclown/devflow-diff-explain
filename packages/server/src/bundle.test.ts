import type { ChildProcess } from 'node:child_process';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

import { PROTOCOL_VERSION, WORKER_ENDPOINTS, workerRegisterResponseSchema } from '@sherpa/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { isProcessAlive, readManifest } from './manifest.js';
import { manifestPathFor } from './paths.js';
import { get, makeTempSherpaDir, removeTempSherpaDir } from './test-support.js';

/**
 * Ключ фикстурного хоста: этому набору важен процесс, а не адаптер, зато живой Арканум
 * в тестах запрещён (docs/testing.md) — с арканумным ключом прогрев маршрута пошёл бы за диффом в сеть.
 */
const PR_KEY = 'fixture-medium';
const TEST_TIMEOUT_MS = 40_000;
const STARTUP_TIMEOUT_MS = 15_000;

const packageRoot = path.resolve(import.meta.dirname, '..');
/** Собран один раз в globalSetup (`src/bundle.global-setup.ts`) — здесь только запускается. */
const bundlePath = path.join(packageRoot, 'dist', 'devflow-diff-explain-server.mjs');
/**
 * Версия поставки — из корневого package.json: в бандле она зашита сборкой, а `SERVER_VERSION`
 * этого процесса нулевой (значение по умолчанию в деве), и сверять с ним нечего.
 */
const releaseVersion = (
    JSON.parse(readFileSync(path.join(packageRoot, '../../package.json'), 'utf8')) as { version: string }
).version;

/**
 * Модуль сервера как его видит дистрибутив скилла: отдельный процесс голым node, стейт в tmp,
 * UI зашит внутрь. Ни чекаута, ни `ui/dist` рядом с процессом нет. В дистрибутиве модуль грузит
 * `devflow-diff-explain server` из CLI; здесь — обёртка из двух строк, чтобы пакет сервера не зависел от CLI.
 */
describe('модуль сервера', () => {
    let sherpaDir: string;
    let workDir: string;
    let child: ChildProcess | null;

    beforeEach(async () => {
        sherpaDir = await makeTempSherpaDir();
        // Каталог запуска, в котором заведомо нет ни чекаута, ни собранного UI.
        workDir = await makeTempSherpaDir();
        child = null;
    });

    afterEach(async () => {
        if (child !== null && child.exitCode === null && child.signalCode === null) {
            child.kill('SIGKILL');
        }
        await removeTempSherpaDir(sherpaDir);
        await removeTempSherpaDir(workDir);
    });

    /** Обёртка над модулем; `prelude` исполняется до импорта. */
    async function writeWrapper(prelude = ''): Promise<string> {
        const wrapper = path.join(workDir, 'run-server.mjs');
        await writeFile(
            wrapper,
            `${prelude}\n` +
                `const { runServer } = await import(${JSON.stringify(pathToFileURL(bundlePath).href)});\n` +
                'process.exitCode = await runServer(process.argv.slice(2));\n',
            'utf8',
        );
        return wrapper;
    }

    async function launch(args: readonly string[], env: NodeJS.ProcessEnv = process.env): Promise<ChildProcess> {
        child = spawn(process.execPath, [await writeWrapper(), ...args], {
            cwd: workDir,
            stdio: ['ignore', 'pipe', 'pipe'],
            env,
        });
        return child;
    }

    it(
        'поднимается отдельным процессом и раздаёт зашитый UI из памяти',
        async () => {
            await launch(['--pr', PR_KEY, '--sherpa-dir', sherpaDir]);

            const manifest = await waitForManifest(sherpaDir);
            expect(manifest.pid).not.toBe(process.pid);
            expect(isProcessAlive(manifest.pid)).toBe(true);

            const health = await get(manifest.port, '/healthz', manifest.token);
            expect(health.status).toBe(200);
            expect(await health.json()).toMatchObject({ ok: true, prKey: PR_KEY, serverVersion: releaseVersion });

            // Статика — без токена: секретов в ней нет (docs/protocol.md §8).
            const index = await get(manifest.port, '/');
            expect(index.status).toBe(200);
            expect(index.headers.get('content-type')).toContain('text/html');
            const html = await index.text();
            expect(html).toContain('<div id="root">');

            for (const [asset, contentType] of [
                [assetHref(html, '.js'), 'text/javascript'],
                [assetHref(html, '.css'), 'text/css'],
                // Фавиконка — марка продукта: в бандле она такой же ассет, как скрипт и стили.
                [assetHref(html, '.svg'), 'image/svg+xml'],
            ] as const) {
                const response = await get(manifest.port, asset);
                expect(response.status, asset).toBe(200);
                expect(response.headers.get('content-type'), asset).toContain(contentType);
                expect((await response.text()).length, asset).toBeGreaterThan(0);
            }
        },
        TEST_TIMEOUT_MS,
    );

    it(
        'воркерская ручка отвечает, а процесс снимается по SIGTERM',
        async () => {
            const server = await launch(['--pr', PR_KEY, '--sherpa-dir', sherpaDir]);
            const manifest = await waitForManifest(sherpaDir);

            const response = await fetch(`http://127.0.0.1:${String(manifest.port)}${WORKER_ENDPOINTS.register}`, {
                method: 'POST',
                headers: {
                    'content-type': 'application/json',
                    authorization: `Bearer ${manifest.token}`,
                },
                body: JSON.stringify({
                    protocolVersion: PROTOCOL_VERSION,
                    cliVersion: '0.0.0',
                    workerId: 'сессия-из-бандла',
                    harness: 'claude-code',
                }),
            });
            expect(response.status).toBe(200);
            expect(workerRegisterResponseSchema.parse(await response.json()).kind).toBe('registered');

            server.kill('SIGTERM');
            await waitFor(async () => (await readManifest(manifestPathFor(sherpaDir, PR_KEY))) === null);
            // Манифест снимается в обработчике сигнала, а сам процесс гаснет следом: на загруженной
            // машине между этим есть зазор, поэтому смерть ждём, а не проверяем сразу после манифеста.
            await waitFor(() => Promise.resolve(!isProcessAlive(manifest.pid)));
        },
        TEST_TIMEOUT_MS,
    );

    it(
        'гаснет сам по простою: убирает манифест и объясняет причину в логе',
        async () => {
            // Порог сокращён недокументированной переменной — четверть часа в тесте не выждать.
            const server = await launch(['--pr', PR_KEY, '--sherpa-dir', sherpaDir], {
                ...process.env,
                SHERPA_IDLE_SECONDS: '2',
            });

            const { code, stdout } = await collectExit(server);
            expect(code).toBe(0);
            expect(stdout).toContain('старт: PR');
            expect(stdout).toContain('остановка по простою: 2 с');
            expect(await readManifest(manifestPathFor(sherpaDir, PR_KEY))).toBeNull();
        },
        TEST_TIMEOUT_MS,
    );

    it(
        'без ключа PR печатает использование и уходит с ненулевым кодом',
        async () => {
            const server = await launch([]);
            const { code, stderr } = await collectExit(server);

            expect(code).toBe(1);
            expect(stderr).toContain('devflow-diff-explain server --pr');
        },
        TEST_TIMEOUT_MS,
    );

    // Модуль лежит в дистрибутиве рядом с CLI: импорт сам по себе не имеет права поднять сервер.
    it(
        'голый импорт модуля ничего не запускает',
        async () => {
            const importer = path.join(workDir, 'import-only.mjs');
            await writeFile(importer, `await import(${JSON.stringify(pathToFileURL(bundlePath).href)});\n`, 'utf8');

            child = spawn(process.execPath, [importer, '--pr', PR_KEY, '--sherpa-dir', sherpaDir], {
                cwd: workDir,
                stdio: ['ignore', 'pipe', 'pipe'],
            });
            const { code, stdout, stderr } = await collectExit(child);

            expect(code).toBe(0);
            expect(stdout).toBe('');
            expect(stderr).toBe('');
            expect(await readManifest(manifestPathFor(sherpaDir, PR_KEY))).toBeNull();
        },
        TEST_TIMEOUT_MS,
    );

    it('не тянет node:sqlite статическим импортом', async () => {
        const source = await readFile(bundlePath, 'utf8');

        // Статический импорт ESM резолвится при линковке — на Node без node:sqlite процесс умер бы
        // сырой ошибкой раньше, чем checkNodeVersion объяснит человеку, что делать.
        expect(source).not.toMatch(/^import[^\n]*node:sqlite/mu);
    });

    it(
        'на неподходящей версии Node объясняет человеку, что делать',
        async () => {
            // Версию рантайма подменяем в обёртке: сам модуль на такой Node просто не на чем запустить.
            const wrapper = await writeWrapper(
                `Object.defineProperty(process.versions, 'node', { value: '22.12.0' });`,
            );

            child = spawn(process.execPath, [wrapper, '--pr', PR_KEY, '--sherpa-dir', sherpaDir], {
                cwd: workDir,
                stdio: ['ignore', 'pipe', 'pipe'],
            });
            const { code, stderr } = await collectExit(child);

            expect(code).toBe(1);
            expect(stderr).toContain('22.13');
            expect(stderr).toContain('22.12.0');
            expect(await readManifest(manifestPathFor(sherpaDir, PR_KEY))).toBeNull();
        },
        TEST_TIMEOUT_MS,
    );
});

async function collectExit(
    server: ChildProcess,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
    let stdout = '';
    let stderr = '';
    server.stdout?.setEncoding('utf8');
    server.stdout?.on('data', (chunk: string) => (stdout += chunk));
    server.stderr?.setEncoding('utf8');
    server.stderr?.on('data', (chunk: string) => (stderr += chunk));
    const code = await new Promise<number | null>((resolve) => server.once('close', resolve));
    return { code, stdout, stderr };
}

/** Ссылка на ассет из index.html: имена файлов сборки Vite содержат хеш и меняются. */
function assetHref(html: string, extension: string): string {
    const match = new RegExp(`/assets/[^"']+\\${extension}`, 'u').exec(html);
    if (match === null) {
        throw new Error(`в index.html нет ссылки на ассет ${extension}`);
    }
    return match[0];
}

async function waitForManifest(sherpaDir: string): Promise<{ port: number; pid: number; token: string }> {
    const manifestPath = manifestPathFor(sherpaDir, PR_KEY);
    let manifest = await readManifest(manifestPath);
    await waitFor(async () => {
        manifest = await readManifest(manifestPath);
        return manifest !== null;
    });
    if (manifest === null) {
        throw new Error('модуль сервера не опубликовал манифест');
    }
    return manifest;
}

async function waitFor(condition: () => Promise<boolean>): Promise<void> {
    const deadline = Date.now() + STARTUP_TIMEOUT_MS;
    while (Date.now() < deadline) {
        if (await condition()) {
            return;
        }
        await delay(50);
    }
    throw new Error('условие не выполнилось за отведённое время');
}

import type { ChildProcess } from 'node:child_process';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CliError } from './errors.js';
import { manifestPathFor } from './paths.js';
import { ensureServer, hasExited, loadServerModule, resolveServerBin, terminateChild } from './up.js';

const PR_KEY = 'arcanum-777';

/**
 * Собранный CLI (`src/bundle.global-setup.ts`): демон — это он же командой `devflow-diff-explain server`, поэтому
 * спавнится настоящий бандл, а подменяется только модуль сервера.
 */
const CLI_BUNDLE = path.resolve(import.meta.dirname, '..', 'dist', 'devflow-diff-explain.mjs');

/** Короткое окно ожидания манифеста: ветки отказа не должны стоить теста в десять секунд. */
const STARTUP_TIMEOUT_MS = 1_500;

describe('поиск модуля сервера', () => {
    let workDir: string;
    let binDir: string;

    beforeEach(async () => {
        // Реальный tmp вместо мока fs: симлинк-кейс проверяется только настоящим симлинком.
        workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sherpa-bin-'));
        binDir = path.join(workDir, 'skill', 'bin');
        await fs.mkdir(binDir, { recursive: true });
        await fs.writeFile(path.join(binDir, 'devflow-diff-explain.mjs'), '// CLI\n');
        await fs.writeFile(path.join(binDir, 'devflow-diff-explain-server.mjs'), '// сервер\n');
    });

    afterEach(async () => {
        await fs.rm(workDir, { recursive: true, force: true });
    });

    it('берётся соседним файлом рядом с самим CLI', async () => {
        await expect(resolveServerBin(path.join(binDir, 'devflow-diff-explain.mjs'), undefined)).resolves.toBe(
            path.join(await fs.realpath(binDir), 'devflow-diff-explain-server.mjs'),
        );
    });

    it('находится через симлинк на каталог скилла', async () => {
        // Так скилл и ставится: `~/.claude/skills/devflow-diff-explain -> <дистрибутив>`.
        const link = path.join(workDir, 'skills-sherpa');
        await fs.symlink(path.join(workDir, 'skill'), link, 'dir');

        await expect(resolveServerBin(path.join(link, 'bin', 'devflow-diff-explain.mjs'), undefined)).resolves.toBe(
            path.join(await fs.realpath(binDir), 'devflow-diff-explain-server.mjs'),
        );
    });

    it('без соседнего сервера — ошибка про неполный дистрибутив', async () => {
        const lonely = path.join(workDir, 'devflow-diff-explain.mjs');
        await fs.writeFile(lonely, '// CLI\n');

        await expect(resolveServerBin(lonely, undefined)).rejects.toThrow('skill distribution is incomplete');
    });

    it('пустой или несуществующий путь запуска — та же ошибка, без падения по stack trace', async () => {
        await expect(resolveServerBin(undefined, undefined)).rejects.toThrow(CliError);
        await expect(resolveServerBin('   ', undefined)).rejects.toThrow('skill distribution is incomplete');
        await expect(resolveServerBin(path.join(workDir, 'нет-такого.mjs'), undefined)).rejects.toThrow(
            'skill distribution is incomplete',
        );
    });

    it('SHERPA_SERVER_BIN перебивает поиск, а несуществующий путь в нём — отдельная ошибка', async () => {
        const custom = path.join(workDir, 'свой-сервер.mjs');
        await fs.writeFile(custom, '// сервер\n');

        await expect(resolveServerBin(path.join(binDir, 'devflow-diff-explain.mjs'), custom)).resolves.toBe(custom);
        await expect(
            resolveServerBin(path.join(binDir, 'devflow-diff-explain.mjs'), path.join(workDir, 'нет-такого.mjs')),
        ).rejects.toThrow('SHERPA_SERVER_BIN');
    });

    it('модуль без функции runServer — ошибка про неполный дистрибутив', async () => {
        const broken = path.join(workDir, 'без-runServer.mjs');
        await fs.writeFile(broken, 'export const runServer = 42;\n');

        await expect(loadServerModule(broken)).rejects.toThrow('skill distribution is incomplete');
    });

    it('битый модуль сервера — ошибка с путём и причиной, а не «повтори команду»', async () => {
        const truncated = path.join(workDir, 'недописанный.mjs');
        await fs.writeFile(truncated, 'export async function runServer(argv) {\n');

        const error: unknown = await loadServerModule(truncated).catch((caught: unknown) => caught);

        expect(error).toBeInstanceOf(CliError);
        expect((error as CliError).message).toContain(`${truncated} failed to load`);
        expect((error as CliError).message).toContain('do not start the worker loop');
    });

    it('модуль с runServer грузится, и функция зовётся с аргументами как есть', async () => {
        const file = path.join(workDir, 'эхо-сервер.mjs');
        await fs.writeFile(file, 'export async function runServer(argv) { return argv.length; }\n');

        const loaded = await loadServerModule(file);

        await expect(loaded.runServer(['--pr', PR_KEY])).resolves.toBe(2);
    });
});

describe('подъём сервера в `up`', () => {
    let workDir: string;
    let sherpaDir: string;
    const spawned: ChildProcess[] = [];

    beforeEach(async () => {
        workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sherpa-up-'));
        sherpaDir = path.join(workDir, 'state');
        await fs.mkdir(path.join(sherpaDir, 'servers'), { recursive: true });
    });

    afterEach(async () => {
        for (const child of spawned.splice(0)) {
            if (!hasExited(child)) {
                child.kill('SIGKILL');
            }
        }
        await killManifestServer(sherpaDir);
        await fs.rm(workDir, { recursive: true, force: true });
    });

    /**
     * Подмена модуля сервера: демон — настоящий процесс CLI, потому что тестируются именно демонизация
     * и ожидание. Раскладка как у дистрибутива (`<корень>/bin/`) — из неё CLI выводит `--install-dir`.
     * `body` — тело экспортируемой `runServer(argv)`.
     */
    async function fakeServer(body: string): Promise<string> {
        const binDir = path.join(workDir, 'skill', 'bin');
        await fs.mkdir(binDir, { recursive: true });
        const file = path.join(binDir, 'devflow-diff-explain-server.mjs');
        await fs.writeFile(file, `export async function runServer(argv) {\n${body}\nreturn 0;\n}\n`);
        return file;
    }

    /** Сервер, который делает главное: слушает порт, отвечает `/healthz` и публикует манифест. */
    const WORKING_SERVER = `
        const http = await import('node:http');
        const fs = await import('node:fs/promises');
        const path = await import('node:path');

        const prKey = argv[argv.indexOf('--pr') + 1];
        const sherpaDir = argv[argv.indexOf('--sherpa-dir') + 1];
        const installDir = argv[argv.indexOf('--install-dir') + 1];
        const repoIndex = argv.indexOf('--repo');
        const repo = repoIndex === -1 ? null : argv[repoIndex + 1];
        const baseIndex = argv.indexOf('--base');
        const base = baseIndex === -1 ? null : argv[baseIndex + 1];
        const branchIndex = argv.indexOf('--branch');
        const branch = branchIndex === -1 ? null : argv[branchIndex + 1];
        const verdictsIndex = argv.indexOf('--verdicts');
        const verdicts = verdictsIndex === -1 ? null : argv[verdictsIndex + 1];
        const token = 'f'.repeat(64);

        let slowFirstHealth = argv.includes('--slow-first-health');
        const server = http.createServer((req, res) => {
            const respond = () => {
                res.writeHead(200, { 'content-type': 'application/json' });
                res.end(JSON.stringify({ ok: true, prKey, pid: process.pid, serverVersion: '0.1.0', protocolVersion: '0.1.0' }));
            };
            if (slowFirstHealth) {
                slowFirstHealth = false;
                setTimeout(respond, 1_200);
                return;
            }
            respond();
        });
        await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

        console.log('старт: PR ' + prKey);
        const manifest = {
            prKey,
            installDir,
            repo,
            base,
            branch,
            verdicts,
            port: server.address().port,
            pid: process.pid,
            token,
            protocolVersion: '0.1.0',
            serverVersion: '0.1.0',
            createdAt: new Date().toISOString(),
        };
        await fs.mkdir(path.join(sherpaDir, 'servers'), { recursive: true });
        await fs.writeFile(path.join(sherpaDir, 'servers', prKey + '.json'), JSON.stringify(manifest));
    `;

    async function up(
        serverBin: string,
        local?: { repo: string; base?: string; branch?: string; verdicts?: string },
        nodeFlags?: readonly string[],
    ) {
        return ensureServer({
            prKey: PR_KEY,
            sherpaDir,
            entry: CLI_BUNDLE,
            serverBin,
            startupTimeoutMs: STARTUP_TIMEOUT_MS,
            ...(nodeFlags === undefined ? {} : { nodeFlags }),
            ...(local === undefined
                ? {}
                : { repo: local.repo, base: local.base, branch: local.branch, verdicts: local.verdicts }),
        });
    }

    async function waitForManifest(): Promise<TestManifest> {
        for (let attempt = 0; attempt < 100; attempt += 1) {
            try {
                return await readManifest(sherpaDir);
            } catch {
                await delay(20);
            }
        }
        throw new Error('сервер не опубликовал манифест');
    }

    it('флаги Node из параметра доходят до демона, незнакомый рантайму флаг отброшен', async () => {
        const guarded = `
            if (!process.execArgv.includes('--no-warnings') || process.execArgv.includes('--no-such-node-flag')) {
                console.error('флаги рантайма: ' + process.execArgv.join(' '));
                process.exit(3);
            }
            ${WORKING_SERVER}
        `;

        const result = await up(await fakeServer(guarded), undefined, ['--no-warnings', '--no-such-node-flag']);

        expect(result.started).toBe(true);
    });

    it('демон — этот же CLI командой `devflow-diff-explain server`, модуль сервера ему передан в SHERPA_SERVER_BIN', async () => {
        const recording = `
            const fsSync = await import('node:fs');
            const sherpaDirArg = argv[argv.indexOf('--sherpa-dir') + 1];
            fsSync.writeFileSync(
                sherpaDirArg + '/daemon.json',
                JSON.stringify({ argv: process.argv.slice(1), serverBin: process.env.SHERPA_SERVER_BIN }),
            );
            ${WORKING_SERVER}
        `;
        const serverBin = await fakeServer(recording);

        await up(serverBin);

        const daemon = JSON.parse(await fs.readFile(path.join(sherpaDir, 'daemon.json'), 'utf8')) as {
            argv: string[];
            serverBin: string;
        };
        expect(daemon.argv.slice(0, 4)).toEqual([await fs.realpath(CLI_BUNDLE), 'server', '--pr', PR_KEY]);
        expect(daemon.serverBin).toBe(serverBin);
    });

    it('манифеста нет — демон поднимается, ссылка строится из его манифеста', async () => {
        const result = await up(await fakeServer(WORKING_SERVER));

        const manifest = await readManifest(sherpaDir);
        expect(result).toEqual({
            uiUrl: `http://127.0.0.1:${String(manifest.port)}/#t=${manifest.token}`,
            started: true,
        });
        expect(manifest.pid).not.toBe(process.pid);
    });

    // Откуда установлен дистрибутив, знает только CLI: сервер получает это аргументом.
    it('демон получает --install-dir — корень дистрибутива над bin/', async () => {
        await up(await fakeServer(WORKING_SERVER));

        expect((await readManifest(sherpaDir)).installDir).toBe(await fs.realpath(path.join(workDir, 'skill')));
    });

    // Каталог, базу и ветку знает только CLI — серверу они уезжают аргументами спавна.
    // Ветка тут не роскошь: на ней построен ключ, а чекаут между `up` и первым снимком могут увести.
    it('демон получает --repo, --base и --branch локального ревью', async () => {
        await up(await fakeServer(WORKING_SERVER), { repo: '/repo/app', base: 'trunk~3', branch: 'feature' });

        const manifest = await readManifest(sherpaDir);
        expect(manifest.repo).toBe('/repo/app');
        expect(manifest.base).toBe('trunk~3');
        expect(manifest.branch).toBe('feature');
        expect(manifest.verdicts).toBeNull();
    });

    it('поручение уезжает демону значением --verdicts', async () => {
        await up(await fakeServer(WORKING_SERVER), { repo: '/repo/app', verdicts: 'on ship, open a PR' });

        expect((await readManifest(sherpaDir)).verdicts).toBe('on ship, open a PR');
    });

    it('без локального ревью ни --repo, ни --base, ни --branch демону не передаются', async () => {
        await up(await fakeServer(WORKING_SERVER));

        const manifest = await readManifest(sherpaDir);
        expect(manifest.repo).toBeNull();
        expect(manifest.base).toBeNull();
        expect(manifest.branch).toBeNull();
        expect(manifest.verdicts).toBeNull();
    });

    it('живой манифест переиспользуется: второй сервер не поднимается', async () => {
        const serverBin = await fakeServer(WORKING_SERVER);
        const first = await up(serverBin);
        const firstPid = (await readManifest(sherpaDir)).pid;

        const second = await up(serverBin);

        expect(first.started).toBe(true);
        expect(second).toEqual({ uiUrl: first.uiUrl, started: false });
        expect((await readManifest(sherpaDir)).pid).toBe(firstPid);
    });

    it('живой сервер берёт адрес UI из своего манифеста, а не из нового окружения CLI', async () => {
        const serverBin = await fakeServer(WORKING_SERVER);
        await up(serverBin);
        const manifest = await readManifest(sherpaDir);
        await fs.writeFile(
            manifestPathFor(sherpaDir, PR_KEY),
            JSON.stringify({ ...manifest, uiHost: 'sherpa-vm.example' }),
        );

        const result = await up(serverBin);

        expect(result).toEqual({
            uiUrl: `http://sherpa-vm.example:${String(manifest.port)}/#t=${manifest.token}`,
            started: false,
        });
    });

    it('манифест чужого сервера после спавна не считается холодным стартом', async () => {
        const serverBin = await fakeServer(WORKING_SERVER);
        const foreign = spawn(
            process.execPath,
            [CLI_BUNDLE, 'server', '--pr', PR_KEY, '--sherpa-dir', sherpaDir, '--slow-first-health'],
            { stdio: 'ignore', env: { ...process.env, SHERPA_SERVER_BIN: serverBin } },
        );
        spawned.push(foreign);
        const foreignManifest = await waitForManifest();
        const losingDaemon = await fakeServer('setTimeout(() => process.exit(0), 500);');

        const result = await up(losingDaemon);

        expect(result).toEqual({
            uiUrl: `http://127.0.0.1:${String(foreignManifest.port)}/#t=${foreignManifest.token}`,
            started: false,
        });
    });

    it('мёртвый манифест не мешает: сервер поднимается заново', async () => {
        await writeManifest(sherpaDir, { pid: await deadPid(), port: 1, token: 'f'.repeat(64) });

        await up(await fakeServer(WORKING_SERVER));

        expect((await readManifest(sherpaDir)).port).not.toBe(1);
    });

    it('сервер молчит — отказ по таймауту с хвостом лога и запретом начинать петлю', async () => {
        const silent = await fakeServer("console.log('шум запуска'); setInterval(() => {}, 1000);");

        await expect(up(silent)).rejects.toThrow('did not start within');
        await expect(up(silent)).rejects.toThrow('шум запуска');
        await expect(up(silent)).rejects.toThrow('do not start the worker loop');
    }, 20_000);

    it('сервер умер сразу — ответ приходит не дожидаясь таймаута', async () => {
        const dying = await fakeServer("console.error('нечем открыть хранилище'); return 1;");

        const started = Date.now();
        await expect(up(dying)).rejects.toThrow('нечем открыть хранилище');
        expect(Date.now() - started).toBeLessThan(STARTUP_TIMEOUT_MS);
    });

    it('модуля сервера нет на месте — ошибка про неполный дистрибутив, ничего не спавнится', async () => {
        await expect(
            ensureServer({
                prKey: PR_KEY,
                sherpaDir,
                entry: undefined,
                startupTimeoutMs: STARTUP_TIMEOUT_MS,
            }),
        ).rejects.toThrow('skill distribution is incomplete');
    });

    // Демон — сам CLI: без пути к нему спавнить нечего, даже если модуль сервера назван явно.
    it('нет пути к CLI — та же ошибка, хотя SHERPA_SERVER_BIN задан', async () => {
        const serverBin = await fakeServer(WORKING_SERVER);

        await expect(
            ensureServer({ prKey: PR_KEY, sherpaDir, entry: undefined, serverBin, startupTimeoutMs: STARTUP_TIMEOUT_MS }),
        ).rejects.toThrow('skill distribution is incomplete');
    });

    describe('снятие зависшего демона', () => {
        function spawnDetached(source: string): ChildProcess {
            // Так же, как демон в `up`: detached + unref — события выхода должны доходить и после этого.
            const child = spawn(process.execPath, ['-e', source], {
                detached: true,
                stdio: ['ignore', 'pipe', 'ignore'],
            });
            child.unref();
            spawned.push(child);
            return child;
        }

        /**
         * Ждём отметки из скрипта: сигнал, посланный до её появления, придёт ещё голому node
         * с обработчиками по умолчанию — и тест про SIGKILL проверял бы не то.
         */
        async function spawnReady(source: string): Promise<ChildProcess> {
            const child = spawnDetached(`${source}\nprocess.stdout.write('ready');`);
            await new Promise((resolve) => child.stdout?.once('data', resolve));
            return child;
        }

        it('снимает живой процесс по SIGTERM', async () => {
            const child = await spawnReady('setInterval(() => {}, 1000);');

            expect(await terminateChild(child, 300)).toBe(true);
            expect(child.signalCode).toBe('SIGTERM');
        });

        it('добивает SIGKILL процесс, который игнорирует SIGTERM', async () => {
            const child = await spawnReady("process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);");

            expect(await terminateChild(child, 300)).toBe(true);
            expect(child.signalCode).toBe('SIGKILL');
        });

        it('на уже завершившемся процессе ничего не делает', async () => {
            const child = spawnDetached('');
            await new Promise((resolve) => child.once('exit', resolve));

            expect(await terminateChild(child, 300)).toBe(true);
            expect(child.exitCode).toBe(0);
        });
    });
});

interface TestManifest {
    readonly port: number;
    readonly pid: number;
    readonly token: string;
    readonly uiHost?: string;
    /** Не часть манифеста: фейковый сервер кладёт сюда свой `--install-dir`, чтобы тест его увидел. */
    readonly installDir?: string;
    /** Так же — аргументы локального ревью, которыми CLI зовёт демона. */
    readonly repo?: string | null;
    readonly base?: string | null;
    readonly branch?: string | null;
    readonly verdicts?: string | null;
}

async function readManifest(sherpaDir: string): Promise<TestManifest> {
    const raw = await fs.readFile(manifestPathFor(sherpaDir, PR_KEY), 'utf8');
    return JSON.parse(raw) as TestManifest;
}

async function writeManifest(sherpaDir: string, parts: TestManifest): Promise<void> {
    await fs.writeFile(
        manifestPathFor(sherpaDir, PR_KEY),
        JSON.stringify({
            prKey: PR_KEY,
            ...parts,
            protocolVersion: '0.1.0',
            serverVersion: '0.1.0',
            createdAt: new Date().toISOString(),
        }),
    );
}

/** Демон переживает тест — снимаем его по PID из манифеста, иначе останется висеть на порту. */
async function killManifestServer(sherpaDir: string): Promise<void> {
    let manifest: TestManifest;
    try {
        manifest = await readManifest(sherpaDir);
    } catch {
        return;
    }
    try {
        process.kill(manifest.pid, 'SIGKILL');
    } catch {
        // Процесса уже нет — снимать нечего.
    }
}

/** PID гарантированно мёртвого процесса: поднимаем короткоживущий node и ждём, пока он исчезнет. */
async function deadPid(): Promise<number> {
    const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
    const pid = child.pid;
    if (pid === undefined) {
        throw new Error('не удалось запустить процесс для получения мёртвого PID');
    }
    await new Promise<void>((resolve) => {
        child.once('exit', () => {
            resolve();
        });
    });
    return pid;
}

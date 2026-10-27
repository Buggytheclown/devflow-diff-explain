import fs from 'node:fs/promises';
import os from 'node:os';

import { PROTOCOL_VERSION, rpcErrorSchema, serverManifestSchema } from '@sherpa/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ServerAlreadyRunningError } from './errors.js';
import { claimManifest, readManifest } from './manifest.js';
import { manifestPathFor } from './paths.js';
import type { SherpaServer } from './server.js';
import { startServer } from './server.js';
import { deadPid, get, makeTempSherpaDir, removeTempSherpaDir } from './test-support.js';
import { SERVER_VERSION } from './version.js';

const PR_KEY = 'arcanum-12345';

describe('startServer', () => {
    let sherpaDir: string;
    let servers: SherpaServer[];

    beforeEach(async () => {
        sherpaDir = await makeTempSherpaDir();
        servers = [];
    });

    afterEach(async () => {
        for (const server of servers) {
            await server.close();
        }
        await removeTempSherpaDir(sherpaDir);
    });

    async function start(prKey = PR_KEY, host?: string): Promise<SherpaServer> {
        // Живой Арканум в тестах запрещён (docs/testing.md): без хоста маршрут не прогревается,
        // и арканумный ключ этого набора остаётся просто ключом.
        const server = await startServer({
            prKey,
            sherpaDir,
            reviewSourceFactory: () => null,
            ...(host === undefined ? {} : { host }),
        });
        servers.push(server);
        return server;
    }

    describe('адрес прослушивания', () => {
        it('без адреса принимает только IPv4 loopback', async () => {
            const server = await start();

            expect((await get(server.port, '/healthz', server.token)).status).toBe(200);
            await expect(fetch(`http://[::1]:${String(server.port)}/healthz`)).rejects.toThrow();
        });

        it(':: принимает IPv6 и сохраняет IPv4 discovery и проверку токена', async () => {
            const server = await start(PR_KEY, '::');
            const url = `http://[::1]:${String(server.port)}/healthz`;

            expect((await fetch(url)).status).toBe(401);
            const response = await fetch(url, { headers: { authorization: `Bearer ${server.token}` } });
            expect(response.status).toBe(200);
            expect(await response.json()).toMatchObject({ ok: true, prKey: PR_KEY });
            expect((await get(server.port, '/healthz', server.token)).status).toBe(200);
            await expect(start()).rejects.toThrow(ServerAlreadyRunningError);
        });
    });

    describe('аутентификация', () => {
        it('без токена /healthz отвечает 401 в формате rpcError', async () => {
            const server = await start();

            const response = await get(server.port, '/healthz');
            expect(response.status).toBe(401);

            const body = rpcErrorSchema.parse(await response.json());
            expect(body.error.code).toBe('unauthorized');
        });

        it('с чужим токеном — тоже 401', async () => {
            const server = await start();

            const response = await get(server.port, '/healthz', 'a'.repeat(64));
            expect(response.status).toBe(401);
            expect(rpcErrorSchema.parse(await response.json()).error.code).toBe('unauthorized');
        });

        it('с токеном /healthz отвечает 200 и рассказывает о себе', async () => {
            const server = await start();

            const response = await get(server.port, '/healthz', server.token);
            expect(response.status).toBe(200);
            expect(await response.json()).toEqual({
                ok: true,
                prKey: PR_KEY,
                pid: process.pid,
                serverVersion: SERVER_VERSION,
                protocolVersion: PROTOCOL_VERSION,
            });
        });

        it('неизвестная ручка с токеном — 404 bad_request', async () => {
            const server = await start();

            const response = await get(server.port, '/нет-такой-ручки', server.token);
            expect(response.status).toBe(404);
            expect(rpcErrorSchema.parse(await response.json()).error.code).toBe('bad_request');
        });

        it('неизвестная ручка без токена — всё равно 401: аутентификация раньше маршрутизации', async () => {
            const server = await start();

            const response = await get(server.port, '/нет-такой-ручки');
            expect(response.status).toBe(401);
        });
    });

    describe('манифест discovery', () => {
        it('пишется по схеме протокола и с правами 0600', async () => {
            const server = await start();
            const manifestPath = manifestPathFor(sherpaDir, PR_KEY);

            const manifest = serverManifestSchema.parse(JSON.parse(await fs.readFile(manifestPath, 'utf8')));
            expect(manifest).toMatchObject({
                prKey: PR_KEY,
                port: server.port,
                uiHost: '127.0.0.1',
                pid: process.pid,
                token: server.token,
                protocolVersion: PROTOCOL_VERSION,
                serverVersion: SERVER_VERSION,
            });
            expect(server.uiHost).toBe('127.0.0.1');

            const stat = await fs.stat(manifestPath);
            expect(stat.mode & 0o777).toBe(0o600);
        });

        it('внешний слушатель кладёт в ссылку UI имя машины, а не адрес сокета', async () => {
            const server = await start(PR_KEY, '::');

            const manifest = await readManifest(manifestPathFor(sherpaDir, PR_KEY));
            // Ссылка `http://[::]:<порт>` никуда не ведёт — в манифесте должно лежать имя машины.
            expect(manifest).toMatchObject({ port: server.port, uiHost: os.hostname() });
            expect(server.uiHost).toBe(os.hostname());
        });

        it('каталоги стейта закрыты правами 0700', async () => {
            await start();

            for (const dir of [sherpaDir, `${sherpaDir}/servers`, `${sherpaDir}/prs/${PR_KEY}`]) {
                const stat = await fs.stat(dir);
                expect(stat.mode & 0o777, dir).toBe(0o700);
            }
        });

        it('манифест мёртвого сервера перезаписывается своим', async () => {
            const manifestPath = manifestPathFor(sherpaDir, PR_KEY);
            await fs.mkdir(`${sherpaDir}/servers`, { recursive: true });
            await claimManifest(manifestPath, {
                prKey: PR_KEY,
                port: 65000,
                pid: await deadPid(),
                token: 'протухший',
                protocolVersion: PROTOCOL_VERSION,
                serverVersion: SERVER_VERSION,
                createdAt: new Date().toISOString(),
            });

            const server = await start();

            const manifest = await readManifest(manifestPath);
            expect(manifest).toMatchObject({ pid: process.pid, port: server.port, token: server.token });
        });
    });

    describe('один сервер на PR', () => {
        it('второй startServer того же PR отбивается с данными живого', async () => {
            const first = await start();

            await expect(start()).rejects.toThrow(ServerAlreadyRunningError);

            const error = await startServer({ prKey: PR_KEY, sherpaDir, reviewSourceFactory: () => null }).catch(
                (caught: unknown) => caught,
            );
            expect(error).toBeInstanceOf(ServerAlreadyRunningError);
            expect(error).toMatchObject({ prKey: PR_KEY, port: first.port, pid: process.pid });
        });

        it('одновременный старт нескольких серверов оставляет ровно один', async () => {
            const results = await Promise.allSettled([
                startServer({ prKey: PR_KEY, sherpaDir, reviewSourceFactory: () => null }),
                startServer({ prKey: PR_KEY, sherpaDir, reviewSourceFactory: () => null }),
                startServer({ prKey: PR_KEY, sherpaDir, reviewSourceFactory: () => null }),
            ]);

            const started = results.flatMap((result) => (result.status === 'fulfilled' ? [result.value] : []));
            servers.push(...started);
            expect(started).toHaveLength(1);

            const winner = started[0];
            if (winner === undefined) {
                throw new Error('ни один сервер не поднялся');
            }

            const rejections = results.flatMap((result) =>
                result.status === 'rejected' ? [result.reason as unknown] : [],
            );
            for (const reason of rejections) {
                expect(reason).toBeInstanceOf(ServerAlreadyRunningError);
                expect(reason).toMatchObject({ prKey: PR_KEY, port: winner.port, pid: process.pid });
            }

            expect(await readManifest(manifestPathFor(sherpaDir, PR_KEY))).toMatchObject({
                port: winner.port,
                token: winner.token,
            });
            // Проигравшие не оставили за собой временных файлов заявки.
            expect(await fs.readdir(`${sherpaDir}/servers`)).toEqual([`${PR_KEY}.json`]);
        });

        it('другой PR поднимается рядом', async () => {
            const first = await start();
            const second = await start('arcanum-999');

            expect(second.port).not.toBe(first.port);
            expect(await readManifest(manifestPathFor(sherpaDir, 'arcanum-999'))).not.toBeNull();
        });
    });

    describe('close', () => {
        it('освобождает порт, удаляет манифест и переживает повторный вызов', async () => {
            const server = await start();
            const manifestPath = manifestPathFor(sherpaDir, PR_KEY);

            await server.close();
            await server.close();

            await expect(fs.stat(manifestPath)).rejects.toThrow();
            await expect(get(server.port, '/healthz', server.token)).rejects.toThrow();
        });
    });

    it('кривой ключ PR не даёт увести запись из каталога стейта', async () => {
        await expect(startServer({ prKey: '../побег', sherpaDir })).rejects.toThrow(/Некорректный ключ PR/);
    });
});

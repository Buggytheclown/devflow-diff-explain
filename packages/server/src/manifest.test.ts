import fs from 'node:fs/promises';
import path from 'node:path';

import type { ServerManifest } from '@sherpa/protocol';
import { PROTOCOL_VERSION } from '@sherpa/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
    claimManifest,
    cleanStaleManifests,
    isManifestServerAlive,
    isProcessAlive,
    readManifest,
    releaseStaleManifest,
    removeOwnManifest,
} from './manifest.js';
import { manifestPathFor, serversDirOf } from './paths.js';
import type { SherpaServer } from './server.js';
import { startServer } from './server.js';
import { deadPid, makeTempSherpaDir, removeTempSherpaDir } from './test-support.js';
import { SERVER_VERSION } from './version.js';

function manifestFor(overrides: Partial<ServerManifest> = {}): ServerManifest {
    return {
        prKey: 'arcanum-1',
        port: 65000,
        pid: process.pid,
        token: 'токен',
        protocolVersion: PROTOCOL_VERSION,
        serverVersion: SERVER_VERSION,
        createdAt: new Date().toISOString(),
        ...overrides,
    };
}

describe('манифест', () => {
    let sherpaDir: string;
    let serversDir: string;
    const servers: SherpaServer[] = [];

    beforeEach(async () => {
        sherpaDir = await makeTempSherpaDir();
        serversDir = serversDirOf(sherpaDir);
        await fs.mkdir(serversDir, { recursive: true });
    });

    afterEach(async () => {
        for (const server of servers.splice(0)) {
            await server.close();
        }
        await removeTempSherpaDir(sherpaDir);
    });

    it('запись атомарна: временных файлов после неё не остаётся', async () => {
        const target = manifestPathFor(sherpaDir, 'arcanum-1');
        const manifest = manifestFor();
        expect(await claimManifest(target, manifest)).toBe(true);

        expect(await fs.readdir(serversDir)).toEqual(['arcanum-1.json']);
        expect(await readManifest(target)).toEqual(manifest);
    });

    it('занятое место не перезаписывается: claimManifest отвечает false и не трогает содержимое', async () => {
        const target = manifestPathFor(sherpaDir, 'arcanum-1');
        const occupant = manifestFor({ port: 65010 });
        await claimManifest(target, occupant);

        expect(await claimManifest(target, manifestFor({ port: 65011 }))).toBe(false);
        expect(await readManifest(target)).toEqual(occupant);
        expect(await fs.readdir(serversDir)).toEqual(['arcanum-1.json']);
    });

    describe('releaseStaleManifest', () => {
        it('снимает протухший манифест, по которому принимали решение', async () => {
            const target = manifestPathFor(sherpaDir, 'arcanum-1');
            const stale = manifestFor({ pid: await deadPid() });
            await claimManifest(target, stale);

            await releaseStaleManifest(target, stale);

            expect(await fs.readdir(serversDir)).toEqual([]);
        });

        it('не снимает манифест, подменённый между проверкой и удалением', async () => {
            const target = manifestPathFor(sherpaDir, 'arcanum-1');
            const stale = manifestFor({ port: 65010, pid: await deadPid() });
            const fresh = manifestFor({ port: 65011 });
            await claimManifest(target, fresh);

            await releaseStaleManifest(target, stale);

            expect(await readManifest(target)).toEqual(fresh);
            expect(await fs.readdir(serversDir)).toEqual(['arcanum-1.json']);
        });

        it('на пустом месте ничего не делает', async () => {
            await releaseStaleManifest(manifestPathFor(sherpaDir, 'arcanum-1'), manifestFor());

            expect(await fs.readdir(serversDir)).toEqual([]);
        });
    });

    it('битый JSON и файл не по схеме читаются как отсутствующие', async () => {
        const broken = path.join(serversDir, 'broken.json');
        const wrongShape = path.join(serversDir, 'wrong.json');
        await fs.writeFile(broken, '{не json');
        await fs.writeFile(wrongShape, JSON.stringify({ prKey: 'arcanum-1', port: 0 }));

        expect(await readManifest(broken)).toBeNull();
        expect(await readManifest(wrongShape)).toBeNull();
        expect(await readManifest(path.join(serversDir, 'нет-такого.json'))).toBeNull();
    });

    it('removeOwnManifest не трогает манифест, перезаписанный чужим сервером', async () => {
        const target = manifestPathFor(sherpaDir, 'arcanum-1');
        const mine = manifestFor({ port: 65001 });
        await claimManifest(target, manifestFor({ port: 65002 }));

        await removeOwnManifest(target, mine);
        expect(await readManifest(target)).not.toBeNull();

        await fs.rm(target);
        await claimManifest(target, mine);
        await removeOwnManifest(target, mine);
        expect(await readManifest(target)).toBeNull();
    });

    describe('cleanStaleManifests', () => {
        it('сносит манифесты мёртвых процессов и мусор, живой оставляет', async () => {
            const live = await startServer({ prKey: 'arcanum-live', sherpaDir });
            servers.push(live);

            const stale = manifestPathFor(sherpaDir, 'arcanum-stale');
            await claimManifest(stale, manifestFor({ prKey: 'arcanum-stale', pid: await deadPid() }));
            const garbage = path.join(serversDir, 'garbage.json');
            await fs.writeFile(garbage, 'не манифест вовсе');
            const foreign = path.join(serversDir, 'readme.txt');
            await fs.writeFile(foreign, 'не .json — не наше дело');

            const removed = await cleanStaleManifests(serversDir);

            expect(removed.sort()).toEqual([garbage, stale].sort());
            expect(await fs.readdir(serversDir)).toEqual(expect.arrayContaining(['arcanum-live.json', 'readme.txt']));
            expect(await readManifest(manifestPathFor(sherpaDir, 'arcanum-live'))).not.toBeNull();
        });

        it('на отсутствующем каталоге не падает', async () => {
            expect(await cleanStaleManifests(path.join(sherpaDir, 'нет-каталога'))).toEqual([]);
        });
    });

    describe('живость сервера из манифеста', () => {
        it('живой сервер отвечает своим prKey', async () => {
            const live = await startServer({ prKey: 'arcanum-live', sherpaDir });
            servers.push(live);
            const manifest = await readManifest(manifestPathFor(sherpaDir, 'arcanum-live'));
            if (manifest === null) {
                throw new Error('живой сервер не записал манифест');
            }

            expect(await isManifestServerAlive(manifest)).toBe(true);
        });

        it('живой PID без сервера на порту — не жив', async () => {
            expect(await isManifestServerAlive(manifestFor({ pid: process.pid, port: 65123 }))).toBe(false);
        });

        it('мёртвый PID — не жив, до сети дело не доходит', async () => {
            const pid = await deadPid();

            expect(isProcessAlive(pid)).toBe(false);
            expect(await isManifestServerAlive(manifestFor({ pid }))).toBe(false);
        });
    });
});

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { RpcFailure } from './errors.js';
import {
    locateYa,
    resolveTrackerToken,
    trackerTokenAvailable,
    trackerTokenFromEnv,
    trackerTokenSource,
    YA_FETCH_TOKEN_ARGS,
} from './tracker-token.js';

describe('OAuth-токен Трекера', () => {
    it('берёт первую непустую переменную окружения по заданному приоритету', () => {
        expect(
            trackerTokenFromEnv({
                SHERPA_TRACKER_TOKEN: ' sherpa-token ',
                TRACKER_TOKEN: 'tracker-token',
                STARTREK_TOKEN: 'startrek-token',
            }),
        ).toBe('sherpa-token');
        expect(trackerTokenFromEnv({ TRACKER_TOKEN: ' tracker-token ' })).toBe('tracker-token');
        expect(trackerTokenFromEnv({ STARTREK_TOKEN: ' startrek-token ' })).toBe('startrek-token');
    });

    it('без токена и без ya возвращает null', async () => {
        expect(await resolveTrackerToken({ env: {} })).toBeNull();
        expect(await resolveTrackerToken({ env: {}, ya: null })).toBeNull();
        expect(trackerTokenAvailable({ env: {} })).toBe(false);
    });

    it('без токена в окружении добывает его через ya tool fetch-token', async () => {
        const runYa = vi.fn((_ya: string, _args: readonly string[]) => Promise.resolve('  ya-token\n'));

        expect(trackerTokenAvailable({ env: {}, ya: '/arcadia/ya' })).toBe(true);
        expect(await resolveTrackerToken({ env: {}, ya: '/arcadia/ya', runYa })).toBe('ya-token');
        expect(runYa).toHaveBeenCalledWith('/arcadia/ya', YA_FETCH_TOKEN_ARGS);
    });

    it('при токене в окружении ya не запускает', async () => {
        const runYa = vi.fn((_ya: string, _args: readonly string[]) => Promise.resolve('ya-token'));

        expect(await resolveTrackerToken({ env: { TRACKER_TOKEN: 'env-token' }, ya: '/arcadia/ya', runYa })).toBe(
            'env-token',
        );
        expect(runYa).not.toHaveBeenCalled();
    });

    it('провал ya — host_unavailable с причиной без stdout команды', async () => {
        const failing = trackerTokenSource({
            env: {},
            ya: '/arcadia/ya',
            runYa: () => Promise.reject(new Error('Command failed: ya tool fetch-token\nskotty: no ssh agent')),
        });
        const empty = trackerTokenSource({ env: {}, ya: '/arcadia/ya', runYa: () => Promise.resolve('\n') });
        const garbage = trackerTokenSource({
            env: {},
            ya: '/arcadia/ya',
            runYa: () => Promise.resolve('Downloading tool...\nsecret-token-value'),
        });

        const failure = await failing().catch((caught: unknown) => caught);
        expect(failure).toBeInstanceOf(RpcFailure);
        expect((failure as RpcFailure).code).toBe('host_unavailable');
        expect((failure as RpcFailure).message).toContain('ya tool fetch-token -preset startrek');
        expect((failure as RpcFailure).details?.[0]).toBe('Command failed: ya tool fetch-token skotty: no ssh agent');

        await expect(empty()).rejects.toMatchObject({ details: ['команда вернула пустой вывод'] });
        const garbageFailure = await garbage().catch((caught: unknown) => caught);
        expect(String(garbageFailure)).not.toContain('secret-token-value');
        expect((garbageFailure as RpcFailure).details?.[0]).toBe('вывод команды не похож на токен');
    });

    it('кэширует успех и повторяет резолв после исключения, не раскрывая значение токена', async () => {
        let reads = 0;
        const secret = 'secret-that-must-not-leak';
        const env = Object.defineProperty({}, 'SHERPA_TRACKER_TOKEN', {
            enumerable: true,
            get: () => {
                reads += 1;
                if (reads === 1) {
                    throw new Error(`broken ${secret}`);
                }
                return secret;
            },
        });
        const source = trackerTokenSource({ env });

        const error = await source().catch((caught: unknown) => caught);
        expect(String(error)).not.toContain(secret);
        expect(await source()).toBe(secret);
        expect(await source()).toBe(secret);
        expect(reads).toBe(2);
    });
});

describe('поиск ya', () => {
    const tempDirs: string[] = [];

    afterEach(async () => {
        for (const dir of tempDirs.splice(0)) {
            await fs.rm(dir, { recursive: true, force: true });
        }
    });

    async function makeTempDir(): Promise<string> {
        const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sherpa-ya-'));
        tempDirs.push(dir);
        return dir;
    }

    async function makeArcadiaRoot(root: string): Promise<string> {
        await fs.mkdir(root, { recursive: true });
        await fs.writeFile(path.join(root, '.arcadia.root'), '');
        const ya = path.join(root, 'ya');
        await fs.writeFile(ya, '#!/bin/sh\n', { mode: 0o755 });
        return ya;
    }

    it('берёт ya из PATH раньше чекаута', async () => {
        const dir = await makeTempDir();
        const bin = path.join(dir, 'bin');
        await fs.mkdir(bin);
        const fromPath = path.join(bin, 'ya');
        await fs.writeFile(fromPath, '#!/bin/sh\n', { mode: 0o755 });
        const root = path.join(dir, 'arcadia');
        await makeArcadiaRoot(root);

        expect(locateYa({ env: { PATH: `${path.join(dir, 'missing')}${path.delimiter}${bin}` }, startDirs: [root] })).toBe(
            fromPath,
        );
    });

    it('поднимается от стартового каталога к корню чекаута по маркеру .arcadia.root', async () => {
        const dir = await makeTempDir();
        const root = path.join(dir, 'arcadia');
        const ya = await makeArcadiaRoot(root);
        const nested = path.join(root, 'junk', 'alice', 'sherpa', 'skill');
        await fs.mkdir(nested, { recursive: true });

        expect(locateYa({ env: {}, startDirs: [path.join(dir, 'elsewhere'), nested] })).toBe(ya);
    });

    it('без PATH и чекаута возвращает null; неисполняемый ya не считается', async () => {
        const dir = await makeTempDir();
        const root = path.join(dir, 'arcadia');
        await fs.mkdir(root);
        await fs.writeFile(path.join(root, '.arcadia.root'), '');
        await fs.writeFile(path.join(root, 'ya'), '', { mode: 0o644 });

        expect(locateYa({ env: {}, startDirs: [root] })).toBeNull();
        expect(locateYa({ env: { PATH: root }, startDirs: [dir] })).toBeNull();
    });
});

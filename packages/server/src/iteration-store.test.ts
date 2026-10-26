import path from 'node:path';

import type { Iteration, PrDiff, ReviewHost } from '@sherpa/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SherpaDatabase } from './db.js';
import { openDatabase } from './db.js';
import { IterationStore, rememberIterationDiff } from './iteration-store.js';
import { makeTempSherpaDir, removeTempSherpaDir } from './test-support.js';

/**
 * Локальное хранилище патчей итераций и кэш срезов (docs/product.md §4a): после force-push хост
 * прошлую итерацию не отдаёт, а старый снапшот обязан остаться читаемым.
 */

function iterationOf(diffId: string, createdAt: string, status: Iteration['status'] = 'previous'): Iteration {
    return {
        diffId,
        baseCommit: `base-${diffId}`,
        headCommit: `head-${diffId}`,
        createdAt,
        status,
    };
}

function diffOf(diffId: string, paths: readonly string[] = []): PrDiff {
    return {
        diffId,
        baseCommit: `base-${diffId}`,
        headCommit: `head-${diffId}`,
        files: paths.map((filePath, index) => ({
            fileId: `${diffId}:${String(index)}`,
            path: filePath,
            oldPath: null,
            changeType: 'modify' as const,
            binary: false,
            generated: false,
            additions: 1,
            deletions: 0,
            patch: '@@ -1 +1,2 @@\n a\n+b\n',
            viewed: false,
            blameUrl: null,
            hostFileUrl: null,
            image: null,
        })),
    };
}

describe('хранилище итераций', () => {
    let sherpaDir: string;
    let file: string;
    const opened: SherpaDatabase[] = [];

    beforeEach(async () => {
        sherpaDir = await makeTempSherpaDir();
        file = path.join(sherpaDir, 'iterations.db');
    });

    afterEach(async () => {
        for (const db of opened.splice(0)) {
            db.close();
        }
        await removeTempSherpaDir(sherpaDir);
    });

    function open(): SherpaDatabase {
        const db = openDatabase(file);
        opened.push(db);
        return db;
    }

    it('upsert сохраняет патч и мету, get отдаёт их обратно', () => {
        const store = new IterationStore({ db: open() });
        const diff = diffOf('iter-1', ['src/index.ts']);

        store.upsert(diff, iterationOf('iter-1', '2026-09-01T10:00:00.000Z', 'active'));

        expect(store.get('iter-1')).toEqual({
            iteration: iterationOf('iter-1', '2026-09-01T10:00:00.000Z', 'active'),
            diff,
        });
        expect(store.get('iter-2')).toBeNull();
    });

    it('повторный upsert обновляет строку, list идёт по времени', () => {
        const store = new IterationStore({ db: open() });

        store.upsert(diffOf('iter-2'), iterationOf('iter-2', '2026-09-02T10:00:00.000Z', 'active'));
        store.upsert(diffOf('iter-1'), iterationOf('iter-1', '2026-09-01T10:00:00.000Z'));
        store.upsert(diffOf('iter-2', ['src/late.ts']), iterationOf('iter-2', '2026-09-02T10:00:00.000Z', 'active'));

        expect(store.list().map((iteration) => iteration.diffId)).toEqual(['iter-1', 'iter-2']);
        expect(store.get('iter-2')?.diff.files.map((diffFile) => diffFile.path)).toEqual(['src/late.ts']);
    });

    it('дифф и итерация обязаны быть одной итерацией', () => {
        const store = new IterationStore({ db: open() });

        expect(() => {
            store.upsert(diffOf('iter-1'), iterationOf('iter-2', '2026-09-01T10:00:00.000Z'));
        }).toThrow(/разные итерации/);
    });

    it('sync: статусы — от хоста, пропавшая из списка становится gone', () => {
        const store = new IterationStore({ db: open() });
        store.upsert(diffOf('iter-1'), iterationOf('iter-1', '2026-09-01T10:00:00.000Z', 'active'));
        store.upsert(diffOf('iter-2'), iterationOf('iter-2', '2026-09-02T10:00:00.000Z', 'active'));

        const merged = store.sync([
            iterationOf('iter-1', '2026-09-01T10:00:00.000Z'),
            iterationOf('iter-3', '2026-09-03T10:00:00.000Z', 'active'),
        ]);

        expect(merged.map((iteration) => [iteration.diffId, iteration.status])).toEqual([
            ['iter-1', 'previous'],
            ['iter-2', 'gone'],
            ['iter-3', 'active'],
        ]);
        // Статус перечисленной берётся у хоста, `gone` остаётся у сохранённой и не перечисленной.
        expect(store.list().map((iteration) => [iteration.diffId, iteration.status])).toEqual([
            ['iter-1', 'previous'],
            ['iter-2', 'gone'],
        ]);
        // Патч ушедшей итерации никуда не делся — по нему читается её снапшот.
        expect(store.get('iter-2')?.diff.diffId).toBe('iter-2');
    });

    it('sync без сохранённых итераций отдаёт список хоста как есть', () => {
        const store = new IterationStore({ db: open() });

        const merged = store.sync([iterationOf('iter-1', '2026-09-01T10:00:00.000Z', 'active')]);

        expect(merged).toEqual([iterationOf('iter-1', '2026-09-01T10:00:00.000Z', 'active')]);
        expect(store.list()).toEqual([]);
    });

    it('getInterdiff считает срез один раз и дальше отдаёт из кэша', async () => {
        const store = new IterationStore({ db: open() });
        const slice = diffOf('iter-2', ['src/changed.ts']);
        const load = vi.fn(() => Promise.resolve(slice));

        const first = await store.getInterdiff('iter-1', 'iter-2', load);
        const second = await store.getInterdiff('iter-1', 'iter-2', load);

        expect(first).toEqual(slice);
        expect(second).toEqual(slice);
        expect(load).toHaveBeenCalledTimes(1);
        // Ключ кэша — пара: другая пара считается заново.
        await store.getInterdiff('iter-2', 'iter-3', () => Promise.resolve(diffOf('iter-3')));
        expect(load).toHaveBeenCalledTimes(1);
    });

    it('повреждённая строка не роняет чтение: предупреждение и пропуск', () => {
        const db = open();
        const store = new IterationStore({ db });
        store.upsert(diffOf('iter-1'), iterationOf('iter-1', '2026-09-01T10:00:00.000Z', 'active'));
        db.prepare("UPDATE iterations SET diff_json = 'не json' WHERE diff_id = 'iter-1'").run();

        const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
        try {
            expect(store.get('iter-1')).toBeNull();
            expect(store.list()).toEqual([]);
            expect(stderr.mock.calls.some((call) => String(call[0]).includes('повреждена'))).toBe(true);
        } finally {
            stderr.mockRestore();
        }
    });

    it('rememberIterationDiff кладёт активную итерацию и молчит на чужом диффе', async () => {
        const store = new IterationStore({ db: open() });
        const active = iterationOf('iter-1', '2026-09-01T10:00:00.000Z', 'active');
        const host = { listIterations: () => Promise.resolve([active]) } as unknown as ReviewHost;

        await rememberIterationDiff(store, host, diffOf('iter-1', ['src/index.ts']));
        expect(store.get('iter-1')?.iteration).toEqual(active);

        const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
        try {
            // Пока грузился дифф, автор запушил: хост эту итерацию уже не называет.
            await rememberIterationDiff(store, host, diffOf('iter-9'));
            expect(store.get('iter-9')).toBeNull();
            expect(stderr.mock.calls.some((call) => String(call[0]).includes('iter-9'))).toBe(true);
        } finally {
            stderr.mockRestore();
        }
    });

    it('падение хоста запись не роняет — ошибка уходит в stderr', async () => {
        const store = new IterationStore({ db: open() });
        const host = { listIterations: () => Promise.reject(new Error('хост прилёг')) } as unknown as ReviewHost;

        const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
        try {
            await expect(rememberIterationDiff(store, host, diffOf('iter-1'))).resolves.toBeUndefined();
            expect(stderr.mock.calls.some((call) => String(call[0]).includes('хост прилёг'))).toBe(true);
        } finally {
            stderr.mockRestore();
        }
    });
});

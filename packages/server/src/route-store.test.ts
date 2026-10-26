import path from 'node:path';

import type { PrDiff, RouteStop } from '@sherpa/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SherpaDatabase } from './db.js';
import { openDatabase } from './db.js';
import type { AcceptedSkeletonInput } from './route-store.js';
import { RouteStore } from './route-store.js';
import type { AcceptedSkeleton } from './route/index.js';
import { makeTempSherpaDir, removeTempSherpaDir } from './test-support.js';

/**
 * История снапшотов маршрута: `route_snapshots` копит все генерации, `route_state`
 * помнит только текущую. Плюс совместимость с накопленной БД — снапшот прежней версии.
 */

function stop(planIndex: number): RouteStop {
    return {
        id: `stop-${String(planIndex)}`,
        planIndex,
        tier: 'high',
        title: `Стоп ${String(planIndex)}`,
        status: 'queued',
        paragraph: null,
        bridge: null,
        anchors: [],
        tests: [],
        droppedClaims: 0,
        validationNotes: [],
        provenance: null,
        change: null,
    };
}

function skeleton(): AcceptedSkeleton {
    return {
        summary: 'PR про колонки',
        stops: [stop(1)],
        tourOrder: ['stop-1'],
        intents: new Map([[1, 'проверить подсчёт']]),
    };
}

function diffOf(diffId: string, headCommit: string): PrDiff {
    return { diffId, baseCommit: 'base-commit', headCommit, files: [] };
}

function accepted(snapshotId: string, previousSnapshotId: string | null, diffId: string): AcceptedSkeletonInput {
    return {
        skeleton: skeleton(),
        diff: diffOf(diffId, `head-${diffId}`),
        provenance: { harness: 'claude-code', model: 'opus', locale: null },
        snapshotId,
        previousSnapshotId,
    };
}

describe('хранилище маршрута: история снапшотов', () => {
    let sherpaDir: string;
    let file: string;
    const opened: SherpaDatabase[] = [];

    beforeEach(async () => {
        sherpaDir = await makeTempSherpaDir();
        file = path.join(sherpaDir, 'route.db');
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

    it('две генерации — два снапшота, текущий второй, previousSnapshotId записан', () => {
        const store = new RouteStore({ db: open() });

        store.acceptSkeleton(accepted('snap-1', null, 'iter-1'));
        store.markReady();
        store.acceptSkeleton(accepted('snap-2', 'snap-1', 'iter-2'));

        expect(store.listSnapshots().map((snapshot) => snapshot.snapshotId)).toEqual(['snap-1', 'snap-2']);
        expect(store.current()?.snapshotId).toBe('snap-2');
        expect(store.current()?.previousSnapshotId).toBe('snap-1');
        expect(store.getSnapshot('snap-1')?.previousSnapshotId).toBeNull();
        // Готовый снапшот прошлой генерации остался готовым: его контент-хеш не потёрся.
        expect(store.getSnapshot('snap-1')?.contentHash).not.toBeNull();
        expect(store.getSnapshot('нет такого')).toBeNull();
    });

    it('заполнение правит строку текущего снапшота, а не плодит новые', () => {
        const store = new RouteStore({ db: open() });

        store.acceptSkeleton(accepted('snap-1', null, 'iter-1'));
        store.setStopStatuses(new Map([[1, { status: 'ready' }]]));
        store.markReady();

        expect(store.listSnapshots()).toHaveLength(1);
        expect(store.getSnapshot('snap-1')?.stops[0]?.status).toBe('ready');
        expect(store.getSnapshot('snap-1')?.contentHash).toBe(store.current()?.contentHash);
    });

    it('reset и cancelSkeleton истории не трогают', () => {
        const store = new RouteStore({ db: open() });

        store.acceptSkeleton(accepted('snap-1', null, 'iter-1'));
        store.markReady();
        store.reset();

        expect(store.current()).toBeNull();
        expect(store.read().snapshot).toBeNull();
        expect(store.listSnapshots().map((snapshot) => snapshot.snapshotId)).toEqual(['snap-1']);
    });

    it('текущий снапшот переживает переоткрытие БД', () => {
        const first = new RouteStore({ db: open() });
        first.acceptSkeleton(accepted('snap-1', null, 'iter-1'));
        first.acceptSkeleton(accepted('snap-2', 'snap-1', 'iter-2'));
        first.markReady();

        const restored = new RouteStore({ db: open() });

        expect(restored.read().phase).toBe('ready');
        expect(restored.current()?.snapshotId).toBe('snap-2');
        expect(restored.listSnapshots()).toHaveLength(2);
    });

    /** Прежняя форма снапшота: ни `baseCommit`, ни `previousSnapshotId`/`carried`, ни `change` у стопов. */
    function legacySnapshotJson(diffId: string): string {
        return JSON.stringify({
            snapshotId: 'snap-legacy',
            commit: 'head-legacy',
            diffId,
            createdAt: '2026-08-25T10:00:00.000Z',
            provenance: { harness: 'claude-code', model: 'opus', locale: null },
            summary: 'маршрут, построенный до итераций',
            stops: [
                {
                    id: 'stop-1',
                    planIndex: 1,
                    tier: 'high',
                    title: 'Стоп 1',
                    status: 'ready',
                    paragraph: 'абзац',
                    bridge: null,
                    anchors: [],
                    tests: [],
                    droppedClaims: 0,
                    validationNotes: [],
                    provenance: null,
                },
            ],
            tourOrder: ['stop-1'],
            contentHash: 'abcdef123456',
        });
    }

    function insertLegacySnapshot(db: SherpaDatabase, diffId: string, json = legacySnapshotJson(diffId)): void {
        db.prepare(
            `INSERT INTO route_snapshots (snapshot_id, diff_id, created_at, previous_snapshot_id, snapshot_json, content_hash)
             VALUES (?, ?, ?, NULL, ?, ?)`,
        ).run('snap-legacy', diffId, '2026-08-25T10:00:00.000Z', json, 'abcdef123456');
        db.prepare(
            `INSERT INTO route_state (id, phase, small_pr, current_snapshot_id, intents, updated_at)
             VALUES (1, 'ready', 0, 'snap-legacy', '[]', '2026-08-25T10:00:00.000Z')`,
        ).run();
    }

    it('снапшот прежней версии читается: baseCommit из сохранённой итерации, остальное — по умолчанию', () => {
        const db = open();
        db.prepare(
            `INSERT INTO iterations (diff_id, base_commit, head_commit, created_at, status, diff_json, fetched_at)
             VALUES ('iter-legacy', 'base-of-iter', 'head-legacy', '2026-08-25T09:00:00.000Z', 'active', '{}', '2026-08-25T09:00:00.000Z')`,
        ).run();
        insertLegacySnapshot(db, 'iter-legacy');

        const store = new RouteStore({ db });
        const snapshot = store.current();

        expect(store.read().phase).toBe('ready');
        expect(snapshot?.baseCommit).toBe('base-of-iter');
        expect(snapshot?.previousSnapshotId).toBeNull();
        expect(snapshot?.carried).toBeNull();
        expect(snapshot?.stops[0]?.change).toBeNull();
    });

    it('carried без причины нулевого переноса читается: причина по умолчанию — null', () => {
        const db = open();
        db.prepare(
            `INSERT INTO iterations (diff_id, base_commit, head_commit, created_at, status, diff_json, fetched_at)
             VALUES ('iter-legacy', 'base-of-iter', 'head-legacy', '2026-08-25T09:00:00.000Z', 'active', '{}', '2026-08-25T09:00:00.000Z')`,
        ).run();
        // Прежняя форма `carried`: только числа переноса.
        insertLegacySnapshot(
            db,
            'iter-legacy',
            JSON.stringify({
                ...(JSON.parse(legacySnapshotJson('iter-legacy')) as Record<string, unknown>),
                carried: { kept: 2, total: 5 },
            }),
        );

        expect(new RouteStore({ db }).current()?.carried).toEqual({ kept: 2, total: 5, zeroReason: null });
    });

    // Значения по умолчанию — только для полей, добавленных позже: подстановка на месте `stops` превратила бы
    // повреждённую строку в пустой валидный маршрут.
    it('повреждённый снапшот отбраковывается схемой, а не добивается пустым списком стопов', () => {
        const db = open();
        const broken = JSON.stringify({
            ...(JSON.parse(legacySnapshotJson('iter-legacy')) as Record<string, unknown>),
            stops: 'мусор',
        });
        db.prepare(
            `INSERT INTO route_snapshots (snapshot_id, diff_id, created_at, previous_snapshot_id, snapshot_json, content_hash)
             VALUES ('snap-broken', 'iter-legacy', '2026-08-25T10:00:00.000Z', NULL, ?, 'abcdef123456')`,
        ).run(broken);
        db.prepare(
            `INSERT INTO route_state (id, phase, small_pr, current_snapshot_id, intents, updated_at)
             VALUES (1, 'ready', 0, 'snap-broken', '[]', '2026-08-25T10:00:00.000Z')`,
        ).run();

        const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
        try {
            const store = new RouteStore({ db });

            expect(store.getSnapshot('snap-broken')).toBeNull();
            expect(store.read().phase).toBe('none');
            expect(stderr.mock.calls.some((call) => String(call[0]).includes('snap-broken'))).toBe(true);
        } finally {
            stderr.mockRestore();
        }
    });

    it('кап генерации живёт в meta по снапшоту и переживает переоткрытие БД', () => {
        const cap = { filesCovered: 120, filesTotal: 500, machineFiles: 380, truncated: false };
        const store = new RouteStore({ db: open() });
        store.acceptSkeleton(accepted('snap-1', null, 'iter-1'));

        expect(store.currentGenerationCap()).toBeNull();
        store.setGenerationCap('snap-1', cap);
        expect(store.currentGenerationCap()).toEqual(cap);

        const reopened = new RouteStore({ db: open() });
        expect(reopened.currentGenerationCap()).toEqual(cap);
        expect(reopened.generationCap('нет такого')).toBeNull();
    });

    it('язык генерации живёт в meta и переживает переоткрытие БД', () => {
        const store = new RouteStore({ db: open() });

        expect(store.generationLocale()).toBeNull();
        store.setGenerationLocale('en');
        expect(store.generationLocale()).toBe('en');

        expect(new RouteStore({ db: open() }).generationLocale()).toBe('en');
    });

    it('повреждённая запись языка генерации читается как «записи нет»', () => {
        const db = open();
        const store = new RouteStore({ db });
        db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run('generation_locale', 'de');

        expect(store.generationLocale()).toBeNull();
    });

    it('повреждённая запись капа читается как «записи нет»', () => {
        const db = open();
        const store = new RouteStore({ db });
        store.acceptSkeleton(accepted('snap-1', null, 'iter-1'));
        db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run('generation_cap:snap-1', '{не json');

        expect(store.currentGenerationCap()).toBeNull();
    });

    it('снапшот прежней версии без сохранённой итерации: база честно неизвестна', () => {
        const db = open();
        insertLegacySnapshot(db, 'iter-forgotten');

        expect(new RouteStore({ db }).current()?.baseCommit).toBe('unknown');
    });
});

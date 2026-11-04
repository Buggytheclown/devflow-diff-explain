import path from 'node:path';

import type { PrDiff, RouteStop } from '@sherpa/protocol';
import { chatExplanationSchema, explanationText } from '@sherpa/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SherpaDatabase } from './db.js';
import { openDatabase } from './db.js';
import type { AcceptedSkeletonInput } from './route-store.js';
import { RouteStore } from './route-store.js';
import type { AcceptedSkeleton } from './route/index.js';
import { makeTempSherpaDir, removeTempSherpaDir } from './test-support.js';
import { architectureStoryFixture } from '@sherpa/fixtures';
import { validateArchitectureOverview } from './architecture-story.js';

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

    it('редакция разбора меняется при публикации текста, но не от служебного статуса', () => {
        const db = open();
        const store = new RouteStore({ db });
        store.acceptSkeleton(accepted('snap-revision', null, 'iter-1'));
        expect(store.current()?.reviewRevision).toBe(1);
        store.setStopStatuses(new Map([[1, { status: 'filling' }]]));
        expect(store.current()?.reviewRevision).toBe(1);
        expect(db.prepare('SELECT COUNT(*) AS count FROM review_revisions WHERE review_id = ?').get('snap-revision')?.count).toBe(1);

        store.applyFillings([{ planIndex: 1, paragraph: 'Опубликованный абзац', bridge: null, anchors: [], tests: [],
            droppedClaims: 0, validationNotes: [], change: null }], { harness: 'claude-code', model: 'opus', locale: null });
        expect(store.current()?.reviewRevision).toBe(2);
        expect(store.getReviewRevision('snap-revision', 1)?.stops[0]?.paragraph).toBeNull();
        expect(store.getReviewRevision('snap-revision', 2)?.stops[0]?.paragraph).toBe('Опубликованный абзац');
        expect(new RouteStore({ db: open() }).getReviewRevision('snap-revision', 1)?.stops[0]?.paragraph).toBeNull();
    });

    it('изменение видимых связей блока создаёт новую редакцию', () => {
        const fixture = architectureStoryFixture();
        const checked = validateArchitectureOverview(JSON.stringify(fixture.outline), fixture.diff);
        if (!checked.ok) throw new Error(checked.errors.join('\n'));
        const store = new RouteStore({ db: open() });
        store.acceptSkeleton({ ...accepted('links', null, fixture.diff.diffId), skeleton: checked.value,
            diff: fixture.diff, presentation: 'story' });
        const before = store.current();
        if (before === null) throw new Error('Expected review');
        const first = before.stops[0];
        if (first === undefined) throw new Error('Expected block');
        const link = { fileId: 'new-related-file', path: 'src/new.ts' };
        store.refineOverview({ ...checked.value, stops: [
            { ...first, relatedFiles: [link] }, ...before.stops.slice(1),
        ] });
        expect(store.current()?.reviewRevision).toBe(2);
        expect(store.getReviewRevision('links', 1)?.stops[0]?.relatedFiles).not.toEqual([link]);
    });

    it('редакция большого обзора восстанавливается без прежнего предела 40 000 символов', () => {
        const fixture = architectureStoryFixture();
        const checked = validateArchitectureOverview(JSON.stringify(fixture.outline), fixture.diff);
        if (!checked.ok) throw new Error(checked.errors.join('\n'));
        const store = new RouteStore({ db: open() });
        store.acceptSkeleton({ ...accepted('large', null, fixture.diff.diffId),
            skeleton: { ...checked.value, summary: 'Большой обзор '.repeat(3500) }, diff: fixture.diff, presentation: 'story' });
        const restored = store.getReviewRevision('large', 1);
        if (restored === null) throw new Error('Expected saved revision');
        const text = explanationText(restored);
        expect(text.length).toBeGreaterThan(40_000);
        expect(chatExplanationSchema.parse({ snapshotId: 'large', diffId: restored.diffId,
            commit: restored.commit, text }).text).toBe(text);
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

    it('у v6 урезание необязательного общего файла не означает потерю отдельных патчей', () => {
        const fixture = architectureStoryFixture();
        const checked = validateArchitectureOverview(JSON.stringify(fixture.outline), fixture.diff);
        if (!checked.ok) throw new Error(checked.errors.join('\n'));
        const store = new RouteStore({ db: open() });
        store.acceptSkeleton({ ...accepted('native', null, fixture.diff.diffId), skeleton: checked.value, diff: fixture.diff, presentation: 'story' });
        store.setGenerationCap('native', { filesCovered: 0, filesTotal: fixture.diff.files.length, machineFiles: 0, truncated: true });
        expect(store.currentGenerationCap()).toBeNull();
        expect(new RouteStore({ db: open() }).currentGenerationCap()).toBeNull();
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

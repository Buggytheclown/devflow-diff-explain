import path from 'node:path';

import type { FileDiff, PrDiff, RouteAnchor } from '@sherpa/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { SherpaDatabase } from './db.js';
import { openDatabase } from './db.js';
import type { StoredIteration } from './iteration-store.js';
import type { IterationMap } from './iterations/index.js';
import { buildIterationMap, identityMap } from './iterations/index.js';
import { ProgressStore } from './progress-store.js';
import { makeTempSherpaDir, removeTempSherpaDir } from './test-support.js';

/**
 * Прогресс чтения в измерении итерации: персист явных отметок, перенос диапазонов
 * и файловых отметок на новую итерацию, отметки остановок нового снапшота.
 */

const V1 = 'iter-1';
const V2 = 'iter-2';
const BASE = 'base-a1b2c3';
const CLOCK = 'services/orders/src/infra/clock.ts';
const ORDER = 'services/orders/src/domain/order.ts';
const HEADERS = ['--- a/x.ts', '+++ b/x.ts'];

/** Правка строк 12–13 файла `CLOCK` в интердиффе: одна удалена, две добавлены (дельта +1). */
const CLOCK_PATCH = [
    ...HEADERS,
    '@@ -10,6 +10,7 @@',
    ' ctx10',
    ' ctx11',
    '-del12',
    '+add12',
    '+add13',
    ' ctx13',
    ' ctx14',
    ' ctx15',
].join('\n');

/** Патч итерации: строки 1–5 добавлены — их и «просматривает» ревьюер в тестах. */
const ADDED_LINES = [...HEADERS, '@@ -1,0 +1,5 @@', '+one', '+two', '+three', '+four', '+five'].join('\n');

describe('хранилище прогресса чтения', () => {
    let sherpaDir: string;
    let file: string;
    const opened: SherpaDatabase[] = [];

    beforeEach(async () => {
        sherpaDir = await makeTempSherpaDir();
        file = path.join(sherpaDir, 'progress.db');
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

    function insertRange(db: SherpaDatabase, diffId: string, fileId: string, start: number, end: number): void {
        db.prepare(
            `INSERT INTO file_seen_ranges (diff_id, file_id, side, start_line, end_line)
             VALUES (?, ?, 'new', ?, ?)`,
        ).run(diffId, fileId, start, end);
    }

    /** Снапшот маршрута этой итерации: его якоря — карта путей для переноса без патча. */
    function insertSnapshot(
        db: SherpaDatabase,
        diffId: string,
        anchors: readonly { fileId: string; path: string }[],
        createdAt = '2026-09-01T10:00:00.000Z',
    ): void {
        const snapshot = {
            snapshotId: `snap-${diffId}`,
            diffId,
            createdAt,
            stops: [{ id: 's01', anchors: anchors.map((a) => ({ ...a, side: 'new', start: 1, end: 5 })) }],
        };
        db.prepare(
            `INSERT INTO route_snapshots (snapshot_id, diff_id, created_at, snapshot_json)
             VALUES (?, ?, ?, ?)`,
        ).run(snapshot.snapshotId, diffId, createdAt, JSON.stringify(snapshot));
    }

    /**
     * Заметка чата с якорем: `anchor` — где она лежит сейчас, `origin` — где её создали.
     * Перенос заметок переписывает первый и не трогает второй.
     */
    function insertNote(
        db: SherpaDatabase,
        anchor: { diffId: string; fileId: string; path: string },
        origin: { diffId: string; fileId: string; path: string } = anchor,
    ): void {
        const at = '2026-09-01T10:00:00.000Z';
        const exchange = db
            .prepare(
                `INSERT INTO chat_exchanges (question, anchor, status, answer, created_at, updated_at)
                 VALUES ('вопрос', ?, 'done', 'ответ', ?, ?)`,
            )
            .run(JSON.stringify(origin), at, at);
        db.prepare(
            `INSERT INTO agent_notes (
                exchange_id, anchor, text, commit_hash, lost_anchor, origin_anchor, origin_commit, created_at
             ) VALUES (?, ?, 'ответ', NULL, 0, ?, NULL, ?)`,
        ).run(exchange.lastInsertRowid, JSON.stringify(anchor), JSON.stringify(origin), at);
    }

    /** Пути, которыми подписаны диапазоны итерации; NULL становится пустой строкой. */
    function pathsOfRanges(db: SherpaDatabase, diffId: string): string[] {
        const rows = db
            .prepare('SELECT path FROM file_seen_ranges WHERE diff_id = ? ORDER BY rowid')
            .all(diffId) as { path: string | null }[];
        return rows.map((row) => row.path ?? '');
    }

    it('пустое хранилище: ни одной записи, ревизия ноль', () => {
        const store = new ProgressStore({ db: open() });

        expect(store.read(V1)).toEqual([]);
        expect(store.revision).toBe(0);
    });

    it('отметка пишется, снимается и переживает переоткрытие БД', () => {
        const store = new ProgressStore({ db: open() });

        store.setFileViewed(V1, 'file-1', true);
        store.setFileViewed(V1, 'file-2', false);

        expect(store.read(V1)).toEqual([
            { fileId: 'file-1', viewed: true, seenRanges: [] },
            { fileId: 'file-2', viewed: false, seenRanges: [] },
        ]);

        // Новый процесс сервера: ревизия начинается заново, а записи никуда не делись.
        const restarted = new ProgressStore({ db: open() });
        expect(restarted.read(V1)).toEqual([
            { fileId: 'file-1', viewed: true, seenRanges: [] },
            { fileId: 'file-2', viewed: false, seenRanges: [] },
        ]);
        expect(restarted.revision).toBe(0);
    });

    it('прогресс одной итерации не видно из другой', () => {
        const store = new ProgressStore({ db: open() });

        store.setFileViewed(V1, 'file-1', true);
        insertRange(open(), V1, 'file-9', 1, 2);

        expect(store.read(V2)).toEqual([]);
        expect(store.read(V1)).toHaveLength(2);
    });

    it('повторная отметка перезаписывает значение, а не плодит строки', () => {
        const store = new ProgressStore({ db: open() });

        store.setFileViewed(V1, 'file-1', true);
        store.setFileViewed(V1, 'file-1', false);

        expect(store.read(V1)).toEqual([{ fileId: 'file-1', viewed: false, seenRanges: [] }]);
    });

    it('ревизия растёт на каждое изменение и стоит на месте при идемпотентной записи', () => {
        const store = new ProgressStore({ db: open() });

        expect(store.setFileViewed(V1, 'file-1', true)).toBe(1);
        expect(store.setFileViewed(V1, 'file-1', false)).toBe(2);
        // Ничего не изменилось — будить остальные вкладки нечем.
        expect(store.setFileViewed(V1, 'file-1', false)).toBe(2);
        expect(store.revision).toBe(2);
    });

    it('подписчик узнаёт новую ревизию и отписывается', () => {
        const store = new ProgressStore({ db: open() });
        const seen: number[] = [];
        const stop = store.subscribe((revision) => {
            seen.push(revision);
        });

        store.setFileViewed(V1, 'file-1', true);
        store.setFileViewed(V1, 'file-1', true);
        store.setFileViewed(V1, 'file-2', true);
        stop();
        store.setFileViewed(V1, 'file-3', true);

        expect(seen).toEqual([1, 2]);
    });

    it('seen-диапазоны читаются вместе с отметками; файл с одними диапазонами — без пина', () => {
        const db = open();
        insertRange(db, V1, 'file-1', 10, 20);
        db.prepare(
            `INSERT INTO file_seen_ranges (diff_id, file_id, side, start_line, end_line)
             VALUES (?, ?, 'old', ?, ?)`,
        ).run(V1, 'file-2', 1, 3);
        const store = new ProgressStore({ db });
        store.setFileViewed(V1, 'file-1', true);

        expect(store.read(V1)).toEqual([
            { fileId: 'file-1', viewed: true, seenRanges: [{ side: 'new', start: 10, end: 20 }] },
            { fileId: 'file-2', viewed: null, seenRanges: [{ side: 'old', start: 1, end: 3 }] },
        ]);
    });

    it('отметка остановки кладёт её диапазоны и переживает переоткрытие БД', () => {
        const store = new ProgressStore({ db: open() });

        expect(
            store.setStopViewed('snap-1', V1, 's01', true, [
                { fileId: 'file-1', side: 'new', start: 10, end: 14 },
                { fileId: 'file-2', side: 'old', start: 3, end: 3 },
            ]),
        ).toBe(1);

        const restarted = new ProgressStore({ db: open() });
        expect(restarted.readStops('snap-1')).toEqual([{ stopId: 's01', viewed: true }]);
        // Отметки другого снапшота — это отметки другого маршрута.
        expect(restarted.readStops('snap-2')).toEqual([]);
        expect(restarted.read(V1)).toEqual([
            { fileId: 'file-1', viewed: null, seenRanges: [{ side: 'new', start: 10, end: 14 }] },
            { fileId: 'file-2', viewed: null, seenRanges: [{ side: 'old', start: 3, end: 3 }] },
        ]);
    });

    it('повторная отметка тем же набором диапазонов ревизию не двигает', () => {
        const store = new ProgressStore({ db: open() });
        const ranges = [
            { fileId: 'file-1', side: 'new' as const, start: 10, end: 14 },
            { fileId: 'file-1', side: 'old' as const, start: 2, end: 4 },
        ];

        expect(store.setStopViewed('snap-1', V1, 's01', true, ranges)).toBe(1);
        // Порядок и дубли в запросе — не изменение хранилища.
        expect(store.setStopViewed('snap-1', V1, 's01', true, [...ranges].reverse())).toBe(1);
        expect(store.setStopViewed('snap-1', V1, 's01', true, [...ranges, ...ranges])).toBe(1);
        // А другой набор — изменение.
        expect(store.setStopViewed('snap-1', V1, 's01', true, ranges.slice(0, 1))).toBe(2);
    });

    it('снятие отметки удаляет диапазоны только своей остановки', () => {
        const store = new ProgressStore({ db: open() });
        store.setStopViewed('snap-1', V1, 's01', true, [{ fileId: 'file-1', side: 'new', start: 10, end: 14 }]);
        store.setStopViewed('snap-1', V1, 's02', true, [{ fileId: 'file-1', side: 'new', start: 40, end: 41 }]);
        store.setFileViewed(V1, 'file-1', true, 'snap-1');

        store.setStopViewed('snap-1', V1, 's01', false, []);

        expect(store.readStops('snap-1')).toEqual([
            { stopId: 's01', viewed: false },
            { stopId: 's02', viewed: true },
        ]);
        // Ручная отметка файла и диапазоны соседней остановки на месте.
        expect(store.read(V1)).toEqual([
            { fileId: 'file-1', viewed: true, seenRanges: [{ side: 'new', start: 40, end: 41 }] },
        ]);
    });

    describe('отметка файла внутри остановки', () => {
        it('пишет диапазоны карточки без пина файла и без отметки остановки', () => {
            const store = new ProgressStore({ db: open() });

            expect(
                store.setStopFileViewed('snap-1', V1, 's01', 'file-1', true, [
                    { side: 'new', start: 10, end: 14 },
                    { side: 'old', start: 2, end: 3 },
                ]),
            ).toBe(1);

            expect(store.read(V1)).toEqual([
                {
                    fileId: 'file-1',
                    viewed: null,
                    seenRanges: expect.arrayContaining([
                        { side: 'new', start: 10, end: 14 },
                        { side: 'old', start: 2, end: 3 },
                    ]) as unknown,
                },
            ]);
            expect(store.readStops('snap-1')).toEqual([]);
        });

        it('тот же набор диапазонов ревизию не двигает', () => {
            const store = new ProgressStore({ db: open() });
            const ranges = [
                { side: 'new' as const, start: 10, end: 14 },
                { side: 'old' as const, start: 2, end: 3 },
            ];

            expect(store.setStopFileViewed('snap-1', V1, 's01', 'file-1', true, ranges)).toBe(1);
            expect(store.setStopFileViewed('snap-1', V1, 's01', 'file-1', true, [...ranges].reverse())).toBe(1);
            expect(store.setStopFileViewed('snap-1', V1, 's01', 'file-1', true, [...ranges, ...ranges])).toBe(1);
            expect(store.setStopFileViewed('snap-1', V1, 's01', 'file-1', true, ranges.slice(0, 1))).toBe(2);
            expect(store.read(V1)).toEqual([
                { fileId: 'file-1', viewed: null, seenRanges: [{ side: 'new', start: 10, end: 14 }] },
            ]);
        });

        it('снятие удаляет только диапазоны этой остановки по этому файлу и снимает её отметку', () => {
            const store = new ProgressStore({ db: open() });
            store.setStopViewed('snap-1', V1, 's01', true, [
                { fileId: 'file-1', side: 'new', start: 10, end: 14 },
                { fileId: 'file-2', side: 'new', start: 1, end: 2 },
            ]);
            store.setStopFileViewed('snap-1', V1, 's02', 'file-1', true, [{ side: 'new', start: 40, end: 41 }]);
            const before = store.revision;

            expect(store.setStopFileViewed('snap-1', V1, 's01', 'file-1', false, [])).toBe(before + 1);

            expect(store.readStops('snap-1')).toEqual([{ stopId: 's01', viewed: false }]);
            expect(store.read(V1)).toEqual([
                { fileId: 'file-2', viewed: null, seenRanges: [{ side: 'new', start: 1, end: 2 }] },
                { fileId: 'file-1', viewed: null, seenRanges: [{ side: 'new', start: 40, end: 41 }] },
            ]);
            // Снимать больше нечего.
            expect(store.setStopFileViewed('snap-1', V1, 's01', 'file-1', false, [])).toBe(before + 1);
        });

        it('снятие не создаёт запись остановки, которой не было, и не трогает файловую отметку', () => {
            const store = new ProgressStore({ db: open() });
            store.setFileViewed(V1, 'file-2', true, 'snap-1');
            store.setStopFileViewed('snap-1', V1, 's01', 'file-1', true, [{ side: 'new', start: 10, end: 14 }]);

            store.setStopFileViewed('snap-1', V1, 's01', 'file-1', false, []);

            expect(store.readStops('snap-1')).toEqual([]);
            expect(store.read(V1)).toEqual([{ fileId: 'file-2', viewed: true, seenRanges: [] }]);
        });

        it('снятие отметки остановки целиком удаляет и пофайловые диапазоны', () => {
            const store = new ProgressStore({ db: open() });
            store.setStopFileViewed('snap-1', V1, 's01', 'file-1', true, [{ side: 'new', start: 10, end: 14 }]);
            store.setStopFileViewed('snap-1', V1, 's01', 'file-2', true, [{ side: 'old', start: 3, end: 3 }]);
            store.setStopViewed('snap-1', V1, 's01', true, [
                { fileId: 'file-1', side: 'new', start: 10, end: 14 },
                { fileId: 'file-2', side: 'old', start: 3, end: 3 },
            ]);
            store.setStopFileViewed('snap-1', V1, 's02', 'file-1', true, [{ side: 'new', start: 40, end: 41 }]);

            store.setStopViewed('snap-1', V1, 's01', false, []);

            expect(store.read(V1)).toEqual([
                { fileId: 'file-1', viewed: null, seenRanges: [{ side: 'new', start: 40, end: 41 }] },
            ]);
        });
    });

    it('снятие файла снимает затронутые остановки и удаляет все их диапазоны одной ревизией', () => {
        const store = new ProgressStore({ db: open() });
        store.setStopViewed('snap-1', V1, 's01', true, [
            { fileId: 'file-1', side: 'new', start: 10, end: 14 },
            { fileId: 'file-2', side: 'old', start: 3, end: 5 },
        ]);
        store.setStopViewed('snap-1', V1, 's02', true, [
            { fileId: 'file-1', side: 'old', start: 20, end: 21 },
            { fileId: 'file-3', side: 'new', start: 7, end: 9 },
        ]);
        const before = store.revision;

        expect(store.setFileViewed(V1, 'file-1', false, 'snap-1')).toBe(before + 1);
        expect(store.readStops('snap-1')).toEqual([
            { stopId: 's01', viewed: false },
            { stopId: 's02', viewed: false },
        ]);
        expect(store.read(V1)).toEqual([{ fileId: 'file-1', viewed: false, seenRanges: [] }]);
        // Повтор уже ничего не меняет: диапазонов-связок нет, файловый флаг тот же.
        expect(store.setFileViewed(V1, 'file-1', false, 'snap-1')).toBe(before + 1);
    });

    it('снятие файла удаляет и перенесённые диапазоны, у которых остановки-источника нет', () => {
        const db = open();
        insertRange(db, V1, 'file-1', 10, 14);
        const store = new ProgressStore({ db });

        expect(store.setFileViewed(V1, 'file-1', false, 'snap-1')).toBe(1);

        expect(store.read(V1)).toEqual([{ fileId: 'file-1', viewed: false, seenRanges: [] }]);
    });

    it('снятие файла без связанных остановок ведёт себя как прежняя файловая запись', () => {
        const store = new ProgressStore({ db: open() });

        expect(store.setFileViewed(V1, 'standalone', false, 'snap-1')).toBe(1);
        expect(store.readStops('snap-1')).toEqual([]);
        expect(store.read(V1)).toEqual([{ fileId: 'standalone', viewed: false, seenRanges: [] }]);
        expect(store.setFileViewed(V1, 'standalone', false, 'snap-1')).toBe(1);
    });

    it('после close подписчиков не будят', () => {
        const store = new ProgressStore({ db: open() });
        let calls = 0;
        store.subscribe(() => {
            calls += 1;
        });

        store.close();
        store.setFileViewed(V1, 'file-1', true);

        expect(calls).toBe(0);
    });

    describe('перенос диапазонов на новую итерацию', () => {
        /** Диапазон, отмеченный в v1, глазами v2 после переноса. */
        function carried(
            store: ProgressStore,
            map: IterationMap,
            marked: { start: number; end: number; side?: 'old' | 'new' },
        ): { side: string; start: number; end: number }[] {
            store.setStopViewed('snap-1', V1, 's01', true, [
                { fileId: fileIdOf(V1, CLOCK), side: marked.side ?? 'new', start: marked.start, end: marked.end },
            ]);
            store.carryRanges(V1, V2, map);
            return store.read(V2).flatMap((progress) => progress.seenRanges);
        }

        it('диапазон целиком до правки переносится как есть', () => {
            const store = storeWith(open(), twoIterations());

            expect(carried(store, clockMap(), { start: 1, end: 5 })).toEqual([
                { side: 'new', start: 1, end: 5 },
            ]);
        });

        it('диапазон после правки переносится со сдвигом', () => {
            const store = storeWith(open(), twoIterations());

            expect(carried(store, clockMap(), { start: 20, end: 25 })).toEqual([
                { side: 'new', start: 21, end: 26 },
            ]);
        });

        it('диапазон, задевший правку, переносится только нетронутой частью', () => {
            const store = storeWith(open(), twoIterations());

            expect(carried(store, clockMap(), { start: 5, end: 15 })).toEqual([
                { side: 'new', start: 5, end: 11 },
                { side: 'new', start: 14, end: 16 },
            ]);
        });

        it('файл, которого в новой итерации нет, не переносит ничего', () => {
            const store = storeWith(
                open(),
                iterations({
                    [V1]: diffOf(V1, [CLOCK, ORDER]),
                    [V2]: diffOf(V2, [ORDER]),
                }),
            );

            expect(carried(store, identityMap(), { start: 1, end: 5 })).toEqual([]);
        });

        it('удалённый автором файл считается отдельно от сбоя резолвера путей', () => {
            const db = open();
            const logs: string[] = [];
            const store = storeWith(
                db,
                iterations({ [V1]: diffOf(V1, [CLOCK]), [V2]: diffOf(V2, [ORDER]) }),
                (message) => logs.push(message),
            );
            store.setStopViewed('snap-1', V1, 's01', true, [
                { fileId: fileIdOf(V1, CLOCK), side: 'new', start: 1, end: 5 },
            ]);

            // Путь известен из патча источника, файла в новой итерации просто нет: «без пути» —
            // это про сломанное сопоставление, а не про правку автора.
            expect(store.carryRanges(V1, V2, identityMap())).toMatchObject({
                ranges: 0,
                sourceRanges: 1,
                unmappedRanges: 0,
                missingRanges: 1,
                touchedRanges: 0,
            });
            expect(logs).toContain(
                `перенос прогресса ${V1} → ${V2}: перенесено 0 диапазонов из 1 ` +
                    '(без пути: 0, нет в новой итерации: 1, затронуты интердиффом: 0)',
            );
        });

        it('якорь заметки, уехавший переносом на цель, читается из origin_anchor', () => {
            const db = open();
            const store = storeWith(db, iterations({ [V2]: diffOf(V2, [CLOCK]) }));
            insertRange(db, V1, fileIdOf(V1, CLOCK), 1, 5);
            // Перенос заметок идёт параллельно переносу прогресса и успел первым: в `anchor`
            // уже цель, и путь `fileId` источника остался только в `origin_anchor`.
            insertNote(
                db,
                { diffId: V2, fileId: fileIdOf(V2, CLOCK), path: CLOCK },
                { diffId: V1, fileId: fileIdOf(V1, CLOCK), path: CLOCK },
            );

            expect(store.carryRanges(V1, V2, identityMap())).toMatchObject({
                ranges: 1,
                unmappedRanges: 0,
            });
        });

        it('переименованный файл прогресс не наследует', () => {
            const store = storeWith(
                open(),
                iterations({
                    [V1]: diffOf(V1, [CLOCK]),
                    [V2]: diffOf(V2, ['services/orders/src/infra/time.ts']),
                }),
            );
            const map = buildIterationMap({
                interdiff: interdiffOf([
                    fileDiff({
                        path: 'services/orders/src/infra/time.ts',
                        oldPath: CLOCK,
                        changeType: 'move',
                    }),
                ]),
                fromBaseCommit: BASE,
                toBaseCommit: BASE,
            });

            expect(carried(store, map, { start: 1, end: 5 })).toEqual([]);
        });

        it('сторона old не переносится при смене базы, а new переносится', () => {
            const db = open();
            const store = storeWith(db, twoIterations());
            const map = buildIterationMap({ interdiff: null, fromBaseCommit: BASE, toBaseCommit: 'base-other' });
            store.setStopViewed('snap-1', V1, 's01', true, [
                { fileId: fileIdOf(V1, CLOCK), side: 'old', start: 1, end: 3 },
                { fileId: fileIdOf(V1, CLOCK), side: 'new', start: 1, end: 3 },
            ]);

            store.carryRanges(V1, V2, map);

            expect(store.read(V2).flatMap((progress) => progress.seenRanges)).toEqual([
                { side: 'new', start: 1, end: 3 },
            ]);
        });

        it('файловый пин переносится только на неизменившийся файл, снятие — всегда', () => {
            const store = storeWith(open(), twoIterations());
            store.setFileViewed(V1, fileIdOf(V1, CLOCK), true);
            store.setFileViewed(V1, fileIdOf(V1, ORDER), true);

            store.carryRanges(V1, V2, clockMap());

            // `CLOCK` интердифф трогает — пин на нём не держится, `ORDER` не тронут.
            expect(store.read(V2)).toEqual([{ fileId: fileIdOf(V2, ORDER), viewed: true, seenRanges: [] }]);

            store.setFileViewed(V1, fileIdOf(V1, CLOCK), false);
            store.carryRanges(V1, 'iter-3', clockMap());
            expect(store.read('iter-3')).toContainEqual({
                fileId: fileIdOf('iter-3', CLOCK),
                viewed: false,
                seenRanges: [],
            });
        });

        it('повторный перенос пары не возвращает снятую ревьюером отметку', () => {
            const store = storeWith(open(), twoIterations());
            store.setStopViewed('snap-1', V1, 's01', true, [
                { fileId: fileIdOf(V1, CLOCK), side: 'new', start: 1, end: 5 },
            ]);

            const first = store.carryRanges(V1, V2, identityMap());
            expect(first).toMatchObject({ ranges: 1, skipped: false });

            // Ревьюер снял отметку уже на новой итерации.
            store.setFileViewed(V2, fileIdOf(V2, CLOCK), false, 'snap-2');
            expect(store.carryRanges(V1, V2, identityMap())).toMatchObject({ ranges: 0, files: 0, skipped: true });
            expect(store.read(V2)).toEqual([{ fileId: fileIdOf(V2, CLOCK), viewed: false, seenRanges: [] }]);
        });

        it('без сохранённого патча целевой итерации перенос не состоялся и повторяется', () => {
            const store = storeWith(open(), iterations({ [V1]: diffOf(V1, [CLOCK]) }));
            store.setStopViewed('snap-1', V1, 's01', true, [
                { fileId: fileIdOf(V1, CLOCK), side: 'new', start: 1, end: 5 },
            ]);

            expect(store.carryRanges(V1, V2, identityMap())).toMatchObject({ ranges: 0, files: 0, skipped: true });

            // Патч доехал — тот же вызов переносит.
            const ready = storeWith(open(), twoIterations());
            expect(ready.carryRanges(V1, V2, identityMap())).toMatchObject({ ranges: 1, skipped: false });
        });

        it('патча источника нет — пути его файлов берутся из якорей снапшота', () => {
            const db = open();
            // Прогресс записал сервер 0.3.x: строки об итерации нет,
            // патча её нет и не будет — путь `fileId` знает только снапшот маршрута.
            const store = storeWith(db, iterations({ [V2]: diffOf(V2, [CLOCK]) }));
            insertRange(db, V1, fileIdOf(V1, CLOCK), 1, 5);
            insertSnapshot(db, V1, [{ fileId: fileIdOf(V1, CLOCK), path: CLOCK }]);

            expect(store.carryRanges(V1, V2, identityMap())).toMatchObject({
                ranges: 1,
                sourceRanges: 1,
                unmappedRanges: 0,
                skipped: false,
            });
            expect(store.read(V2)).toEqual([
                { fileId: fileIdOf(V2, CLOCK), viewed: null, seenRanges: [{ side: 'new', start: 1, end: 5 }] },
            ]);
        });

        it('диапазон на файле без якоря считается непривязанным, остальные переносятся', () => {
            const db = open();
            const store = storeWith(db, iterations({ [V2]: diffOf(V2, [CLOCK, ORDER]) }));
            insertRange(db, V1, fileIdOf(V1, CLOCK), 1, 5);
            insertRange(db, V1, fileIdOf(V1, ORDER), 1, 5);
            insertSnapshot(db, V1, [{ fileId: fileIdOf(V1, CLOCK), path: CLOCK }]);

            expect(store.carryRanges(V1, V2, identityMap())).toMatchObject({
                ranges: 1,
                sourceRanges: 2,
                unmappedRanges: 1,
            });
            expect(store.read(V2).map((progress) => progress.fileId)).toEqual([fileIdOf(V2, CLOCK)]);
        });

        it('перенос подписывает строки путём, и следующий перенос идёт по нему', () => {
            const db = open();
            const store = storeWith(db, twoIterations());
            store.setStopViewed('snap-1', V1, 's01', true, [
                { fileId: fileIdOf(V1, CLOCK), side: 'new', start: 1, end: 5 },
            ]);
            store.carryRanges(V1, V2, identityMap());

            expect(pathsOfRanges(db, V2)).toEqual([CLOCK]);

            // Патча V2 у следующего сервера нет, якорей тоже: путь несёт сама запись.
            const next = storeWith(db, iterations({ 'iter-3': diffOf('iter-3', [CLOCK]) }));
            expect(next.carryRanges(V2, 'iter-3', identityMap())).toMatchObject({
                ranges: 1,
                unmappedRanges: 0,
            });
            expect(pathsOfRanges(db, 'iter-3')).toEqual([CLOCK]);
        });
    });

    describe('усыновление легаси-прогресса', () => {
        it('записи без итерации переезжают на активную, конфликт остаётся за ней', () => {
            const db = open();
            const store = new ProgressStore({ db });
            store.setFileViewed('unknown', 'file-1', true);
            store.setFileViewed('unknown', 'file-2', true);
            insertRange(db, 'unknown', 'file-1', 10, 14);
            insertRange(db, V1, 'file-1', 10, 14);
            store.setFileViewed(V1, 'file-1', false);

            store.adoptLegacy(V1);

            expect(store.read('unknown')).toEqual([]);
            expect(store.read(V1)).toEqual([
                // Решение, принятое уже на активной итерации, усыновление не переигрывает.
                { fileId: 'file-1', viewed: false, seenRanges: [{ side: 'new', start: 10, end: 14 }] },
                { fileId: 'file-2', viewed: true, seenRanges: [] },
            ]);
            // Повтор ничего не меняет.
            const revision = store.revision;
            store.adoptLegacy(V1);
            expect(store.revision).toBe(revision);
        });
    });

    describe('итерация-источник переноса', () => {
        it('самая поздняя итерация с прогрессом, кроме активной', () => {
            const db = open();
            const store = new ProgressStore({ db });
            rememberIteration(db, V1, '2026-09-01T10:00:00.000Z');
            rememberIteration(db, V2, '2026-09-02T10:00:00.000Z');
            rememberIteration(db, 'iter-3', '2026-09-03T10:00:00.000Z');

            expect(store.latestDiffIdWithProgress('iter-3')).toBeNull();

            store.setFileViewed(V1, 'file-1', true);
            expect(store.latestDiffIdWithProgress('iter-3')).toBe(V1);

            insertRange(db, V2, 'file-2', 1, 2);
            expect(store.latestDiffIdWithProgress('iter-3')).toBe(V2);
            expect(store.latestDiffIdWithProgress(V2)).toBe(V1);
        });

        it('смётая force-push итерация тоже источник, а отвергнутая уступает следующей', () => {
            const db = open();
            const store = new ProgressStore({ db });
            rememberIteration(db, V1, '2026-09-01T10:00:00.000Z');
            rememberIteration(db, V2, '2026-09-02T10:00:00.000Z', 'gone');
            rememberIteration(db, 'iter-3', '2026-09-03T10:00:00.000Z');
            store.setFileViewed(V1, 'file-1', true);
            insertRange(db, V2, 'file-2', 1, 2);

            // Прогресс исчезнувшей итерации самый свежий: срез против неё умеет не всякий хост,
            // но выбор источника это не решает.
            expect(store.latestDiffIdWithProgress('iter-3')).toBe(V2);
            expect(store.latestDiffIdWithProgress('iter-3', [V2])).toBe(V1);
            expect(store.latestDiffIdWithProgress('iter-3', [V1, V2])).toBeNull();
        });

        it('итерация без строки в iterations тоже источник', () => {
            const db = open();
            const store = new ProgressStore({ db });
            // Прогресс сервера 0.3.x: итерации он не сохранял, а отметки остались.
            insertRange(db, V1, 'file-1', 1, 2);

            expect(store.latestDiffIdWithProgress(V2)).toBe(V1);
        });

        it('без строк в iterations свежесть читается по снапшоту, а потом по отметке файла', () => {
            const db = open();
            const store = new ProgressStore({ db, now: () => new Date('2026-09-01T10:00:00.000Z') });
            insertRange(db, V1, 'file-1', 1, 2);
            insertSnapshot(db, V1, [], '2026-09-01T09:00:00.000Z');
            insertRange(db, V2, 'file-2', 1, 2);
            insertSnapshot(db, V2, [], '2026-09-02T09:00:00.000Z');

            expect(store.latestDiffIdWithProgress('iter-3')).toBe(V2);

            // У третьей итерации снапшота нет — её место в очереди задаёт время отметки файла.
            const later = new ProgressStore({ db, now: () => new Date('2026-09-03T10:00:00.000Z') });
            later.setFileViewed('iter-3', 'file-3', true);
            expect(later.latestDiffIdWithProgress('iter-4')).toBe('iter-3');
        });

        it('легаси-итерация источником не бывает: её усыновляет adoptLegacy', () => {
            const db = open();
            const store = new ProgressStore({ db });
            insertRange(db, 'unknown', 'file-1', 1, 2);

            expect(store.latestDiffIdWithProgress(V1)).toBeNull();
        });
    });

    describe('есть ли на итерации отметки просмотра', () => {
        it('диапазон и файловый пин считаются, снятый пин — нет', () => {
            const db = open();
            const store = new ProgressStore({ db });

            expect(store.hasViewedMarks(V1)).toBe(false);

            store.setFileViewed(V1, 'file-1', false);
            expect(store.hasViewedMarks(V1)).toBe(false);

            insertRange(db, V1, 'file-1', 1, 2);
            expect(store.hasViewedMarks(V1)).toBe(true);
            expect(store.hasViewedMarks(V2)).toBe(false);

            store.setFileViewed(V2, 'file-2', true);
            expect(store.hasViewedMarks(V2)).toBe(true);
        });
    });

    describe('перенос отметок остановок на новый снапшот', () => {
        const anchors: RouteAnchor[] = [
            { fileId: fileIdOf(V1, CLOCK), path: CLOCK, side: 'new', start: 1, end: 5, collapsed: false },
        ];

        function diffWithAddedLines(): PrDiff {
            return interdiffOf([fileDiff({ path: CLOCK, patch: ADDED_LINES, fileId: fileIdOf(V1, CLOCK) })], V1);
        }

        it('накрытая диапазонами остановка становится просмотренной и получает свои куски', () => {
            const store = new ProgressStore({ db: open() });
            insertRange(open(), V1, fileIdOf(V1, CLOCK), 1, 5);

            const carried = store.carryStopsInTransaction({
                snapshotId: 'snap-2',
                diffId: V1,
                stops: [{ id: 's01', anchors }],
                diff: diffWithAddedLines(),
            });
            carried.afterCommit();

            expect(carried.kept).toBe(1);
            expect(store.readStops('snap-2')).toEqual([{ stopId: 's01', viewed: true }]);
            // Кусок перешёл под остановку, а не задвоился.
            expect(store.read(V1)).toEqual([
                { fileId: fileIdOf(V1, CLOCK), viewed: null, seenRanges: [{ side: 'new', start: 1, end: 5 }] },
            ]);
        });

        it('накрытая наполовину остановка не переносится, а стоп без якорей — тем более', () => {
            const store = new ProgressStore({ db: open() });
            insertRange(open(), V1, fileIdOf(V1, CLOCK), 1, 3);

            const carried = store.carryStopsInTransaction({
                snapshotId: 'snap-2',
                diffId: V1,
                stops: [
                    { id: 's01', anchors },
                    { id: 'other', anchors: [] },
                ],
                diff: diffWithAddedLines(),
            });

            expect(carried.kept).toBe(0);
            expect(store.readStops('snap-2')).toEqual([]);
        });

        it('файловый пин накрывает остановку целиком, а решение ревьюера не переигрывается', () => {
            const db = open();
            const store = new ProgressStore({ db });
            store.setFileViewed(V1, fileIdOf(V1, CLOCK), true);
            store.setStopViewed('snap-2', V1, 's01', false, []);

            const carried = store.carryStopsInTransaction({
                snapshotId: 'snap-2',
                diffId: V1,
                stops: [
                    { id: 's01', anchors },
                    { id: 's02', anchors },
                ],
                diff: diffWithAddedLines(),
            });

            expect(carried.kept).toBe(1);
            expect(store.readStops('snap-2')).toEqual([
                { stopId: 's01', viewed: false },
                { stopId: 's02', viewed: true },
            ]);
        });

        it('отметку, поставленную вкладкой по тем же диапазонам, перенос засчитывает без перезаписи', () => {
            const db = open();
            const store = new ProgressStore({ db });
            insertRange(db, V1, fileIdOf(V1, CLOCK), 1, 5);
            // Вкладка успела отметить остановку по перенесённым диапазонам раньше заморозки.
            store.setStopViewed('snap-2', V1, 's01', true, [
                { fileId: fileIdOf(V1, CLOCK), side: 'new', start: 1, end: 5 },
            ]);

            const carried = store.carryStopsInTransaction({
                snapshotId: 'snap-2',
                diffId: V1,
                stops: [{ id: 's01', anchors }],
                diff: diffWithAddedLines(),
            });

            expect(carried.kept).toBe(1);
            expect(store.readStops('snap-2')).toEqual([{ stopId: 's01', viewed: true }]);
        });

        it('прочитанная руками остановка не выдаётся за перенесённую: своя отметка не в счёт', () => {
            const store = new ProgressStore({ db: open() });
            // Переносить нечего: ревьюер сам прочитал остановку, пока снапшот заполнялся.
            store.setStopViewed('snap-2', V1, 's01', true, [
                { fileId: fileIdOf(V1, CLOCK), side: 'new', start: 1, end: 5 },
            ]);

            const carried = store.carryStopsInTransaction({
                snapshotId: 'snap-2',
                diffId: V1,
                stops: [{ id: 's01', anchors }],
                diff: diffWithAddedLines(),
            });

            expect(carried.kept).toBe(0);
            expect(store.readStops('snap-2')).toEqual([{ stopId: 's01', viewed: true }]);
        });

        it('повторная заморозка снапшота (дозаполнение стопа) не считает перенос второй раз', () => {
            const db = open();
            const store = new ProgressStore({ db });
            insertRange(db, V1, fileIdOf(V1, CLOCK), 1, 5);
            const input = {
                snapshotId: 'snap-2',
                diffId: V1,
                stops: [{ id: 's01', anchors }],
                diff: diffWithAddedLines(),
            };

            expect(store.carryStopsInTransaction(input).kept).toBe(1);
            expect(store.carryStopsInTransaction(input).kept).toBe(0);
            expect(store.readStops('snap-2')).toEqual([{ stopId: 's01', viewed: true }]);
        });

        it('повторная заморозка не задваивает и остановку, накрытую файловым пином', () => {
            const db = open();
            const store = new ProgressStore({ db });
            store.setFileViewed(V1, fileIdOf(V1, CLOCK), true);
            const input = {
                snapshotId: 'snap-2',
                diffId: V1,
                stops: [{ id: 's01', anchors }],
                diff: diffWithAddedLines(),
            };

            expect(store.carryStopsInTransaction(input).kept).toBe(1);
            expect(store.carryStopsInTransaction(input).kept).toBe(0);
        });
    });
});

/** `fileId` фикстурных итераций меняется с каждой итерацией — стабилен только путь. */
function fileIdOf(diffId: string, filePath: string): string {
    return `${diffId}:${filePath}`;
}

function fileDiff(overrides: Partial<FileDiff> & Pick<FileDiff, 'path'>): FileDiff {
    return {
        fileId: `file:${overrides.path}`,
        oldPath: null,
        changeType: 'modify',
        binary: false,
        generated: false,
        additions: 0,
        deletions: 0,
        patch: null,
        viewed: null,
        blameUrl: null,
        hostFileUrl: null,
        image: null,
        ...overrides,
    };
}

function interdiffOf(files: readonly FileDiff[], diffId = 'interdiff'): PrDiff {
    return { diffId, baseCommit: BASE, headCommit: 'head-b', files: [...files] };
}

/** Патч итерации: одни и те же пути, свои `fileId` — как у фикстур. */
function diffOf(diffId: string, paths: readonly string[]): PrDiff {
    return {
        diffId,
        baseCommit: BASE,
        headCommit: `head-${diffId}`,
        files: paths.map((filePath) => fileDiff({ path: filePath, fileId: fileIdOf(diffId, filePath) })),
    };
}

/** Хранилище патчей итераций глазами переноса: ему хватает `get`. */
function iterations(diffs: Record<string, PrDiff>): { get: (diffId: string) => StoredIteration | null } {
    return {
        get: (diffId) => {
            const diff = diffs[diffId];
            return diff === undefined
                ? null
                : {
                      diff,
                      iteration: {
                          diffId,
                          baseCommit: diff.baseCommit,
                          headCommit: diff.headCommit,
                          createdAt: '2026-09-02T10:00:00.000Z',
                          status: 'active',
                      },
                  };
        },
    };
}

function twoIterations(): { get: (diffId: string) => StoredIteration | null } {
    return iterations({
        [V1]: diffOf(V1, [CLOCK, ORDER]),
        [V2]: diffOf(V2, [CLOCK, ORDER]),
        'iter-3': diffOf('iter-3', [CLOCK, ORDER]),
    });
}

function storeWith(
    db: SherpaDatabase,
    store: { get: (diffId: string) => StoredIteration | null },
    log: (message: string) => void = () => undefined,
): ProgressStore {
    return new ProgressStore({ db, iterations: store, log });
}

/** Карта, в которой интердифф правит строки 12–13 файла `CLOCK`. */
function clockMap(): IterationMap {
    return buildIterationMap({
        interdiff: interdiffOf([fileDiff({ path: CLOCK, patch: CLOCK_PATCH })]),
        fromBaseCommit: BASE,
        toBaseCommit: BASE,
    });
}

/** Строка итерации в хранилище: `latestDiffIdWithProgress` берёт порядок из неё. */
function rememberIteration(
    db: SherpaDatabase,
    diffId: string,
    createdAt: string,
    status: 'previous' | 'gone' = 'previous',
): void {
    db.prepare(
        `INSERT INTO iterations (diff_id, base_commit, head_commit, created_at, status, diff_json, fetched_at)
         VALUES (?, ?, ?, ?, ?, '{}', ?)`,
    ).run(diffId, BASE, `head-${diffId}`, createdAt, status, createdAt);
}

import fs from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { fixtureIteration, makeFixtureHost } from '@sherpa/fixtures';

import { ChatStore } from './chat-store.js';
import { openDatabase, readSchemaVersion } from './db.js';
import { IterationFeed } from './iteration-feed.js';
import { IterationStore } from './iteration-store.js';
import { MIGRATIONS } from './migrations.js';
import { databasePathFor } from './paths.js';
import { ProgressStore } from './progress-store.js';
import { RouteStore } from './route-store.js';
import type { SherpaServer } from './server.js';
import { startServer } from './server.js';
import { makeTempSherpaDir, removeTempSherpaDir } from './test-support.js';

describe('хранилище', () => {
    let sherpaDir: string;
    const servers: SherpaServer[] = [];

    beforeEach(async () => {
        sherpaDir = await makeTempSherpaDir();
    });

    afterEach(async () => {
        for (const server of servers.splice(0)) {
            await server.close();
        }
        await removeTempSherpaDir(sherpaDir);
    });

    it('сервер создаёт БД PR в режиме WAL', async () => {
        // Живой Арканум в тестах запрещён (docs/testing.md): без хоста прогрев маршрута никуда не ходит.
        servers.push(await startServer({ prKey: 'arcanum-42', sherpaDir, reviewHostFactory: () => null }));
        const file = databasePathFor(sherpaDir, 'arcanum-42');

        await expect(fs.stat(file)).resolves.toBeDefined();

        const reader = new DatabaseSync(file, { readOnly: true });
        try {
            expect(reader.prepare('PRAGMA journal_mode').get()).toMatchObject({ journal_mode: 'wal' });
        } finally {
            reader.close();
        }
    });

    it('миграции применяются один раз и фиксируют версию схемы', () => {
        const file = `${sherpaDir}/migrations.db`;

        const first = openDatabase(file);
        const appliedAfterFirst = first.prepare('SELECT name FROM migrations ORDER BY id').all() as { name: string }[];
        expect(appliedAfterFirst.map((row) => row.name)).toEqual(MIGRATIONS.map((migration) => migration.name));
        expect(readSchemaVersion(first)).toBe(String(MIGRATIONS.length));
        first.close();

        const second = openDatabase(file);
        const appliedAfterSecond = second.prepare('SELECT COUNT(*) AS count FROM migrations').get() as {
            count: number;
        };
        expect(appliedAfterSecond.count).toBe(MIGRATIONS.length);
        second.close();
    });

    // БД PR переживает обновление скилла: новые миграции применяются к уже накопленному стейту.
    it('последняя миграция доезжает до существующей БД, не теряя её данных', () => {
        const file = `${sherpaDir}/upgrade.db`;

        const before = openDatabase(file, MIGRATIONS.slice(0, -1));
        before
            .prepare('INSERT INTO worker (id, worker_id, harness, registered_at, last_seen_at) VALUES (1, ?, ?, ?, ?)')
            .run('w-1', 'claude-code', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
        before.close();

        const after = openDatabase(file);
        try {
            expect(readSchemaVersion(after)).toBe(String(MIGRATIONS.length));
            expect(after.prepare('SELECT worker_id, harness, model, lang FROM worker').get()).toMatchObject({
                worker_id: 'w-1',
                harness: 'claude-code',
                model: null,
                lang: null,
            });
        } finally {
            after.close();
        }
    });

    /** Схема, какой она была до названной миграции: следующие за ней миграции ещё не применены. */
    function migrationsBefore(name: string): typeof MIGRATIONS {
        const index = MIGRATIONS.findIndex((migration) => migration.name === name);
        expect(index).toBeGreaterThan(0);
        return MIGRATIONS.slice(0, index);
    }

    // Накопленная БД не теряет маршрут при переезде на множественность снапшотов.
    it('миграция итераций переносит снапшот из route_state в route_snapshots', () => {
        const file = `${sherpaDir}/route-snapshot.db`;
        const snapshot = {
            snapshotId: 'snap-legacy',
            commit: 'head-legacy',
            diffId: 'iter-legacy',
            createdAt: '2026-08-25T10:00:00.000Z',
            provenance: { harness: 'claude-code', model: 'opus', locale: null },
            summary: 'маршрут до итераций',
            stops: [],
            tourOrder: [],
            contentHash: 'abcdef123456',
        };

        const before = openDatabase(file, migrationsBefore('010-iterations'));
        before
            .prepare(
                `INSERT INTO route_state (id, phase, small_pr, snapshot, intents, updated_at)
                 VALUES (1, 'ready', 0, ?, '[]', '2026-08-25T10:00:00.000Z')`,
            )
            .run(JSON.stringify(snapshot));
        before.close();

        const after = openDatabase(file);
        try {
            expect(after.prepare('SELECT * FROM route_snapshots').all()).toEqual([
                {
                    snapshot_id: 'snap-legacy',
                    diff_id: 'iter-legacy',
                    created_at: '2026-08-25T10:00:00.000Z',
                    previous_snapshot_id: null,
                    snapshot_json: JSON.stringify(snapshot),
                    content_hash: 'abcdef123456',
                },
            ]);
            expect(after.prepare('SELECT phase, current_snapshot_id FROM route_state').get()).toMatchObject({
                phase: 'ready',
                current_snapshot_id: 'snap-legacy',
            });
            // Блоб снапшота из `route_state` уехал вовсе: истина живёт в `route_snapshots`.
            const columns = after.prepare('PRAGMA table_info(route_state)').all() as { name: string }[];
            expect(columns.map((column) => column.name)).not.toContain('snapshot');

            const store = new RouteStore({ db: after });
            expect(store.current()?.snapshotId).toBe('snap-legacy');
            expect(store.listSnapshots()).toHaveLength(1);
        } finally {
            after.close();
        }
    });

    // Итерацию задачи прежние привязки не называют: продолжать по ним генерацию нельзя.
    it('миграция итерации задач стирает привязки, записанные до неё', () => {
        const file = `${sherpaDir}/route-tasks.db`;

        const before = openDatabase(file, migrationsBefore('012-route-task-iteration'));
        before
            .prepare(
                'INSERT INTO tasks (id, type, priority, instructions, context_files, status, attempt, ' +
                    'created_at, updated_at) ' +
                    "VALUES (7, 'route.skeleton', 'background', '', '[]', 'queued', 1, " +
                    "'2026-08-25T10:00:00.000Z', '2026-08-25T10:00:00.000Z')",
            )
            .run();
        before
            .prepare("INSERT INTO route_tasks (task_id, kind, plan_indexes, created_at) " +
                "VALUES (7, 'skeleton', '[]', '2026-08-25T10:00:00.000Z')")
            .run();
        before.close();

        const after = openDatabase(file);
        try {
            expect(after.prepare('SELECT COUNT(*) AS count FROM route_tasks').get()).toMatchObject({ count: 0 });
            // Сама задача остаётся: сироту без привязки отменит оркестратор.
            expect(after.prepare('SELECT COUNT(*) AS count FROM tasks').get()).toMatchObject({ count: 1 });
            const columns = after.prepare('PRAGMA table_info(route_tasks)').all() as { name: string }[];
            expect(columns.map((column) => column.name)).toContain('diff_id');
        } finally {
            after.close();
        }
    });

    // Ручная правка БД не должна ронять старт сервера на миграции.
    it('миграция итераций переживает повреждённый блоб снапшота', () => {
        const file = `${sherpaDir}/route-broken.db`;

        const before = openDatabase(file, migrationsBefore('010-iterations'));
        before
            .prepare(
                `INSERT INTO route_state (id, phase, small_pr, snapshot, intents, updated_at)
                 VALUES (1, 'ready', 0, 'это не json', '[]', '2026-08-25T10:00:00.000Z')`,
            )
            .run();
        before.close();

        const after = openDatabase(file);
        try {
            expect(after.prepare('SELECT COUNT(*) AS count FROM route_snapshots').get()).toMatchObject({ count: 0 });
            expect(after.prepare('SELECT current_snapshot_id FROM route_state').get()).toMatchObject({
                current_snapshot_id: null,
            });
            // Блоб не переехал — маршрута нет: `ready` без снапшота соврал бы UI готовым маршрутом.
            const store = new RouteStore({ db: after });
            expect(store.read().phase).toBe('none');
            expect(store.current()).toBeNull();
        } finally {
            after.close();
        }
    });

    // Прогресс накопленной БД не теряется, когда у его таблиц появляется измерение итерации.
    it('миграция прогресса уводит записи на активную итерацию, а отметки стопов — на текущий снапшот', () => {
        const file = `${sherpaDir}/progress-iterations.db`;

        const before = openDatabase(file, migrationsBefore('013-progress-iterations'));
        before
            .prepare(
                `INSERT INTO iterations (diff_id, base_commit, head_commit, created_at, status, diff_json, fetched_at)
                 VALUES ('iter-old', 'base', 'head-old', '2026-08-30T10:00:00.000Z', 'previous', '{}', '2026-08-30T10:00:00.000Z'),
                        ('iter-live', 'base', 'head-live', '2026-08-31T10:00:00.000Z', 'active', '{}', '2026-08-31T10:00:00.000Z')`,
            )
            .run();
        before
            .prepare(
                `INSERT INTO route_snapshots (snapshot_id, diff_id, created_at, snapshot_json)
                 VALUES ('snap-1', 'iter-live', '2026-08-31T11:00:00.000Z', '{}')`,
            )
            .run();
        before
            .prepare(
                `INSERT INTO route_state (id, phase, small_pr, current_snapshot_id, intents, updated_at)
                 VALUES (1, 'ready', 0, 'snap-1', '[]', '2026-08-31T11:00:00.000Z')`,
            )
            .run();
        before
            .prepare(
                `INSERT INTO file_progress (file_id, viewed, updated_at)
                 VALUES ('file-1', 1, '2026-08-31T11:00:00.000Z')`,
            )
            .run();
        before
            .prepare(
                `INSERT INTO file_seen_ranges (file_id, side, start_line, end_line, source_stop_id)
                 VALUES ('file-1', 'new', 3, 7, 's01')`,
            )
            .run();
        before
            .prepare(
                `INSERT INTO stop_progress (stop_id, viewed, updated_at)
                 VALUES ('s01', 1, '2026-08-31T11:00:00.000Z')`,
            )
            .run();
        before.close();

        const after = openDatabase(file);
        try {
            expect(after.prepare('SELECT diff_id, file_id, viewed FROM file_progress').all()).toEqual([
                { diff_id: 'iter-live', file_id: 'file-1', viewed: 1 },
            ]);
            expect(
                after.prepare('SELECT diff_id, source_stop_id, carried_from FROM file_seen_ranges').all(),
            ).toEqual([{ diff_id: 'iter-live', source_stop_id: 's01', carried_from: null }]);
            expect(after.prepare('SELECT snapshot_id, stop_id, viewed FROM stop_progress').all()).toEqual([
                { snapshot_id: 'snap-1', stop_id: 's01', viewed: 1 },
            ]);
            expect(after.prepare('SELECT COUNT(*) AS count FROM progress_carries').get()).toMatchObject({
                count: 0,
            });
        } finally {
            after.close();
        }
    });

    // Сервер без хоста итераций не знает: его прогресс живёт на `LEGACY_DIFF_ID`.
    it('миграция прогресса без итераций и снапшота: записи уезжают на unknown, стопы удаляются', () => {
        const file = `${sherpaDir}/progress-legacy.db`;

        const before = openDatabase(file, migrationsBefore('013-progress-iterations'));
        before
            .prepare(
                `INSERT INTO file_progress (file_id, viewed, updated_at)
                 VALUES ('file-1', 0, '2026-08-31T11:00:00.000Z')`,
            )
            .run();
        before
            .prepare(
                `INSERT INTO stop_progress (stop_id, viewed, updated_at)
                 VALUES ('s01', 1, '2026-08-31T11:00:00.000Z')`,
            )
            .run();
        before.close();

        const after = openDatabase(file);
        try {
            expect(after.prepare('SELECT diff_id, file_id FROM file_progress').all()).toEqual([
                { diff_id: 'unknown', file_id: 'file-1' },
            ]);
            // Отметка остановки без снапшота ни к чему не относится.
            expect(after.prepare('SELECT COUNT(*) AS count FROM stop_progress').get()).toMatchObject({
                count: 0,
            });
        } finally {
            after.close();
        }
    });

    // Заметка накопленной БД стоит там, где её закрепили: раньше исходного места в схеме не было.
    it('миграция якорей заметок заполняет исходное место копией текущего', () => {
        const file = `${sherpaDir}/notes-anchors.db`;
        const anchor = {
            diffId: 'iter-1',
            fileId: 'file-1',
            path: 'src/main.ts',
            side: 'new',
            start: 10,
            end: 12,
        };

        const before = openDatabase(file, migrationsBefore('014-notes-anchors'));
        before
            .prepare(
                `INSERT INTO chat_exchanges (
                    id, question, anchor, status, answer, progress_text, error, task_id, head_commit,
                    created_at, updated_at
                 ) VALUES (1, 'вопрос', ?, 'done', 'ответ', NULL, NULL, NULL, 'head-1', ?, ?)`,
            )
            .run(JSON.stringify(anchor), '2026-08-25T10:00:00.000Z', '2026-08-25T10:00:00.000Z');
        before
            .prepare(
                `INSERT INTO agent_notes (id, exchange_id, anchor, text, commit_hash, created_at)
                 VALUES (1, 1, ?, 'ответ', 'head-1', ?)`,
            )
            .run(JSON.stringify(anchor), '2026-08-25T10:00:00.000Z');
        before.close();

        const after = openDatabase(file);
        try {
            const store = new ChatStore({ db: after });
            const note = store.read().notes[0];
            expect(note?.anchor).toEqual(anchor);
            expect(note?.origin).toEqual({ commit: 'head-1', anchor });
            expect(note?.lostAnchor).toBe(false);
            store.close();
        } finally {
            after.close();
        }
    });

    // Буфер черновиков приезжает пустой таблицей и накопленному стейту не мешает.
    it('миграция буфера черновиков заводит таблицу с проверкой состояния', () => {
        const file = `${sherpaDir}/draft-buffer.db`;

        const before = openDatabase(file, migrationsBefore('018-draft-buffer'));
        before.close();

        const after = openDatabase(file);
        try {
            const insert = after.prepare(
                `INSERT INTO draft_buffer (
                    id, comment_id, draft_json, state, error, attempts, idempotency_key, created_at, updated_at
                 ) VALUES (?, NULL, '{}', ?, NULL, 0, 'key-1', ?, ?)`,
            );
            insert.run('ck-1', 'pending', '2026-09-03T10:00:00.000Z', '2026-09-03T10:00:00.000Z');
            expect(after.prepare('SELECT id, state, attempts FROM draft_buffer').all()).toEqual([
                { id: 'ck-1', state: 'pending', attempts: 0 },
            ]);
            expect(() => {
                insert.run('ck-2', 'sent', '2026-09-03T10:00:00.000Z', '2026-09-03T10:00:00.000Z');
            }).toThrow();

            // Пары «ключ записи → созданный черновик» живут отдельно: строка буфера после
            // успеха исчезает, а помнить о созданном комментарии надо и дальше.
            after.prepare('INSERT INTO draft_buffer_saved (id, comment_id, created_at) VALUES (?, ?, ?)').run(
                'ck-1',
                'c-42',
                '2026-09-03T10:00:01.000Z',
            );
            expect(after.prepare('SELECT id, comment_id FROM draft_buffer_saved').all()).toEqual([
                { id: 'ck-1', comment_id: 'c-42' },
            ]);
        } finally {
            after.close();
        }
    });

    // Язык обмена приезжает пустой колонкой: накопленные обмены остаются русскими.
    it('миграция языка чата заводит колонку, а старые обмены читаются как русские', () => {
        const file = `${sherpaDir}/chat-locale.db`;
        const at = '2026-09-04T10:00:00.000Z';

        const before = openDatabase(file, migrationsBefore('020-chat-locale'));
        before
            .prepare(
                `INSERT INTO chat_exchanges (
                    id, question, anchor, status, answer, progress_text, error, task_id, head_commit,
                    created_at, updated_at
                 ) VALUES (1, 'вопрос старого обмена', NULL, 'done', 'ответ', NULL, NULL, NULL, 'head-1', ?, ?)`,
            )
            .run(at, at);
        before.close();

        const after = openDatabase(file);
        try {
            expect(readSchemaVersion(after)).toBe(String(MIGRATIONS.length));
            expect(after.prepare('SELECT id, locale FROM chat_exchanges').all()).toEqual([
                { id: 1, locale: null },
            ]);

            const store = new ChatStore({ db: after });
            // `null` в колонке — обмен, записанный до появления языка: контракт отдаёт его как «языка не знаем».
            expect(store.read().exchanges[0]?.locale).toBeNull();
            store.close();
        } finally {
            after.close();
        }
    });

    // Накопленная доитерационная БД переезжает целиком — всей цепочкой миграций 010…015 сразу.
    it('цепочка миграций доводит доитерационную базу до итераций, ничего не теряя', () => {
        const file = `${sherpaDir}/legacy-to-iterations.db`;
        const at = '2026-08-25T10:00:00.000Z';
        const snapshot = {
            snapshotId: 'snap-legacy-iter',
            commit: 'head-legacy',
            diffId: 'iter-legacy',
            createdAt: at,
            provenance: { harness: 'claude-code', model: 'opus', locale: null },
            summary: 'маршрут, построенный до итераций',
            stops: [],
            tourOrder: [],
            contentHash: 'abcdef123456',
        };
        // Якорь старой заметки итерацию не называет: этого поля в схеме ещё не было.
        const anchor = { fileId: 'file-1', path: 'src/main.ts', side: 'new', start: 10, end: 12 };

        const before = openDatabase(file, migrationsBefore('010-iterations'));
        before
            .prepare(
                `INSERT INTO route_state (id, phase, small_pr, snapshot, intents, updated_at)
                 VALUES (1, 'ready', 0, ?, '[]', ?)`,
            )
            .run(JSON.stringify(snapshot), at);
        before.prepare('INSERT INTO stop_progress (stop_id, viewed, updated_at) VALUES (?, 1, ?)').run('s01', at);
        before.prepare('INSERT INTO stop_progress (stop_id, viewed, updated_at) VALUES (?, 1, ?)').run('s03', at);
        before.prepare('INSERT INTO file_progress (file_id, viewed, updated_at) VALUES (?, 1, ?)').run('file-1', at);
        before
            .prepare(
                `INSERT INTO file_seen_ranges (file_id, side, start_line, end_line, source_stop_id)
                 VALUES ('file-1', 'new', 3, 7, 's01')`,
            )
            .run();
        before
            .prepare(
                `INSERT INTO chat_exchanges (
                    id, question, anchor, status, answer, progress_text, error, task_id, head_commit,
                    created_at, updated_at
                 ) VALUES (1, 'вопрос', ?, 'done', 'ответ', NULL, NULL, NULL, 'head-legacy', ?, ?)`,
            )
            .run(JSON.stringify(anchor), at, at);
        before
            .prepare(
                `INSERT INTO agent_notes (id, exchange_id, anchor, text, commit_hash, created_at)
                 VALUES (1, 1, ?, 'ответ', 'head-legacy', ?)`,
            )
            .run(JSON.stringify(anchor), at);
        before.close();

        const after = openDatabase(file);
        try {
            expect(readSchemaVersion(after)).toBe(String(MIGRATIONS.length));

            // Снапшот доехал блобом как есть и остался текущим маршрутом PR.
            const store = new RouteStore({ db: after });
            expect(store.current()?.snapshotId).toBe('snap-legacy-iter');
            expect(after.prepare('SELECT snapshot_json FROM route_snapshots').get()).toMatchObject({
                snapshot_json: JSON.stringify(snapshot),
            });

            // Отметки остановок ключуются снапшотом, а не PR; `carried` — про перенос, которого
            // у этих отметок не было: их поставил ревьюер руками.
            expect(after.prepare('SELECT snapshot_id, stop_id, carried FROM stop_progress ORDER BY stop_id').all()).toEqual([
                { snapshot_id: 'snap-legacy-iter', stop_id: 's01', carried: 0 },
                { snapshot_id: 'snap-legacy-iter', stop_id: 's03', carried: 0 },
            ]);

            // Итераций в такой базе нет вовсе, поэтому прогресс уезжает на итерацию снапшота:
            // именно её ревьюер и читал. `LEGACY_DIFF_ID` достаётся только базе без маршрута.
            expect(after.prepare('SELECT diff_id, file_id, viewed FROM file_progress').all()).toEqual([
                { diff_id: 'iter-legacy', file_id: 'file-1', viewed: 1 },
            ]);
            expect(
                after.prepare('SELECT diff_id, start_line, end_line, carried_from FROM file_seen_ranges').all(),
            ).toEqual([{ diff_id: 'iter-legacy', start_line: 3, end_line: 7, carried_from: null }]);
            expect(after.prepare('SELECT COUNT(*) AS count FROM progress_carries').get()).toMatchObject({ count: 0 });

            // Якорь без итерации читается как `LEGACY_DIFF_ID` — его усыновит фид, когда хост
            // назовёт активную; исходное место заметки заполнено копией текущего.
            const chat = new ChatStore({ db: after });
            const note = chat.read().notes[0];
            expect(note?.anchor).toEqual({ ...anchor, diffId: 'unknown' });
            expect(note?.origin).toEqual({ commit: 'head-legacy', anchor: { ...anchor, diffId: 'unknown' } });
            expect(note?.lostAnchor).toBe(false);
            chat.close();
        } finally {
            after.close();
        }
    });

    // Апгрейд накопленной БД 0.3.x: прогресс есть, итераций нет — перенос обязан его найти.
    it('после апгрейда 0.3.x отметки переезжают на итерацию, на которой сервер поднялся', async () => {
        const file = `${sherpaDir}/legacy-carry.db`;
        const at = '2026-08-25T10:00:00.000Z';
        const v1 = fixtureIteration('medium', 0);
        const v2 = fixtureIteration('medium', 1);
        // Файл, которого срез v1→v2 не касается: его отметки обязаны доехать целиком.
        const source = v1.diff.files[0];
        const target = v2.diff.files[0];
        if (source === undefined || target === undefined) {
            throw new Error('у фикстуры medium нет файлов');
        }
        const snapshot = {
            snapshotId: 'snap-legacy-iter',
            commit: v1.iteration.headCommit,
            diffId: v1.iteration.diffId,
            createdAt: at,
            provenance: { harness: 'claude-code', model: 'opus' },
            summary: 'маршрут, построенный до итераций',
            stops: [
                {
                    id: 's01',
                    planIndex: 1,
                    tier: 'high',
                    title: 'Окно редактирования',
                    status: 'ready',
                    paragraph: 'что изменилось',
                    bridge: null,
                    anchors: [
                        {
                            fileId: source.fileId,
                            path: source.path,
                            side: 'new',
                            start: 1,
                            end: 5,
                            collapsed: false,
                        },
                    ],
                    tests: [],
                    droppedClaims: 0,
                    validationNotes: [],
                    provenance: null,
                },
            ],
            tourOrder: ['s01'],
            contentHash: 'abcdef123456',
        };

        const before = openDatabase(file, migrationsBefore('010-iterations'));
        before
            .prepare(
                `INSERT INTO route_state (id, phase, small_pr, snapshot, intents, updated_at)
                 VALUES (1, 'ready', 0, ?, '[]', ?)`,
            )
            .run(JSON.stringify(snapshot), at);
        before.prepare('INSERT INTO stop_progress (stop_id, viewed, updated_at) VALUES (?, 1, ?)').run('s01', at);
        before
            .prepare('INSERT INTO file_progress (file_id, viewed, updated_at) VALUES (?, 1, ?)')
            .run(source.fileId, at);
        before
            .prepare(
                `INSERT INTO file_seen_ranges (file_id, side, start_line, end_line, source_stop_id)
                 VALUES (?, 'new', 1, 5, 's01')`,
            )
            .run(source.fileId);
        before.close();

        const db = openDatabase(file);
        try {
            // Итераций в базе 0.3.x нет вовсе: искать источник по таблице `iterations` бесполезно.
            expect(db.prepare('SELECT COUNT(*) AS count FROM iterations').get()).toMatchObject({ count: 0 });

            const iterations = new IterationStore({ db });
            const route = new RouteStore({ db });
            const progress = new ProgressStore({ db, iterations, log: () => undefined });
            const host = makeFixtureHost('medium');
            // Пуш случился, пока сервер лежал: он поднимается уже на второй итерации.
            host.advanceIteration();
            const feed = new IterationFeed({
                host,
                iterations,
                route,
                progress,
                log: () => undefined,
            });
            const release = feed.subscribe(() => undefined);
            try {
                for (let attempt = 0; attempt < 200; attempt += 1) {
                    if (progress.read(v2.iteration.diffId).length > 0) {
                        break;
                    }
                    await new Promise((resolve) => setTimeout(resolve, 5));
                }

                expect(progress.read(v2.iteration.diffId)).toEqual([
                    { fileId: target.fileId, viewed: true, seenRanges: [{ side: 'new', start: 1, end: 5 }] },
                ]);
                expect(
                    db.prepare('SELECT from_diff_id, to_diff_id FROM progress_carries').all(),
                ).toEqual([{ from_diff_id: v1.iteration.diffId, to_diff_id: v2.iteration.diffId }]);
            } finally {
                release();
                feed.close();
                progress.close();
                route.close();
            }
        } finally {
            db.close();
        }
    });

    it('схема содержит служебные таблицы и очередь задач с индексом планировщика', () => {
        const db = openDatabase(`${sherpaDir}/tables.db`);
        try {
            const objects = db
                .prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'index') ORDER BY name")
                .all() as { name: string }[];

            expect(objects.map((row) => row.name)).toEqual(
                expect.arrayContaining(['meta', 'migrations', 'tasks', 'tasks_scheduler', 'worker']),
            );
        } finally {
            db.close();
        }
    });

    it('падение миграции не оставляет открытого соединения и половины схемы', () => {
        const file = `${sherpaDir}/broken.db`;

        expect(() =>
            openDatabase(file, [
                { name: '001-meta', sql: 'CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);' },
                { name: '002-broken', sql: 'CREATE TABLE ok (id INTEGER); СИНТАКСИЧЕСКИЙ МУСОР;' },
            ]),
        ).toThrow();

        const db = new DatabaseSync(file, { readOnly: true });
        try {
            const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as {
                name: string;
            }[];
            expect(tables.map((row) => row.name)).not.toContain('ok');
        } finally {
            db.close();
        }
    });

    // Список append-only: имя — вечный ключ применённой миграции, номер — её место в порядке.
    it('список миграций: имена уникальны, номера идут подряд, sql непустой', () => {
        const names = MIGRATIONS.map((migration) => migration.name);

        expect(new Set(names).size).toBe(names.length);
        expect(names.map((name) => Number(name.slice(0, 3)))).toEqual(
            MIGRATIONS.map((_migration, index) => index + 1),
        );
        for (const migration of MIGRATIONS) {
            expect(migration.name).toMatch(/^\d{3}-[a-z0-9-]+$/);
            expect(migration.sql.trim()).not.toBe('');
        }
    });

    // Апгрейд скилла застаёт БД на любой из прошлых версий: каждая должна достраиваться до текущей.
    it('база, застывшая на любом префиксе списка, достраивается до полной схемы', () => {
        for (let applied = 1; applied <= MIGRATIONS.length; applied += 1) {
            const file = `${sherpaDir}/prefix-${String(applied)}.db`;

            const partial = openDatabase(file, MIGRATIONS.slice(0, applied));
            expect(readSchemaVersion(partial)).toBe(String(applied));
            partial.close();

            const full = openDatabase(file);
            try {
                expect(readSchemaVersion(full)).toBe(String(MIGRATIONS.length));
                expect(full.prepare('SELECT COUNT(*) AS count FROM migrations').get()).toMatchObject({
                    count: MIGRATIONS.length,
                });
            } finally {
                full.close();
            }
        }
    });

    // Сервер поднимался без хоста итераций, но маршрут построить успел: его снапшот и называет итерацию.
    it('миграция прогресса без активной итерации уводит записи на итерацию текущего снапшота', () => {
        const file = `${sherpaDir}/progress-snapshot.db`;

        const before = openDatabase(file, migrationsBefore('013-progress-iterations'));
        before
            .prepare(
                `INSERT INTO iterations (diff_id, base_commit, head_commit, created_at, status, diff_json, fetched_at)
                 VALUES ('iter-snap', 'base', 'head-snap', '2026-08-30T10:00:00.000Z', 'previous', '{}', '2026-08-30T10:00:00.000Z')`,
            )
            .run();
        before
            .prepare(
                `INSERT INTO route_snapshots (snapshot_id, diff_id, created_at, snapshot_json)
                 VALUES ('snap-1', 'iter-snap', '2026-08-31T11:00:00.000Z', '{}')`,
            )
            .run();
        before
            .prepare(
                `INSERT INTO route_state (id, phase, small_pr, current_snapshot_id, intents, updated_at)
                 VALUES (1, 'ready', 0, 'snap-1', '[]', '2026-08-31T11:00:00.000Z')`,
            )
            .run();
        before
            .prepare(
                `INSERT INTO file_progress (file_id, viewed, updated_at)
                 VALUES ('file-1', 1, '2026-08-31T11:00:00.000Z')`,
            )
            .run();
        before
            .prepare(
                `INSERT INTO file_seen_ranges (file_id, side, start_line, end_line, source_stop_id)
                 VALUES ('file-1', 'new', 3, 7, 's01')`,
            )
            .run();
        before.close();

        const after = openDatabase(file);
        try {
            expect(after.prepare('SELECT diff_id, file_id FROM file_progress').all()).toEqual([
                { diff_id: 'iter-snap', file_id: 'file-1' },
            ]);
            expect(after.prepare('SELECT diff_id, file_id FROM file_seen_ranges').all()).toEqual([
                { diff_id: 'iter-snap', file_id: 'file-1' },
            ]);
        } finally {
            after.close();
        }
    });

    // Учёт переноса заводится нулём: остановки, дожившие до него, ещё никуда не переносились.
    it('миграция учёта переноса ставит существующим остановкам carried = 0', () => {
        const file = `${sherpaDir}/stop-carried.db`;

        const before = openDatabase(file, migrationsBefore('015-stop-carried'));
        before
            .prepare(
                `INSERT INTO stop_progress (snapshot_id, stop_id, viewed, updated_at)
                 VALUES ('snap-1', 's01', 1, '2026-08-31T11:00:00.000Z'),
                        ('snap-1', 's02', 0, '2026-08-31T11:00:00.000Z')`,
            )
            .run();
        before.close();

        const after = openDatabase(file);
        try {
            expect(after.prepare('SELECT stop_id, viewed, carried FROM stop_progress ORDER BY stop_id').all()).toEqual([
                { stop_id: 's01', viewed: 1, carried: 0 },
                { stop_id: 's02', viewed: 0, carried: 0 },
            ]);
        } finally {
            after.close();
        }
    });

    // Бэкфилла путей нет: старые `fileId` разрешать нечем, и выдумывать путь миграция не должна.
    it('миграция путей прогресса заводит колонки пустыми', () => {
        const file = `${sherpaDir}/progress-paths.db`;

        const before = openDatabase(file, migrationsBefore('016-progress-paths'));
        before
            .prepare(
                `INSERT INTO file_progress (diff_id, file_id, viewed, updated_at)
                 VALUES ('iter-1', 'file-1', 1, '2026-08-31T11:00:00.000Z')`,
            )
            .run();
        before
            .prepare(
                `INSERT INTO file_seen_ranges (diff_id, file_id, side, start_line, end_line, source_stop_id, carried_from)
                 VALUES ('iter-1', 'file-1', 'new', 3, 7, 's01', NULL)`,
            )
            .run();
        before.close();

        const after = openDatabase(file);
        try {
            expect(after.prepare('SELECT file_id, path FROM file_progress').all()).toEqual([
                { file_id: 'file-1', path: null },
            ]);
            expect(after.prepare('SELECT file_id, path FROM file_seen_ranges').all()).toEqual([
                { file_id: 'file-1', path: null },
            ]);
        } finally {
            after.close();
        }
    });
});

import path from 'node:path';

import { chatFixtures, fixtureData, fixtureIteration, makeFixtureHost } from '@sherpa/fixtures';
import type { AgentNote, Iteration, RouteSnapshot } from '@sherpa/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ChatStore } from './chat-store.js';
import type { SherpaDatabase } from './db.js';
import { openDatabase } from './db.js';
import type { NoteCarrier } from './iteration-feed.js';
import { IterationFeed, staleFor } from './iteration-feed.js';
import { IterationStore } from './iteration-store.js';
import { ProgressStore } from './progress-store.js';
import type { RouteListener } from './route-store.js';
import { UNKNOWN_BASE_COMMIT } from './route-store.js';
import { mediumReadySnapshot } from './route/fixture-support.js';
import { makeTempSherpaDir, removeTempSherpaDir, seedAgentNotes } from './test-support.js';

/**
 * Детект пуша: объединённый список итераций, признак «маршрут устарел» и затронутые
 * остановки. Фикстура `medium` даёт три итерации, третья — force-push поверх второй.
 */

/** Мета итерации фикстуры `medium`: v1, обычный пуш v2 и force-push v3 поверх второй. */
function fixtureIterationMeta(index: number): Omit<Iteration, 'status'> {
    const meta = fixtureData('medium').iterations[index]?.iteration;
    if (meta === undefined) {
        throw new Error(`у фикстуры medium нет итерации ${String(index + 1)}`);
    }
    return meta;
}

const V1 = fixtureIterationMeta(0);
const V2 = fixtureIterationMeta(1);
const V3 = fixtureIterationMeta(2);
const NOTES = chatFixtures('medium')?.notes ?? [];
const NOTES_AFTER_PUSH = chatFixtures('medium')?.notesAfterPush ?? [];

function iterationOf(source: Omit<Iteration, 'status'>, status: Iteration['status']): Iteration {
    return { ...source, status };
}

function snapshotOn(iteration: Omit<Iteration, 'status'>): RouteSnapshot {
    return { ...mediumReadySnapshot(), diffId: iteration.diffId, commit: iteration.headCommit };
}

/** Ждёт условия, пока не сойдётся: интердифф считается асинхронно и своего события не даёт. */
async function waitFor(condition: () => boolean): Promise<void> {
    for (let attempt = 0; attempt < 200 && !condition(); attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(condition()).toBe(true);
}

describe('правило stale', () => {
    it('снапшота нет — сравнивать нечего', () => {
        expect(staleFor(null, [iterationOf(V1, 'active')])).toBeNull();
    });

    it('активная итерация неизвестна — фид ещё не стартовал', () => {
        expect(staleFor(snapshotOn(V1), [])).toBeNull();
    });

    it('снапшот на активной итерации не устарел', () => {
        expect(staleFor(snapshotOn(V1), [iterationOf(V1, 'active')])).toBeNull();
    });

    it('снапшот прошлой итерации устарел и называет обе стороны', () => {
        expect(staleFor(snapshotOn(V1), [iterationOf(V1, 'previous'), iterationOf(V2, 'active')])).toEqual({
            routeCommit: V1.headCommit,
            prCommit: V2.headCommit,
            prDiffId: V2.diffId,
            newIterations: 1,
            affectedStopIds: [],
        });
    });

    it('force-push считается за одну итерацию: переписанная в счёт не идёт', () => {
        const stale = staleFor(snapshotOn(V1), [
            iterationOf(V1, 'previous'),
            iterationOf(V2, 'gone'),
            iterationOf(V3, 'active'),
        ]);
        expect(stale).toMatchObject({ newIterations: 1, prDiffId: V3.diffId });
    });

    it('снапшот на переписанной итерации всё равно устарел', () => {
        const stale = staleFor(snapshotOn(V2), [
            iterationOf(V1, 'previous'),
            iterationOf(V2, 'gone'),
            iterationOf(V3, 'active'),
        ]);
        expect(stale).toMatchObject({ newIterations: 1, routeCommit: V2.headCommit });
    });

    it('итерации снапшота нет в списке — считаем с начала истории, но не меньше одной', () => {
        const stale = staleFor(snapshotOn(V1), [iterationOf(V3, 'active')]);
        expect(stale).toMatchObject({ newIterations: 1, prDiffId: V3.diffId });
    });
});

describe('фид итераций', () => {
    let sherpaDir: string;
    let db: SherpaDatabase;
    let store: IterationStore;
    let feed: IterationFeed;
    let snapshot: RouteSnapshot | null;
    /** История снапшотов PR: из неё фид достаёт базу итерации, которой нет в списке хоста. */
    let snapshots: RouteSnapshot[];
    let routeListeners: Set<RouteListener>;
    let routeRevision: number;
    let revisions: number[];
    let logs: string[];

    beforeEach(async () => {
        sherpaDir = await makeTempSherpaDir();
        db = openDatabase(path.join(sherpaDir, 'feed.db'));
        store = new IterationStore({ db });
        snapshot = null;
        snapshots = [];
        routeListeners = new Set();
        routeRevision = 0;
        revisions = [];
        logs = [];
    });

    afterEach(async () => {
        feed.close();
        db.close();
        await removeTempSherpaDir(sherpaDir);
    });

    /** Фид над фикстурным хостом; снапшот маршрута подменяется прямо в тесте. */
    function makeFeed(
        host = makeFixtureHost('medium'),
        notes: NoteCarrier | null = null,
        progress: ProgressStore | null = null,
        carryRetryMs = 5,
    ): { host: ReturnType<typeof makeFixtureHost> } {
        feed = new IterationFeed({
            host,
            notes,
            progress,
            carryRetryMs,
            iterations: store,
            route: {
                current: () => snapshot,
                listSnapshots: () => [...snapshots],
                subscribe: (listener) => {
                    routeListeners.add(listener);
                    return () => {
                        routeListeners.delete(listener);
                    };
                },
            },
            log: (message) => logs.push(message),
        });
        return { host };
    }

    /** Смена снапшота маршрута с уведомлением фида — так это делает `RouteStore`. */
    function setSnapshot(next: RouteSnapshot): void {
        snapshot = next;
        snapshots.push(next);
        routeRevision += 1;
        for (const listener of [...routeListeners]) {
            listener(routeRevision);
        }
    }

    function listen(): () => void {
        return feed.subscribe((revision) => revisions.push(revision));
    }

    it('до подписки список пуст, после — приходит из хоста', () => {
        makeFeed();
        expect(feed.iterations()).toEqual([]);
        expect(feed.active()).toBeNull();

        listen();

        expect(feed.iterations().map((iteration) => iteration.diffId)).toEqual([V1.diffId]);
        expect(feed.active()?.diffId).toBe(V1.diffId);
        expect(revisions).toEqual([1]);
    });

    it('патч активной итерации оседает в хранилище', async () => {
        makeFeed();
        listen();

        await waitFor(() => store.get(V1.diffId) !== null);
        expect(store.get(V1.diffId)?.diff.headCommit).toBe(V1.headCommit);
    });

    it('патч чужой итерации не оседает в хранилище и не отдаётся вызвавшему', async () => {
        const host = makeFixtureHost('medium');
        // Пока грузился патч v1, автор запушил: хост отвечает уже патчем v2.
        host.getDiff = (slice) =>
            slice === undefined
                ? Promise.resolve(fixtureIteration('medium', 1).diff)
                : makeFixtureHost('medium').getDiff(slice);
        makeFeed(host);
        listen();

        await waitFor(() => logs.length > 0);
        expect(logs.some((message) => message.includes(V2.diffId))).toBe(true);
        expect(store.get(V1.diffId)).toBeNull();
        expect(store.get(V2.diffId)).toBeNull();
    });

    it('пуш делает снапшот устаревшим, затронутые остановки приезжают вторым уведомлением', async () => {
        const { host } = makeFeed();
        snapshot = snapshotOn(V1);
        listen();
        expect(feed.staleFor(snapshot)).toBeNull();

        host.advanceIteration();

        expect(feed.active()?.diffId).toBe(V2.diffId);
        // Список итераций публикуется сразу: ждать интердифф Арканума (2.8–3.7 с) баннеру нельзя.
        expect(feed.staleFor(snapshot)).toEqual({
            routeCommit: V1.headCommit,
            prCommit: V2.headCommit,
            prDiffId: V2.diffId,
            newIterations: 1,
            affectedStopIds: [],
        });
        const beforeInterdiff = revisions.length;

        await waitFor(() => (feed.staleFor(snapshot)?.affectedStopIds.length ?? 0) > 0);

        expect(feed.staleFor(snapshot)?.affectedStopIds).toEqual(['s02', 's03', 's06']);
        expect(revisions.length).toBeGreaterThan(beforeInterdiff);
    });

    it('якоря снапшота дописала приёмка секции — затронутые остановки пересчитываются', async () => {
        const { host } = makeFeed();
        // Пуш застал генерацию: скелет уже принят, но якорей у стопов ещё нет.
        const bare = { ...snapshotOn(V1), stops: mediumReadySnapshot().stops.map((stop) => ({ ...stop, anchors: [] })) };
        setSnapshot(bare);
        listen();
        host.advanceIteration();

        // Первый расчёт честно даёт пустой список: сравнивать интердифф не с чем.
        await waitFor(() => revisions.length >= 3);
        expect(feed.staleFor(snapshot)?.affectedStopIds).toEqual([]);

        setSnapshot(snapshotOn(V1));

        await waitFor(() => (feed.staleFor(snapshot)?.affectedStopIds.length ?? 0) > 0);
        expect(feed.staleFor(snapshot)?.affectedStopIds).toEqual(['s02', 's03', 's06']);
    });

    it('после force-push переписанная итерация становится gone, а прошлый снапшот — устаревшим', async () => {
        const { host } = makeFeed();
        snapshot = snapshotOn(V1);
        listen();
        host.advanceIteration();
        await waitFor(() => store.get(V2.diffId) !== null);

        host.advanceIteration();

        expect(feed.iterations().map((iteration) => [iteration.diffId, iteration.status])).toEqual([
            [V1.diffId, 'previous'],
            [V2.diffId, 'gone'],
            [V3.diffId, 'active'],
        ]);
        expect(feed.staleFor(snapshot)).toMatchObject({ newIterations: 1, prDiffId: V3.diffId });
    });

    it('хост без срезов оставляет баннер без остановок и жалуется один раз', async () => {
        const host = makeFixtureHost('medium');
        host.getDiff = (slice) =>
            slice === undefined
                ? makeFixtureHost('medium').getDiff()
                : Promise.reject(new Error('срезы этому хосту недоступны'));
        makeFeed(host);
        snapshot = snapshotOn(V1);
        listen();
        host.advanceIteration();

        await waitFor(() => logs.length > 0);
        host.advanceIteration();
        await waitFor(() => feed.active()?.diffId === V3.diffId);

        expect(feed.staleFor(snapshot)?.affectedStopIds).toEqual([]);
        expect(logs.filter((message) => message.includes('затронутые остановки'))).toHaveLength(1);
    });

    /**
     * Заметки фикстуры на той же БД. Возвращённый носитель — тот же стор, но с записью пар
     * переноса: тест обязан видеть, что фид зовёт миграцию один раз и с правильной парой.
     */
    function makeNotes(seed: readonly AgentNote[]): { chat: ChatStore; carrier: NoteCarrier; calls: string[] } {
        const chat = new ChatStore({ db });
        seedAgentNotes(db, seed);
        const calls: string[] = [];
        const carrier: NoteCarrier = {
            adoptLegacyAnchors: (diffId) => chat.adoptLegacyAnchors(diffId),
            read: () => chat.read(),
            migrateNotes: (from, to, map, fileIdOf, headCommit) => {
                calls.push(`${from} ${to}`);
                return chat.migrateNotes(from, to, map, fileIdOf, headCommit);
            },
        };
        return { chat, carrier, calls };
    }

    it('пуш перевозит якоря заметок на активную итерацию — один раз и той же парой', async () => {
        const notes = makeNotes(NOTES);
        const { host } = makeFeed(makeFixtureHost('medium'), notes.carrier);
        listen();
        // На своей итерации переносить нечего: пары `from → to` ещё нет.
        expect(notes.calls).toEqual([]);

        host.advanceIteration();

        await waitFor(() => notes.chat.read().notes.some((note) => note.anchor.diffId === V2.diffId));
        expect(notes.chat.read().notes).toEqual(NOTES_AFTER_PUSH);
        expect(notes.calls).toEqual([`${V1.diffId} ${V2.diffId}`]);
    });

    it('срез пары спрашивается у хоста один раз: остановки и якоря ждут один запрос', async () => {
        const host = makeFixtureHost('medium');
        const slices: string[] = [];
        const original = host.getDiff.bind(host);
        host.getDiff = async (slice) => {
            if (slice === undefined) {
                return original(slice);
            }
            slices.push(`${slice.base} ${slice.head}`);
            // Срез у Арканума идёт секунды: без задержки оба потребителя не успевают встретиться.
            await new Promise((resolve) => setTimeout(resolve, 20));
            return original(slice);
        };
        const notes = makeNotes(NOTES);
        makeFeed(host, notes.carrier);
        // Снапшот маршрута стоит на той же итерации, что и заметки: пара среза у них общая.
        snapshot = snapshotOn(V1);
        listen();

        host.advanceIteration();

        await waitFor(() => notes.chat.read().notes.some((note) => note.anchor.diffId === V2.diffId));
        await waitFor(() => (feed.staleFor(snapshot)?.affectedStopIds.length ?? 0) > 0);
        expect(slices).toEqual([`${V1.diffId} ${V2.diffId}`]);
    });

    it('отказ хоста на срезе не хоронит якоря: перенос повторяется', async () => {
        const host = makeFixtureHost('medium');
        const original = host.getDiff.bind(host);
        let refusals = 0;
        host.getDiff = (slice) => {
            if (slice !== undefined && refusals < 1) {
                refusals += 1;
                return Promise.reject(new Error('срез не отдался: сеть'));
            }
            return original(slice);
        };
        const notes = makeNotes(NOTES);
        makeFeed(host, notes.carrier);
        listen();

        host.advanceIteration();

        // Нового пуша не будет: якоря переезжают на повторе по таймеру, а не на следующем списке.
        await waitFor(() => logs.some((message) => message.includes('якоря заметок')));
        await waitFor(() => notes.chat.read().notes.some((note) => note.anchor.diffId === V2.diffId));
        expect(notes.chat.read().notes).toEqual(NOTES_AFTER_PUSH);
    });

    it('хост без срезов: перенести нечем — заметки прошлой итерации теряют якорь', async () => {
        const host = makeFixtureHost('medium');
        const pr = await host.getPr();
        host.getPr = () => Promise.resolve({ ...pr, capabilities: { ...pr.capabilities, iterations: false } });
        const notes = makeNotes(NOTES);
        makeFeed(host, notes.carrier);
        listen();

        host.advanceIteration();

        await waitFor(() => notes.chat.read().notes.every((note) => note.lostAnchor));
        // Якорь остаётся последним удачным: заметка уходит из кода, но помнит своё место.
        expect(notes.chat.read().notes.map((note) => note.anchor)).toEqual(NOTES.map((note) => note.anchor));
    });

    /** Прогресс чтения на той же БД: состоявшиеся переносы видны в `progress_carries`. */
    function makeProgress(): ProgressStore {
        return new ProgressStore({ db, iterations: store, log: (message) => logs.push(message) });
    }

    /** Просмотренный кусок файла — так его записала бы читалка. */
    function seedSeenRange(diffId: string, fileId: string): void {
        db.prepare(
            `INSERT INTO file_seen_ranges (diff_id, file_id, side, start_line, end_line)
             VALUES (?, ?, 'new', 1, 2)`,
        ).run(diffId, fileId);
    }

    /** Пары «источник → цель», перенос прогресса между которыми уже состоялся. */
    function progressCarries(): string[] {
        const rows = db
            .prepare('SELECT from_diff_id, to_diff_id FROM progress_carries ORDER BY rowid')
            .all() as { from_diff_id: string; to_diff_id: string }[];
        return rows.map((row) => `${row.from_diff_id} ${row.to_diff_id}`);
    }

    /** `fileId` первого файла итерации фикстуры: по нему прогресс сопоставляется через путь. */
    function fixtureFileId(index: number): string {
        const fileId = fixtureIteration('medium', index).diff.files[0]?.fileId;
        if (fileId === undefined) {
            throw new Error(`у итерации ${String(index + 1)} фикстуры medium нет файлов`);
        }
        return fileId;
    }

    /** Путь того же файла: он один на все итерации, и только по нему они и сопоставляются. */
    function fixtureFilePath(index: number): string {
        const filePath = fixtureIteration('medium', index).diff.files[0]?.path;
        if (filePath === undefined) {
            throw new Error(`у итерации ${String(index + 1)} фикстуры medium нет файлов`);
        }
        return filePath;
    }

    it('источник, смётый force-push, отвергнут навсегда: заметки теряют якорь и повтора нет', async () => {
        const notes = makeNotes(NOTES);
        const { host } = makeFeed(makeFixtureHost('medium'), notes.carrier);
        listen();
        host.advanceIteration();
        await waitFor(() => notes.chat.read().notes.some((note) => note.anchor.diffId === V2.diffId));

        // Force-push: v2 уходит из списка хоста, и срез v2→v3 он не посчитает уже никогда.
        host.advanceIteration();

        await waitFor(() => notes.chat.read().notes.every((note) => note.lostAnchor));
        // Якорь и origin остаются последними удачными — заметка помнит своё место в v2.
        expect(notes.chat.read().notes).toEqual(NOTES_AFTER_PUSH.map((note) => ({ ...note, lostAnchor: true })));
        expect(notes.calls.filter((call) => call === `${V2.diffId} ${V3.diffId}`)).toHaveLength(1);
        expect(
            logs.some((message) => message.includes(`срез ${V2.diffId}→${V3.diffId} хост отверг окончательно`)),
        ).toBe(true);

        const calls = [...notes.calls];
        await new Promise((resolve) => setTimeout(resolve, 40));

        // Таймер повтора после окончательного отказа не ставится: пробовать нечего.
        expect(notes.calls).toEqual(calls);
        expect(logs.some((message) => message.includes('будет повтор'))).toBe(false);
    });

    it('временный отказ на срезе прогресса: повтор, а не откат на более старый источник', async () => {
        const host = makeFixtureHost('medium');
        const original = host.getDiff.bind(host);
        let refusals = 0;
        host.getDiff = (slice) => {
            if (slice !== undefined && refusals < 1) {
                refusals += 1;
                return Promise.reject(new Error('срез не отдался: сеть'));
            }
            return original(slice);
        };
        makeFeed(host, null, makeProgress());
        listen();

        await waitFor(() => store.get(V1.diffId) !== null);
        seedSeenRange(V1.diffId, fixtureFileId(0));
        // Итерация постарше, у которой прогресс тоже есть: сетевой сбой не повод съезжать на неё.
        const older = iterationOf(
            { ...V1, diffId: 'iter-older', createdAt: '2000-01-01T00:00:00.000Z' },
            'previous',
        );
        store.upsert({ ...fixtureIteration('medium', 0).diff, diffId: older.diffId }, older);
        seedSeenRange(older.diffId, fixtureFileId(0));

        host.advanceIteration();

        await waitFor(() => progressCarries().length > 0);
        expect(progressCarries()).toEqual([`${V1.diffId} ${V2.diffId}`]);
        expect(logs.some((message) => message.includes(`срез ${V1.diffId}→${V2.diffId} не получен, будет повтор`))).toBe(
            true,
        );
        expect(logs.some((message) => message.includes(older.diffId))).toBe(false);
    });

    /**
     * Снапшот маршрута итерации 0.3.x: его якоря — единственная карта путей для переноса.
     * Базы в блобе такого снапшота нет, и `RouteStore` отдаёт его с заглушкой вместо неё —
     * история снапшотов теста повторяет это ровно так же.
     */
    function seedRouteSnapshot(diffId: string, files: readonly { fileId: string; path: string }[]): void {
        const at = '2026-08-25T10:00:00.000Z';
        const snapshotId = `snap-${diffId}`;
        const stored = {
            snapshotId,
            diffId,
            createdAt: at,
            stops: [
                {
                    id: 's01',
                    anchors: files.map((file) => ({ ...file, side: 'new', start: 1, end: 5 })),
                },
            ],
        };
        db.prepare(
            `INSERT INTO route_snapshots (snapshot_id, diff_id, created_at, snapshot_json)
             VALUES (?, ?, ?, ?)`,
        ).run(snapshotId, diffId, at, JSON.stringify(stored));
        snapshots.push({
            ...snapshotOn(V1),
            snapshotId,
            diffId,
            createdAt: at,
            baseCommit: UNKNOWN_BASE_COMMIT,
        });
    }

    /** Диапазоны, приехавшие на итерацию переносом. */
    function carriedRanges(diffId: string): { file_id: string; side: string; start_line: number }[] {
        return db
            .prepare(
                `SELECT file_id, side, start_line FROM file_seen_ranges
                  WHERE diff_id = ? AND carried_from IS NOT NULL ORDER BY rowid`,
            )
            .all(diffId) as { file_id: string; side: string; start_line: number }[];
    }

    it('прогресс итерации без строки в iterations переносится по якорям её снапшота', async () => {
        // Прогресс записал сервер 0.3.x: строки об итерации нет, патча тоже.
        seedSeenRange(V1.diffId, fixtureFileId(0));
        seedRouteSnapshot(V1.diffId, [{ fileId: fixtureFileId(0), path: fixtureFilePath(0) }]);
        const host = makeFixtureHost('medium');
        // Пуш случился, пока сервер не работал: он поднимается уже на второй итерации.
        host.advanceIteration();
        makeFeed(host, null, makeProgress());
        listen();

        await waitFor(() => progressCarries().length > 0);

        expect(store.get(V1.diffId)).toBeNull();
        expect(progressCarries()).toEqual([`${V1.diffId} ${V2.diffId}`]);
        expect(carriedRanges(V2.diffId)).toEqual([
            { file_id: fixtureFileId(1), side: 'new', start_line: 1 },
        ]);
    });

    it('база источника неизвестна: старая сторона не переносится, в логе строка', async () => {
        const legacy = 'iter-0-3-x';
        const host = makeFixtureHost('medium');
        const original = host.getDiff.bind(host);
        // Итерации 0.3.x хост в списке не называет, но срез с ней считает — как Арканум.
        host.getDiff = (slice) =>
            slice?.base === legacy ? original({ base: V1.diffId, head: slice.head }) : original(slice);
        seedSeenRange(legacy, 'legacy-file');
        db.prepare(
            `INSERT INTO file_seen_ranges (diff_id, file_id, side, start_line, end_line)
             VALUES (?, 'legacy-file', 'old', 1, 2)`,
        ).run(legacy);
        seedRouteSnapshot(legacy, [{ fileId: 'legacy-file', path: fixtureFilePath(0) }]);
        host.advanceIteration();
        makeFeed(host, null, makeProgress());
        listen();

        await waitFor(() => progressCarries().length > 0);

        expect(progressCarries()).toEqual([`${legacy} ${V2.diffId}`]);
        // Старая сторона считается затронутой: сравнить базы не с чем.
        expect(carriedRanges(V2.diffId)).toEqual([
            { file_id: fixtureFileId(1), side: 'new', start_line: 1 },
        ]);
        expect(
            logs.some((message) =>
                message.includes(`перенос прогресса ${legacy} → ${V2.diffId}: база итерации ${legacy} неизвестна`),
            ),
        ).toBe(true);
    });

    it('источник не найден: строка одна на итерацию, а не на каждое событие вотчера', async () => {
        const { host, replay } = replayableHost();
        makeFeed(host, null, makeProgress());
        listen();

        await waitFor(() => logs.some((message) => message.includes('источник не найден')));
        replay();
        replay();
        await new Promise((resolve) => setTimeout(resolve, 40));

        expect(logs.filter((message) => message.includes('источник не найден'))).toEqual([
            `перенос прогресса на ${V1.diffId}: источник не найден — прогресса на других итерациях нет`,
        ]);
    });

    it('повтор поднимает оба переноса: и якоря заметок, и прогресс', async () => {
        const host = makeFixtureHost('medium');
        const original = host.getDiff.bind(host);
        let refusals = 0;
        host.getDiff = (slice) => {
            if (slice !== undefined && refusals < 2) {
                refusals += 1;
                return Promise.reject(new Error('срез не отдался: сеть'));
            }
            return original(slice);
        };
        const notes = makeNotes(NOTES);
        makeFeed(host, notes.carrier, makeProgress());
        listen();
        await waitFor(() => store.get(V1.diffId) !== null);
        seedSeenRange(V1.diffId, fixtureFileId(0));

        host.advanceIteration();

        await waitFor(() => notes.chat.read().notes.some((note) => note.anchor.diffId === V2.diffId));
        await waitFor(() => progressCarries().length > 0);
        expect(notes.chat.read().notes).toEqual(NOTES_AFTER_PUSH);
        expect(progressCarries()).toEqual([`${V1.diffId} ${V2.diffId}`]);
        expect(logs.some((message) => message.includes('якоря заметок итерации') && message.includes('будет повтор'))).toBe(
            true,
        );
        expect(logs.some((message) => message.includes('не получен, будет повтор'))).toBe(true);
    });

    it('сбой патча активной итерации якоря не хоронит, даже если источник смёл force-push', async () => {
        const host = makeFixtureHost('medium');
        const original = host.getDiff.bind(host);
        let activeDown = false;
        host.getDiff = (slice) => {
            if (slice === undefined) {
                return activeDown ? Promise.reject(new Error('хост прилёг')) : original(slice);
            }
            // Срез с v2 фикстура не считает (итерации нет в списке): подменяем ответом, чтобы
            // перенос дошёл до патча активной итерации — падать должен именно он.
            return slice.base === V2.diffId
                ? Promise.resolve(fixtureIteration('medium', 2).diff)
                : original(slice);
        };
        const notes = makeNotes(NOTES);
        makeFeed(host, notes.carrier);
        listen();
        host.advanceIteration();
        await waitFor(() => notes.chat.read().notes.some((note) => note.anchor.diffId === V2.diffId));

        const before = notes.chat.read().notes;

        activeDown = true;
        host.advanceIteration();

        await waitFor(() =>
            logs.some((message) => message.includes('якоря заметок итерации') && message.includes('будет повтор')),
        );
        // Отказал патч активной, а не срез: про источник это не говорит ничего, и якоря целы.
        expect(notes.chat.read().notes).toEqual(before);
        expect(logs.some((message) => message.includes('хост отверг окончательно'))).toBe(false);
    });

    it('сбой записи при окончательном отказе не хоронит источник молча: повтор доводит до lost_anchor', async () => {
        const notes = makeNotes(NOTES);
        const attempts: string[] = [];
        let failWrite = false;
        const carrier: NoteCarrier = {
            adoptLegacyAnchors: (diffId) => notes.carrier.adoptLegacyAnchors(diffId),
            read: () => notes.carrier.read(),
            migrateNotes: (from, to, map, fileIdOf, headCommit) => {
                attempts.push(`${from} ${to}`);
                if (failWrite) {
                    failWrite = false;
                    throw new Error('БД занята');
                }
                return notes.carrier.migrateNotes(from, to, map, fileIdOf, headCommit);
            },
        };
        const { host } = makeFeed(makeFixtureHost('medium'), carrier);
        listen();
        host.advanceIteration();
        await waitFor(() => notes.chat.read().notes.some((note) => note.anchor.diffId === V2.diffId));

        failWrite = true;
        host.advanceIteration();

        await waitFor(() => notes.chat.read().notes.every((note) => note.lostAnchor));
        expect(logs.some((message) => message.includes('якоря заметок итерации') && message.includes('будет повтор'))).toBe(
            true,
        );
        // Источник отказан только с удачной записью: сбой БД дал вторую попытку, а не тишину.
        expect(attempts.filter((call) => call === `${V2.diffId} ${V3.diffId}`)).toHaveLength(2);
    });

    it('хост без срезов не гоняет перенос прогресса по кругу', async () => {
        const host = makeFixtureHost('medium');
        const pr = await host.getPr();
        host.getPr = () => Promise.resolve({ ...pr, capabilities: { ...pr.capabilities, iterations: false } });
        const slices: string[] = [];
        const original = host.getDiff.bind(host);
        host.getDiff = (slice) => {
            if (slice !== undefined) {
                slices.push(`${slice.base} ${slice.head}`);
            }
            return original(slice);
        };
        makeFeed(host, null, makeProgress());
        listen();
        await waitFor(() => store.get(V1.diffId) !== null);
        seedSeenRange(V1.diffId, fixtureFileId(0));

        host.advanceIteration();

        await waitFor(() => logs.some((message) => message.includes('хост без срезов')));
        // Повтор каждые 5 мс дал бы десятки запросов: отказ хоста без срезов окончателен.
        await new Promise((resolve) => setTimeout(resolve, 40));
        expect(slices).toEqual([]);
        expect(logs.filter((message) => message.includes('прогресс не перенесён'))).toHaveLength(1);
        expect(progressCarries()).toEqual([]);
    });

    /**
     * Хост со счётчиком срезов и возможностью повторить событие вотчера тем же списком: так
     * выглядит поллинг Арканума, который отдал один и тот же ответ дважды.
     */
    function replayableHost(): {
        host: ReturnType<typeof makeFixtureHost>;
        slices: string[];
        replay: () => void;
    } {
        const host = makeFixtureHost('medium');
        const slices: string[] = [];
        const original = host.getDiff.bind(host);
        host.getDiff = (slice) => {
            if (slice !== undefined) {
                slices.push(`${slice.base} ${slice.head}`);
            }
            return original(slice);
        };
        let listener: ((iterations: Iteration[]) => void) | null = null;
        const watch = host.watchIterations.bind(host);
        host.watchIterations = (onChange) => {
            listener = onChange;
            return watch(onChange);
        };
        return {
            host,
            slices,
            replay: () => {
                const notify = listener;
                if (notify === null) {
                    throw new Error('вотчер итераций ещё не подписан');
                }
                void host.listIterations().then(notify);
            },
        };
    }

    /**
     * Носитель заметок, который отдельно считает результативные миграции: повторный вызов
     * `migrateNotes` на уже переехавших заметках не меняет ничего и в счёт не идёт.
     */
    function countingNotes(seed: readonly AgentNote[]): {
        chat: ChatStore;
        carrier: NoteCarrier;
        effective: string[];
    } {
        const notes = makeNotes(seed);
        const effective: string[] = [];
        const carrier: NoteCarrier = {
            adoptLegacyAnchors: (diffId) => notes.carrier.adoptLegacyAnchors(diffId),
            read: () => notes.carrier.read(),
            migrateNotes: (from, to, map, fileIdOf, headCommit) => {
                const migration = notes.carrier.migrateNotes(from, to, map, fileIdOf, headCommit);
                if (migration.moved + migration.lost > 0) {
                    effective.push(`${from} ${to}`);
                }
                return migration;
            },
        };
        return { chat: notes.chat, carrier, effective };
    }

    /**
     * Оба переноса доехали: якоря заметок на новой итерации, прогресс записан в журнал.
     * Заметка на переписанных строках якорь теряет и остаётся с прежним — отсюда `some`.
     */
    async function waitForBothCarries(chat: ChatStore): Promise<void> {
        await waitFor(() => chat.read().notes.some((note) => note.anchor.diffId === V2.diffId));
        await waitFor(() => progressCarries().length > 0);
    }

    it('повторное событие с тем же списком итераций переносы не повторяет', async () => {
        const { host, slices, replay } = replayableHost();
        const notes = countingNotes(NOTES);
        makeFeed(host, notes.carrier, makeProgress());
        listen();
        await waitFor(() => store.get(V1.diffId) !== null);
        seedSeenRange(V1.diffId, fixtureFileId(0));

        host.advanceIteration();
        await waitForBothCarries(notes.chat);

        // Поллинг хоста отдаёт тот же список ещё дважды: каждое событие перезапускает оба
        // переноса, но эффектов у них уже нет — срез лежит в кэше, а пара переноса в журнале.
        replay();
        replay();
        await new Promise((resolve) => setTimeout(resolve, 40));

        expect(slices).toEqual([`${V1.diffId} ${V2.diffId}`]);
        expect(progressCarries()).toEqual([`${V1.diffId} ${V2.diffId}`]);
        expect(notes.effective).toEqual([`${V1.diffId} ${V2.diffId}`]);
        expect(notes.chat.read().notes).toEqual(NOTES_AFTER_PUSH);
    });

    it('два события подряд посреди переноса склеиваются в один срез и один перенос', async () => {
        const { host, slices, replay } = replayableHost();
        const original = host.getDiff.bind(host);
        host.getDiff = async (slice) => {
            if (slice === undefined) {
                return original(slice);
            }
            // Срез у Арканума идёт секунды: следующие события застают перенос неоконченным.
            await new Promise((resolve) => setTimeout(resolve, 20));
            return original(slice);
        };
        const notes = countingNotes(NOTES);
        makeFeed(host, notes.carrier, makeProgress());
        listen();
        await waitFor(() => store.get(V1.diffId) !== null);
        seedSeenRange(V1.diffId, fixtureFileId(0));

        host.advanceIteration();
        replay();
        replay();

        await waitForBothCarries(notes.chat);
        await new Promise((resolve) => setTimeout(resolve, 40));

        expect(slices).toEqual([`${V1.diffId} ${V2.diffId}`]);
        expect(progressCarries()).toEqual([`${V1.diffId} ${V2.diffId}`]);
        expect(notes.effective).toEqual([`${V1.diffId} ${V2.diffId}`]);
    });

    it('уход последнего слушателя гасит подписку на хост', () => {
        const { host } = makeFeed();
        const release = listen();
        const before = revisions.length;

        release();
        host.advanceIteration();

        expect(revisions).toHaveLength(before);
    });
});

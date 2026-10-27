import path from 'node:path';

import { fixtureData, fixtureIteration, makeFixtureHost } from '@sherpa/fixtures';
import type { Iteration, RouteSnapshot } from '@sherpa/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { SherpaDatabase } from './db.js';
import { openDatabase } from './db.js';
import { IterationFeed, staleFor } from './iteration-feed.js';
import { IterationStore } from './iteration-store.js';
import type { RouteListener } from './route-store.js';
import { mediumReadySnapshot } from './route/fixture-support.js';
import { makeTempSherpaDir, removeTempSherpaDir } from './test-support.js';

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
    ): { host: ReturnType<typeof makeFixtureHost> } {
        feed = new IterationFeed({
            host,
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

    it('уход последнего слушателя гасит подписку на хост', () => {
        const { host } = makeFeed();
        const release = listen();
        const before = revisions.length;

        release();
        host.advanceIteration();

        expect(revisions).toHaveLength(before);
    });
});

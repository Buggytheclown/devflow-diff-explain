import fsSync from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import type { RouteRawResults } from '@sherpa/fixtures';
import { fixtureData, makeFixtureHost } from '@sherpa/fixtures';
import type {
    Iteration,
    PrDiff,
    RouteSectionResult,
    RouteStopChange,
    UiReviewRouteResponse,
    UiState,
} from '@sherpa/protocol';
import {
    rpcErrorSchema,
    UI_DEV_ENDPOINTS,
    UI_ENDPOINTS,
    UI_ROUTE_EVENT,
    UI_STATE_EVENT,
    uiReviewDiffResponseSchema,
    uiReviewProgressResponseSchema,
    uiReviewRouteResponseSchema,
    uiReviewSnapshotsResponseSchema,
    uiRouteEventSchema,
    uiStateSchema,
    uiChatResponseSchema,
} from '@sherpa/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openDatabase } from './db.js';
import { MIGRATIONS } from './migrations.js';
import { databasePathFor, prStateDirOf } from './paths.js';
import { requiredSeenRanges } from './progress-store.js';
import { asRawText, mediumRawResults, mediumRawResultsV2, mediumReadySnapshot } from './route/fixture-support.js';
import type { TaskRecord } from './queue.js';
import type { SherpaServer } from './server.js';
import { startServer } from './server.js';
import { get, makeTempSherpaDir, postJson, removeTempSherpaDir } from './test-support.js';

/**
 * Ручки итераций и перенос прогресса между ними на фикстурном хосте: список
 * в снапшоте UI, `stale` маршрута, история снапшотов, дифф по итерации и срез между ними,
 * переезд отметок после пуша. «Пуш» изображает дев-ручка `advance-iteration`.
 */

const PR = 'fixture-medium';
const WORKER = 'w-iterations';
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

/** Ключ общего контекста итерации — тот же, что считает `diffKeyOf`: по нему видно, чей это дифф. */
function diffKeyOf(iteration: { baseCommit: string; headCommit: string }): string {
    return `${iteration.baseCommit}-${iteration.headCommit}`;
}

describe('итерации в ручках UI', () => {
    let sherpaDir: string;
    let servers: SherpaServer[];
    let streams: SseStream[];
    /** Сколько раз хост считал срез между итерациями: кэш обязан спрашивать его один раз. */
    let sliceCalls: number;

    beforeEach(async () => {
        sherpaDir = await makeTempSherpaDir();
        servers = [];
        streams = [];
        sliceCalls = 0;
    });

    afterEach(async () => {
        for (const stream of streams) {
            stream.close();
        }
        for (const server of servers) {
            await server.close();
        }
        await removeTempSherpaDir(sherpaDir);
    });

    /** `brokenIterations` — хост не отдаёт список итераций: фид активную назвать не сможет. */
    async function start(options: { brokenIterations?: boolean } = {}): Promise<SherpaServer> {
        const host = makeFixtureHost('medium');
        const getDiff = host.getDiff.bind(host);
        host.getDiff = (slice) => {
            if (slice !== undefined) {
                sliceCalls += 1;
            }
            return getDiff(slice);
        };
        if (options.brokenIterations === true) {
            host.listIterations = () => Promise.reject(new Error('хост прилёг'));
        }
        const server = await startServer({
            prKey: PR,
            sherpaDir,
            longPollSeconds: 0.3,
            reviewHostFactory: () => ({
                name: 'fixture',
                host,
                advanceIteration: () => host.advanceIteration(),
            }),
        });
        servers.push(server);
        server.workerRegistry.register(WORKER, 'claude-code', 'opus-5');
        await server.route.warmup();
        return server;
    }

    /** Полный проход генерации: скелет и все секции сдаются фикстурными выводами модели. */
    async function completeRoute(server: SherpaServer): Promise<string> {
        const skeleton = routeTasks(server, 'route.skeleton').at(-1) ?? 0;
        completeTask(server, skeleton, mediumRawResults().skeleton);
        for (const [position, taskId] of routeTasks(server, 'route.section').entries()) {
            completeTask(server, taskId, sectionFor(position + 1));
        }
        const route = (await readRoute(server)).route;
        expect(route.phase).toBe('ready');
        return route.snapshot?.snapshotId ?? '';
    }

    /** Ждущие задачи генерации: у перестройки в очереди лежат ещё и закрытые задачи прошлой. */
    function routeTasks(server: SherpaServer, type: 'route.skeleton' | 'route.section'): number[] {
        return server.queue
            .listTasks()
            .filter((task) => task.type === type && task.status === 'queued')
            .map((task) => task.id);
    }

    function completeTask(server: SherpaServer, taskId: number, result: unknown): void {
        const leased = server.queue.next(WORKER);
        expect(leased?.task.id).toBe(taskId);
        server.queue.complete(WORKER, taskId, typeof result === 'string' ? result : asRawText(result));
    }

    function sectionFor(planIndex: number): RouteSectionResult {
        const section = mediumRawResults().sections.find((entry) => entry.stops[0]?.planIndex === planIndex);
        if (section === undefined) {
            throw new Error(`у фикстуры нет секции стопа ${String(planIndex)}`);
        }
        return section;
    }

    async function advance(server: SherpaServer): Promise<void> {
        const response = await postJson(
            server.port,
            UI_DEV_ENDPOINTS.fixtureAdvanceIteration,
            {},
            server.token,
        );
        expect(response.status).toBe(200);
    }

    async function readRoute(server: SherpaServer, query = ''): Promise<UiReviewRouteResponse> {
        const response = await get(server.port, `${UI_ENDPOINTS.reviewRoute}${query}`, server.token);
        expect(response.status).toBe(200);
        return uiReviewRouteResponseSchema.parse(await response.json());
    }

    async function readDiff(server: SherpaServer, query = ''): Promise<PrDiff> {
        const response = await get(server.port, `${UI_ENDPOINTS.reviewDiff}${query}`, server.token);
        expect(response.status).toBe(200);
        return uiReviewDiffResponseSchema.parse(await response.json()).diff;
    }

    /** SSE-канал с уже прочитанным первым снапшотом состояния. */
    async function openState(server: SherpaServer): Promise<SseStream> {
        const stream = await openSse(
            `http://127.0.0.1:${String(server.port)}${UI_ENDPOINTS.events}?token=${server.token}`,
        );
        streams.push(stream);
        return stream;
    }

    it('пуш приезжает в снапшот состояния без reload и двигает ревизию маршрута', async () => {
        const server = await start();
        await completeRoute(server);
        const stream = await openState(server);
        const before = await nextState(stream);
        expect(before.iterations.map((iteration) => [iteration.diffId, iteration.status])).toEqual([
            [V1.diffId, 'active'],
        ]);
        const beforeRoute = uiRouteEventSchema.parse(JSON.parse((await nextRoute(stream)).data));

        await advance(server);

        const after = await nextState(stream);
        expect(after.iterations.map((iteration) => [iteration.diffId, iteration.status])).toEqual([
            [V1.diffId, 'previous'],
            [V2.diffId, 'active'],
        ]);
        const afterRoute = uiRouteEventSchema.parse(JSON.parse((await nextRoute(stream)).data));
        expect(afterRoute.routeRevision).toBeGreaterThan(beforeRoute.routeRevision);
        expect(afterRoute.routeRevision).toBe((await readRoute(server)).routeRevision);
    });

    it('маршрут прошлой итерации помечен stale и назван обеими сторонами', async () => {
        const server = await start();
        const snapshotId = await completeRoute(server);
        const stream = await openState(server);
        await nextState(stream);
        expect((await readRoute(server)).route.stale).toBeNull();

        await advance(server);
        await nextState(stream);

        const route = (await readRoute(server)).route;
        expect(route.stale).toMatchObject({
            routeCommit: V1.headCommit,
            prCommit: V2.headCommit,
            prDiffId: V2.diffId,
            newIterations: 1,
        });
        // Тот же снапшот по id читается отдельно — на нём UI и остаётся после пуша.
        const past = await readRoute(server, `?snapshot=${snapshotId}`);
        expect(past.route.snapshot?.snapshotId).toBe(snapshotId);
        expect(past.route.phase).toBe('ready');
        expect(past.route.stale).toMatchObject({ prDiffId: V2.diffId });
    });

    it('неизвестный снапшот отбивается bad_request', async () => {
        const server = await start();
        const response = await get(server.port, `${UI_ENDPOINTS.reviewRoute}?snapshot=нет-такого`, server.token);
        expect(response.status).toBe(400);
        expect(rpcErrorSchema.parse(await response.json()).error.code).toBe('bad_request');
    });

    it('история снапшотов различает текущий, устаревший и потерянный при force-push', async () => {
        const server = await start();
        const stream = await openState(server);
        await nextState(stream);
        const first = await completeRoute(server);

        await advance(server);
        await nextState(stream);
        expect(await server.route.generate()).toBe('started');
        const second = await completeRoute(server);

        await advance(server);
        await nextState(stream);
        expect(await server.route.generate()).toBe('started');
        const third = await completeRoute(server);

        const response = await get(server.port, UI_ENDPOINTS.reviewSnapshots, server.token);
        expect(response.status).toBe(200);
        const snapshots = uiReviewSnapshotsResponseSchema.parse(await response.json()).snapshots;
        expect(snapshots.map((snapshot) => [snapshot.snapshotId, snapshot.diffId, snapshot.status])).toEqual([
            [first, V1.diffId, 'stale'],
            [second, V2.diffId, 'gone'],
            [third, V3.diffId, 'current'],
        ]);
        expect(snapshots.at(-1)?.previousSnapshotId).toBe(second);
    });

    it('дифф отдаётся по итерации, а неизвестная итерация отбивается', async () => {
        const server = await start();
        const stream = await openState(server);
        await nextState(stream);
        await advance(server);
        await nextState(stream);

        expect((await readDiff(server)).diffId).toBe(V2.diffId);
        expect((await readDiff(server, `?diffId=${V1.diffId}`)).headCommit).toBe(V1.headCommit);
        expect((await readDiff(server, `?diffId=${V2.diffId}`)).headCommit).toBe(V2.headCommit);

        const response = await get(server.port, `${UI_ENDPOINTS.reviewDiff}?diffId=99999`, server.token);
        expect(response.status).toBe(400);
        expect(rpcErrorSchema.parse(await response.json()).error.message).toContain('не сохранён');
    });

    it('срез между итерациями считается один раз и дальше берётся из кэша', async () => {
        const server = await start();
        const stream = await openState(server);
        await nextState(stream);
        await advance(server);
        await nextState(stream);

        const query = `?base=${V1.diffId}&head=${V2.diffId}`;
        const slice = await readDiff(server, query);
        const before = sliceCalls;
        const again = await readDiff(server, query);

        expect(slice.diffId).toBe(V2.diffId);
        expect(slice.baseCommit).toBe(V1.headCommit);
        expect(again).toEqual(slice);
        expect(sliceCalls).toBe(before);
    });

    it('прогресс прошлой итерации читается по её diffId и остаётся при ней', async () => {
        const server = await start();
        await completeRoute(server);
        const snapshotId = (await readRoute(server)).route.snapshot?.snapshotId ?? '';
        await postJson(
            server.port,
            UI_ENDPOINTS.reviewStopViewed,
            {
                snapshotId,
                stopId: 's01',
                viewed: true,
                ranges: [{ fileId: 'file-1', side: 'new', start: 3, end: 7 }],
            },
            server.token,
        );
        const stream = await openState(server);
        await nextState(stream);
        await advance(server);
        await nextState(stream);

        // Маршрут остался на прошлой итерации: её снапшот и её отметки.
        const past = await readProgress(server, `?diffId=${V1.diffId}`);
        expect(past.diffId).toBe(V1.diffId);
        expect(past.stops).toEqual([{ stopId: 's01', viewed: true }]);
        expect(past.files).toEqual([
            { fileId: 'file-1', viewed: null, seenRanges: [{ side: 'new', start: 3, end: 7 }] },
        ]);

        // Названная явно активная итерация отвечает как запрос без параметра: отметки
        // остановок берутся от текущего снапшота, даже если он построен на прошлой итерации.
        const active = await readProgress(server, `?diffId=${V2.diffId}`);
        const noParam = await readProgress(server);
        expect(active.diffId).toBe(V2.diffId);
        expect(active.stops).toEqual([{ stopId: 's01', viewed: true }]);
        expect(active.files).toEqual(noParam.files);
        expect(active.stops).toEqual(noParam.stops);
        expect(active.progressRevision).toBe(past.progressRevision);
    });

    it('отметка в окне устаревания ложится под итерацию снапшота и повторяется на активной', async () => {
        const server = await start();
        await completeRoute(server);
        const stream = await openState(server);
        await nextState(stream);
        await advance(server);
        await nextState(stream);

        // Срез кладётся в кэш явным запросом: без него повторять отметку не по чему.
        const slice = await readDiff(server, `?base=${V1.diffId}&head=${V2.diffId}`);
        const touched = new Set(slice.files.map((file) => file.path));
        const v1 = await readDiff(server, `?diffId=${V1.diffId}`);
        const v2 = await readDiff(server, `?diffId=${V2.diffId}`);
        const v2Paths = new Set(v2.files.map((file) => file.path));
        const carried = v1.files.find((file) => !touched.has(file.path) && v2Paths.has(file.path));
        const changed = v1.files.find((file) => touched.has(file.path));
        if (carried === undefined || changed === undefined) {
            throw new Error('фикстуре medium нужен и нетронутый вторым пушем файл, и изменившийся');
        }
        const carriedInV2 = v2.files.find((file) => file.path === carried.path)?.fileId ?? '';

        for (const fileId of [carried.fileId, changed.fileId]) {
            const written = await postJson(
                server.port,
                UI_ENDPOINTS.reviewFileViewed,
                { fileId, viewed: true },
                server.token,
            );
            expect(written.status).toBe(200);
        }

        // Отметки легли под ту итерацию, чьи `fileId` прислал UI, — нарисованную на экране.
        const past = await readProgress(server, `?diffId=${V1.diffId}`);
        expect(past.files).toContainEqual({ fileId: carried.fileId, viewed: true, seenRanges: [] });
        expect(past.files).toContainEqual({ fileId: changed.fileId, viewed: true, seenRanges: [] });

        // На активную повторился только нетронутый срезом файл: изменившийся ревьюер не видел.
        const active = await readProgress(server, `?diffId=${V2.diffId}`);
        expect(active.files).toContainEqual({ fileId: carriedInV2, viewed: true, seenRanges: [] });
        const changedInV2 = v2.files.find((file) => file.path === changed.path)?.fileId ?? null;
        expect(active.files.some((file) => file.fileId === changedInV2 && file.viewed === true)).toBe(false);
    });

    it('диапазоны остановки из окна устаревания повторяются на активной итерации и снимаются с обеих', async () => {
        const server = await start();
        await completeRoute(server);
        const snapshotId = (await readRoute(server)).route.snapshot?.snapshotId ?? '';
        const stream = await openState(server);
        await nextState(stream);
        await advance(server);
        await nextState(stream);

        const { carried, carriedInV2 } = await untouchedFile(server);
        const seenRanges = [{ side: 'new' as const, start: 3, end: 7 }];
        const written = await postJson(
            server.port,
            UI_ENDPOINTS.reviewStopViewed,
            { snapshotId, stopId: 's01', viewed: true, ranges: [{ fileId: carried, ...seenRanges[0] }] },
            server.token,
        );
        expect(written.status).toBe(200);

        // Диапазоны легли под нарисованную итерацию и повторились на активной: перестройка
        // маршрута читает прогресс активной, и без второй записи остановка вернулась бы непросмотренной.
        const past = await readProgress(server, `?diffId=${V1.diffId}`);
        expect(past.files).toContainEqual({ fileId: carried, viewed: null, seenRanges });
        const active = await readProgress(server, `?diffId=${V2.diffId}`);
        expect(active.files).toContainEqual({ fileId: carriedInV2, viewed: null, seenRanges });

        const cleared = await postJson(
            server.port,
            UI_ENDPOINTS.reviewStopViewed,
            { snapshotId, stopId: 's01', viewed: false, ranges: [] },
            server.token,
        );
        expect(cleared.status).toBe(200);
        for (const diffId of [V1.diffId, V2.diffId]) {
            const after = await readProgress(server, `?diffId=${diffId}`);
            expect(after.files.filter((file) => file.seenRanges.length > 0)).toEqual([]);
        }
    });

    it('отметка файла в остановке из окна устаревания повторяется на активной итерации и снимается с обеих', async () => {
        const server = await start();
        await completeRoute(server);
        const snapshotId = (await readRoute(server)).route.snapshot?.snapshotId ?? '';
        const stream = await openState(server);
        await nextState(stream);
        await advance(server);
        await nextState(stream);

        const { carried, carriedInV2 } = await untouchedFile(server);
        const seenRanges = [{ side: 'new' as const, start: 3, end: 7 }];
        const written = await postJson(
            server.port,
            UI_ENDPOINTS.reviewStopFileViewed,
            { snapshotId, stopId: 's01', fileId: carried, viewed: true, ranges: seenRanges },
            server.token,
        );
        expect(written.status).toBe(200);

        const past = await readProgress(server, `?diffId=${V1.diffId}`);
        expect(past.files).toContainEqual({ fileId: carried, viewed: null, seenRanges });
        const active = await readProgress(server, `?diffId=${V2.diffId}`);
        expect(active.files).toContainEqual({ fileId: carriedInV2, viewed: null, seenRanges });

        const cleared = await postJson(
            server.port,
            UI_ENDPOINTS.reviewStopFileViewed,
            { snapshotId, stopId: 's01', fileId: carried, viewed: false, ranges: [] },
            server.token,
        );
        expect(cleared.status).toBe(200);
        for (const diffId of [V1.diffId, V2.diffId]) {
            const after = await readProgress(server, `?diffId=${diffId}`);
            expect(after.files.filter((file) => file.seenRanges.length > 0)).toEqual([]);
        }
    });

    it('хост не отдал список итераций: прогресс названной прошлой не подменяется активной', async () => {
        const server = await start();
        await completeRoute(server);
        const fileId = (await readDiff(server, `?diffId=${V1.diffId}`)).files[0]?.fileId ?? '';
        const written = await postJson(
            server.port,
            UI_ENDPOINTS.reviewFileViewed,
            { fileId, viewed: true },
            server.token,
        );
        expect(written.status).toBe(200);
        await server.close();
        servers.length = 0;

        // Фид активную назвать не может, но итерации у хоста есть: спрошенная читается как есть,
        // а не как «единственная» — иначе отметки на экране погасли бы.
        const restarted = await start({ brokenIterations: true });
        const past = await readProgress(restarted, `?diffId=${V1.diffId}`);
        expect(past.diffId).toBe(V1.diffId);
        expect(past.files).toContainEqual({ fileId, viewed: true, seenRanges: [] });
    });

    /** Файл фикстуры, которого второй пуш не коснулся: на него и повторяются отметки. */
    async function untouchedFile(server: SherpaServer): Promise<{ carried: string; carriedInV2: string }> {
        // Срез кладётся в кэш явным запросом: без него повторять отметку не по чему.
        const slice = await readDiff(server, `?base=${V1.diffId}&head=${V2.diffId}`);
        const touched = new Set(slice.files.map((file) => file.path));
        const v1 = await readDiff(server, `?diffId=${V1.diffId}`);
        const v2 = await readDiff(server, `?diffId=${V2.diffId}`);
        const v2Paths = new Set(v2.files.map((file) => file.path));
        const carried = v1.files.find((file) => !touched.has(file.path) && v2Paths.has(file.path));
        if (carried === undefined) {
            throw new Error('фикстуре medium нужен нетронутый вторым пушем файл');
        }
        return {
            carried: carried.fileId,
            carriedInV2: v2.files.find((file) => file.path === carried.path)?.fileId ?? '',
        };
    }

    async function readProgress(server: SherpaServer, query = '') {
        const response = await get(server.port, `${UI_ENDPOINTS.reviewProgress}${query}`, server.token);
        expect(response.status).toBe(200);
        return uiReviewProgressResponseSchema.parse(await response.json());
    }
});

describe('генерация и вопросы на своей итерации', () => {
    let sherpaDir: string;
    let servers: SherpaServer[];
    let streams: SseStream[];

    beforeEach(async () => {
        sherpaDir = await makeTempSherpaDir();
        servers = [];
        streams = [];
    });

    afterEach(async () => {
        for (const stream of streams) {
            stream.close();
        }
        for (const server of servers) {
            await server.close();
        }
        await removeTempSherpaDir(sherpaDir);
    });

    /** Сервер с агентом, поднятым SSE-каналом (иначе фид итераций не стартует) и прогретым маршрутом. */
    async function start(): Promise<{ server: SherpaServer; stream: SseStream }> {
        const host = makeFixtureHost('medium');
        const server = await startServer({
            prKey: PR,
            sherpaDir,
            longPollSeconds: 0.3,
            reviewHostFactory: () => ({
                name: 'fixture',
                host,
                advanceIteration: () => host.advanceIteration(),
            }),
        });
        servers.push(server);
        const stream = await openSse(
            `http://127.0.0.1:${String(server.port)}${UI_ENDPOINTS.events}?token=${server.token}`,
        );
        streams.push(stream);
        await nextState(stream);
        server.workerRegistry.register(WORKER, 'claude-code', 'opus-5');
        await server.route.warmup();
        return { server, stream };
    }

    async function advance(server: SherpaServer, stream: SseStream): Promise<void> {
        const response = await postJson(
            server.port,
            UI_DEV_ENDPOINTS.fixtureAdvanceIteration,
            {},
            server.token,
        );
        expect(response.status).toBe(200);
        await nextState(stream);
    }

    function queuedTasks(server: SherpaServer, type: 'route.skeleton' | 'route.section'): TaskRecord[] {
        return server.queue.listTasks().filter((task) => task.type === type && task.status === 'queued');
    }

    function completeTask(server: SherpaServer, taskId: number, result: unknown): void {
        const leased = server.queue.next(WORKER);
        expect(leased?.task.id).toBe(taskId);
        server.queue.complete(WORKER, taskId, typeof result === 'string' ? result : asRawText(result));
    }

    function sectionFor(planIndex: number): RouteSectionResult {
        const section = mediumRawResults().sections.find((entry) => entry.stops[0]?.planIndex === planIndex);
        if (section === undefined) {
            throw new Error(`у фикстуры нет секции стопа ${String(planIndex)}`);
        }
        return section;
    }

    async function readRoute(server: SherpaServer): Promise<UiReviewRouteResponse> {
        const response = await get(server.port, UI_ENDPOINTS.reviewRoute, server.token);
        expect(response.status).toBe(200);
        return uiReviewRouteResponseSchema.parse(await response.json());
    }

    it('пуш посреди генерации не переносит её на новую итерацию — снапшот рождается устаревшим', async () => {
        const { server, stream } = await start();
        const skeleton = queuedTasks(server, 'route.skeleton')[0]?.id ?? 0;

        await advance(server, stream);
        completeTask(server, skeleton, mediumRawResults().skeleton);
        const sections = queuedTasks(server, 'route.section');
        for (const [position, task] of sections.entries()) {
            completeTask(server, task.id, sectionFor(position + 1));
        }

        const route = (await readRoute(server)).route;
        expect(route.phase).toBe('ready');
        expect(route.snapshot?.diffId).toBe(V1.diffId);
        expect(route.snapshot?.commit).toBe(V1.headCommit);
        expect(route.stale).toMatchObject({ prDiffId: V2.diffId, newIterations: 1 });
        // Секции, поставленные уже после пуша, собраны по общему диффу своей итерации.
        expect(sections[0]?.contextFiles.some((file) => file.includes(diffKeyOf(V1)))).toBe(true);
    });

    it('перестройка после пуша строит снапшот на новой итерации и помнит прошлый', async () => {
        const { server, stream } = await start();
        completeTask(server, queuedTasks(server, 'route.skeleton')[0]?.id ?? 0, mediumRawResults().skeleton);
        for (const [position, task] of queuedTasks(server, 'route.section').entries()) {
            completeTask(server, task.id, sectionFor(position + 1));
        }
        const first = (await readRoute(server)).route.snapshot?.snapshotId;

        await advance(server, stream);
        expect(await server.route.generate()).toBe('started');
        completeTask(server, queuedTasks(server, 'route.skeleton')[0]?.id ?? 0, mediumRawResults().skeleton);
        for (const [position, task] of queuedTasks(server, 'route.section').entries()) {
            completeTask(server, task.id, sectionFor(position + 1));
        }

        const route = (await readRoute(server)).route;
        expect(route.snapshot?.diffId).toBe(V2.diffId);
        expect(route.snapshot?.previousSnapshotId).toBe(first);
        expect(route.stale).toBeNull();
    });

    it('дозаполнение стопа после пуша идёт по диффу итерации снапшота', async () => {
        const { server, stream } = await start();
        completeTask(server, queuedTasks(server, 'route.skeleton')[0]?.id ?? 0, mediumRawResults().skeleton);
        const sections = queuedTasks(server, 'route.section');
        const failed = sections[0]?.id ?? 0;
        expect(server.queue.next(WORKER)?.task.id).toBe(failed);
        server.queue.fail(WORKER, failed, 'агент остановился раньше');
        for (const [position, task] of sections.entries()) {
            if (task.id !== failed) {
                completeTask(server, task.id, sectionFor(position + 1));
            }
        }
        const snapshotId = (await readRoute(server)).route.snapshot?.snapshotId ?? '';

        await advance(server, stream);
        const response = await postJson(
            server.port,
            UI_ENDPOINTS.reviewRouteFillStop,
            { snapshotId, planIndex: 1 },
            server.token,
        );

        expect(response.status).toBe(200);
        const refill = queuedTasks(server, 'route.section')[0];
        expect(refill?.contextFiles.some((file) => file.includes(diffKeyOf(V1)))).toBe(true);
        expect(refill?.contextFiles.some((file) => file.includes(diffKeyOf(V2)))).toBe(false);
    });

    it('вопрос по прошлой итерации строится из её патча и не сносит контекст открытой генерации', async () => {
        const { server, stream } = await start();
        completeTask(server, queuedTasks(server, 'route.skeleton')[0]?.id ?? 0, mediumRawResults().skeleton);
        for (const [position, task] of queuedTasks(server, 'route.section').entries()) {
            completeTask(server, task.id, sectionFor(position + 1));
        }
        await advance(server, stream);
        // Перестройка на новой итерации держит свой общий контекст открытой задачей.
        expect(await server.route.generate()).toBe('started');
        const routeTask = queuedTasks(server, 'route.skeleton')[0];
        expect(routeTask?.contextFiles.some((file) => file.includes(diffKeyOf(V2)))).toBe(true);

        const anchored = fixtureData('medium').iterations[0]?.diff.files.find(
            (file) => file.path === 'services/orders/src/api/handlers.ts',
        );
        const response = await postJson(
            server.port,
            UI_ENDPOINTS.reviewChatAsk,
            {
                text: 'Почему этот обработчик так выглядел на прошлой итерации?',
                anchor: {
                    diffId: V1.diffId,
                    fileId: anchored?.fileId,
                    path: anchored?.path,
                    side: 'new',
                    start: 2,
                    end: 4,
                },
            },
            server.token,
        );
        expect(response.status).toBe(200);

        const chatTask = server.queue.listTasks().find((task) => task.type === 'chat');
        const selection = chatTask?.contextFiles.find((file) => file.endsWith('selection.patch.md')) ?? '';
        expect(fsSync.readFileSync(selection, 'utf8')).toContain('services/orders/src/api/handlers.ts');
        // Общий контекст открытой задачи маршрута чистка вопроса не трогает.
        for (const file of routeTask?.contextFiles ?? []) {
            expect(fsSync.existsSync(file)).toBe(true);
        }

        // Коммит обмена — голова итерации якоря: контекст собран из её патча, а не из активной.
        expect(server.queue.next(WORKER)?.task.id).toBe(chatTask?.id);
        server.queue.complete(WORKER, chatTask?.id ?? 0, 'Тогда обработчик ещё не знал про окно правки.');
        const chat = uiChatResponseSchema.parse(
            await (await get(server.port, UI_ENDPOINTS.reviewChat, server.token)).json(),
        );
        expect(chat.notes[0]?.origin.commit).toBe(V1.headCommit);
    });

    it('вопрос по итерации без сохранённого патча отбивается bad_request', async () => {
        const { server } = await start();
        const response = await postJson(
            server.port,
            UI_ENDPOINTS.reviewChatAsk,
            {
                text: 'А что было в позапрошлой итерации?',
                anchor: {
                    diffId: '404404',
                    fileId: 'file-1',
                    path: 'services/orders/src/api/handlers.ts',
                    side: 'new',
                    start: 2,
                    end: 4,
                },
            },
            server.token,
        );

        expect(response.status).toBe(400);
        expect(rpcErrorSchema.parse(await response.json()).error.message).toContain('не сохранён');
    });
});

describe('перенос прогресса между итерациями', () => {
    let sherpaDir: string;
    let servers: SherpaServer[];
    let streams: SseStream[];
    let databases: DatabaseSync[];
    /** Срезы, которые сервер спросил у хоста: по ним видно, с какой итерации шёл перенос. */
    let slices: string[];

    beforeEach(async () => {
        sherpaDir = await makeTempSherpaDir();
        servers = [];
        streams = [];
        databases = [];
        slices = [];
    });

    afterEach(async () => {
        for (const stream of streams) {
            stream.close();
        }
        for (const db of databases) {
            db.close();
        }
        for (const server of servers) {
            await server.close();
        }
        await removeTempSherpaDir(sherpaDir);
    });

    /**
     * Сервер с открытым SSE-каналом: без него фид итераций не стартует и перенос не зовётся.
     * `failSlices` изображает хост, который срез между итерациями не отдаёт вовсе.
     */
    async function start(options: { failSlices?: boolean } = {}): Promise<{ server: SherpaServer; stream: SseStream }> {
        const host = makeFixtureHost('medium');
        const getDiff = host.getDiff.bind(host);
        host.getDiff = (slice) => {
            if (slice !== undefined) {
                slices.push(`${slice.base}→${slice.head}`);
                if (options.failSlices === true) {
                    return Promise.reject(new Error('срез между итерациями недоступен'));
                }
            }
            return getDiff(slice);
        };
        const server = await startServer({
            prKey: PR,
            sherpaDir,
            longPollSeconds: 0.3,
            reviewHostFactory: () => ({
                name: 'fixture',
                host,
                advanceIteration: () => host.advanceIteration(),
            }),
        });
        servers.push(server);
        const stream = await openSse(
            `http://127.0.0.1:${String(server.port)}${UI_ENDPOINTS.events}?token=${server.token}`,
        );
        streams.push(stream);
        await nextState(stream);
        server.workerRegistry.register(WORKER, 'claude-code', 'opus-5');
        await server.route.warmup();
        return { server, stream };
    }

    function db(): DatabaseSync {
        const opened = new DatabaseSync(databasePathFor(sherpaDir, PR), { readOnly: true });
        databases.push(opened);
        return opened;
    }

    function completeTask(server: SherpaServer, taskId: number, result: unknown): void {
        const leased = server.queue.next(WORKER);
        expect(leased?.task.id).toBe(taskId);
        server.queue.complete(WORKER, taskId, typeof result === 'string' ? result : asRawText(result));
    }

    function queued(server: SherpaServer, type: 'route.skeleton' | 'route.section'): number[] {
        return server.queue
            .listTasks()
            .filter((task) => task.type === type && task.status === 'queued')
            .map((task) => task.id);
    }

    /** Полный проход генерации на текущей итерации. */
    async function completeRoute(server: SherpaServer): Promise<string> {
        const skeleton = queued(server, 'route.skeleton').at(-1) ?? 0;
        completeTask(server, skeleton, mediumRawResults().skeleton);
        for (const [position, taskId] of queued(server, 'route.section').entries()) {
            const section = mediumRawResults().sections.find(
                (entry) => entry.stops[0]?.planIndex === position + 1,
            );
            completeTask(server, taskId, section);
        }
        const route = uiReviewRouteResponseSchema.parse(
            await (await get(server.port, UI_ENDPOINTS.reviewRoute, server.token)).json(),
        ).route;
        expect(route.phase).toBe('ready');
        return route.snapshot?.snapshotId ?? '';
    }

    async function readRouteSnapshot(server: SherpaServer) {
        const response = await get(server.port, UI_ENDPOINTS.reviewRoute, server.token);
        return uiReviewRouteResponseSchema.parse(await response.json()).route.snapshot;
    }

    /** Отметка остановки ровно теми диапазонами, которые посчитал бы UI по диффу итерации. */
    async function markStop(server: SherpaServer, stopId: string, diff: PrDiff): Promise<void> {
        const snapshot = await readRouteSnapshot(server);
        const stop = snapshot?.stops.find((candidate) => candidate.id === stopId);
        if (snapshot === null || stop === undefined) {
            throw new Error(`в снапшоте нет остановки ${stopId}`);
        }
        const response = await postJson(
            server.port,
            UI_ENDPOINTS.reviewStopViewed,
            {
                snapshotId: snapshot.snapshotId,
                stopId,
                viewed: true,
                ranges: requiredSeenRanges(stop.anchors, diff),
            },
            server.token,
        );
        expect(response.status).toBe(200);
    }

    async function advance(server: SherpaServer, stream: SseStream): Promise<void> {
        const response = await postJson(server.port, UI_DEV_ENDPOINTS.fixtureAdvanceIteration, {}, server.token);
        expect(response.status).toBe(200);
        await nextState(stream);
    }

    /** Перенос идёт асинхронно от списка хоста: ждём строку в журнале переносов. */
    async function waitForCarry(from: string, to: string): Promise<void> {
        const reader = db();
        await expect
            .poll(() =>
                (
                    reader
                        .prepare('SELECT from_diff_id, to_diff_id FROM progress_carries')
                        .all() as { from_diff_id: string; to_diff_id: string }[]
                ).map((row) => `${row.from_diff_id}→${row.to_diff_id}`),
            )
            .toContain(`${from}→${to}`);
    }

    function seenRanges(diffId: string): { file_id: string; carried_from: string | null }[] {
        return db()
            .prepare(
                'SELECT file_id, side, start_line, end_line, source_stop_id, carried_from ' +
                    'FROM file_seen_ranges WHERE diff_id = ? ORDER BY rowid',
            )
            .all(diffId) as { file_id: string; carried_from: string | null }[];
    }

    async function readProgress(server: SherpaServer, query = '') {
        const response = await get(server.port, `${UI_ENDPOINTS.reviewProgress}${query}`, server.token);
        expect(response.status).toBe(200);
        return uiReviewProgressResponseSchema.parse(await response.json());
    }

    it('пуш переносит диапазоны на новую итерацию один раз и по путям файлов', async () => {
        const { server, stream } = await start();
        await completeRoute(server);
        const v1Diff = fixtureData('medium').iterations[0]?.diff;
        if (v1Diff === undefined) {
            throw new Error('у фикстуры medium нет первой итерации');
        }
        for (const stopId of ['s01', 's02', 's04', 's05']) {
            await markStop(server, stopId, v1Diff);
        }
        const beforeCount = seenRanges(V1.diffId).length;

        await advance(server, stream);
        await waitForCarry(V1.diffId, V2.diffId);

        const carried = seenRanges(V2.diffId);
        expect(carried.length).toBeGreaterThan(0);
        // Перенесённые куски помечены итерацией-источником и не привязаны к остановке.
        expect(carried.every((row) => row.carried_from === V1.diffId)).toBe(true);
        // `fileId` новой итерации — свой: сопоставление шло по пути файла.
        const v1Files = new Set(seenRanges(V1.diffId).map((row) => row.file_id));
        expect(carried.some((row) => v1Files.has(row.file_id))).toBe(false);
        expect(seenRanges(V1.diffId)).toHaveLength(beforeCount);

        // Повторный список хоста перенос не удваивает.
        const again = seenRanges(V2.diffId).length;
        await server.route.warmup();
        await expect.poll(() => seenRanges(V2.diffId).length).toBe(again);
        expect(db().prepare('SELECT COUNT(*) AS count FROM progress_carries').get()).toMatchObject({ count: 1 });

        // Вторая вкладка подписывается на тот же фид: подписка на хост уже жива, и ни нового
        // среза, ни нового переноса её появление не заказывает.
        const slicesBefore = slices.length;
        const second = await openSse(
            `http://127.0.0.1:${String(server.port)}${UI_ENDPOINTS.events}?token=${server.token}`,
        );
        streams.push(second);
        await nextState(second);
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(slices).toHaveLength(slicesBefore);
        expect(seenRanges(V2.diffId)).toHaveLength(again);
    });

    it('перестройка после пуша оставляет просмотренными остановки, которых пуш не коснулся', async () => {
        const { server, stream } = await start();
        const first = await completeRoute(server);
        const v1Diff = fixtureData('medium').iterations[0]?.diff;
        if (v1Diff === undefined) {
            throw new Error('у фикстуры medium нет первой итерации');
        }
        // s02 пуш трогает, остальные три — нет (фикстура medium v1→v2).
        for (const stopId of ['s01', 's02', 's04', 's05']) {
            await markStop(server, stopId, v1Diff);
        }

        await advance(server, stream);
        await waitForCarry(V1.diffId, V2.diffId);
        expect(await server.route.generate()).toBe('started');
        const second = await completeRoute(server);

        const snapshot = await readRouteSnapshot(server);
        expect(snapshot?.diffId).toBe(V2.diffId);
        expect(snapshot?.previousSnapshotId).toBe(first);
        expect(snapshot?.carried).toEqual({ kept: 3, total: 6, zeroReason: null });
        expect(second).not.toBe(first);

        const active = await readProgress(server);
        expect(active.stops).toEqual([
            { stopId: 's01', viewed: true },
            { stopId: 's04', viewed: true },
            { stopId: 's05', viewed: true },
        ]);
        // Прогресс прошлой итерации остался её прогрессом.
        const past = await readProgress(server, `?diffId=${V1.diffId}`);
        expect(past.stops.map((stop) => stop.stopId)).toEqual(['s01', 's02', 's04', 's05']);
    });

    it('отметки доехали, но ни одной остановки не накрыли — причина «нет перекрытия»', async () => {
        const { server, stream } = await start();
        await completeRoute(server);
        const v1Diff = fixtureData('medium').iterations[0]?.diff;
        if (v1Diff === undefined) {
            throw new Error('у фикстуры medium нет первой итерации');
        }
        // Отмечена ровно та остановка, которую пуш трогает: часть её диапазонов доедет,
        // но целиком просмотренной она на новой итерации уже не будет.
        await markStop(server, 's02', v1Diff);

        await advance(server, stream);
        await waitForCarry(V1.diffId, V2.diffId);
        expect(await server.route.generate()).toBe('started');
        await completeRoute(server);

        expect(seenRanges(V2.diffId).filter((row) => row.carried_from !== null).length).toBeGreaterThan(0);
        expect((await readRouteSnapshot(server))?.carried).toEqual({
            kept: 0,
            total: 6,
            zeroReason: 'no_overlap',
        });
    });

    it('хост не отдал срез — перенос не состоялся, и баннер получает именно эту причину', async () => {
        const { server, stream } = await start({ failSlices: true });
        await completeRoute(server);
        const v1Diff = fixtureData('medium').iterations[0]?.diff;
        if (v1Diff === undefined) {
            throw new Error('у фикстуры medium нет первой итерации');
        }
        await markStop(server, 's01', v1Diff);

        await advance(server, stream);
        expect(await server.route.generate()).toBe('started');
        await completeRoute(server);

        expect(seenRanges(V2.diffId)).toHaveLength(0);
        expect((await readRouteSnapshot(server))?.carried).toEqual({
            kept: 0,
            total: 6,
            zeroReason: 'no_interdiff',
        });
    });

    it('force-push переносит прогресс с самой свежей итерации, а исчезнувшую помечает gone', async () => {
        const { server, stream } = await start();
        await completeRoute(server);
        const v1Diff = fixtureData('medium').iterations[0]?.diff;
        if (v1Diff === undefined) {
            throw new Error('у фикстуры medium нет первой итерации');
        }
        await markStop(server, 's01', v1Diff);

        await advance(server, stream);
        await waitForCarry(V1.diffId, V2.diffId);
        await advance(server, stream);
        // Источник берётся по свежести прогресса, а не по статусу итерации: сначала спрашивается
        // срез со смётой force-push'ем v2. Фикстурный хост его не считает (итерации нет в списке),
        // и перенос отступает на следующего кандидата с прогрессом.
        await waitForCarry(V1.diffId, V3.diffId);
        expect(slices).toContain(`${V2.diffId}→${V3.diffId}`);

        expect(seenRanges(V3.diffId).length).toBeGreaterThan(0);
        expect(seenRanges(V3.diffId).every((row) => row.carried_from === V1.diffId)).toBe(true);
        const state = uiStateSchema.parse(
            await (await get(server.port, UI_ENDPOINTS.state, server.token)).json(),
        );
        expect(state.iterations.find((iteration) => iteration.diffId === V2.diffId)?.status).toBe('gone');
    });
});

/**
 * Перегенерация после пуша: задачи второго захода несут срез, прошлый маршрут и
 * обсуждение, а классификацию стопов считает сервер — модель только объясняет.
 */
describe('перегенерация после пуша: контекст «что изменилось»', () => {
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

    type FixtureHost = ReturnType<typeof makeFixtureHost>;

    /** Сервер на заданном хосте: рестарт изображается вторым сервером на том же хосте и стейте. */
    async function start(host: FixtureHost): Promise<SherpaServer> {
        const server = await startServer({
            prKey: PR,
            sherpaDir,
            longPollSeconds: 0.3,
            reviewHostFactory: () => ({
                name: 'fixture',
                host,
                advanceIteration: () => host.advanceIteration(),
            }),
        });
        servers.push(server);
        server.workerRegistry.register(WORKER, 'claude-code', 'opus-5');
        await server.route.warmup();
        return server;
    }

    function queued(server: SherpaServer, type: 'route.skeleton' | 'route.section'): number[] {
        return server.queue
            .listTasks()
            .filter((task) => task.type === type && task.status === 'queued')
            .map((task) => task.id);
    }

    function complete(server: SherpaServer, taskId: number, result: unknown): void {
        const leased = server.queue.next(WORKER);
        expect(leased?.task.id).toBe(taskId);
        server.queue.complete(WORKER, taskId, asRawText(result));
    }

    /** Полный проход генерации заданными выводами модели. */
    async function completeRoute(server: SherpaServer, raw: RouteRawResults): Promise<void> {
        const skeleton = queued(server, 'route.skeleton').at(-1);
        if (skeleton !== undefined) {
            complete(server, skeleton, raw.skeleton);
        }
        completeSections(server, raw);
        expect((await readRoute(server)).phase).toBe('ready');
    }

    /** Секции ставятся в порядке плана: задача по позиции в очереди и есть её стоп. */
    function completeSections(server: SherpaServer, raw: RouteRawResults): void {
        for (const taskId of queued(server, 'route.section')) {
            const planIndex = server.route.stopsOfTask(taskId)?.[0] ?? 0;
            const section = raw.sections.find((entry) => entry.stops[0]?.planIndex === planIndex);
            if (section === undefined) {
                throw new Error(`у выводов модели нет секции стопа ${String(planIndex)}`);
            }
            complete(server, taskId, section);
        }
    }

    async function readRoute(server: SherpaServer) {
        const response = await get(server.port, UI_ENDPOINTS.reviewRoute, server.token);
        expect(response.status).toBe(200);
        return uiReviewRouteResponseSchema.parse(await response.json()).route;
    }

    async function advance(server: SherpaServer): Promise<void> {
        const response = await postJson(server.port, UI_DEV_ENDPOINTS.fixtureAdvanceIteration, {}, server.token);
        expect(response.status).toBe(200);
    }

    /** Имена контекстных файлов задачи без методички: она адресуется хешем содержимого. */
    function contextNames(server: SherpaServer, taskId: number): string[] {
        const files = server.queue.getTask(taskId)?.contextFiles ?? [];
        for (const file of files) {
            expect(fsSync.existsSync(file)).toBe(true);
        }
        return files.slice(1).map((file) => file.split('/').at(-1) ?? '');
    }

    function changeOf(snapshot: { stops: { id: string; change: RouteStopChange | null }[] } | null) {
        return (snapshot?.stops ?? []).map((stop) => [stop.id, stop.change?.kind ?? null]);
    }

    it('второй заход: задачи несут срез, прошлый маршрут и обсуждение, стопы получают классификацию', async () => {
        const host = makeFixtureHost('medium');
        const server = await start(host);
        await completeRoute(server, mediumRawResults());

        await advance(server);
        expect(await server.route.generate()).toBe('started');

        const skeleton = queued(server, 'route.skeleton').at(-1) ?? 0;
        expect(contextNames(server, skeleton)).toEqual([
            'pr-diff.md',
            'interdiff.md',
            'previous-route.md',
            'threads-since.md',
        ]);
        complete(server, skeleton, mediumRawResultsV2().skeleton);
        const section = queued(server, 'route.section')[0] ?? 0;
        expect(contextNames(server, section).at(-1)).toBe('section-01-plan.md');
        expect(contextNames(server, section)).toContain('interdiff.md');
        completeSections(server, mediumRawResultsV2());

        const snapshot = (await readRoute(server)).snapshot;
        expect(snapshot?.diffId).toBe(V2.diffId);
        expect(changeOf(snapshot)).toEqual([
            ['s01', null],
            ['s02', 'changed'],
            ['s03', 'changed'],
            ['s04', null],
            ['s05', null],
            ['s06', 'new'],
            ['other', null],
        ]);
        const changed = snapshot?.stops.find((stop) => stop.id === 's03');
        expect(changed?.change?.reason).toContain('api/rejection-status.ts');
        expect(changed?.change?.threadIds).toEqual(['4820242']);
    });

    it('перегенерация на той же итерации: среза нет и классификации тоже', async () => {
        const host = makeFixtureHost('medium');
        const server = await start(host);
        await completeRoute(server, mediumRawResults());

        expect(await server.route.generate()).toBe('started');
        const skeleton = queued(server, 'route.skeleton').at(-1) ?? 0;
        expect(contextNames(server, skeleton)).toEqual(['pr-diff.md', 'previous-route.md', 'threads-since.md']);
        complete(server, skeleton, mediumRawResults().skeleton);
        completeSections(server, mediumRawResults());

        const snapshot = (await readRoute(server)).snapshot;
        expect(snapshot?.stops.every((stop) => stop.change === null)).toBe(true);
    });

    it('рестарт посреди второго захода: карта берётся из кэша срезов, тредов больше нет', async () => {
        const host = makeFixtureHost('medium');
        const first = await start(host);
        await completeRoute(first, mediumRawResults());
        await advance(first);
        expect(await first.route.generate()).toBe('started');
        complete(first, queued(first, 'route.skeleton').at(-1) ?? 0, mediumRawResultsV2().skeleton);
        await first.close();

        const second = await start(host);
        completeSections(second, mediumRawResultsV2());

        const snapshot = (await readRoute(second)).snapshot;
        expect(changeOf(snapshot)).toEqual([
            ['s01', null],
            ['s02', 'changed'],
            ['s03', 'changed'],
            ['s04', null],
            ['s05', null],
            ['s06', 'new'],
            ['other', null],
        ]);
        // Треды сетевые: восстановленный контекст их не держит, и ссылки на них вырезаны.
        expect(snapshot?.stops.find((stop) => stop.id === 's03')?.change?.threadIds).toEqual([]);
    });

    it('отказ хоста в тредах генерацию не рушит: файл честно говорит, что их нет', async () => {
        const host = makeFixtureHost('medium');
        const server = await start(host);
        await completeRoute(server, mediumRawResults());
        host.getThreads = () => Promise.reject(new Error('хост прилёг'));

        await advance(server);
        expect(await server.route.generate()).toBe('started');
        const skeleton = queued(server, 'route.skeleton').at(-1) ?? 0;
        const threadsFile = (server.queue.getTask(skeleton)?.contextFiles ?? []).at(-1) ?? '';
        expect(fsSync.readFileSync(threadsFile, 'utf8')).toContain('[UNAVAILABLE:');

        complete(server, skeleton, mediumRawResultsV2().skeleton);
        completeSections(server, mediumRawResultsV2());

        const snapshot = (await readRoute(server)).snapshot;
        expect(snapshot?.stops.find((stop) => stop.id === 's02')?.change?.kind).toBe('changed');
        // Известных тредов нет — ссылка модели на тред отброшена с пометкой ревьюеру.
        const cited = snapshot?.stops.find((stop) => stop.id === 's03');
        expect(cited?.change?.threadIds).toEqual([]);
        expect(cited?.validationNotes).toContain('Ссылка на неизвестный тред 4820242 удалена.');
    });
});

/**
 * БД, накопленная прежними версиями: сервер поднимается на ней, доводит схему миграциями и
 * продолжает работать — старый снапшот читается, прогресс и якоря заметок живут дальше.
 */
describe('сервер на накопленной базе прежней версии', () => {
    let sherpaDir: string;
    let servers: SherpaServer[];
    let streams: SseStream[];

    beforeEach(async () => {
        sherpaDir = await makeTempSherpaDir();
        servers = [];
        streams = [];
    });

    afterEach(async () => {
        for (const stream of streams) {
            stream.close();
        }
        for (const server of servers) {
            await server.close();
        }
        await removeTempSherpaDir(sherpaDir);
    });

    const AT = '2026-08-20T10:00:00.000Z';
    /** Файл первой итерации, которого пуш не касается: его прогресс и заметка переезжают целиком. */
    const UNTOUCHED_PATH = 'services/orders/src/domain/edit-window.ts';

    function untouchedFileId(): string {
        const fileId = fixtureData('medium')
            .iterations[0]?.diff.files.find((file) => file.path === UNTOUCHED_PATH)?.fileId;
        if (fileId === undefined) {
            throw new Error(`у первой итерации фикстуры medium нет файла ${UNTOUCHED_PATH}`);
        }
        return fileId;
    }

    /**
     * База, какой её оставил бы старый сервер: снапшот блобом в `route_state`, прогресс без
     * измерения итерации, якорь заметки без `diffId`. `diffId` снапшота задаёт тест — от него
     * зависит, узнает ли хост итерацию, на которой ревьюер остановился.
     */
    function seedLegacyDatabase(diffId: string): string {
        fsSync.mkdirSync(prStateDirOf(sherpaDir, PR), { recursive: true });
        const snapshot = { ...mediumReadySnapshot(), diffId };
        const anchor = { fileId: untouchedFileId(), path: UNTOUCHED_PATH, side: 'new', start: 24, end: 32 };
        const beforeIterations = MIGRATIONS.slice(
            0,
            MIGRATIONS.findIndex((migration) => migration.name === '010-iterations'),
        );

        const db = openDatabase(databasePathFor(sherpaDir, PR), beforeIterations);
        db.prepare(
            `INSERT INTO route_state (id, phase, small_pr, snapshot, intents, updated_at)
             VALUES (1, 'ready', 0, ?, '[]', ?)`,
        ).run(JSON.stringify(snapshot), AT);
        db.prepare('INSERT INTO stop_progress (stop_id, viewed, updated_at) VALUES (?, 1, ?)').run('s01', AT);
        db.prepare('INSERT INTO file_progress (file_id, viewed, updated_at) VALUES (?, 1, ?)').run(
            untouchedFileId(),
            AT,
        );
        db.prepare(
            `INSERT INTO file_seen_ranges (file_id, side, start_line, end_line, source_stop_id)
             VALUES (?, 'new', 24, 32, 's01')`,
        ).run(untouchedFileId());
        db.prepare(
            `INSERT INTO chat_exchanges (
                id, question, anchor, status, answer, progress_text, error, task_id, head_commit,
                created_at, updated_at
             ) VALUES (1, 'вопрос', ?, 'done', 'ответ', NULL, NULL, NULL, ?, ?, ?)`,
        ).run(JSON.stringify(anchor), snapshot.commit, AT, AT);
        db.prepare(
            `INSERT INTO agent_notes (id, exchange_id, anchor, text, commit_hash, created_at)
             VALUES (1, 1, ?, 'ответ', ?, ?)`,
        ).run(JSON.stringify(anchor), snapshot.commit, AT);
        db.close();
        return snapshot.snapshotId;
    }

    /** Сервер на уже засеянной базе, с открытым SSE-каналом: без него фид итераций не стартует. */
    async function start(): Promise<{ server: SherpaServer; stream: SseStream }> {
        const host = makeFixtureHost('medium');
        const server = await startServer({
            prKey: PR,
            sherpaDir,
            longPollSeconds: 0.3,
            reviewHostFactory: () => ({
                name: 'fixture',
                host,
                advanceIteration: () => host.advanceIteration(),
            }),
        });
        servers.push(server);
        const stream = await openSse(
            `http://127.0.0.1:${String(server.port)}${UI_ENDPOINTS.events}?token=${server.token}`,
        );
        streams.push(stream);
        await nextState(stream);
        await server.route.warmup();
        return { server, stream };
    }

    async function readProgress(server: SherpaServer, query = '') {
        const response = await get(server.port, `${UI_ENDPOINTS.reviewProgress}${query}`, server.token);
        expect(response.status).toBe(200);
        return uiReviewProgressResponseSchema.parse(await response.json());
    }

    async function readChat(server: SherpaServer) {
        const response = await get(server.port, UI_ENDPOINTS.reviewChat, server.token);
        expect(response.status).toBe(200);
        return uiChatResponseSchema.parse(await response.json());
    }

    it('снапшот, прогресс и якоря заметок продолжают жить на активной итерации', async () => {
        const snapshotId = seedLegacyDatabase(V1.diffId);
        const { server, stream } = await start();

        // Снапшот прошлого сервера остался текущим маршрутом и читается по своему id.
        const snapshots = uiReviewSnapshotsResponseSchema.parse(
            await (await get(server.port, UI_ENDPOINTS.reviewSnapshots, server.token)).json(),
        ).snapshots;
        expect(snapshots.map((snapshot) => [snapshot.snapshotId, snapshot.status])).toEqual([
            [snapshotId, 'current'],
        ]);
        const past = uiReviewRouteResponseSchema.parse(
            await (await get(server.port, `${UI_ENDPOINTS.reviewRoute}?snapshot=${snapshotId}`, server.token)).json(),
        ).route;
        expect(past.phase).toBe('ready');
        expect(past.snapshot?.snapshotId).toBe(snapshotId);
        expect(past.stale).toBeNull();

        // Прогресс уехал на итерацию снапшота, а она и есть активная: ревьюер видит своё чтение.
        const progress = await readProgress(server);
        expect(progress.files.find((file) => file.fileId === untouchedFileId())?.seenRanges).toEqual([
            { side: 'new', start: 24, end: 32 },
        ]);
        expect(progress.stops).toEqual([{ stopId: 's01', viewed: true }]);

        // Якорь заметки итерации не называл — фид усыновил его активной.
        await expect.poll(async () => (await readChat(server)).notes[0]?.anchor.diffId).toBe(V1.diffId);

        // И дальше всё как обычно: пуш перевозит и прогресс, и якорь.
        expect((await postJson(server.port, UI_DEV_ENDPOINTS.fixtureAdvanceIteration, {}, server.token)).status).toBe(
            200,
        );
        await nextState(stream);
        await expect
            .poll(async () => (await readProgress(server, `?diffId=${V2.diffId}`)).files.length)
            .toBeGreaterThan(0);
        await expect.poll(async () => (await readChat(server)).notes[0]?.anchor.diffId).toBe(V2.diffId);
    });

    it('снапшот на итерации, которой у хоста нет: маршрут читается, но его прогресс осиротел', async () => {
        const snapshotId = seedLegacyDatabase('iter-которой-нет');
        const { server } = await start();

        // Маршрут читается: снапшот неизменяем и живёт своим блобом.
        const route = uiReviewRouteResponseSchema.parse(
            await (await get(server.port, UI_ENDPOINTS.reviewRoute, server.token)).json(),
        ).route;
        expect(route.snapshot?.snapshotId).toBe(snapshotId);
        // Итерация снапшота хосту неизвестна, активная — другая: маршрут честно устарел.
        expect(route.stale).toMatchObject({ prDiffId: V1.diffId, newIterations: 1 });

        // Прогресс миграция увела на итерацию снапшота, а её сервер не знает: перенести его
        // не с чего (`latestDiffIdWithProgress` смотрит только на сохранённые итерации), и на
        // активной итерации чтения нет. Такую базу чинит перестройка маршрута, а не миграция.
        expect((await readProgress(server)).files).toEqual([]);
        expect((await readProgress(server, '?diffId=iter-которой-нет')).files).toHaveLength(1);
        // Якорь заметки итерации не называл вовсе — его усыновляет активная, и он на месте.
        await expect.poll(async () => (await readChat(server)).notes[0]?.anchor.diffId).toBe(V1.diffId);
    });
});

async function nextState(stream: SseStream): Promise<UiState> {
    for (;;) {
        const event = await stream.next();
        if (event.event === UI_STATE_EVENT) {
            return uiStateSchema.parse(JSON.parse(event.data));
        }
    }
}

async function nextRoute(stream: SseStream): Promise<SseEvent> {
    for (;;) {
        const event = await stream.next();
        if (event.event === UI_ROUTE_EVENT) {
            return event;
        }
    }
}

interface SseEvent {
    readonly event: string;
    readonly data: string;
}

interface SseStream {
    readonly next: () => Promise<SseEvent>;
    readonly close: () => void;
}

/** Минимальный SSE-клиент: `EventSource` в Node нет, а событий тут читается по одному. */
async function openSse(url: string): Promise<SseStream> {
    const controller = new AbortController();
    const response = await fetch(url, { signal: controller.signal });
    if (response.status !== 200 || response.body === null) {
        throw new Error(`SSE-канал не открылся: ${String(response.status)}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const ready: SseEvent[] = [];
    let buffer = '';

    return {
        next: async () => {
            for (;;) {
                const event = ready.shift();
                if (event !== undefined) {
                    return event;
                }

                const chunk: { done: boolean; value?: Uint8Array } = await reader.read();
                if (chunk.done) {
                    throw new Error('SSE-канал закрылся раньше ожидаемого события');
                }
                buffer += decoder.decode(chunk.value, { stream: true });

                let boundary = buffer.indexOf('\n\n');
                while (boundary !== -1) {
                    ready.push(parseSseEvent(buffer.slice(0, boundary)));
                    buffer = buffer.slice(boundary + 2);
                    boundary = buffer.indexOf('\n\n');
                }
            }
        },
        close: () => {
            controller.abort();
        },
    };
}

function parseSseEvent(raw: string): SseEvent {
    let event = 'message';
    const data: string[] = [];
    for (const line of raw.split('\n')) {
        if (line.startsWith('event: ')) {
            event = line.slice('event: '.length);
        } else if (line.startsWith('data: ')) {
            data.push(line.slice('data: '.length));
        }
    }
    return { event, data: data.join('\n') };
}

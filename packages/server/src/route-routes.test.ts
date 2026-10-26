import http from 'node:http';

import type { Iteration, RouteSnapshot, RpcError, UiRouteState } from '@sherpa/protocol';
import {
    rpcErrorSchema,
    UI_ENDPOINTS,
    uiReviewRouteResponseSchema,
    uiReviewSnapshotsResponseSchema,
} from '@sherpa/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createRequestListener } from './http.js';
import type { IterationFeed } from './iteration-feed.js';
import { mediumReadySnapshot } from './route/fixture-support.js';
import type { RouteOrchestrator } from './route-orchestrator.js';
import { createRouteRoutes } from './route-routes.js';
import type { RouteStore } from './route-store.js';
import { get, postJson, postRaw } from './test-support.js';

/**
 * Ручки маршрута на уровне обработчиков: стор и оркестратор — заглушки. Проверяется то, что
 * ручка считает сама, — статусы снапшотов, составная ревизия и валидация тел.
 */

const TOKEN = 'route-routes-token';

/** Снапшот с подменёнными id и итерацией: остальное берётся у готовой фикстуры. */
function snapshotOf(snapshotId: string, diffId: string, createdAt: string): RouteSnapshot {
    return { ...mediumReadySnapshot(), snapshotId, diffId, createdAt, previousSnapshotId: null };
}

function iterationOf(diffId: string, status: Iteration['status']): Iteration {
    return {
        diffId,
        baseCommit: 'base',
        headCommit: `head-${diffId}`,
        createdAt: '2026-09-01T10:00:00.000Z',
        status,
    };
}

interface Stubs {
    readonly state: UiRouteState;
    readonly snapshots: RouteSnapshot[];
    readonly current: RouteSnapshot | null;
    readonly revision: number;
    readonly feed: IterationFeed | null;
}

describe('ручки маршрута', () => {
    let server: http.Server | null;
    let port: number;
    let generate: ReturnType<typeof vi.fn>;
    let fillStop: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        server = null;
        generate = vi.fn(() => Promise.resolve('started'));
        fillStop = vi.fn(() => Promise.resolve('started'));
    });

    afterEach(async () => {
        const handle = server;
        server = null;
        if (handle !== null) {
            handle.closeAllConnections();
            await new Promise<void>((resolve) => {
                handle.close(() => {
                    resolve();
                });
            });
        }
    });

    async function start(stubs: Partial<Stubs> = {}): Promise<void> {
        const snapshots = stubs.snapshots ?? [];
        const current = stubs.current ?? null;
        const state: UiRouteState = stubs.state ?? {
            phase: current === null ? 'none' : 'ready',
            smallPr: false,
            snapshot: current,
            failure: null,
            stale: null,
        };
        const store = {
            revision: stubs.revision ?? 0,
            read: () => state,
            current: () => current,
            listSnapshots: () => snapshots,
            getSnapshot: (id: string) => snapshots.find((snapshot) => snapshot.snapshotId === id) ?? null,
        } as unknown as RouteStore;
        const routes = createRouteRoutes({
            store,
            orchestrator: { generate, fillStop } as unknown as RouteOrchestrator,
            iterationFeed: stubs.feed ?? null,
        });

        const listener = http.createServer(createRequestListener({ token: TOKEN, routes }));
        await new Promise<void>((resolve) => listener.listen(0, '127.0.0.1', resolve));
        const address = listener.address();
        if (address === null || typeof address === 'string') {
            throw new Error('тестовый сервер слушает не TCP-порт');
        }
        server = listener;
        port = address.port;
    }

    async function errorOf(response: Response): Promise<RpcError['error']> {
        return rpcErrorSchema.parse(await response.json()).error;
    }

    it('без фида итераций всё, кроме текущего снапшота, помечено stale', async () => {
        const past = snapshotOf('snap-1', 'iter-1', '2026-09-01T10:00:00.000Z');
        const live = snapshotOf('snap-2', 'iter-2', '2026-09-01T11:00:00.000Z');
        await start({ snapshots: [past, live], current: live });

        const response = await get(port, UI_ENDPOINTS.reviewSnapshots, TOKEN);

        expect(response.status).toBe(200);
        const body = uiReviewSnapshotsResponseSchema.parse(await response.json());
        // Список итераций пуст — сказать «коммита больше нет» нельзя, честнее «устарел».
        expect(body.snapshots.map((snapshot) => [snapshot.snapshotId, snapshot.status])).toEqual([
            ['snap-1', 'stale'],
            ['snap-2', 'current'],
        ]);
    });

    it('без фида ревизия маршрута равна ревизии хранилища', async () => {
        await start({ revision: 17 });

        const response = await get(port, UI_ENDPOINTS.reviewRoute, TOKEN);

        expect(uiReviewRouteResponseSchema.parse(await response.json()).routeRevision).toBe(17);
    });

    it('снапшот на итерации, ушедшей из PR, помечен gone', async () => {
        const gone = snapshotOf('snap-1', 'iter-gone', '2026-09-01T10:00:00.000Z');
        const stale = snapshotOf('snap-2', 'iter-old', '2026-09-01T11:00:00.000Z');
        const live = snapshotOf('snap-3', 'iter-live', '2026-09-01T12:00:00.000Z');
        const feed = {
            iterations: () => [iterationOf('iter-old', 'previous'), iterationOf('iter-live', 'active')],
            staleFor: () => null,
            revision: 0,
        } as unknown as IterationFeed;
        await start({ snapshots: [gone, stale, live], current: live, feed });

        const response = await get(port, UI_ENDPOINTS.reviewSnapshots, TOKEN);

        const body = uiReviewSnapshotsResponseSchema.parse(await response.json());
        expect(body.snapshots.map((snapshot) => snapshot.status)).toEqual(['gone', 'stale', 'current']);
    });

    it('снапшот, чья итерация объявлена gone, тоже gone', async () => {
        const past = snapshotOf('snap-1', 'iter-1', '2026-09-01T10:00:00.000Z');
        const live = snapshotOf('snap-2', 'iter-2', '2026-09-01T11:00:00.000Z');
        const feed = {
            iterations: () => [iterationOf('iter-1', 'gone'), iterationOf('iter-2', 'active')],
            staleFor: () => null,
            revision: 0,
        } as unknown as IterationFeed;
        await start({ snapshots: [past, live], current: live, feed });

        const body = uiReviewSnapshotsResponseSchema.parse(
            await (await get(port, UI_ENDPOINTS.reviewSnapshots, TOKEN)).json(),
        );

        expect(body.snapshots.map((snapshot) => snapshot.status)).toEqual(['gone', 'current']);
    });

    it('прошлый снапшот всегда ready без провала, даже когда живая фаза failed', async () => {
        const past = snapshotOf('snap-1', 'iter-1', '2026-09-01T10:00:00.000Z');
        const live = snapshotOf('snap-2', 'iter-2', '2026-09-01T11:00:00.000Z');
        await start({
            snapshots: [past, live],
            current: live,
            state: {
                phase: 'failed',
                smallPr: true,
                snapshot: live,
                failure: { message: 'модель не сдала скелет', rawOutput: null },
                stale: null,
            },
        });

        const response = await get(port, `${UI_ENDPOINTS.reviewRoute}?snapshot=snap-1`, TOKEN);

        const body = uiReviewRouteResponseSchema.parse(await response.json());
        expect(body.route.snapshot?.snapshotId).toBe('snap-1');
        expect(body.route.phase).toBe('ready');
        expect(body.route.smallPr).toBe(false);
        expect(body.route.failure).toBeNull();
    });

    it('чужой snapshot в query — bad_request', async () => {
        await start({ snapshots: [], current: null });

        const response = await get(port, `${UI_ENDPOINTS.reviewRoute}?snapshot=snap-нет`, TOKEN);

        expect(response.status).toBe(400);
        expect((await errorOf(response)).code).toBe('bad_request');
    });

    it('битое тело fill-stop не доходит до оркестратора', async () => {
        await start();

        const response = await postJson(
            port,
            UI_ENDPOINTS.reviewRouteFillStop,
            { snapshotId: 'snap-1', planIndex: 0 },
            TOKEN,
        );

        expect(response.status).toBe(400);
        const error = await errorOf(response);
        expect(error.code).toBe('bad_request');
        expect(error.details?.[0]).toContain('planIndex: ');
        expect(fillStop).not.toHaveBeenCalled();
    });

    it('битый JSON на обеих POST-ручках — bad_request', async () => {
        await start();

        const generateResponse = await postRaw(port, UI_ENDPOINTS.reviewRouteGenerate, '{"locale": ', TOKEN);
        const fillResponse = await postRaw(port, UI_ENDPOINTS.reviewRouteFillStop, 'не json вовсе', TOKEN);

        expect(generateResponse.status).toBe(400);
        expect((await errorOf(generateResponse)).code).toBe('bad_request');
        expect(fillResponse.status).toBe(400);
        expect((await errorOf(fillResponse)).code).toBe('bad_request');
        expect(generate).not.toHaveBeenCalled();
        expect(fillStop).not.toHaveBeenCalled();
    });
});

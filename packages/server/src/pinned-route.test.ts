import type { IncomingMessage } from 'node:http';
import { architectureStoryFixture } from '@sherpa/fixtures';
import { UI_ENDPOINTS, uiReviewRouteResponseSchema } from '@sherpa/protocol';
import type { RouteSnapshot, UiRouteState } from '@sherpa/protocol';
import { expect, it } from 'vitest';
import { createRouteRoutes } from './route-routes.js';
import type { RouteOrchestrator } from './route-orchestrator.js';
import type { RouteStore } from './route-store.js';

it('GET route разделяет готовый A и ещё не опубликованный B при новой подготовке', async () => {
    const base = architectureStoryFixture().snapshot;
    const aCode = 'a'.repeat(64), bCode = 'b'.repeat(64);
    const a: RouteSnapshot = { ...base, snapshotId: 'review-a', diffId: 'diff-a', codeSnapshotId: aCode };
    const b: RouteSnapshot = { ...base, snapshotId: 'review-b', diffId: 'diff-b', codeSnapshotId: bCode };
    let state: UiRouteState = { phase: 'reading', smallPr: false, snapshot: a, failure: null, stale: null };
    const store = {
        revision: 1, read: () => state, current: () => state.snapshot,
        generationDiffId: () => 'diff-b',
        latestForCode: (id: string) => id === aCode ? a : null,
        getSnapshot: (id: string) => id === a.snapshotId ? a : id === b.snapshotId ? b : null,
    } as unknown as RouteStore;
    const routes = createRouteRoutes({ store, orchestrator: {} as RouteOrchestrator, iterationFeed: null,
        codeDiffId: (id) => id === aCode ? a.diffId : id === bCode ? b.diffId : null });
    const route = routes.find((entry) => entry.path === UI_ENDPOINTS.reviewRoute && entry.method === 'GET');
    if (route === undefined || !('handle' in route)) throw new Error('Missing route');
    const read = (query: string) => route.handle({ req: {} as IncomingMessage,
        url: new URL(`http://127.0.0.1${UI_ENDPOINTS.reviewRoute}?${query}`), onClose: () => undefined });
    const openedB = await read(`codeSnapshotId=${bCode}`);
    expect(openedB.status).toBe(200);
    expect(uiReviewRouteResponseSchema.parse(openedB.body).route).toMatchObject({ phase: 'reading', snapshot: null });
    const openedA = await read(`codeSnapshotId=${aCode}`);
    expect(uiReviewRouteResponseSchema.parse(openedA.body).route).toMatchObject({ phase: 'ready', snapshot: { snapshotId: a.snapshotId } });
    state = { ...state, phase: 'filling', snapshot: b };
    expect(uiReviewRouteResponseSchema.parse((await read(`codeSnapshotId=${bCode}`)).body).route)
        .toMatchObject({ phase: 'filling', snapshot: { snapshotId: b.snapshotId } });
    expect(uiReviewRouteResponseSchema.parse((await read(`codeSnapshotId=${aCode}`)).body).route)
        .toMatchObject({ phase: 'ready', snapshot: { snapshotId: a.snapshotId } });
    expect((await read(`snapshot=${a.snapshotId}&codeSnapshotId=${bCode}`)).status).toBe(400);
});

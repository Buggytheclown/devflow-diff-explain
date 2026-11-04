import type { IncomingMessage } from 'node:http';

import type { CodeReader } from '@sherpa/protocol';
import { UI_ENDPOINTS, uiReviewDiffResponseSchema } from '@sherpa/protocol';
import { expect, it, vi } from 'vitest';

import { createReadRoutes } from './read-routes.js';
import { mediumDiff } from './route/fixture-support.js';

it('код по постоянному ID доступен до обзора и не подменяется активной версией', async () => {
    const codeId = 'a'.repeat(64);
    const pinned = { ...mediumDiff(), codeSnapshotId: codeId };
    const current = { ...pinned, diffId: 'next', codeSnapshotId: 'b'.repeat(64), headCommit: 'next-head' };
    const getDiff = vi.fn(() => Promise.resolve(current));
    const routes = createReadRoutes({
        host: { getDiff } as unknown as CodeReader,
        codeSnapshot: (id) => id === codeId ? pinned : null,
        prMeta: { get: () => null },
    });
    const route = routes.find((entry) => entry.path === UI_ENDPOINTS.reviewDiff);
    if (route === undefined || !('handle' in route)) throw new Error('Missing diff route');
    const read = (query: string) => route.handle({
        req: {} as IncomingMessage,
        url: new URL(`http://127.0.0.1${UI_ENDPOINTS.reviewDiff}?${query}`),
        onClose: () => undefined,
    });
    const response = await read(`codeSnapshotId=${codeId}`);
    expect(response.status).toBe(200);
    expect(uiReviewDiffResponseSchema.parse(response.body).diff).toEqual(pinned);
    expect((await read(`codeSnapshotId=${'c'.repeat(64)}`)).status).toBe(404);
    expect((await read(`codeSnapshotId=${codeId}&diffId=next`)).status).toBe(400);
    expect(getDiff).not.toHaveBeenCalled();
});

import { MEDIUM_DIFF_ID, MEDIUM_DIFF_ID_V2 } from '@sherpa/fixtures';
import { rpcErrorSchema, UI_DEV_ENDPOINTS, uiReviewDiffResponseSchema, uiReviewWriteAckSchema } from '@sherpa/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { SherpaServer } from './server.js';
import { startServer } from './server.js';
import { get, makeTempSherpaDir, postJson, removeTempSherpaDir } from './test-support.js';

/**
 * Дев-ручка «фикстура получает пуш»: она есть только у фикстурного prKey и закрыта тем же
 * токеном, что UI-ручки.
 */

describe('дев-ручки сервера', () => {
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

    async function start(prKey: string): Promise<SherpaServer> {
        const server = await startServer({ prKey, sherpaDir, longPollSeconds: 0.3 });
        servers.push(server);
        return server;
    }

    async function diffIdOf(server: SherpaServer): Promise<string> {
        const response = await get(server.port, '/api/ui/review/diff', server.token);
        return uiReviewDiffResponseSchema.parse(await response.json()).diff.diffId;
    }

    it('на fixture-medium переводит ревью на следующую итерацию', async () => {
        const server = await start('fixture-medium');
        expect(await diffIdOf(server)).toBe(MEDIUM_DIFF_ID);

        const response = await postJson(
            server.port,
            UI_DEV_ENDPOINTS.fixtureAdvanceIteration,
            {},
            server.token,
        );

        expect(response.status).toBe(200);
        expect(uiReviewWriteAckSchema.parse(await response.json())).toEqual({ acknowledged: true });
        expect(await diffIdOf(server)).toBe(MEDIUM_DIFF_ID_V2);
    });

    it('на fixture-small вторая попытка упирается в конец фикстуры', async () => {
        const server = await start('fixture-small');

        const response = await postJson(
            server.port,
            UI_DEV_ENDPOINTS.fixtureAdvanceIteration,
            {},
            server.token,
        );

        expect(response.status).toBe(400);
        expect(rpcErrorSchema.parse(await response.json()).error.code).toBe('bad_request');
    });

    it('у арканумного prKey такого маршрута нет вовсе', async () => {
        const server = await start('arcanum-4821');

        const response = await postJson(
            server.port,
            UI_DEV_ENDPOINTS.fixtureAdvanceIteration,
            {},
            server.token,
        );

        expect(response.status).toBe(404);
    });

    it('дев-ручка закрыта тем же токеном, что UI-ручки', async () => {
        const server = await start('fixture-medium');

        const response = await postJson(server.port, UI_DEV_ENDPOINTS.fixtureAdvanceIteration, {});

        expect(response.status).toBe(401);
        expect(await diffIdOf(server)).toBe(MEDIUM_DIFF_ID);
    });
});

import { UI_ENDPOINTS, rpcErrorSchema, uiPrStateResponseSchema } from '@sherpa/protocol';
import type { UiPrState } from '@sherpa/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { SherpaServer } from './server.js';
import { startServer } from './server.js';
import { get, makeTempSherpaDir, patchJson, removeTempSherpaDir } from './test-support.js';

const PR_KEY = 'arcanum-4242';
const OTHER_PR_KEY = 'arcanum-4343';

/** Ручка per-PR состояния UI: свёртки и история палитры живут в базе этого PR. */
describe('ручка состояния UI этого PR', () => {
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

    /** Хоста ревью нет намеренно: состояние UI обязано работать и у сервера без него. */
    async function start(prKey = PR_KEY): Promise<SherpaServer> {
        const server = await startServer({
            prKey,
            sherpaDir,
            longPollSeconds: 0.3,
            reviewHostFactory: () => null,
            feedback: { env: {} },
        });
        servers.push(server);
        return server;
    }

    async function readPrState(server: SherpaServer): Promise<UiPrState> {
        const response = await get(server.port, UI_ENDPOINTS.prState, server.token);
        expect(response.status).toBe(200);
        return uiPrStateResponseSchema.parse(await response.json()).prState;
    }

    it('без записей отдаёт дефолты', async () => {
        const server = await start();

        expect(await readPrState(server)).toEqual({ treeCollapsed: {}, diffCollapsed: {}, paletteRecent: [] });
    });

    it('патч виден следующему GET и не трогает соседние поля', async () => {
        const server = await start();
        await patchJson(server.port, UI_ENDPOINTS.prState, { treeCollapsed: { 'src/api': true } }, server.token);

        const response = await patchJson(
            server.port,
            UI_ENDPOINTS.prState,
            { paletteRecent: ['diff.toggleMode'] },
            server.token,
        );

        expect(response.status).toBe(200);
        expect(uiPrStateResponseSchema.parse(await response.json()).prState).toEqual({
            treeCollapsed: { 'src/api': true },
            diffCollapsed: {},
            paletteRecent: ['diff.toggleMode'],
        });
        expect(await readPrState(server)).toMatchObject({ treeCollapsed: { 'src/api': true } });
    });

    it('невалидное значение — bad_request, состояние не меняется', async () => {
        const server = await start();
        await patchJson(server.port, UI_ENDPOINTS.prState, { diffCollapsed: { f1: true } }, server.token);

        const response = await patchJson(server.port, UI_ENDPOINTS.prState, { diffCollapsed: ['f1'] }, server.token);

        expect(response.status).toBe(400);
        expect(rpcErrorSchema.parse(await response.json()).error.code).toBe('bad_request');
        expect((await readPrState(server)).diffCollapsed).toEqual({ f1: true });
    });

    it('без токена ручка молчит', async () => {
        const server = await start();

        expect((await get(server.port, UI_ENDPOINTS.prState)).status).toBe(401);
        expect((await patchJson(server.port, UI_ENDPOINTS.prState, { paletteRecent: [] })).status).toBe(401);
    });

    it('у каждого PR состояние своё', async () => {
        const first = await start();
        const second = await start(OTHER_PR_KEY);

        await patchJson(first.port, UI_ENDPOINTS.prState, { paletteRecent: ['first'] }, first.token);
        await patchJson(second.port, UI_ENDPOINTS.prState, { paletteRecent: ['second'] }, second.token);

        expect((await readPrState(first)).paletteRecent).toEqual(['first']);
        expect((await readPrState(second)).paletteRecent).toEqual(['second']);
    });
});

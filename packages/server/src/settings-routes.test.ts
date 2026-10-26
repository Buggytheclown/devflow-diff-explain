import type { UiSettings } from '@sherpa/protocol';
import { UI_ENDPOINTS, rpcErrorSchema, uiSettingsResponseSchema } from '@sherpa/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { SherpaServer } from './server.js';
import { startServer } from './server.js';
import { get, makeTempSherpaDir, patchJson, removeTempSherpaDir } from './test-support.js';

const PR_KEY = 'arcanum-4242';
const OTHER_PR_KEY = 'arcanum-4343';

describe('ручка глобальных настроек UI', () => {
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

    /** Хоста ревью нет намеренно: настройки обязаны работать и у сервера без него. */
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

    async function readSettings(server: SherpaServer): Promise<UiSettings> {
        const response = await get(server.port, UI_ENDPOINTS.settings, server.token);
        expect(response.status).toBe(200);
        return uiSettingsResponseSchema.parse(await response.json()).settings;
    }

    it('без файла отдаёт дефолты', async () => {
        const server = await start();

        expect(await readSettings(server)).toEqual({
            diffMode: 'unified',
            shipMode: 'ship',
            composerLayout: 'visual',
            locale: 'auto',
            theme: 'auto',
            arcanum: false,
            textSize: 'm',
            onboarding: { completedAt: null, step: 0 },
            updates: { dismissedVersion: null },
        });
    });

    it('патч одного поля возвращает полный набор и не трогает соседние', async () => {
        const server = await start();
        await patchJson(server.port, UI_ENDPOINTS.settings, { shipMode: 'sticky_ship' }, server.token);

        const response = await patchJson(server.port, UI_ENDPOINTS.settings, { diffMode: 'split' }, server.token);

        expect(response.status).toBe(200);
        expect(uiSettingsResponseSchema.parse(await response.json()).settings).toEqual({
            diffMode: 'split',
            shipMode: 'sticky_ship',
            composerLayout: 'visual',
            locale: 'auto',
            theme: 'auto',
            arcanum: false,
            textSize: 'm',
            onboarding: { completedAt: null, step: 0 },
            updates: { dismissedVersion: null },
        });
        expect(await readSettings(server)).toMatchObject({ diffMode: 'split', shipMode: 'sticky_ship' });
    });

    it.each([
        ['dark', false], ['light', false], ['auto', false],
        ['dark', true], ['light', true], ['auto', true],
    ] as const)('тема %s, Arcanum=%s читаются другим сервером', async (theme, arcanum) => {
        const first = await start();

        const response = await patchJson(first.port, UI_ENDPOINTS.settings, { theme, arcanum }, first.token);

        expect(response.status).toBe(200);
        expect(uiSettingsResponseSchema.parse(await response.json()).settings).toMatchObject({ theme, arcanum });
        expect(await readSettings(first)).toMatchObject({ theme, arcanum });

        const second = await start(OTHER_PR_KEY);
        expect(await readSettings(second)).toMatchObject({ theme, arcanum });
    });

    it('патчи темы и Arcanum не сбрасывают друг друга', async () => {
        const server = await start();
        await patchJson(server.port, UI_ENDPOINTS.settings, { theme: 'light' }, server.token);
        await patchJson(server.port, UI_ENDPOINTS.settings, { arcanum: true }, server.token);
        expect(await readSettings(server)).toMatchObject({ theme: 'light', arcanum: true });

        await patchJson(server.port, UI_ENDPOINTS.settings, { theme: 'auto' }, server.token);
        expect(await readSettings(server)).toMatchObject({ theme: 'auto', arcanum: true });

        await patchJson(server.port, UI_ENDPOINTS.settings, { arcanum: false }, server.token);
        expect(await readSettings(server)).toMatchObject({ theme: 'auto', arcanum: false });
    });

    it.each([{ arcanum: 'true' }, { theme: 'arcanum-dark' }])('невалидный новый выбор отклоняется: %j', async (patch) => {
        const server = await start();
        const response = await patchJson(server.port, UI_ENDPOINTS.settings, patch, server.token);

        expect(response.status).toBe(400);
        expect(await readSettings(server)).toMatchObject({ theme: 'auto', arcanum: false });
    });

    it('вложенный объект патча заменяется целиком и не задевает язык', async () => {
        const server = await start();

        const response = await patchJson(
            server.port,
            UI_ENDPOINTS.settings,
            { onboarding: { completedAt: null, step: 3 } },
            server.token,
        );

        expect(response.status).toBe(200);
        expect(uiSettingsResponseSchema.parse(await response.json()).settings).toMatchObject({
            onboarding: { completedAt: null, step: 3 },
            locale: 'auto',
            theme: 'auto',
            arcanum: false,
            textSize: 'm',
        });
    });

    it('патч языка не сбрасывает онбординг', async () => {
        const server = await start();
        await patchJson(server.port, UI_ENDPOINTS.settings, { onboarding: { completedAt: null, step: 3 } }, server.token);

        await patchJson(server.port, UI_ENDPOINTS.settings, { locale: 'en' }, server.token);

        expect(await readSettings(server)).toMatchObject({ locale: 'en', onboarding: { completedAt: null, step: 3 } });
    });

    it('сервер другого PR видит те же настройки', async () => {
        const first = await start();
        const second = await start(OTHER_PR_KEY);

        await patchJson(first.port, UI_ENDPOINTS.settings, { diffMode: 'split' }, first.token);
        await patchJson(second.port, UI_ENDPOINTS.settings, { shipMode: 'sticky_ship' }, second.token);

        expect(await readSettings(first)).toMatchObject({ diffMode: 'split', shipMode: 'sticky_ship' });
    });

    it('невалидное значение — bad_request', async () => {
        const server = await start();

        const response = await patchJson(server.port, UI_ENDPOINTS.settings, { diffMode: 'three-way' }, server.token);

        expect(response.status).toBe(400);
        expect(rpcErrorSchema.parse(await response.json()).error.code).toBe('bad_request');
        expect(await readSettings(server)).toMatchObject({ diffMode: 'unified' });
    });

    it('без токена ручка молчит', async () => {
        const server = await start();

        expect((await get(server.port, UI_ENDPOINTS.settings)).status).toBe(401);
        expect((await patchJson(server.port, UI_ENDPOINTS.settings, { diffMode: 'split' })).status).toBe(401);
    });
});

import type { UiSettings } from '@sherpa/protocol';
import { UI_ENDPOINTS, rpcErrorSchema, uiSettingsResponseSchema } from '@sherpa/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { SherpaServer } from './server.js';
import { startServer } from './test-support.js';
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
            reviewSourceFactory: () => null,
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
            generationLocale: 'auto',
            locale: 'ru',
            theme: 'dark',
            arcanum: true,
            textSize: 'm',
        });
    });

    it('патч одного поля возвращает полный набор и не трогает соседние', async () => {
        const server = await start();
        await patchJson(server.port, UI_ENDPOINTS.settings, { generationLocale: 'en' }, server.token);

        const response = await patchJson(server.port, UI_ENDPOINTS.settings, { diffMode: 'split' }, server.token);

        expect(response.status).toBe(200);
        expect(uiSettingsResponseSchema.parse(await response.json()).settings).toEqual({
            diffMode: 'split',
            generationLocale: 'en',
            locale: 'ru',
            theme: 'dark',
            arcanum: true,
            textSize: 'm',
        });
        expect(await readSettings(server)).toMatchObject({ diffMode: 'split', generationLocale: 'en' });
    });

    it.each([
        ['dark', false], ['light', false], ['auto', false],
        ['dark', true], ['light', true], ['auto', true],
    ] as const)('тема %s, Arcanum=%s читаются другим сервером', async (theme, arcanum) => {
        const first = await start();

        const response = await patchJson(first.port, UI_ENDPOINTS.settings, { theme, arcanum }, first.token);

        expect(response.status).toBe(200);
        expect(uiSettingsResponseSchema.parse(await response.json()).settings).toMatchObject({ theme: 'dark', arcanum: true });
        expect(await readSettings(first)).toMatchObject({ theme: 'dark', arcanum: true });

        const second = await start(OTHER_PR_KEY);
        expect(await readSettings(second)).toMatchObject({ theme: 'dark', arcanum: true });
    });

    it('старые настройки оформления не меняют фиксированный интерфейс', async () => {
        const server = await start();
        await patchJson(server.port, UI_ENDPOINTS.settings, { theme: 'light', arcanum: true, locale: 'en' }, server.token);
        expect(await readSettings(server)).toMatchObject({ theme: 'dark', arcanum: true, locale: 'ru' });
    });

    it.each([{ arcanum: 'true' }, { theme: 'arcanum-dark' }])('невалидный новый выбор отклоняется: %j', async (patch) => {
        const server = await start();
        const response = await patchJson(server.port, UI_ENDPOINTS.settings, patch, server.token);

        expect(response.status).toBe(400);
        expect(await readSettings(server)).toMatchObject({ theme: 'dark', arcanum: true });
    });

    it('язык генерации не меняет русский UI', async () => {
        const server = await start();
        await patchJson(server.port, UI_ENDPOINTS.settings, { generationLocale: 'en', textSize: 'l' }, server.token);
        expect(await readSettings(server)).toMatchObject({ generationLocale: 'en', locale: 'ru', textSize: 'l' });
    });

    it('сервер другого PR видит те же настройки', async () => {
        const first = await start();
        const second = await start(OTHER_PR_KEY);

        await patchJson(first.port, UI_ENDPOINTS.settings, { diffMode: 'split' }, first.token);
        await patchJson(second.port, UI_ENDPOINTS.settings, { generationLocale: 'en' }, second.token);

        expect(await readSettings(first)).toMatchObject({ diffMode: 'split', generationLocale: 'en' });
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

import { makeFixtureHost } from '@sherpa/fixtures';
import {
    PROTOCOL_VERSION,
    rpcErrorSchema,
    UI_ENDPOINTS,
    uiFeedbackResponseSchema,
    uiStateSchema,
} from '@sherpa/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SherpaServer } from './server.js';
import { startServer } from './server.js';
import { makeTempSherpaDir, postJson, removeTempSherpaDir, get } from './test-support.js';
import { SERVER_VERSION } from './version.js';

const PR_KEY = 'fixture-medium';
const TRACKER_TOKEN = 'tracker-secret';

describe('канал фидбека', () => {
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

    async function start(
        options: Parameters<typeof startServer>[0]['feedback'] = {},
        currentUser: () => string | null | Promise<string | null> = () => 'alice',
    ): Promise<SherpaServer> {
        const host = makeFixtureHost('medium');
        const server = await startServer({
            prKey: PR_KEY,
            sherpaDir,
            idleSeconds: 0,
            reviewHostFactory: () => ({ name: 'fixture', host, currentUser }),
            feedback: {
                env: { SHERPA_TRACKER_TOKEN: TRACKER_TOKEN },
                retryBaseMs: 0,
                sleep: () => Promise.resolve(),
                random: () => 0,
                ...options,
            },
        });
        servers.push(server);
        return server;
    }

    it('создаёт сабтикет с полным автоконтекстом', async () => {
        const requests: { url: string; init: RequestInit | undefined }[] = [];
        const server = await start({
            fetch: (url, init) => {
                requests.push({ url, init });
                return Promise.resolve(new Response(JSON.stringify({ key: 'EXAMPLE-123456' }), { status: 201 }));
            },
        });
        server.workerRegistry.register('w-feedback', 'claude-code', 'claude-opus-5');

        const response = await postJson(
            server.port,
            UI_ENDPOINTS.feedback,
            {
                text: 'Не видно статус публикации\nПодробности проблемы.',
                includeContext: true,
                context: { view: 'overview', routePhase: 'ready', uiVersion: '0.6.0' },
            },
            server.token,
        );

        expect(response.status).toBe(200);
        expect(uiFeedbackResponseSchema.parse(await response.json())).toEqual({
            outcome: 'created',
            issueKey: 'EXAMPLE-123456',
            issueUrl: 'https://st.yandex-team.ru/EXAMPLE-123456',
            message: null,
        });
        expect(requests).toHaveLength(1);
        expect(requests[0]?.url).toBe('https://st-api.yandex-team.ru/v2/issues');
        expect(new Headers(requests[0]?.init?.headers).get('authorization')).toBe(`OAuth ${TRACKER_TOKEN}`);
        const body = jsonRequestBody(requests[0]?.init) as Record<string, string>;
        expect(body).toMatchObject({
            queue: 'SHERPA',
            summary: 'Не видно статус публикации',
        });
        expect(body).not.toHaveProperty('parent');
        expect(body.description).toContain('Не видно статус публикации\nПодробности проблемы.');
        expect(body.description).toContain(`Версия: UI 0.6.0, сервер ${SERVER_VERSION}, протокол ${PROTOCOL_VERSION}`);
        expect(body.description).toContain('PR: fixture-medium');
        expect(body.description).toContain('Вью: overview');
        expect(body.description).toContain('Фаза маршрута: ready');
        expect(body.description).toContain('claude-code · claude-opus-5 · подключён');
        expect(body.description).toContain('Пользователь: alice');
    });

    it('без контекста отправляет текст как есть и не спрашивает логин', async () => {
        const currentUser = vi.fn(() => 'alice');
        let description = '';
        const server = await start(
            {
                fetch: (_url, init) => {
                    description = (jsonRequestBody(init) as { description: string }).description;
                    return Promise.resolve(new Response(JSON.stringify({ key: 'EXAMPLE-2' }), { status: 201 }));
                },
            },
            currentUser,
        );

        const response = await postJson(
            server.port,
            UI_ENDPOINTS.feedback,
            { text: 'Текст без контекста', includeContext: false, context: null },
            server.token,
        );

        expect(response.status).toBe(200);
        expect(description).toBe('Текст без контекста');
        expect(currentUser).not.toHaveBeenCalled();
    });

    it('без токена показывает деградацию в снапшоте и ручке, fetch не вызывает', async () => {
        const fetchMock = vi.fn((_url: string, _init?: RequestInit) =>
            Promise.resolve(new Response(JSON.stringify({ key: 'EXAMPLE-unexpected' }), { status: 201 })),
        );
        const server = await start({ env: {}, fetch: fetchMock });

        const state = uiStateSchema.parse(
            await (await get(server.port, UI_ENDPOINTS.state, server.token)).json(),
        );
        const response = await postJson(
            server.port,
            UI_ENDPOINTS.feedback,
            { text: 'Не потерять этот текст', includeContext: true, context: { view: 'diff', routePhase: 'none', uiVersion: '0.6.0' } },
            server.token,
        );

        expect(state.feedback.available).toBe(false);
        expect(state.feedback.reason).toMatch(/^Нет OAuth-токена Трекера: /u);
        expect(state.feedback.reason).toContain('очередь SHERPA');
        expect(uiFeedbackResponseSchema.parse(await response.json())).toEqual({
            outcome: 'unavailable',
            issueKey: null,
            issueUrl: null,
            message: state.feedback.reason,
        });
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('без токена в окружении добывает его через ya tool fetch-token при первой отправке', async () => {
        const runYa = vi.fn((_ya: string, _args: readonly string[]) => Promise.resolve('ya-token\n'));
        const requests: RequestInit[] = [];
        const server = await start({
            env: {},
            ya: '/arcadia/ya',
            runYa,
            fetch: (_url, init) => {
                requests.push(init ?? {});
                return Promise.resolve(new Response(JSON.stringify({ key: 'EXAMPLE-4' }), { status: 201 }));
            },
        });

        const state = uiStateSchema.parse(
            await (await get(server.port, UI_ENDPOINTS.state, server.token)).json(),
        );
        expect(state.feedback).toEqual({ available: true, reason: null });
        expect(runYa).not.toHaveBeenCalled();

        for (const text of ['Первый', 'Второй']) {
            const response = await postJson(
                server.port,
                UI_ENDPOINTS.feedback,
                { text, includeContext: false, context: null },
                server.token,
            );
            expect(response.status).toBe(200);
            expect(uiFeedbackResponseSchema.parse(await response.json()).outcome).toBe('created');
        }

        expect(runYa).toHaveBeenCalledTimes(1);
        expect(runYa).toHaveBeenCalledWith('/arcadia/ya', ['tool', 'fetch-token', '-preset', 'startrek']);
        expect(requests.map((init) => new Headers(init.headers).get('authorization'))).toEqual([
            'OAuth ya-token',
            'OAuth ya-token',
        ]);
    });

    it('провал ya tool fetch-token — деградация канала с причиной, fetch не вызывает', async () => {
        const fetchMock = vi.fn((_url: string, _init?: RequestInit) =>
            Promise.resolve(new Response(JSON.stringify({ key: 'EXAMPLE-unexpected' }), { status: 201 })),
        );
        const server = await start({
            env: {},
            ya: '/arcadia/ya',
            runYa: () => Promise.reject(new Error('Command failed: ya tool fetch-token\nskotty: no ssh agent')),
            fetch: fetchMock,
        });

        const response = await postJson(
            server.port,
            UI_ENDPOINTS.feedback,
            { text: 'Не потерять этот текст', includeContext: false, context: null },
            server.token,
        );

        expect(response.status).toBe(200);
        const body = uiFeedbackResponseSchema.parse(await response.json());
        expect(body.outcome).toBe('unavailable');
        expect(body.message).toMatch(/^Нет OAuth-токена Трекера: не удалось получить его через `ya tool fetch-token -preset startrek`/u);
        expect(body.message).toContain('skotty: no ssh agent');
        expect(body.message).toContain('очередь SHERPA');
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('после трёх 503 возвращает host_unavailable', async () => {
        const fetchMock = vi.fn(() =>
            Promise.resolve(new Response('temporary', { status: 503, statusText: 'Service Unavailable' })),
        );
        const server = await start({ fetch: fetchMock, retryAttempts: 3 });

        const response = await postJson(
            server.port,
            UI_ENDPOINTS.feedback,
            { text: 'Повторить потом', includeContext: false, context: null },
            server.token,
        );

        expect(response.status).toBe(502);
        const error = rpcErrorSchema.parse(await response.json());
        expect(error.error.code).toBe('host_unavailable');
        expect(error.error.message).toContain('Введённый текст сохранён');
        expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it('сетевую ошибку не повторяет: ретраи только для 429 и 5xx', async () => {
        const fetchMock = vi.fn(() => Promise.reject(new Error('connection refused')));
        const server = await start({ fetch: fetchMock, retryAttempts: 3 });

        const response = await postJson(
            server.port,
            UI_ENDPOINTS.feedback,
            { text: 'Повторить вручную', includeContext: false, context: null },
            server.token,
        );

        expect(response.status).toBe(502);
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('проверяет обязательные поля и лимит текста до обращения к Трекеру', async () => {
        const fetchMock = vi.fn(() =>
            Promise.resolve(new Response(JSON.stringify({ key: 'EXAMPLE-3' }), { status: 201 })),
        );
        const server = await start({ fetch: fetchMock });

        const empty = await postJson(
            server.port,
            UI_ENDPOINTS.feedback,
            { text: '', includeContext: true, context: { view: 'route', routePhase: 'ready', uiVersion: '0.6.0' } },
            server.token,
        );
        const tooLong = await postJson(
            server.port,
            UI_ENDPOINTS.feedback,
            { text: 'x'.repeat(20_001), includeContext: false, context: null },
            server.token,
        );
        const badContext = await postJson(
            server.port,
            UI_ENDPOINTS.feedback,
            { text: 'ok', includeContext: true, context: { view: '', routePhase: 'unknown', uiVersion: '0.6.0' } },
            server.token,
        );

        expect(empty.status).toBe(400);
        expect(tooLong.status).toBe(400);
        expect(badContext.status).toBe(400);
        expect((await empty.json() as { error: { details?: string[] } }).error.details?.[0]).toContain('text:');
        expect(fetchMock).not.toHaveBeenCalled();
    });
});

function jsonRequestBody(init: RequestInit | undefined): unknown {
    if (typeof init?.body !== 'string') {
        throw new Error('тест ожидал строковое JSON-тело');
    }
    return JSON.parse(init.body) as unknown;
}

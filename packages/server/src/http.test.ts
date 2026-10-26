import http from 'node:http';

import { rpcErrorSchema } from '@sherpa/protocol';
import { afterEach, describe, expect, it } from 'vitest';

import type { Route } from './http.js';
import { createRequestListener } from './http.js';
import { get, postJson } from './test-support.js';

const TOKEN = 'manifest-token';

describe('роутер: набор роутов, собираемый на старте', () => {
    let running: { server: http.Server; port: number } | null = null;

    afterEach(async () => {
        const handle = running;
        running = null;
        if (handle !== null) {
            handle.server.closeAllConnections();
            await new Promise<void>((resolve) => {
                handle.server.close(() => {
                    resolve();
                });
            });
        }
    });

    async function listen(routes: readonly Route[], ready: Promise<void>): Promise<number> {
        const server = http.createServer(createRequestListener({ token: TOKEN, routes, ready }));
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
        const address = server.address();
        if (address === null || typeof address === 'string') {
            throw new Error('тестовый сервер слушает не TCP-порт');
        }
        running = { server, port: address.port };
        return address.port;
    }

    /**
     * Регрессия: манифест публикуется раньше воркерских ручек, поэтому вызов по свежему манифесту
     * законно приходит в промежуток между публикацией и сборкой роутов. 404 в этот момент —
     * ложное «такой ручки нет»: сессия сочла бы сервер несовместимым.
     */
    it('вызов, пришедший до сборки роутов, дожидается их, а не получает 404', async () => {
        const routes: Route[] = [healthRoute()];
        let markReady!: () => void;
        const port = await listen(
            routes,
            new Promise<void>((resolve) => {
                markReady = resolve;
            }),
        );

        const pending = postJson(port, '/worker/register', {}, TOKEN);
        await new Promise((resolve) => setTimeout(resolve, 50));
        routes.push({
            method: 'POST',
            path: '/worker/register',
            handle: () => ({ status: 200, body: { kind: 'registered' } }),
        });
        markReady();

        const response = await pending;
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ kind: 'registered' });
    });

    /** `/healthz` есть с самого начала — им конкурент проверяет нашу живость, ждать он не должен. */
    it('роут из стартового набора отвечает, не дожидаясь готовности остальных', async () => {
        // Промис не резолвится вовсе: если бы `/healthz` его ждал, тест не дождался бы ответа.
        const port = await listen([healthRoute()], neverReady());

        const response = await get(port, '/healthz', TOKEN);

        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ ok: true });
    });

    it('после готовности неизвестная ручка — это 404, а не ожидание', async () => {
        const port = await listen([healthRoute()], Promise.resolve());

        const response = await postJson(port, '/worker/next', {}, TOKEN);

        expect(response.status).toBe(404);
        expect(rpcErrorSchema.parse(await response.json()).error.code).toBe('bad_request');
    });

    it('без токена неизвестная ручка отвечает 401 и после готовности', async () => {
        const port = await listen([healthRoute()], Promise.resolve());

        const response = await postJson(port, '/worker/next', {});

        expect(response.status).toBe(401);
        expect(rpcErrorSchema.parse(await response.json()).error.code).toBe('unauthorized');
    });
});

/** Готовность, которая не наступает: ею проверяется, что стартовый роут её не ждёт. */
function neverReady(): Promise<void> {
    return new Promise<void>(() => undefined);
}

function healthRoute(): Route {
    return { method: 'GET', path: '/healthz', handle: () => ({ status: 200, body: { ok: true } }) };
}

import http from 'node:http';

import type { ChatExchange, RpcError, UiChatAskAnchor } from '@sherpa/protocol';
import { rpcErrorSchema, UI_ENDPOINTS } from '@sherpa/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ChatOrchestrator } from './chat-orchestrator.js';
import { createChatRoutes } from './chat-routes.js';
import type { ChatStore } from './chat-store.js';
import { createRequestListener } from './http.js';
import { get, postJson, postRaw } from './test-support.js';

/**
 * Ручки чата на уровне обработчиков: стор и оркестратор — заглушки, проверяется договор ручки
 * (валидация тела, что уезжает в оркестратор, форма ответа), а не поведение чата.
 */

const TOKEN = 'chat-routes-token';

const EXCHANGE: ChatExchange = {
    id: 1,
    question: 'что тут происходит',
    anchor: null,
    status: 'queued',
    taskId: null,
    answer: null,
    progressText: null,
    error: null,
    locale: null,
    createdAt: '2026-09-01T10:00:00.000Z',
    updatedAt: '2026-09-01T10:00:00.000Z',
};

describe('ручки чата', () => {
    let server: http.Server | null;
    let port: number;
    let ask: ReturnType<typeof vi.fn>;
    let cancel: ReturnType<typeof vi.fn>;
    let retry: ReturnType<typeof vi.fn>;
    let deleteNote: ReturnType<typeof vi.fn>;
    let read: ReturnType<typeof vi.fn>;

    beforeEach(async () => {
        ask = vi.fn(() => Promise.resolve(EXCHANGE));
        cancel = vi.fn(() => 'cancelled');
        retry = vi.fn(() => Promise.resolve('retried'));
        deleteNote = vi.fn();
        read = vi.fn(() => ({ exchanges: [EXCHANGE], notes: [], chatRevision: 7 }));

        const store = { read, deleteNote } as unknown as ChatStore;
        const orchestrator = { ask, cancel, retry } as unknown as ChatOrchestrator;
        const routes = createChatRoutes({ store, orchestrator });

        const listener = http.createServer(createRequestListener({ token: TOKEN, routes }));
        await new Promise<void>((resolve) => listener.listen(0, '127.0.0.1', resolve));
        const address = listener.address();
        if (address === null || typeof address === 'string') {
            throw new Error('тестовый сервер слушает не TCP-порт');
        }
        server = listener;
        port = address.port;
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

    async function errorOf(response: Response): Promise<RpcError['error']> {
        return rpcErrorSchema.parse(await response.json()).error;
    }

    it('объявляет все пять ручек чата на путях контракта', () => {
        const routes = createChatRoutes({
            store: { read, deleteNote } as unknown as ChatStore,
            orchestrator: { ask, cancel, retry } as unknown as ChatOrchestrator,
        });

        expect(routes.map((route) => `${route.method} ${route.path}`)).toEqual([
            `GET ${UI_ENDPOINTS.reviewChat}`,
            `POST ${UI_ENDPOINTS.reviewChatAsk}`,
            `POST ${UI_ENDPOINTS.reviewChatCancel}`,
            `POST ${UI_ENDPOINTS.reviewChatRetry}`,
            `POST ${UI_ENDPOINTS.reviewChatNoteDelete}`,
        ]);
    });

    it('история чата приезжает из стора', async () => {
        const response = await get(port, UI_ENDPOINTS.reviewChat, TOKEN);

        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({ chatRevision: 7 });
        expect(read).toHaveBeenCalledTimes(1);
    });

    it('тело не по контракту — 400 с путём поля в деталях', async () => {
        const response = await postJson(port, UI_ENDPOINTS.reviewChatAsk, {}, TOKEN);

        expect(response.status).toBe(400);
        const error = await errorOf(response);
        expect(error.code).toBe('bad_request');
        expect(error.details?.[0]).toContain('text: ');
        expect(ask).not.toHaveBeenCalled();
    });

    it('корневая ошибка валидации — деталь без пути и без ведущего двоеточия', async () => {
        const response = await postJson(port, UI_ENDPOINTS.reviewChatAsk, 'строка', TOKEN);

        expect(response.status).toBe(400);
        const detail = (await errorOf(response)).details?.[0] ?? '';
        expect(detail).toContain('expected object');
        expect(detail.startsWith(':')).toBe(false);
    });

    it('битый JSON — bad_request, а не 500', async () => {
        const response = await postRaw(port, UI_ENDPOINTS.reviewChatAsk, '{"text": ', TOKEN);

        expect(response.status).toBe(400);
        expect((await errorOf(response)).code).toBe('bad_request');
        expect(ask).not.toHaveBeenCalled();
    });

    it('отсутствующий якорь приходит в оркестратор как null', async () => {
        const response = await postJson(port, UI_ENDPOINTS.reviewChatAsk, { text: 'вопрос' }, TOKEN);

        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ exchange: EXCHANGE });
        expect(ask.mock.calls[0]).toEqual(['вопрос', null, undefined, undefined]);
    });

    it('явный null якоря контракт не пропускает: поле необязательное, но не nullable', async () => {
        const response = await postJson(port, UI_ENDPOINTS.reviewChatAsk, { text: 'вопрос', anchor: null }, TOKEN);

        expect(response.status).toBe(400);
        expect((await errorOf(response)).details?.[0]).toContain('anchor: ');
        expect(ask).not.toHaveBeenCalled();
    });

    it('заданный якорь и локаль доезжают до оркестратора как есть', async () => {
        const anchor: UiChatAskAnchor = {
            fileId: 'file-1',
            path: 'src/index.ts',
            side: 'new',
            start: 10,
            end: 12,
        };

        const response = await postJson(
            port,
            UI_ENDPOINTS.reviewChatAsk,
            { text: 'вопрос', anchor, locale: 'en' },
            TOKEN,
        );

        expect(response.status).toBe(200);
        expect(ask.mock.calls[0]).toEqual(['вопрос', anchor, 'en', undefined]);
    });

    it('отмена и повтор отдают исход оркестратора', async () => {
        const cancelled = await postJson(port, UI_ENDPOINTS.reviewChatCancel, { exchangeId: 5 }, TOKEN);
        const retried = await postJson(port, UI_ENDPOINTS.reviewChatRetry, { exchangeId: 5 }, TOKEN);

        expect(await cancelled.json()).toEqual({ outcome: 'cancelled' });
        expect(await retried.json()).toEqual({ outcome: 'retried' });
        expect(cancel).toHaveBeenCalledWith(5);
        expect(retry).toHaveBeenCalledWith(5);
    });

    it('удаление заметки подтверждается и зовёт стор ровно раз', async () => {
        const response = await postJson(port, UI_ENDPOINTS.reviewChatNoteDelete, { noteId: 3 }, TOKEN);

        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ acknowledged: true });
        expect(deleteNote.mock.calls).toEqual([[3]]);
    });

    it('битый noteId до стора не доходит', async () => {
        const response = await postJson(port, UI_ENDPOINTS.reviewChatNoteDelete, { noteId: 0 }, TOKEN);

        expect(response.status).toBe(400);
        expect((await errorOf(response)).details?.[0]).toContain('noteId: ');
        expect(deleteNote).not.toHaveBeenCalled();
    });
});

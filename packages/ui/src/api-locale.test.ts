import { UI_ENDPOINTS } from '@sherpa/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { askReviewChat, generateReviewRoute } from './api.js';

/** Язык генерации уезжает на сервер телом запроса — вкладка знает его, сервер нет. */

const originalFetch = globalThis.fetch;

afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
});

function mockJson(payload: unknown): ReturnType<typeof vi.fn> {
    const fetch = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) =>
        Promise.resolve(
            new Response(JSON.stringify(payload), {
                status: 200,
                headers: { 'content-type': 'application/json' },
            }),
        ),
    );
    globalThis.fetch = fetch;
    return fetch;
}

function bodyOf(fetch: ReturnType<typeof vi.fn>): unknown {
    const init = fetch.mock.calls[0]?.[1] as RequestInit | undefined;
    const body = init?.body;
    return JSON.parse(typeof body === 'string' ? body : 'null');
}

describe('локаль в запросах UI API', () => {
    it('генерация маршрута шлёт локаль вкладки телом запроса', async () => {
        const fetch = mockJson({ outcome: 'started' });

        expect(await generateReviewRoute('токен', 'en')).toBe('started');
        expect(fetch.mock.calls[0]?.[0]).toBe(UI_ENDPOINTS.reviewRouteGenerate);
        expect(bodyOf(fetch)).toEqual({ locale: 'en' });
    });

    it('вопрос чата без якоря несёт текст и локаль', async () => {
        const fetch = mockJson({
            exchange: {
                id: 1,
                question: 'Why?',
                anchor: null,
                status: 'queued',
                taskId: 7,
                answer: null,
                progressText: null,
                error: null,
                locale: 'en',
                createdAt: '2026-09-04T10:00:00.000Z',
                updatedAt: '2026-09-04T10:00:00.000Z',
            },
        });

        const exchange = await askReviewChat('токен', 'Why?', undefined, 'en');

        expect(exchange.locale).toBe('en');
        expect(bodyOf(fetch)).toEqual({ text: 'Why?', locale: 'en' });
    });

    it('вопрос по выделению добавляет якорь, локаль остаётся', async () => {
        const anchor = { fileId: 'f1', path: 'src/main.ts', side: 'new', start: 10, end: 12 } as const;
        const fetch = mockJson({
            exchange: {
                id: 2,
                question: 'Почему?',
                anchor: { ...anchor, diffId: 'iter-1' },
                status: 'queued',
                taskId: 8,
                answer: null,
                progressText: null,
                error: null,
                locale: 'ru',
                createdAt: '2026-09-04T10:00:00.000Z',
                updatedAt: '2026-09-04T10:00:00.000Z',
            },
        });

        await askReviewChat('токен', 'Почему?', anchor, 'ru');

        expect(bodyOf(fetch)).toEqual({ text: 'Почему?', locale: 'ru', anchor });
    });
});

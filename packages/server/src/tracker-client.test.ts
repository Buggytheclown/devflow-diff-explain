import { describe, expect, it, vi } from 'vitest';

import { RpcFailure } from './errors.js';
import { TrackerClient } from './tracker-client.js';

describe('клиент Яндекс Трекера', () => {
    it('не принимает успех без валидного key', async () => {
        const client = new TrackerClient({
            token: () => Promise.resolve('secret'),
            fetch: () => Promise.resolve(new Response(JSON.stringify({ id: 'EXAMPLE-1' }), { status: 201 })),
        });

        const error = await client.createIssue({ summary: '[Sherpa] test', description: 'test' }).catch(
            (caught: unknown) => caught,
        );

        expect(error).toBeInstanceOf(RpcFailure);
        expect((error as RpcFailure).code).toBe('host_unavailable');
        expect((error as RpcFailure).message).toContain('ответ не сошёлся со схемой');
    });

    it('не повторяет обычный 4xx', async () => {
        const fetchMock = vi.fn(() => Promise.resolve(new Response('bad', { status: 400, statusText: 'Bad Request' })));
        const client = new TrackerClient({
            token: () => Promise.resolve('secret'),
            fetch: fetchMock,
            retryAttempts: 4,
            retryBaseMs: 0,
            sleep: () => Promise.resolve(),
        });

        await expect(client.createIssue({ summary: '[Sherpa] test', description: 'test' })).rejects.toThrow(
            '400 Bad Request',
        );
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });
});

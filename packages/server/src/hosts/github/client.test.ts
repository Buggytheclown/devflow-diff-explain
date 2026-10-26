import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { RpcFailure } from '../../errors.js';

import { GithubClient } from './client.js';

/**
 * Клиент GitHub в изоляции: ретраи, ожидание окна лимита, пагинация REST по `Link`
 * и то, что токен не выходит за заголовок запроса.
 */

const TOKEN = 'test-token-must-never-leak-42';
const QUERY = 'query SherpaProbe { rateLimit { cost remaining resetAt } viewer { login } }';
const SCHEMA = z.object({ viewer: z.object({ login: z.string() }) });

/** Отказ вызова как `RpcFailure`: удачный вызов здесь — ошибка теста, а не другая ветка типа. */
async function failureOf(call: Promise<unknown>): Promise<RpcFailure> {
    try {
        await call;
    } catch (error) {
        return error as RpcFailure;
    }
    throw new Error('ожидали отказ хоста, а вызов удался');
}

interface Call {
    readonly url: string;
    readonly headers: Headers;
}

function makeClient(
    responses: readonly (() => Response)[],
    options: { calls?: Call[]; sleeps?: number[]; now?: () => number; rateLimitWaitMs?: number } = {},
): GithubClient {
    let index = 0;
    return new GithubClient({
        token: () => Promise.resolve(TOKEN),
        baseUrl: 'https://api.github.test',
        retryAttempts: 3,
        retryBaseMs: 10,
        random: () => 0,
        sleep: (ms) => {
            options.sleeps?.push(ms);
            return Promise.resolve();
        },
        ...(options.now === undefined ? {} : { now: options.now }),
        ...(options.rateLimitWaitMs === undefined ? {} : { rateLimitWaitMs: options.rateLimitWaitMs }),
        fetch: (url, init) => {
            options.calls?.push({ url, headers: new Headers(init?.headers) });
            const next = responses[Math.min(index, responses.length - 1)];
            index += 1;
            if (next === undefined) {
                throw new Error('в тесте кончились ответы');
            }
            return Promise.resolve(next());
        },
    });
}

function graphqlOk(body: unknown, remaining = 4999): () => Response {
    return () =>
        new Response(
            JSON.stringify({ data: { rateLimit: { cost: 1, remaining, resetAt: '2026-09-20T11:00:00Z' }, ...(body as object) } }),
            { status: 200, headers: { 'content-type': 'application/json' } },
        );
}

describe('клиент GitHub', () => {
    it('шлёт токен заголовком и версию API', async () => {
        const calls: Call[] = [];
        const client = makeClient([graphqlOk({ viewer: { login: 'alice' } })], { calls });

        expect(await client.graphql(QUERY, {}, SCHEMA)).toEqual({ viewer: { login: 'alice' } });
        expect(calls[0]?.headers.get('authorization')).toBe(`Bearer ${TOKEN}`);
        expect(calls[0]?.headers.get('x-github-api-version')).toBe('2022-11-28');
        expect(calls[0]?.headers.get('accept')).toBe('application/vnd.github+json');
    });

    it('ошибка GitHub в `errors[]` приезжает текстом хоста, без токена', async () => {
        const client = makeClient([
            () =>
                new Response(JSON.stringify({ data: null, errors: [{ message: 'Resource not accessible' }] }), {
                    status: 200,
                }),
        ]);

        const failure = await failureOf(client.graphql(QUERY, {}, SCHEMA));
        expect(failure).toBeInstanceOf(RpcFailure);
        expect(failure.message).toBe('GitHub, SherpaProbe: ошибка GitHub: Resource not accessible.');
        expect(failure.message).not.toContain(TOKEN);
    });

    it('5xx лечится повтором, 4xx — нет', async () => {
        const sleeps: number[] = [];
        const flaky = makeClient(
            [() => new Response('boom', { status: 502 }), graphqlOk({ viewer: { login: 'alice' } })],
            { sleeps },
        );
        expect(await flaky.graphql(QUERY, {}, SCHEMA)).toEqual({ viewer: { login: 'alice' } });
        expect(sleeps).toEqual([10]);

        const calls: Call[] = [];
        const forbidden = makeClient([() => new Response('no', { status: 404, statusText: 'Not Found' })], { calls });
        await expect(forbidden.graphql(QUERY, {}, SCHEMA)).rejects.toBeInstanceOf(RpcFailure);
        expect(calls).toHaveLength(1);
    });

    it('ответ не по схеме — отказ хоста, а не дырка в данных', async () => {
        const client = makeClient([graphqlOk({ viewer: { name: 'alice' } })]);

        const failure = await failureOf(client.graphql(QUERY, {}, SCHEMA));
        expect(failure.message).toContain('ответ не сошёлся со схемой адаптера');
        expect(failure.details?.[0]).toContain('viewer.login');
    });

    it('остаток лимита ниже запаса — следующий запрос ждёт сброса окна', async () => {
        const sleeps: number[] = [];
        const reset = Date.parse('2026-09-20T11:00:00Z');
        const client = makeClient(
            [graphqlOk({ viewer: { login: 'alice' } }, 12), graphqlOk({ viewer: { login: 'alice' } })],
            { sleeps, now: () => reset - 30_000 },
        );

        await client.graphql(QUERY, {}, SCHEMA);
        expect(sleeps).toEqual([]);
        await client.graphql(QUERY, {}, SCHEMA);
        expect(sleeps).toEqual([30_000]);
    });

    it('403 с нулевым остатком не ретраится экспонентой, а ждёт окна', async () => {
        const sleeps: number[] = [];
        const reset = Date.parse('2026-09-20T11:00:00Z');
        const client = makeClient(
            [
                () =>
                    new Response('rate limited', {
                        status: 403,
                        headers: {
                            'x-ratelimit-remaining': '0',
                            'x-ratelimit-reset': String(Math.floor(reset / 1000)),
                        },
                    }),
                graphqlOk({ viewer: { login: 'alice' } }),
            ],
            { sleeps, now: () => reset - 5_000 },
        );

        expect(await client.graphql(QUERY, {}, SCHEMA)).toEqual({ viewer: { login: 'alice' } });
        expect(sleeps).toEqual([5_000]);
    });

    it('мутации с единственной попыткой лимит тоже пережидают', async () => {
        const sleeps: number[] = [];
        const reset = Date.parse('2026-09-20T11:00:00Z');
        const client = makeClient(
            [
                () =>
                    new Response('rate limited', {
                        status: 403,
                        headers: {
                            'x-ratelimit-remaining': '0',
                            'x-ratelimit-reset': String(Math.floor(reset / 1000)),
                        },
                    }),
                graphqlOk({ viewer: { login: 'alice' } }),
            ],
            { sleeps, now: () => reset - 5_000 },
        );

        // Одна попытка у записи — чтобы не задвоить создание, а не чтобы не дождаться окна.
        expect(await client.graphql(QUERY, {}, SCHEMA, 1)).toEqual({ viewer: { login: 'alice' } });
        expect(sleeps).toEqual([5_000]);
    });

    it('лимит без момента сброса не крутит холостой цикл', async () => {
        const calls: Call[] = [];
        const client = makeClient(
            [() => new Response('rate limited', { status: 429, headers: { 'x-ratelimit-remaining': '0' } })],
            { calls },
        );

        const failure = await failureOf(client.graphql(QUERY, {}, SCHEMA, 1));
        expect(failure.message).toContain('лимит запросов GitHub исчерпан');
        expect(calls).toHaveLength(3);
    });

    it('ждать до сброса дольше разумного — отказ хоста, а не сон на час', async () => {
        const reset = Date.parse('2026-09-20T11:00:00Z');
        const client = makeClient(
            [
                () =>
                    new Response('rate limited', {
                        status: 429,
                        headers: {
                            'x-ratelimit-remaining': '0',
                            'x-ratelimit-reset': String(Math.floor(reset / 1000)),
                        },
                    }),
            ],
            { now: () => reset - 3_600_000, rateLimitWaitMs: 60_000 },
        );

        const failure = await failureOf(client.graphql(QUERY, {}, SCHEMA));
        expect(failure.code).toBe('host_unavailable');
        expect(failure.message).toContain('лимит запросов исчерпан');
    });

    it('REST-список дочитывается по заголовку `Link`', async () => {
        const pages = [
            () =>
                new Response('[{"filename":"a.ts"}]', {
                    status: 200,
                    headers: { link: '<https://api.github.test/next?page=2>; rel="next", <x>; rel="last"' },
                }),
            () => new Response('[{"filename":"b.ts"}]', { status: 200 }),
        ];
        const calls: Call[] = [];
        const client = makeClient(pages, { calls });

        const files = await client.restList('/files', z.array(z.object({ filename: z.string() })));
        expect(files).toEqual([{ filename: 'a.ts' }, { filename: 'b.ts' }]);
        expect(calls[1]?.url).toBe('https://api.github.test/next?page=2');
    });

    it('404 у байтов файла — это null, а не ошибка', async () => {
        const client = makeClient([() => new Response('{"message":"Not Found"}', { status: 404 })]);

        expect(await client.restBytes('/repos/a/b/contents/nope.png')).toBeNull();
    });
});

import { describe, expect, it } from 'vitest';

import { RpcFailure } from '../../errors.js';

import { githubTokenSource, resolveGithubToken } from './token.js';

/** Значение токена не должно всплыть ни в одном тексте — тест ищет именно его. */
const SECRET = 'ghp-secret-value-42';

/** Отказ цепочки как `RpcFailure`: удачный вызов здесь — ошибка теста. */
async function failureOf(call: Promise<unknown>): Promise<RpcFailure> {
    try {
        await call;
    } catch (error) {
        return error as RpcFailure;
    }
    throw new Error('ожидали отказ цепочки токена, а токен нашёлся');
}

describe('токен GitHub', () => {
    it('берётся из GITHUB_TOKEN раньше остальных источников', async () => {
        const token = await resolveGithubToken({
            env: { GITHUB_TOKEN: ` ${SECRET} `, GH_TOKEN: 'other' },
            runGh: () => Promise.reject(new Error('не должен вызываться')),
        });

        expect(token).toBe(SECRET);
    });

    it('падает на GH_TOKEN, когда первый не задан', async () => {
        const token = await resolveGithubToken({
            env: { GH_TOKEN: SECRET },
            runGh: () => Promise.reject(new Error('не должен вызываться')),
        });

        expect(token).toBe(SECRET);
    });

    it('последний источник — `gh auth token`', async () => {
        const token = await resolveGithubToken({ env: {}, runGh: () => Promise.resolve(`${SECRET}\n`) });

        expect(token).toBe(SECRET);
    });

    it('неудача всей цепочки — host_unavailable со списком причин, но без токена в тексте', async () => {
        const failure = await failureOf(
            resolveGithubToken({
                env: { GITHUB_TOKEN: '  ', GH_TOKEN: '' },
                runGh: () => Promise.reject(new Error('gh: not logged in')),
            }),
        );

        expect(failure).toBeInstanceOf(RpcFailure);
        expect(failure.code).toBe('host_unavailable');
        expect(failure.details).toEqual([
            'GITHUB_TOKEN не задан',
            'GH_TOKEN не задан',
            '`gh auth token`: gh: not logged in',
        ]);
    });

    it('значение найденного токена наружу не выходит', async () => {
        // Источник сработал — ни сообщение, ни детали не должны содержать значение.
        const source = githubTokenSource({ env: { GITHUB_TOKEN: SECRET } });
        expect(await source()).toBe(SECRET);

        const failure = await failureOf(resolveGithubToken({ env: {}, runGh: () => Promise.resolve('') }));

        expect(JSON.stringify([failure.message, failure.details])).not.toContain(SECRET);
    });

    it('источник кэширует удачу и не кэширует неудачу', async () => {
        let calls = 0;
        const source = githubTokenSource({
            env: {},
            runGh: () => {
                calls += 1;
                return calls === 1 ? Promise.reject(new Error('нет сессии')) : Promise.resolve(SECRET);
            },
        });

        await expect(source()).rejects.toBeInstanceOf(RpcFailure);
        expect(await source()).toBe(SECRET);
        expect(await source()).toBe(SECRET);
        expect(calls).toBe(2);
    });
});

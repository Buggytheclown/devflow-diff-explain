import { describe, expect, it } from 'vitest';

import { RpcFailure } from '../../errors.js';

import { arcTokenSource, resolveArcToken } from './token.js';

/** Цепочка arc: `$ARC_TOKEN` → `~/.arc/token` → `arc token show --json` (`docs/architecture.md` §Токен). */

const FROM_ENV = 'token-from-env';
const FROM_FILE = 'token-from-file';
const FROM_ARC = 'token-from-arc';

const noFile = (): Promise<string> => Promise.reject(new Error('ENOENT: нет такого файла'));
const noArc = (): Promise<string> => Promise.reject(new Error('spawn arc ENOENT'));

describe('токен Арканума', () => {
    it('переменная окружения старше файла и команды', async () => {
        const token = await resolveArcToken({
            env: { ARC_TOKEN: ` ${FROM_ENV}\n` },
            readFile: () => Promise.resolve(FROM_FILE),
            runArc: () => Promise.resolve(JSON.stringify({ token: FROM_ARC })),
        });

        expect(token).toBe(FROM_ENV);
    });

    it('пустая переменная пропускается, читается файл', async () => {
        const token = await resolveArcToken({
            env: { ARC_TOKEN: '   ' },
            readFile: () => Promise.resolve(`${FROM_FILE}\n`),
            runArc: noArc,
        });

        expect(token).toBe(FROM_FILE);
    });

    it('нет файла — спрашиваем arc', async () => {
        const token = await resolveArcToken({
            env: {},
            readFile: noFile,
            runArc: () => Promise.resolve(JSON.stringify({ token: FROM_ARC, type: 'oauth' })),
        });

        expect(token).toBe(FROM_ARC);
    });

    it('не нашли нигде — host_unavailable со списком причин, без значений токенов', async () => {
        const error = await resolveArcToken({ env: {}, readFile: noFile, runArc: noArc }).catch(
            (caught: unknown) => caught,
        );

        expect(error).toBeInstanceOf(RpcFailure);
        const failure = error as RpcFailure;
        expect(failure.code).toBe('host_unavailable');
        expect(failure.details).toHaveLength(3);
        expect(failure.details?.[0]).toContain('ARC_TOKEN');
        expect(JSON.stringify(failure.details)).not.toContain(FROM_ARC);
    });

    it('кривой вывод arc — понятная причина, а не исключение JSON', async () => {
        const error = await resolveArcToken({
            env: {},
            readFile: noFile,
            runArc: () => Promise.resolve('не json'),
        }).catch((caught: unknown) => caught);

        expect((error as RpcFailure).details?.[2]).toContain('не является JSON');
    });

    it('источник кэширует успех и не кэширует неудачу', async () => {
        let calls = 0;
        let broken = true;
        const source = arcTokenSource({
            env: {},
            readFile: noFile,
            runArc: () => {
                calls += 1;
                return broken ? Promise.reject(new Error('arc спит')) : Promise.resolve(JSON.stringify({ token: FROM_ARC }));
            },
        });

        await expect(source()).rejects.toThrow(RpcFailure);
        broken = false;
        expect(await source()).toBe(FROM_ARC);
        expect(await source()).toBe(FROM_ARC);
        expect(calls).toBe(2);
    });
});

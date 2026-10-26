import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { PROTOCOL_VERSION } from '@sherpa/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { connect, resolvePrKey, resolveWorkerId } from './discovery.js';
import { CliError } from './errors.js';
import { manifestPathFor, sherpaDirFrom, workerIdPathFor } from './paths.js';
import type { CommandRunner } from './pr-discovery.js';

const PR_KEY = 'arcanum-777';

describe('discovery', () => {
    let sherpaDir: string;
    let env: Record<string, string | undefined>;

    beforeEach(async () => {
        sherpaDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sherpa-cli-'));
        env = { SHERPA_DIR: sherpaDir };
    });

    afterEach(async () => {
        await fs.rm(sherpaDir, { recursive: true, force: true });
    });

    async function writeManifest(overrides: Record<string, unknown> = {}): Promise<void> {
        const manifestPath = manifestPathFor(sherpaDir, PR_KEY);
        await fs.mkdir(path.dirname(manifestPath), { recursive: true });
        await fs.writeFile(
            manifestPath,
            JSON.stringify({
                prKey: PR_KEY,
                port: 49152,
                pid: process.pid,
                token: 'секрет',
                protocolVersion: PROTOCOL_VERSION,
                serverVersion: '0.0.0',
                createdAt: new Date().toISOString(),
                ...overrides,
            }),
        );
    }

    describe('ключ PR', () => {
        /** Discovery из cwd: `arc info --json`, затем `arc pr status --json`. */
        function arcOnBranch(prId: number): CommandRunner {
            return (_command, args) =>
                Promise.resolve({
                    exitCode: 0,
                    stdout: args[0] === 'info' ? '{"branch":"EXAMPLE-1"}' : `{"id":${String(prId)}}`,
                    stderr: '',
                    failure: null,
                });
        }

        const noCheckout: CommandRunner = () =>
            Promise.resolve({
                exitCode: 1,
                stdout: '',
                stderr: 'Not a mounted arc repository. Did you forget to mount arcadia?',
                failure: null,
            });

        it('берётся из флага, иначе из SHERPA_PR', async () => {
            await expect(resolvePrKey('arcanum-1', { SHERPA_PR: 'arcanum-2' }, arcOnBranch(3))).resolves.toBe(
                'arcanum-1',
            );
            await expect(resolvePrKey(undefined, { SHERPA_PR: 'arcanum-2' }, arcOnBranch(3))).resolves.toBe(
                'arcanum-2',
            );
        });

        it('без того и другого — PR текущей ветки arc-чекаута', async () => {
            await expect(resolvePrKey(undefined, {}, arcOnBranch(4242))).resolves.toBe('arcanum-4242');
            await expect(resolvePrKey(undefined, { SHERPA_PR: '  ' }, arcOnBranch(7))).resolves.toBe('arcanum-7');
        });

        it('discovery не удалось — прежняя просьба про скилл и --pr, с причиной одной строкой', async () => {
            await expect(resolvePrKey(undefined, {}, noCheckout)).rejects.toThrow(CliError);
            await expect(resolvePrKey(undefined, {}, noCheckout)).rejects.toThrow('--pr');
            await expect(resolvePrKey(undefined, {}, noCheckout)).rejects.toThrow('not an arc checkout');
        });

        it('ссылка на PR github.com нормализуется в ключ до всего остального', async () => {
            await expect(
                resolvePrKey('https://github.com/acme/sherpa/pull/42', {}, arcOnBranch(3)),
            ).resolves.toBe('github-acme--sherpa--42');
            await expect(
                resolvePrKey('https://github.com/acme/ui--kit/pull/7/files#diff-abc', {}, arcOnBranch(3)),
            ).resolves.toBe('github-acme--ui--kit--7');
            await expect(
                resolvePrKey(undefined, { SHERPA_PR: 'https://github.com/acme/sherpa/pull/9' }, arcOnBranch(3)),
            ).resolves.toBe('github-acme--sherpa--9');
            // Готовый ключ остаётся собой.
            await expect(resolvePrKey('github-acme--sherpa--42', {}, arcOnBranch(3))).resolves.toBe(
                'github-acme--sherpa--42',
            );
        });

        it('принимает ссылки обоих доменов Arcanum, но не похожие чужие адреса', async () => {
            for (const host of ['a.yandex-team.ru', 'arcanum.yandex-team.ru']) {
                await expect(resolvePrKey(`https://${host}/review/4243/details?x=1#files`, {}, arcOnBranch(3))).resolves.toBe('arcanum-4243');
            }
            await expect(resolvePrKey(undefined, { SHERPA_PR: 'https://arcanum.yandex-team.ru/review/42' }, arcOnBranch(3))).resolves.toBe('arcanum-42');
            for (const value of ['https://a.yandex-team.ru.evil/review/42', 'https://user@a.yandex-team.ru/review/42', 'https://a.yandex-team.ru/review/no']) {
                await expect(resolvePrKey(value, {}, arcOnBranch(3))).rejects.toThrow('invalid PR key');
            }
        });

        it('ключ с выходом из каталога стейта отбивается', async () => {
            await expect(resolvePrKey('../../etc', {}, arcOnBranch(3))).rejects.toThrow('invalid PR key');
        });
    });

    describe('корень стейта', () => {
        it('SHERPA_DIR перебивает ~/.sherpa', () => {
            expect(sherpaDirFrom({ SHERPA_DIR: '/tmp/x' })).toBe('/tmp/x');
            expect(sherpaDirFrom({})).toBe(path.join(os.homedir(), '.sherpa'));
        });
    });

    describe('манифест', () => {
        it('даёт порт и токен сервера', async () => {
            await writeManifest();

            const connection = await connect(PR_KEY, env);

            expect(connection).toMatchObject({ prKey: PR_KEY, port: 49152, token: 'секрет' });
            expect(connection.workerId).not.toBe('');
        });

        it('нет манифеста, битый JSON, не та схема или чужой PR — одна понятная ошибка', async () => {
            await expect(connect(PR_KEY, env)).rejects.toThrow('not found or not responding');

            const manifestPath = manifestPathFor(sherpaDir, PR_KEY);
            await fs.mkdir(path.dirname(manifestPath), { recursive: true });
            await fs.writeFile(manifestPath, '{не json');
            await expect(connect(PR_KEY, env)).rejects.toThrow('not found or not responding');

            await writeManifest({ port: 0 });
            await expect(connect(PR_KEY, env)).rejects.toThrow('not found or not responding');

            await writeManifest({ prKey: 'arcanum-778' });
            await expect(connect(PR_KEY, env)).rejects.toThrow('not found or not responding');
        });
    });

    describe('идентичность воркера', () => {
        it('создаётся один раз и переживает следующие вызовы', async () => {
            const first = await resolveWorkerId(sherpaDir, PR_KEY, env);
            const second = await resolveWorkerId(sherpaDir, PR_KEY, env);

            expect(first).toBe(second);
            expect((await fs.readFile(workerIdPathFor(sherpaDir, PR_KEY), 'utf8')).trim()).toBe(first);
        });

        it('параллельные первые вызовы получают один и тот же id', async () => {
            const [first, second] = await Promise.all([
                resolveWorkerId(sherpaDir, PR_KEY, env),
                resolveWorkerId(sherpaDir, PR_KEY, env),
            ]);

            expect(first).toBe(second);
            expect((await fs.readFile(workerIdPathFor(sherpaDir, PR_KEY), 'utf8')).trim()).toBe(first);
        });

        it('файл доступен только владельцу', async () => {
            await resolveWorkerId(sherpaDir, PR_KEY, env);

            const stats = await fs.stat(workerIdPathFor(sherpaDir, PR_KEY));

            expect(stats.mode & 0o777).toBe(0o600);
        });

        it('SHERPA_WORKER_ID перебивает файл и ничего не пишет', async () => {
            const workerId = await resolveWorkerId(sherpaDir, PR_KEY, { ...env, SHERPA_WORKER_ID: 'w-отладка' });

            expect(workerId).toBe('w-отладка');
            await expect(fs.stat(workerIdPathFor(sherpaDir, PR_KEY))).rejects.toThrow();
        });
    });
});

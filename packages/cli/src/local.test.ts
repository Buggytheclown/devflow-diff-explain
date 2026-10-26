import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { localPrKey, resolveLocalTarget } from './local.js';
import type { CommandOutcome, CommandRunner } from './pr-discovery.js';

/**
 * Ключ локального ревью и резолюция каталога. Живой `arc` не зовётся — исполнитель подставляется,
 * каталог настоящий: путь приводится к абсолютному через realpath.
 */

const INFO = `{
  "repository":"arcadia",
  "author":"alice",
  "user_login":"alice",
  "branch":"sherpa-local-host",
  "hash":"32b57bd3cec8a32a34b72b757cd9f99a436c515a"
}
`;

const NOT_A_CHECKOUT = 'Not a mounted arc repository. Did you forget to mount arcadia?\n';

const NOT_A_GIT_REPO = 'fatal: not a git repository (or any of the parent directories): .git\n';

function outcome(overrides: Partial<CommandOutcome> = {}): CommandOutcome {
    return { exitCode: 0, stdout: '', stderr: '', failure: null, ...overrides };
}

interface Call {
    readonly args: readonly string[];
    readonly cwd: string | undefined;
}

/**
 * Подставной исполнитель: ответ выбирается по первому аргументу команды, а `special` перебивает
 * его там, где одна и та же команда (`git rev-parse`) спрашивается о разном.
 */
function runner(
    answers: Record<string, CommandOutcome>,
    calls: Call[] = [],
    special: (args: readonly string[]) => CommandOutcome | null = () => null,
): CommandRunner {
    return (_command, args, options) => {
        calls.push({ args, cwd: options?.cwd });
        return Promise.resolve(
            special(args) ?? answers[args[0] ?? ''] ?? outcome({ exitCode: 1, stderr: 'unexpected\n' }),
        );
    };
}

describe('ключ локального ревью', () => {
    it('имя каталога плюс отпечаток пути и ветки', () => {
        expect(localPrKey('arc', '/Users/alice/arc/wt/sherpa', 'main')).toMatch(/^local-arc-sherpa-[0-9a-f]{8}$/u);
        expect(localPrKey('git', '/Users/alice/code/app', 'main')).toMatch(/^local-git-app-[0-9a-f]{8}$/u);
    });

    it('одинаковые вход и ветка дают один ключ, разные — разные', () => {
        const key = localPrKey('arc', '/repo/app', 'feature');

        expect(localPrKey('arc', '/repo/app', 'feature')).toBe(key);
        expect(localPrKey('arc', '/repo/app', 'other')).not.toBe(key);
        expect(localPrKey('arc', '/other/app', 'feature')).not.toBe(key);
    });

    // Живой сервер ключа переиспользуется как есть: другая база обязана быть другим ключом,
    // иначе `up --base` молча попал бы на сервер, сравнивающий с чем-то другим.
    it('явная база — часть ключа', () => {
        const key = localPrKey('arc', '/repo/app', 'feature');

        expect(localPrKey('arc', '/repo/app', 'feature', undefined)).toBe(key);
        expect(localPrKey('arc', '/repo/app', 'feature', 'trunk~5')).not.toBe(key);
        expect(localPrKey('arc', '/repo/app', 'feature', 'trunk~5')).toBe(localPrKey('arc', '/repo/app', 'feature', 'trunk~5'));
    });

    // Ключ подставляется в пути стейта, поэтому алфавит ограничен `prKeySchema`.
    it('имя каталога приводится к алфавиту ключа', () => {
        expect(localPrKey('arc', '/repo/моя папка', 'main')).toMatch(/^local-arc-[-]{9}-[0-9a-f]{8}$/u);
        expect(localPrKey('arc', '/repo/a.b_c-d', 'main')).toMatch(/^local-arc-a\.b_c-d-[0-9a-f]{8}$/u);
        expect(localPrKey('arc', '/', 'main')).toMatch(/^local-arc-dir-[0-9a-f]{8}$/u);
    });
});

describe('резолюция каталога локального ревью', () => {
    let dir: string;

    beforeEach(async () => {
        dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'sherpa-cli-local-')));
    });

    afterEach(async () => {
        await fs.rm(dir, { recursive: true, force: true });
    });

    it('каталог, ветка и ключ — из arc, вызванного в этом каталоге', async () => {
        const calls: Call[] = [];
        const run = runner({ root: outcome({ stdout: `${dir}\n` }), info: outcome({ stdout: INFO }) }, calls);

        const target = await resolveLocalTarget(dir, 'trunk~3', run);

        expect(target).toEqual({
            prKey: localPrKey('arc', dir, 'sherpa-local-host', 'trunk~3'),
            vcs: 'arc',
            repo: dir,
            branch: 'sherpa-local-host',
            base: 'trunk~3',
        });
        expect(calls.map((call) => call.cwd)).toEqual([dir, dir]);
        expect(calls.map((call) => call.args.join(' '))).toEqual(['root', 'info --json']);
    });

    // Каталог вне Аркадии: `arc` о нём не знает, и вид VCS определяет второй вопрос — git.
    it('нет arc — каталог и ветка спрашиваются у git', async () => {
        const calls: Call[] = [];
        const run = runner(
            {
                root: outcome({ exitCode: null, failure: 'not-found' }),
                'rev-parse': outcome({ stdout: `${dir}\n` }),
            },
            calls,
            (args) => (args.includes('--abbrev-ref') ? outcome({ stdout: 'feature\n' }) : null),
        );

        const target = await resolveLocalTarget(dir, undefined, run);

        expect(target).toEqual({
            prKey: localPrKey('git', dir, 'feature', undefined),
            vcs: 'git',
            repo: dir,
            branch: 'feature',
            base: undefined,
        });
        expect(target.prKey).toMatch(/^local-git-/u);
        expect(calls.map((call) => call.args.join(' '))).toEqual([
            'root',
            'rev-parse --show-toplevel',
            'rev-parse --abbrev-ref HEAD',
        ]);
    });

    // Клон git внутри arc-чекаута: `arc root` там отвечает успехом, но ревью — про git.
    it('каталог с собственным .git — git, даже если arc его знает', async () => {
        await fs.mkdir(path.join(dir, '.git'));
        const calls: Call[] = [];
        const run = runner(
            { root: outcome({ stdout: `${dir}\n` }), 'rev-parse': outcome({ stdout: `${dir}\n` }) },
            calls,
            (args) => (args.includes('--abbrev-ref') ? outcome({ stdout: 'feature\n' }) : null),
        );

        const target = await resolveLocalTarget(dir, undefined, run);

        expect(target.vcs).toBe('git');
        expect(calls.map((call) => call.args.join(' '))).toEqual([
            'rev-parse --show-toplevel',
            'rev-parse --abbrev-ref HEAD',
        ]);
    });

    // Ревью заведено на ветку: без неё ключ не из чего строить.
    it('отсоединённая голова git — отказ с объяснением', async () => {
        const run = runner(
            { root: outcome({ exitCode: 1, stderr: NOT_A_CHECKOUT }), 'rev-parse': outcome({ stdout: `${dir}\n` }) },
            [],
            (args) => (args.includes('--abbrev-ref') ? outcome({ stdout: 'HEAD\n' }) : null),
        );

        await expect(resolveLocalTarget(dir, undefined, run)).rejects.toThrow('is on a detached HEAD');
    });

    it('относительный путь приводится к абсолютному', async () => {
        const nested = path.join(dir, 'app');
        await fs.mkdir(nested);
        const run = runner({ root: outcome({ stdout: `${dir}\n` }), info: outcome({ stdout: INFO }) });

        const target = await resolveLocalTarget(path.join(dir, 'app', '..', 'app'), undefined, run);

        expect(target.repo).toBe(nested);
        expect(target.base).toBeUndefined();
    });

    it('каталога нет — отказ до всякого arc', async () => {
        const calls: Call[] = [];
        const run = runner({}, calls);

        await expect(resolveLocalTarget(path.join(dir, 'нет-такого'), undefined, run)).rejects.toThrow(
            'there is no directory',
        );
        expect(calls).toEqual([]);
    });

    it('путь ведёт на файл — отказ', async () => {
        const file = path.join(dir, 'file.txt');
        await fs.writeFile(file, 'x');

        await expect(resolveLocalTarget(file, undefined, runner({}))).rejects.toThrow('is not a directory');
    });

    // Отказали обе VCS: в тексте обе причины — по ним видно, чего именно не хватает.
    it('ни arc, ни git — отказ с причинами обоих', async () => {
        const run = runner({
            root: outcome({ exitCode: 1, stderr: NOT_A_CHECKOUT }),
            'rev-parse': outcome({ exitCode: 128, stderr: NOT_A_GIT_REPO }),
        });

        await expect(resolveLocalTarget(dir, undefined, run)).rejects.toThrow(
            'is not inside an arc or git checkout ' +
                '(arc: Not a mounted arc repository. Did you forget to mount arcadia?; ' +
                'git: fatal: not a git repository (or any of the parent directories): .git)',
        );
    });

    it('нет ни одного бинарника — отказ говорит про PATH', async () => {
        const run = runner({
            root: outcome({ exitCode: null, failure: 'not-found' }),
            'rev-parse': outcome({ exitCode: null, failure: 'not-found' }),
        });

        await expect(resolveLocalTarget(dir, undefined, run)).rejects.toThrow(
            '(`arc` is not in PATH; `git` is not in PATH)',
        );
    });

    it('вывод arc info без ветки — отказ, а не ключ из пустоты', async () => {
        const run = runner({ root: outcome({ stdout: `${dir}\n` }), info: outcome({ stdout: '{}' }) });

        await expect(resolveLocalTarget(dir, undefined, run)).rejects.toThrow('it needs the branch name');
    });
});

import { describe, expect, it } from 'vitest';

import type { CommandOutcome, CommandRunner } from './pr-discovery.js';
import { discoverPrKeyFromCheckout } from './pr-discovery.js';

/**
 * Синтетические ответы сохраняют форму контракта команд:
 * `arc info --json` и `arc pr status --json` на ветке с PR, на ветке без PR и вне чекаута.
 * Живой `arc` в тестах не зовётся — исполнитель подставляется.
 */

const INFO_ON_BRANCH = `{
  "repository":"arcadia",
  "remote":"users/alice/EXAMPLE-42",
  "author":"alice",
  "summary":"Обновлена конфигурация примера",
  "remote_head":"6b5bb7fee7fe0c358b48cc24979b67fcfa6bab18",
  "user_login":"alice",
  "branch":"EXAMPLE-42",
  "mount_id":"00000000-11111111-22222222-33333333",
  "repository_type":"vfs",
  "date":"2026-08-10T23:17:39+02:00",
  "message":"Обновлена конфигурация примера",
  "hash":"6b5bb7fee7fe0c358b48cc24979b67fcfa6bab18"
}
`;

// PR приходит целиком, вместе с description на десятки килобайт: тут он усечён до сути.
const PR_STATUS_FOUND = `{
  "id":4242,
  "url":"https://a.yandex-team.ru/review/4242",
  "author":"alice",
  "summary":"EXAMPLE-42: Добавить кеширование в пример",
  "description":"План решения задачи: https://st.yandex-team.ru/EXAMPLE-42",
  "status":"conflicts",
  "issues":["EXAMPLE-42"],
  "merge_allowed":false,
  "from_branch":"users/alice/EXAMPLE-42",
  "to_branch":"trunk",
  "reviewers":["robot-example-reviewer"],
  "created_at":"2026-08-10T21:19:02Z"
}
`;

const NOT_A_CHECKOUT_STDERR = 'Not a mounted arc repository. Did you forget to mount arcadia?\n';
const NO_PR_STDERR = "No pull request in arcanum for branch 'trunk'\n[FAIL] Can't find any PR with id \n";

function ok(stdout: string): CommandOutcome {
    return { exitCode: 0, stdout, stderr: '', failure: null };
}

function failed(stderr: string): CommandOutcome {
    return { exitCode: 1, stdout: '', stderr, failure: null };
}

/** Исполнитель, отвечающий по порядку вызовов: первый — `arc info`, второй — `arc pr status`. */
function runnerOf(...outcomes: readonly CommandOutcome[]): { run: CommandRunner; calls: string[][] } {
    const calls: string[][] = [];
    const run: CommandRunner = (command, args) => {
        calls.push([command, ...args]);
        const outcome = outcomes[calls.length - 1];
        if (outcome === undefined) {
            throw new Error(`неожиданный вызов ${command} ${args.join(' ')}`);
        }
        return Promise.resolve(outcome);
    };
    return { run, calls };
}

describe('discovery PR из чекаута', () => {
    it('ветка с PR — ключ арканумного хоста, ровно две read-only команды', async () => {
        const { run, calls } = runnerOf(ok(INFO_ON_BRANCH), ok(PR_STATUS_FOUND));

        await expect(discoverPrKeyFromCheckout(run)).resolves.toEqual({
            kind: 'found',
            prKey: 'arcanum-4242',
        });
        expect(calls).toEqual([
            ['arc', 'info', '--json'],
            ['arc', 'pr', 'status', '--json'],
        ]);
    });

    it('у ветки нет PR — подсказка с веткой и словами самого arc, второй команды хватает', async () => {
        const { run } = runnerOf(ok(INFO_ON_BRANCH), failed(NO_PR_STDERR));

        const discovery = await discoverPrKeyFromCheckout(run);

        expect(discovery).toEqual({
            kind: 'unavailable',
            hint: 'branch `EXAMPLE-42` has no PR (arc: No pull request in arcanum for branch \'trunk\')',
        });
    });

    it('не arc-чекаут — до `pr status` дело не доходит', async () => {
        const { run, calls } = runnerOf(failed(NOT_A_CHECKOUT_STDERR));

        const discovery = await discoverPrKeyFromCheckout(run);

        expect(discovery).toEqual({
            kind: 'unavailable',
            hint: 'not an arc checkout (arc: Not a mounted arc repository. Did you forget to mount arcadia?)',
        });
        expect(calls).toHaveLength(1);
    });

    it('нет бинаря arc — своя подсказка, а не текст чужой ошибки', async () => {
        const { run } = runnerOf({ exitCode: null, stdout: '', stderr: '', failure: 'not-found' });

        await expect(discoverPrKeyFromCheckout(run)).resolves.toEqual({
            kind: 'unavailable',
            hint: '`arc` is not in PATH — Sherpa detects the PR of the current branch with it',
        });
    });

    it('таймаут `pr status` — подсказка с командой и сроком', async () => {
        const { run } = runnerOf(ok(INFO_ON_BRANCH), {
            exitCode: null,
            stdout: '',
            stderr: '',
            failure: 'timeout',
        });

        await expect(discoverPrKeyFromCheckout(run)).resolves.toEqual({
            kind: 'unavailable',
            hint: '`arc pr status --json` did not answer within 10 s',
        });
    });

    it('битый JSON статуса — отказ, а не падение', async () => {
        const { run } = runnerOf(ok(INFO_ON_BRANCH), ok('{"id":149313'));

        await expect(discoverPrKeyFromCheckout(run)).resolves.toEqual({
            kind: 'unavailable',
            hint: '`arc pr status --json` printed something Sherpa cannot read',
        });
    });

    it('нечисловой или пустой id — тот же отказ: ключ хоста из такого не собрать', async () => {
        for (const stdout of ['{"id":"4242"}', '{"id":0}', '{"url":"https://a.yandex-team.ru/review/1"}', '']) {
            const { run } = runnerOf(ok(INFO_ON_BRANCH), ok(stdout));

            await expect(discoverPrKeyFromCheckout(run)).resolves.toMatchObject({ kind: 'unavailable' });
        }
    });

    it('битый вывод `arc info` не мешает: ветка нужна только подсказке', async () => {
        const { run } = runnerOf(ok('не json'), ok(PR_STATUS_FOUND));

        await expect(discoverPrKeyFromCheckout(run)).resolves.toEqual({
            kind: 'found',
            prKey: 'arcanum-4242',
        });
    });

    it('ветка неизвестна и PR нет — подсказка обходится без имени ветки', async () => {
        const { run } = runnerOf(ok('не json'), failed(NO_PR_STDERR));

        await expect(discoverPrKeyFromCheckout(run)).resolves.toMatchObject({
            hint: expect.stringContaining('the current branch has no PR') as unknown as string,
        });
    });

    it('длинный текст ошибки arc в подсказке обрезается', async () => {
        const { run } = runnerOf(ok(INFO_ON_BRANCH), failed(`${'ы'.repeat(500)}\n`));

        const discovery = await discoverPrKeyFromCheckout(run);

        expect(discovery.kind).toBe('unavailable');
        expect(discovery.kind === 'unavailable' ? discovery.hint.length : 0).toBeLessThan(200);
    });
});

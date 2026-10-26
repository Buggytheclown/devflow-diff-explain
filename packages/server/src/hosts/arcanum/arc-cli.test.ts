import { homedir } from 'node:os';

import { describe, expect, it } from 'vitest';

import { RpcFailure } from '../../errors.js';

import { ArcCli } from './arc-cli.js';
import type { MockArcCall } from './mock-arc.js';
import { makeMockArcCli, makeMockArcRunner, MOCK_ARC_ROOT } from './mock-arc.js';

/**
 * Локальный `arc`: поиск чекаута, батчирование путей и перевод отказов в `host_unavailable`.
 * Живой `arc` здесь не зовётся — всё через записанные ответы (`mock-arc.ts`).
 */

const BASE = '001a722674f219d8096bbff02e1240aa9cffba97';
/** Блоб старой стороны `index.ts` записанного PR — на нём проверяется чтение текста. */
const BASE_BLOB = '03b412b02312d0c8bcb833ac4a8350594d4bc1c8';
const MERGE = '6589b540d27df17e0ce3a9dc0b569a1c2f0999ac';
const SECOND_MOUNT = '/home/alice/arc/arcadia';
const ARCADIA = 'arcadia';
const CLOUDIA = 'cloudia';

/** Выбор чекаута в лог тестов не пишем. */
function silent(): void {
    return undefined;
}

function failure(error: unknown): RpcFailure {
    expect(error).toBeInstanceOf(RpcFailure);
    return error as RpcFailure;
}

describe('поиск чекаута arc', () => {
    it('сервер запущен внутри маунта — берётся он, а не первый живой из списка', async () => {
        const calls: MockArcCall[] = [];
        const arc = makeMockArcCli({ calls, cwd: `${SECOND_MOUNT}/examples/ui` });

        await arc.showText(ARCADIA, BASE_BLOB);

        // `arc info` спрашивается только у своего маунта: он ответил, дальше искать незачем.
        expect(calls.filter((call) => call.kind === 'info').map((call) => call.cwd)).toEqual([
            SECOND_MOUNT,
        ]);
        expect(calls.find((call) => call.kind === 'show')?.cwd).toBe(SECOND_MOUNT);
    });

    it('свой чекаут находится без списка маунтов: `arc mount --list` может и упасть', async () => {
        const calls: MockArcCall[] = [];
        const arc = makeMockArcCli({
            calls,
            cwd: `${SECOND_MOUNT}/examples/ui`,
            failing: { mount: 'failed' },
        });

        await arc.showText(ARCADIA, BASE_BLOB);

        expect(calls.find((call) => call.kind === 'show')?.cwd).toBe(SECOND_MOUNT);
        // До списка маунтов дело не дошло вовсе: чекаут запуска нашёлся сам по себе.
        expect(calls.some((call) => call.kind === 'mount')).toBe(false);
    });

    it('каталог запуска сервера удалён — поиск идёт дальше по списку маунтов', async () => {
        const calls: MockArcCall[] = [];
        // Ворктри сняли, а демон Шерпы живёт: запуск процесса в таком каталоге падает с ENOENT,
        // и `arc root` до нас не доходит — это не повод объявлять, что arc нет вовсе.
        const arc = makeMockArcCli({ calls, cwd: '/tmp/снятый-ворктри', failing: { root: 'not-found' } });

        await arc.showText(ARCADIA, BASE_BLOB);

        expect(calls.find((call) => call.kind === 'show')?.cwd).toBe(MOCK_ARC_ROOT);
        // Список маунтов спрашивается из каталога, который снятие ворктри пережил.
        expect(calls.find((call) => call.kind === 'mount')?.cwd).toBe(homedir());
    });

    it('сервер запущен вне маунтов — берётся первый живой из списка', async () => {
        const calls: MockArcCall[] = [];
        const arc = makeMockArcCli({ calls, cwd: '/tmp' });

        await arc.showText(ARCADIA, BASE_BLOB);

        expect(calls.find((call) => call.kind === 'show')?.cwd).toBe(MOCK_ARC_ROOT);
    });

    it('протухшая запись «mounted» пропускается: чекаут проверяется вызовом arc info', async () => {
        const calls: MockArcCall[] = [];
        // Демон первого маунта умер, а статус в списке остался прежним.
        const arc = makeMockArcCli({ calls, cwd: '/tmp', alive: [SECOND_MOUNT] });

        await arc.showText(ARCADIA, BASE_BLOB);

        expect(calls.filter((call) => call.kind === 'info').map((call) => call.cwd)).toEqual([
            MOCK_ARC_ROOT,
            SECOND_MOUNT,
        ]);
        expect(calls.find((call) => call.kind === 'show')?.cwd).toBe(SECOND_MOUNT);
    });

    it('ни одного живого чекаута — host_unavailable с понятной причиной', async () => {
        const arc = makeMockArcCli({ cwd: '/tmp', alive: [] });

        const error = failure(await arc.showText(ARCADIA, BASE_BLOB).catch((caught: unknown) => caught));

        expect(error.code).toBe('host_unavailable');
        expect(error.message).toContain('чекаут Аркадии');
    });

    it('пустой список маунтов — своя формулировка', async () => {
        const arc = makeMockArcCli({ cwd: '/tmp', mounts: [] });

        const error = failure(await arc.showText(ARCADIA, BASE_BLOB).catch((caught: unknown) => caught));

        expect(error.message).toContain('не показал ни одного');
    });

    it('найденный чекаут ищется один раз, а неудача не запоминается', async () => {
        const calls: MockArcCall[] = [];
        let alive: string[] = [];
        const arc = new ArcCli({
            cwd: '/tmp',
            log: silent,
            // Раннер тот же, а список живых маунтов меняется между вызовами.
            runner: (command) =>
                makeMockArcRunner({ calls, cwd: '/tmp', alive })(command),
        });

        await expect(arc.showText(ARCADIA, BASE_BLOB)).rejects.toThrow(RpcFailure);

        alive = [MOCK_ARC_ROOT];
        await arc.showText(ARCADIA, BASE_BLOB);
        await arc.showText(ARCADIA, BASE_BLOB);

        // Первая попытка искала и не нашла, вторая нашла, третья взяла мемоизированный корень.
        expect(calls.filter((call) => call.kind === 'mount')).toHaveLength(2);
    });

    it('выбранный чекаут пишется в лог одной строкой', async () => {
        const lines: string[] = [];
        const arc = makeMockArcCli({ cwd: '/tmp', log: (line): void => {
                lines.push(line);
            }, });

        await arc.showText(ARCADIA, BASE_BLOB);
        await arc.showText(ARCADIA, BASE_BLOB);

        expect(lines).toHaveLength(1);
        expect(lines[0]).toContain(MOCK_ARC_ROOT);
    });
});

describe('чекаут по репозиторию PR', () => {
    it('PR Cloudia при одних аркадийных маунтах — отказ с командой монтирования', async () => {
        const arc = makeMockArcCli({
            cwd: '/tmp',
            mounts: [{ status: 'mounted', mount: MOCK_ARC_ROOT, tenant: ARCADIA }],
        });

        const error = failure(await arc.showText(CLOUDIA, BASE_BLOB).catch((caught: unknown) => caught));

        expect(error.code).toBe('host_unavailable');
        expect(error.message).toContain('чекаут Cloudia');
        expect(error.message).toContain('arc mount -r cloudia');
        expect(error.message).toContain('среди маунтов arc его нет');
    });

    it('свой чекаут чужого репозитория пропускается ради живого клаудийного из списка', async () => {
        const calls: MockArcCall[] = [];
        const arc = makeMockArcCli({
            calls,
            cwd: `${SECOND_MOUNT}/examples/ui`,
            mounts: [
                { status: 'mounted', mount: MOCK_ARC_ROOT, tenant: CLOUDIA },
                { status: 'mounted', mount: SECOND_MOUNT, tenant: ARCADIA },
            ],
        });

        await arc.showText(CLOUDIA, BASE_BLOB);

        expect(calls.find((call) => call.kind === 'show')?.cwd).toBe(MOCK_ARC_ROOT);
        // Аркадийный маунт из списка отсеян по полю `tenant` — `arc info` в нём не спрашивают.
        // Свой чекаут проверяется всё равно: `arc root` о репозитории не говорит.
        expect(calls.filter((call) => call.kind === 'info').map((call) => call.cwd)).toEqual([
            SECOND_MOUNT,
            MOCK_ARC_ROOT,
        ]);
    });

    it('список без поля tenant — репозиторий кандидата узнаётся из arc info', async () => {
        const calls: MockArcCall[] = [];
        const arc = makeMockArcCli({
            calls,
            cwd: '/tmp',
            legacyMountList: true,
            mounts: [
                { status: 'mounted', mount: MOCK_ARC_ROOT, tenant: ARCADIA },
                { status: 'mounted', mount: SECOND_MOUNT, tenant: CLOUDIA },
            ],
        });

        await arc.showText(CLOUDIA, BASE_BLOB);

        // Отсеять по списку нечем, поэтому спрошены оба — и взят тот, чей `arc info` назвал Cloudia.
        expect(calls.filter((call) => call.kind === 'info').map((call) => call.cwd)).toEqual([
            MOCK_ARC_ROOT,
            SECOND_MOUNT,
        ]);
        expect(calls.find((call) => call.kind === 'show')?.cwd).toBe(SECOND_MOUNT);
    });

    it('чекаут мемоизируется на репозиторий: два тенанта — два чекаута', async () => {
        const calls: MockArcCall[] = [];
        const arc = makeMockArcCli({
            calls,
            cwd: '/tmp',
            mounts: [
                { status: 'mounted', mount: MOCK_ARC_ROOT, tenant: ARCADIA },
                { status: 'mounted', mount: SECOND_MOUNT, tenant: CLOUDIA },
            ],
        });

        await arc.showText(ARCADIA, BASE_BLOB);
        await arc.showText(CLOUDIA, BASE_BLOB);
        await arc.showText(ARCADIA, BASE_BLOB);

        expect(calls.filter((call) => call.kind === 'show').map((call) => call.cwd)).toEqual([
            MOCK_ARC_ROOT,
            SECOND_MOUNT,
            MOCK_ARC_ROOT,
        ]);
        // Поиск на тенант ровно один: третье чтение взяло мемоизированный корень.
        expect(calls.filter((call) => call.kind === 'mount')).toHaveLength(2);
    });
});

describe('чтение диффа и блобов через arc', () => {
    it('пути уходят батчами, а cwd вызова — корень чекаута', async () => {
        const calls: MockArcCall[] = [];
        const paths = Array.from({ length: 30 }, (_, index) => `docs/file-${String(index)}.md`);
        const arc = makeMockArcCli({ calls, cwd: '/tmp', patch: '' });

        await arc.diff(ARCADIA, BASE, MERGE, paths);

        const diffs = calls.filter((call) => call.kind === 'diff');
        expect(diffs).toHaveLength(2);
        expect(diffs.every((call) => call.cwd === MOCK_ARC_ROOT)).toBe(true);
        // Пути делятся без потерь и без дублей, а команда всегда просит git-формат.
        expect(diffs.flatMap((call) => call.args.slice(call.args.indexOf('--') + 1))).toEqual(paths);
        expect(diffs.every((call) => call.args[1] === '--git')).toBe(true);
    });

    it('без путей arc не зовётся вовсе: дифф по всему дереву запрещён', async () => {
        const calls: MockArcCall[] = [];
        const arc = makeMockArcCli({ calls, cwd: '/tmp' });

        expect(await arc.diff(ARCADIA, BASE, MERGE, [])).toBe('');
        expect(calls).toEqual([]);
    });

    it('куски батчей склеиваются в один патч', async () => {
        const arc = makeMockArcCli({ cwd: '/tmp' });

        const patch = await arc.diff(ARCADIA, BASE, MERGE, [
            'examples/ui/packages/grid/src/index.ts',
            'examples/ui/docs/added.md',
        ]);

        expect(patch).toContain('diff --git a/examples/ui/packages/grid/src/index.ts');
        expect(patch).toContain('diff --git a/examples/ui/docs/added.md');
    });

    it('showBytes отдаёт сырые байты, showText — текст', async () => {
        const arc = makeMockArcCli({ cwd: '/tmp' });

        const bytes = await arc.showBytes(ARCADIA, 'bbb0001112223334445556667778889990001112');
        const text = await arc.showText(ARCADIA, BASE_BLOB);

        expect([...bytes.slice(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
        expect(text).toContain('export function columns');
    });
});

describe('отказы arc', () => {
    it('неизвестный объект: host_unavailable с хэшем и советом подтянуть коммиты', async () => {
        const arc = makeMockArcCli({ cwd: '/tmp' });

        const error = failure(await arc.showText(ARCADIA, 'deadbeef').catch((caught: unknown) => caught));

        expect(error.code).toBe('host_unavailable');
        expect(error.message).toContain('deadbeef');
        expect(error.message).toContain('arc pull');
    });

    it('таймаут: host_unavailable, а не пустой дифф', async () => {
        const arc = makeMockArcCli({ cwd: '/tmp', failing: { diff: 'timeout' } });

        const error = failure(
            await arc.diff(ARCADIA, BASE, MERGE, ['docs/a.md']).catch((caught: unknown) => caught),
        );

        expect(error.code).toBe('host_unavailable');
        expect(error.message).toContain('не успел');
    });

    it('arc не найден в PATH — об этом и сказано', async () => {
        const arc = makeMockArcCli({ cwd: '/tmp', failing: { mount: 'not-found' } });

        const error = failure(await arc.showText(ARCADIA, BASE_BLOB).catch((caught: unknown) => caught));

        expect(error.message).toContain('PATH');
    });

    it('код возврата ≠ 0: причина из stderr едет в текст ошибки', async () => {
        const arc = makeMockArcCli({ cwd: '/tmp', failing: { diff: 2 } });

        const error = failure(
            await arc.diff(ARCADIA, BASE, MERGE, ['docs/a.md']).catch((caught: unknown) => caught),
        );

        expect(error.code).toBe('host_unavailable');
        expect(error.message).toContain('mock arc failure (diff)');
        expect(error.message).toContain(MOCK_ARC_ROOT);
    });

    it('нечитаемый список маунтов — host_unavailable, а не пустой поиск', async () => {
        const arc = new ArcCli({
            cwd: '/tmp',
            log: silent,
            // Сервер запущен вне маунтов, а список маунтов приходит не JSON-ом.
            runner: (command) =>
                Promise.resolve(
                    command.args[0] === 'mount'
                        ? {
                              exitCode: 0,
                              stdout: new TextEncoder().encode('не json'),
                              stderr: '',
                              failure: null,
                          }
                        : {
                              exitCode: 1,
                              stdout: new Uint8Array(),
                              stderr: 'Not a mounted arc repository.\n',
                              failure: null,
                          },
                ),
        });

        const error = failure(await arc.showText(ARCADIA, BASE_BLOB).catch((caught: unknown) => caught));

        expect(error.message).toContain('arc mount --list --json');
    });
});


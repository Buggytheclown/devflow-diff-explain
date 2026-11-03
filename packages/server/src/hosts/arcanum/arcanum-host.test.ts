import type { Iteration } from '@sherpa/protocol';
import { IMAGE_BLOB_MAX_BYTES, prDiffSchema } from '@sherpa/protocol';
import { describe, expect, it, vi } from 'vitest';

import { RpcFailure } from '../../errors.js';
import { describeReviewSourceContract } from '../review-source-contract.js';

import { ArcanumHost } from './arcanum-host.js';
import type { MockArcCall, MockArcOptions } from './mock-arc.js';
import { makeMockArcCli } from './mock-arc.js';
import type {
    MockArcanumControl,
    MockArcanumOptions,
    MockTenant,
} from './mock-transport.js';
import {
    EXPECTED_FIELDS,
    makeMockArcanumFetch,
    mockAbcPaths,
    MOCK_DIFF_SET_ID,
    MOCK_PR_ID,
    MOCK_PREVIOUS_DIFF_SET_ID,
    MOCK_PUSHED_DIFF_SET_ID,
    mockFile,
    mockPreviewAYaml,
} from './mock-transport.js';

/**
 * Адаптер Арканума на записанных ответах: общий контрактный набор целиком (чтение и запись)
 * плюс проверки маппинга, кэша итерации, деградации линз и того, что токен не утекает в тексты
 * ошибок. Метаданные приезжают из мока Арканума, текст диффа и байты сторон — из мока `arc`.
 */

/** Латиница не случайно: значение едет заголовком, а заголовок обязан быть ISO-8859-1. */
const TOKEN = 'test-token-must-never-leak-42';

function makeHost(
    options: MockArcanumOptions = {},
    pollIntervalMs = 20,
    arc: MockArcOptions = {},
): ArcanumHost {
    return new ArcanumHost({
        prId: MOCK_PR_ID,
        fetch: makeMockArcanumFetch(options),
        arc: makeMockArcCli(arc),
        token: () => Promise.resolve(TOKEN),
        pollIntervalMs,
        transport: { retryAttempts: 1 },
    });
}

/** «Пуш» мока по конкретному хосту: у каждого экземпляра своё состояние записанного PR. */
const pushes = new WeakMap<ArcanumHost, MockArcanumControl>();

/** Контрактный хост на записанных ответах названного тенанта: PR и чекаут `arc` — одного репо. */
function contractHostOf(tenant: MockTenant): () => ArcanumHost {
    return () => {
        const control: MockArcanumControl = {};
        const host = new ArcanumHost({
            prId: MOCK_PR_ID,
            fetch: makeMockArcanumFetch({ control, tenant }),
            arc: makeMockArcCli({ tenant }),
            token: () => Promise.resolve(TOKEN),
            pollIntervalMs: 20,
            transport: { retryAttempts: 1 },
        });
        pushes.set(host, control);
        return host;
    };
}

const CONTRACT_OPTIONS = {
    advance: (host: ArcanumHost): void => {
        const push = pushes.get(host)?.push;
        if (push === undefined) {
            throw new Error('мок Арканума не отдал ручку «пуш»');
        }
        push();
    },
};

describeReviewSourceContract('ArcanumHost (записанные ответы)', contractHostOf('arcadia'), CONTRACT_OPTIONS);

// Cloudia — тот же Арканум другим тенантом: контракт обязан выполняться и на ней.
describeReviewSourceContract(
    'ArcanumHost (Cloudia, записанные ответы)',
    contractHostOf('cloudia'),
    CONTRACT_OPTIONS,
);

describe('адаптер Арканума: чтение', () => {
    it('шапка PR переводится в контракт словами хоста', async () => {
        const pr = await makeHost().getPr();

        expect(pr).toEqual({
            id: '4242',
            url: 'https://a.yandex-team.ru/review/4242',
            title: 'EXAMPLE-1: grid — считаем колонки честно',
            author: {
                login: 'carol',
                displayName: null,
                bot: false,
                avatarUrl: 'https://center.yandex-team.ru/api/v1/user/carol/avatar/100.jpg',
            },
            fromBranch: 'users/alice/EXAMPLE-1',
            toBranch: 'trunk',
            state: 'open',
            statusLabel: 'review_in_progress',
            // Статус проверок Арканум этой ручкой не отдаёт — честный null.
            checks: null,
            // Микросекунды Арканума приводятся к одной форме для UI.
            updatedAt: '2026-08-20T20:37:28.641Z',
            capabilities: {
                publishVerdicts: [],
                fileViewedSync: false,
                fileContent: true,
                sourceAtRevision: true,
                commentIssues: false,
                commentResolve: false,
                editPublished: false,
                iterations: true,
                blobs: true,
            },
            // Мок PR ревьюеров с вердиктами не отдаёт.
            verdicts: [],
            // Личность ревьюера — логин владельца токена из заголовка ответа.
            viewer: {
                login: 'alice',
                displayName: null,
                bot: false,
                avatarUrl: 'https://center.yandex-team.ru/api/v1/user/alice/avatar/100.jpg',
            },
        });
    });

    it('без заголовка с логином viewer остаётся null, а правка опубликованного выключается', async () => {
        const pr = await makeHost({ user: null }).getPr();

        expect(pr.viewer).toBeNull();
        expect(pr.capabilities.editPublished).toBe(false);
    });

    // Вердикты — не структурное поле: сюрприз в их форме не должен уносить с собой шапку PR.
    it('незнакомая форма блока ревьюеров не роняет мету PR', async () => {
        const pr: unknown = JSON.parse(mockFile('pr.json'));
        const host = makeHost({
            bodies: {
                pr: () =>
                    JSON.stringify({
                        data: { ...(pr as Record<string, unknown>), review: { reviewers: 'кто-то есть' } },
                    }),
            },
        });

        const meta = await host.getPr();

        expect(meta.verdicts).toEqual([]);
        expect(meta.title).not.toBe('');
    });

    it('дифф: файлы changelist, текст из локального arc, числа из патча', async () => {
        const diff = await makeHost().getDiff();

        expect(diff.diffId).toBe('9001');
        expect(diff.baseCommit).toBe('001a722674f219d8096bbff02e1240aa9cffba97');
        // Ревьюируется merge-коммит, а не HEAD ветки.
        expect(diff.headCommit).toBe('6589b540d27df17e0ce3a9dc0b569a1c2f0999ac');

        // Каталоги в дифф не едут — только файлы.
        expect(diff.files.map((file) => file.path)).toEqual([
            'examples/ui/packages/grid/src/index.ts',
            'examples/ui/packages/grid/src/legacy.ts',
            'examples/ui/docs/moved.md',
            'examples/ui/docs/renamed.md',
            'examples/ui/assets/logo.png',
            'examples/ui/assets/moved-logo.png',
            'examples/ui/docs/added.md',
            'examples/ui/docs/huge.md',
            'examples/ui/assets/banner.png',
            'examples/ui/assets/icon.svg',
            'examples/ui/assets/removed-banner.png',
        ]);

        const index = diff.files[0];
        expect(index).toMatchObject({
            fileId: 'eid:file-index',
            changeType: 'modify',
            binary: false,
            generated: false,
            additions: 2,
            deletions: 1,
            viewed: true,
        });
        expect(index?.patch).toContain('diff --git a/examples/ui/packages/grid/src/index.ts');
        expect(index?.patch?.endsWith('\n')).toBe(true);

        expect(diff.files[1]).toMatchObject({ changeType: 'delete', additions: 0, deletions: 2, viewed: false });
        // Переименование `arc` рисует парой «удалён старый путь + добавлен новый целиком»:
        // changelist держит один элемент на новом пути, кусок старого пути отбрасывается.
        expect(diff.files.map((file) => file.path)).not.toContain('examples/ui/docs/old.md');
        expect(diff.files[2]).toMatchObject({
            changeType: 'move',
            oldPath: 'examples/ui/docs/old.md',
            additions: 3,
            deletions: 0,
        });
        expect(diff.files[2]?.patch).toContain('new file mode');
        expect(diff.files[4]).toMatchObject({ binary: true, patch: null, additions: 0, deletions: 0 });
    });

    it('conflict доезжает до контракта как есть: UI метит такой файл бейджем', async () => {
        const host = makeHost(
            {
                bodies: {
                    changelist: () =>
                        JSON.stringify({
                            data: [
                                {
                                    path: 'examples/ui/docs/conflicted.md',
                                    entry_id: 'eid:file-conflict',
                                    change_type: 'conflict',
                                    node_type: 'file',
                                    binary: false,
                                },
                            ],
                        }),
                },
            },
            20,
            {
                patch: [
                    'diff --git a/examples/ui/docs/conflicted.md b/examples/ui/docs/conflicted.md',
                    '--- a/examples/ui/docs/conflicted.md',
                    '+++ b/examples/ui/docs/conflicted.md',
                    '@@ -1,1 +1,2 @@',
                    ' # Grid',
                    '+Конфликтная строка.',
                    '',
                ].join('\n'),
            },
        );

        const diff = await host.getDiff();

        // Схема контракта (`fileChangeTypeSchema`) знает `conflict`: адаптер его не подменяет.
        expect(prDiffSchema.parse(diff).files[0]).toMatchObject({ changeType: 'conflict', additions: 1 });
    });

    it('delete внутри переименованного каталога: кусок патча ищется по старому пути', async () => {
        // Живая форма Арканума (PR 15371420): каталог `old-dir` переехал в `new-dir`, файлы внутри
        // переименованы, и у удалённого элемента `path` склеен из нового каталога и старого имени.
        // По этому пути в патче куска нет и быть не может — настоящий путь лежит в `source`.
        const host = makeHost(
            {
                bodies: {
                    changelist: () =>
                        JSON.stringify({
                            data: [
                                {
                                    path: 'examples/ui/new-dir/old-name.ts',
                                    entry_id: 'eid:file-dropped',
                                    change_type: 'delete',
                                    node_type: 'file',
                                    binary: false,
                                    source: { path: 'examples/ui/old-dir/old-name.ts' },
                                },
                            ],
                        }),
                },
            },
            20,
            {
                patch: [
                    'diff --git a/examples/ui/old-dir/old-name.ts b/examples/ui/old-dir/old-name.ts',
                    'deleted file mode 100644',
                    '--- a/examples/ui/old-dir/old-name.ts',
                    '+++ /dev/null',
                    '@@ -1,2 +0,0 @@',
                    '-export const a = 1;',
                    '-export const b = 2;',
                    '',
                ].join('\n'),
            },
        );

        const diff = await host.getDiff();

        expect(diff.files[0]).toMatchObject({
            path: 'examples/ui/new-dir/old-name.ts',
            oldPath: 'examples/ui/old-dir/old-name.ts',
            changeType: 'delete',
            additions: 0,
            deletions: 2,
        });
        expect(diff.files[0]?.patch).toContain('deleted file mode');
    });

    it('файл changelist без куска в диффе arc — ошибка хоста, а не пустой дифф', async () => {
        const host = makeHost({}, 20, {
            patch: ['diff --git a/other.ts b/other.ts', '@@ -1 +1 @@', '-a', '+b', ''].join('\n'),
        });

        const error = await host.getDiff().catch((caught: unknown) => caught);

        expect(error).toBeInstanceOf(RpcFailure);
        expect((error as RpcFailure).code).toBe('host_unavailable');
        expect((error as RpcFailure).message).toContain('examples/ui/packages/grid/src/index.ts');
    });

    it('без опроса active-diff не кэшируется: пуш виден следующим же вызовом', async () => {
        const calls = new Map<string, number>();
        const host = makeHost({ calls });

        await host.getDiff();
        await host.getDiff();

        expect(calls.get('active-diff')).toBe(2);
    });

    // Тяжёлые ручки Арканума заменены локальным `arc` — обращение к любой из них считается
    // регрессией и роняет мок; этот тест проходит полный сценарий чтения ради такой проверки.
    it('в брошенные ручки Арканума (patch, text-diff, content/file) адаптер не ходит', async () => {
        const seen: string[] = [];
        const inner = makeMockArcanumFetch();
        const host = new ArcanumHost({
            prId: MOCK_PR_ID,
            token: () => Promise.resolve(TOKEN),
            arc: makeMockArcCli(),
            transport: { retryAttempts: 1 },
            fetch: (input, init) => {
                seen.push(new URL(input).pathname);
                return inner(input, init);
            },
        });

        await host.getDiff();
        await host.getDiff({ base: String(MOCK_PREVIOUS_DIFF_SET_ID), head: String(MOCK_DIFF_SET_ID) });
        await host.getFileContent('eid:file-index');
        await host.getBlob('bbb0001112223334445556667778889990001112');

        expect(seen.filter((path) => /\/patch$|text-diff$|\/repos\/content\/file$/.test(path))).toEqual([]);
    });

    it('токен уходит заголовком и не появляется в ошибке', async () => {
        const seen: string[] = [];
        const host = new ArcanumHost({
            prId: MOCK_PR_ID,
            arc: makeMockArcCli(),
            token: () => Promise.resolve(TOKEN),
            transport: { retryAttempts: 1 },
            fetch: (input, init) => {
                seen.push(String(new Headers(init?.headers).get('authorization')));
                return makeMockArcanumFetch({ failing: { pr: 500 } })(input, init);
            },
        });

        const error = await host.getPr().catch((caught: unknown) => caught);

        expect(seen[0]).toBe(`OAuth ${TOKEN}`);
        expect(error).toBeInstanceOf(RpcFailure);
        const failure = error as RpcFailure;
        expect(failure.code).toBe('host_unavailable');
        expect(JSON.stringify([failure.message, failure.details])).not.toContain(TOKEN);
    });

    it('ответ, не прошедший схему, — ошибка хоста, а не дырка в данных', async () => {
        // Проекция `fields` может молча выбросить поле: у файла пропал entry_id.
        const host = makeHost({
            bodies: {
                changelist: () =>
                    JSON.stringify({
                        data: [{ path: 'a.ts', change_type: 'modify', node_type: 'file' }],
                    }),
            },
        });

        const error = await host.getDiff().catch((caught: unknown) => caught);

        expect(error).toBeInstanceOf(RpcFailure);
        expect((error as RpcFailure).code).toBe('host_unavailable');
        expect((error as RpcFailure).details?.join(' ')).toContain('entry_id');
    });

    it('5xx повторяется, 4xx — нет', async () => {
        const calls = new Map<string, number>();
        const flaky = makeMockArcanumFetch({ calls });
        let firstAttempt = true;
        const retrying = new ArcanumHost({
            prId: MOCK_PR_ID,
            arc: makeMockArcCli(),
            token: () => Promise.resolve(TOKEN),
            transport: { retryAttempts: 3, retryBaseMs: 0, sleep: () => Promise.resolve(), random: () => 0 },
            fetch: (input, init) => {
                if (firstAttempt) {
                    firstAttempt = false;
                    return Promise.resolve(new Response('{"errors":[]}', { status: 503 }));
                }
                return flaky(input, init);
            },
        });
        expect((await retrying.getPr()).id).toBe('4242');

        const notFoundCalls = new Map<string, number>();
        const missing = makeHost({ calls: notFoundCalls, failing: { pr: 404 } });
        await expect(missing.getPr()).rejects.toThrow(RpcFailure);
        expect(notFoundCalls.get('pr')).toBe(1);
    });

});

describe('адаптер Арканума: итерации', () => {
    it('перечисляются опубликованные диффсеты, активный — по active-diff', async () => {
        const iterations = await makeHost().listIterations();

        expect(iterations).toEqual([
            {
                diffId: String(MOCK_PREVIOUS_DIFF_SET_ID),
                baseCommit: '001a722674f219d8096bbff02e1240aa9cffba97',
                headCommit: '9f3c1ab77c0f4a2d9b6e51c8d3a7f4b210e6c845',
                createdAt: '2026-08-19T09:12:44.512Z',
                status: 'previous',
            },
            {
                diffId: String(MOCK_DIFF_SET_ID),
                baseCommit: '001a722674f219d8096bbff02e1240aa9cffba97',
                headCommit: '6589b540d27df17e0ce3a9dc0b569a1c2f0999ac',
                createdAt: '2026-08-20T10:31:07.118Z',
                status: 'active',
            },
        ]);
    });

    it('проекция списка диффсетов — плоская', async () => {
        const calls = new Map<string, number>();
        const fields: (string | null)[] = [];
        const inner = makeMockArcanumFetch({ calls });
        const host = new ArcanumHost({
            prId: MOCK_PR_ID,
            arc: makeMockArcCli(),
            token: () => Promise.resolve(TOKEN),
            transport: { retryAttempts: 1 },
            fetch: (input, init) => {
                const url = new URL(input);
                if (url.pathname.endsWith('/diffs')) {
                    fields.push(url.searchParams.get('fields'));
                }
                return inner(input, init);
            },
        });

        await host.listIterations();

        expect(fields).toEqual([EXPECTED_FIELDS.diffSets]);
    });

    it('неопубликованный диффсет и диффсет без коммитов в список не едут', async () => {
        const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
        const host = makeHost({
            bodies: {
                diffs: () =>
                    JSON.stringify({
                        data: [
                            { id: 35860000, created_at: '2026-08-18T08:00:00.000000Z', published: true },
                            { id: 35865000, created_at: '2026-08-18T09:00:00.000000Z', published: false },
                            ...(JSON.parse(mockFile('diffs.json')) as unknown[]),
                        ],
                    }),
            },
        });

        try {
            const iterations = await host.listIterations();

            expect(iterations.map((iteration) => iteration.diffId)).toEqual([
                String(MOCK_PREVIOUS_DIFF_SET_ID),
                String(MOCK_DIFF_SET_ID),
            ]);
            expect(stderr.mock.calls.some((call) => String(call[0]).includes('35860000'))).toBe(true);
        } finally {
            stderr.mockRestore();
        }
    });

    it('срез между итерациями: файлы changelist, текст из arc по merge-коммитам', async () => {
        const arcCalls: MockArcCall[] = [];
        const slice = await makeHost({}, 20, { calls: arcCalls }).getDiff({
            base: String(MOCK_PREVIOUS_DIFF_SET_ID),
            head: String(MOCK_DIFF_SET_ID),
        });

        // Дифф считается между ревьюируемыми коммитами итераций, а не между вершинами их веток.
        expect(arcCalls.find((call) => call.kind === 'diff')?.args.slice(2, 4)).toEqual([
            '9f3c1ab77c0f4a2d9b6e51c8d3a7f4b210e6c845',
            '6589b540d27df17e0ce3a9dc0b569a1c2f0999ac',
        ]);
        expect(slice.diffId).toBe(String(MOCK_DIFF_SET_ID));
        // База среза — ревьюируемый коммит базовой итерации, голова — активной.
        expect(slice.baseCommit).toBe('9f3c1ab77c0f4a2d9b6e51c8d3a7f4b210e6c845');
        expect(slice.headCommit).toBe('6589b540d27df17e0ce3a9dc0b569a1c2f0999ac');
        expect(slice.files.map((file) => file.path)).toEqual([
            'examples/ui/packages/grid/src/index.ts',
            'examples/ui/docs/added.md',
            'examples/ui/assets/banner.png',
        ]);
        // fileId среза — свои, с fileId итерации они не совпадают.
        expect(slice.files.map((file) => file.fileId)).toEqual(['eid:i-index', 'eid:i-added', 'eid:i-banner']);
        expect(slice.files[0]?.patch).toContain('@@ -1,4 +1,4 @@');
        expect(slice.files[0]).toMatchObject({ additions: 1, deletions: 1 });
        expect(slice.files[1]).toMatchObject({ changeType: 'add', additions: 2, deletions: 0 });
        // Картинка среза: текста у неё нет, зато стороны собраны из блобов его changelist.
        expect(slice.files[2]).toMatchObject({ binary: true, patch: null });
        expect(slice.files[2]?.image).toEqual({
            mime: 'image/png',
            before: { blobId: 'ccc0001112223334445556667778889990001112', size: 115 },
            after: { blobId: 'bbb0001112223334445556667778889990001112', size: 108 },
        });
    });

    it('пустой интердифф — валидный дифф без файлов', async () => {
        const host = makeHost({ bodies: { 'interdiff-changelist': () => '{"data":[]}' } });

        const slice = await host.getDiff({
            base: String(MOCK_PREVIOUS_DIFF_SET_ID),
            head: String(MOCK_DIFF_SET_ID),
        });

        expect(slice.files).toEqual([]);
        expect(slice.diffId).toBe(String(MOCK_DIFF_SET_ID));
    });

    // Файл без текста поехал бы в UI как «в срезе не менялся» — худший вид молчаливой потери.
    it('arc не показал файл среза — host_unavailable, а не пустой патч', async () => {
        const host = makeHost({}, 20, {
            patch: [
                'diff --git a/examples/ui/docs/added.md b/examples/ui/docs/added.md',
                'new file mode 100644',
                '--- /dev/null',
                '+++ b/examples/ui/docs/added.md',
                '@@ -0,0 +1,1 @@',
                '+# Added',
                '',
            ].join('\n'),
        });

        const error = await host
            .getDiff({ base: String(MOCK_PREVIOUS_DIFF_SET_ID), head: String(MOCK_DIFF_SET_ID) })
            .catch((caught: unknown) => caught);

        expect(error).toBeInstanceOf(RpcFailure);
        expect((error as RpcFailure).code).toBe('host_unavailable');
        expect((error as RpcFailure).message).toContain('examples/ui/packages/grid/src/index.ts');
    });

    it('срез с неизвестной итерацией — bad_request с понятным текстом', async () => {
        const error = await makeHost()
            .getDiff({ base: 'iter-1', head: String(MOCK_DIFF_SET_ID) })
            .catch((caught: unknown) => caught);

        expect(error).toBeInstanceOf(RpcFailure);
        expect((error as RpcFailure).code).toBe('bad_request');
        expect((error as RpcFailure).message).toContain('iter-1');
    });

    it('watchIterations будит подписчика на смене активного диффсета', async () => {
        const control: MockArcanumControl = {};
        const host = new ArcanumHost({
            prId: MOCK_PR_ID,
            arc: makeMockArcCli(),
            fetch: makeMockArcanumFetch({ control }),
            token: () => Promise.resolve(TOKEN),
            pollIntervalMs: 10,
            transport: { retryAttempts: 1 },
        });

        const snapshots: Iteration[][] = [];
        const stop = host.watchIterations((iterations) => {
            snapshots.push(iterations);
        });
        try {
            await waitUntil(() => snapshots.length > 0);
            expect(snapshots[0]?.find((iteration) => iteration.status === 'active')?.diffId).toBe(
                String(MOCK_DIFF_SET_ID),
            );

            control.push?.();
            await waitUntil(() => snapshots.length > 1);

            const last = snapshots.at(-1) ?? [];
            expect(last.map((iteration) => iteration.diffId)).toEqual([
                String(MOCK_PREVIOUS_DIFF_SET_ID),
                String(MOCK_DIFF_SET_ID),
                String(MOCK_PUSHED_DIFF_SET_ID),
            ]);
            expect(last.filter((iteration) => iteration.status === 'active')).toHaveLength(1);
            expect(last.at(-1)?.status).toBe('active');
        } finally {
            stop();
        }
    });
});

describe('адаптер Арканума: переименования и батчи arc', () => {
    /** Changelist без переименований: остаются modify, delete и бинарное добавление. */
    function withoutRenames(): string {
        const entries = JSON.parse(mockFile('changelist.json')) as { change_type: string }[];
        return JSON.stringify({ data: entries.filter((entry) => entry.change_type !== 'move') });
    }

    it('move: дельта как её показывает arc — весь новый файл добавлениями', async () => {
        const diff = await makeHost().getDiff();
        const moved = diff.files.find((file) => file.path === 'examples/ui/docs/moved.md');

        // `arc` рисует переименование парой «удалён старый путь + добавлен новый»; своей
        // арифметики у адаптера нет, поэтому в UI едут именно эти числа.
        expect(moved).toMatchObject({ changeType: 'move', additions: 3, deletions: 0 });
        expect(moved?.patch).toContain('+Колонки считаются по ненулевой ширине.');
    });

    it('чистое переименование: текст нового пути целиком, старый путь — в oldPath', async () => {
        const diff = await makeHost().getDiff();
        const renamed = diff.files.find((file) => file.path === 'examples/ui/docs/renamed.md');

        expect(renamed).toMatchObject({
            changeType: 'move',
            oldPath: 'examples/ui/docs/keep.md',
            additions: 2,
            deletions: 0,
        });
        expect(renamed?.patch).toContain('+# Колонки');
    });

    it('в arc уходят оба пути move и ни одного бинарного, одним батчем', async () => {
        const calls: MockArcCall[] = [];

        await makeHost({}, 20, { calls }).getDiff();

        const diffs = calls.filter((call) => call.kind === 'diff');
        expect(diffs).toHaveLength(1);
        const args = diffs[0]?.args ?? [];
        const paths = args.slice(args.indexOf('--') + 1);
        expect(paths).toEqual([
            'examples/ui/packages/grid/src/index.ts',
            'examples/ui/packages/grid/src/legacy.ts',
            'examples/ui/docs/moved.md',
            'examples/ui/docs/old.md',
            'examples/ui/docs/renamed.md',
            'examples/ui/docs/keep.md',
            'examples/ui/docs/added.md',
            'examples/ui/docs/huge.md',
            'examples/ui/assets/icon.svg',
        ]);
    });

    it('бинарное переименование остаётся бинарным файлом без патча', async () => {
        const diff = await makeHost().getDiff();
        const logo = diff.files.find((file) => file.path === 'examples/ui/assets/moved-logo.png');

        expect(logo).toMatchObject({
            changeType: 'move',
            binary: true,
            patch: null,
            additions: 0,
            deletions: 0,
        });
    });

    it('PR без текстовых файлов в arc не ходит вовсе', async () => {
        const calls: MockArcCall[] = [];
        const binaryOnly = JSON.stringify({
            data: (JSON.parse(mockFile('changelist.json')) as { path: string }[]).filter(
                (entry) => entry.path === 'examples/ui/assets/logo.png',
            ),
        });

        const diff = await makeHost({ bodies: { changelist: () => binaryOnly } }, 20, { calls }).getDiff();

        expect(diff.files.map((file) => file.path)).toEqual(['examples/ui/assets/logo.png']);
        expect(calls.filter((call) => call.kind === 'diff')).toEqual([]);
    });

    it('пути батчатся: длинный changelist уходит несколькими вызовами arc', async () => {
        const entries = Array.from({ length: 30 }, (_, index) => ({
            path: `examples/ui/docs/file-${String(index)}.md`,
            entry_id: `eid:file-${String(index)}`,
            change_type: 'modify',
            node_type: 'file',
            binary: false,
        }));
        const patch = entries
            .map((entry) =>
                [
                    `diff --git a/${entry.path} b/${entry.path}`,
                    `--- a/${entry.path}`,
                    `+++ b/${entry.path}`,
                    '@@ -1 +1 @@',
                    '-было',
                    '+стало',
                    '',
                ].join('\n'),
            )
            .join('');
        const calls: MockArcCall[] = [];

        const diff = await makeHost(
            { bodies: { changelist: () => JSON.stringify({ data: entries }) } },
            20,
            { calls, patch },
        ).getDiff();

        const diffs = calls.filter((call) => call.kind === 'diff');
        expect(diffs).toHaveLength(2);
        expect(diff.files).toHaveLength(30);
        expect(diff.files.every((file) => file.additions === 1 && file.deletions === 1)).toBe(true);
    });

    it('дифф arc читается один раз на итерацию', async () => {
        const calls: MockArcCall[] = [];
        const host = makeHost({}, 20, { calls });

        await host.getDiff();
        await host.getDiff();

        expect(calls.filter((call) => call.kind === 'diff')).toHaveLength(1);
    });

    it('отказ arc — host_unavailable, а не пустой дифф; в кэш он не ложится', async () => {
        const calls: MockArcCall[] = [];
        const host = makeHost({}, 20, { calls, failing: { diff: 1 } });

        const error = await host.getDiff().catch((caught: unknown) => caught);

        expect(error).toBeInstanceOf(RpcFailure);
        expect((error as RpcFailure).code).toBe('host_unavailable');
        // Провалившийся дифф не запоминается: следующий вызов пробует снова.
        await host.getDiff().catch(() => null);
        expect(calls.filter((call) => call.kind === 'diff')).toHaveLength(2);
    });

    it('PR без переименований в старые пути arc не зовёт', async () => {
        const calls: MockArcCall[] = [];
        const host = makeHost({ bodies: { changelist: withoutRenames } }, 20, { calls });

        const diff = await host.getDiff();

        expect(diff.files.map((file) => file.path)).not.toContain('examples/ui/docs/moved.md');
        const diffCall = calls.find((call) => call.kind === 'diff');
        expect(diffCall?.args).not.toContain('examples/ui/docs/old.md');
    });
});

describe('адаптер Арканума: содержимое файлов и blame', () => {
    /** Хост и журнал того, какие объекты адаптер прочитал локальным `arc`. */
    function makeContentHost(
        options: MockArcanumOptions = {},
        arc: MockArcOptions = {},
    ): { host: ArcanumHost; shown: () => string[] } {
        const calls: MockArcCall[] = [];
        const host = new ArcanumHost({
            prId: MOCK_PR_ID,
            arc: makeMockArcCli({ ...arc, calls }),
            token: () => Promise.resolve(TOKEN),
            transport: { retryAttempts: 1 },
            fetch: makeMockArcanumFetch(options),
        });
        const shown = (): string[] =>
            calls.filter((call) => call.kind === 'show').map((call) => call.args[1] ?? '');
        return { host, shown };
    }

    it('modify: обе стороны — два чтения блобов', async () => {
        const { host, shown } = makeContentHost();

        const content = await host.getFileContent('eid:file-index');

        expect(shown()).toEqual([
            '03b412b02312d0c8bcb833ac4a8350594d4bc1c8',
            'c9ec99eb2e1a286c1319bb8ec5cd2de6f740fc62',
        ]);
        expect(content?.oldText).toBe('export function columns(grid: Grid): number {\n    return grid.length;\n}\n');
        expect(content?.newText).toContain('column.width > 0');
        // Строки контекста должны сойтись с патчем по номерам — на этом стоит «Expand context».
        expect(content?.newText?.split('\n')[0]).toBe('export function columns(grid: Grid): number {');
    });

    it('add: старой стороны нет — одно чтение и null вместо выдуманной пустой строки', async () => {
        const { host, shown } = makeContentHost();

        const content = await host.getFileContent('eid:file-added');

        expect(shown()).toEqual(['9999999000000011111112222222333333344444']);
        expect(content?.oldText).toBeNull();
        expect(content?.newText).toBe('# Ширина\n\nШирина колонки — число.\n');
    });

    it('delete: новой стороны нет — зеркально', async () => {
        const { host, shown } = makeContentHost();

        const content = await host.getFileContent('eid:file-legacy');

        expect(shown()).toEqual(['ccc1112223334445556667778889990001112223']);
        expect(content?.newText).toBeNull();
        expect(content?.oldText).toBe('export const legacy = true;\nexport const legacyColumns = 3;\n');
    });

    it('чистое переименование: равные blob — одно чтение за новой стороной', async () => {
        const { host, shown } = makeContentHost();

        const content = await host.getFileContent('eid:file-renamed');

        expect(shown()).toEqual(['2222222333333344444445555555666666677777']);
        expect(content?.oldText).toBe(content?.newText);
        expect(content?.newText).toBe('# Колонки\n\n');
    });

    it('бинарник и файл за порогом размера отсекаются до чтения', async () => {
        const { host, shown } = makeContentHost();

        expect(await host.getFileContent('eid:file-logo')).toBeNull();
        expect(await host.getFileContent('eid:file-huge')).toBeNull();
        expect(shown()).toEqual([]);
    });

    // Картинке расширять нечего: у png нет текста вовсе, а svg показывается карточкой.
    it('картинка — null без чтения, включая svg с текстовым патчем', async () => {
        const { host, shown } = makeContentHost();

        expect(await host.getFileContent('eid:file-banner')).toBeNull();
        expect(await host.getFileContent('eid:file-icon')).toBeNull();
        expect(shown()).toEqual([]);
    });

    it('arc не отдал блоб: ошибка наружу, а не null', async () => {
        const { host } = makeContentHost({}, { failing: { show: 1 } });

        const error = await host.getFileContent('eid:file-legacy').catch((caught: unknown) => caught);

        // `null` в контракте — свойство файла: отдай мы его здесь, UI закэшировал бы отказ
        // и навсегда погасил «Expand context» с ложной причиной. Ошибку он предлагает повторить.
        expect(error).toBeInstanceOf(RpcFailure);
        expect((error as RpcFailure).code).toBe('host_unavailable');
    });

    /**
     * Картинки. Опорный факт разведки: у png changelist отдаёт `binary: false`, поэтому
     * двоичность считается по расширению — иначе кусок arc-патча «Binary files … differ» уехал бы
     * в UI как текстовый дифф.
     */
    it('png: binary и patch: null вопреки binary: false в changelist, стороны из блобов', async () => {
        const diff = await makeHost().getDiff();
        const byPath = new Map(diff.files.map((file) => [file.path, file]));

        const banner = byPath.get('examples/ui/assets/banner.png');
        expect(banner).toMatchObject({ binary: true, patch: null, additions: 0, deletions: 0 });
        expect(banner?.image).toEqual({
            mime: 'image/png',
            before: { blobId: 'aaa0001112223334445556667778889990001112', size: 109 },
            after: { blobId: 'bbb0001112223334445556667778889990001112', size: 108 },
        });

        // add и delete: сторон по одной, и стороны эти разные.
        expect(byPath.get('examples/ui/assets/logo.png')?.image).toEqual({
            mime: 'image/png',
            before: null,
            after: { blobId: 'ddd1112223334445556667778889990001112223', size: 115 },
        });
        expect(byPath.get('examples/ui/assets/removed-banner.png')).toMatchObject({
            changeType: 'delete',
            binary: true,
            patch: null,
        });
        expect(byPath.get('examples/ui/assets/removed-banner.png')?.image).toEqual({
            mime: 'image/png',
            before: { blobId: '1110001112223334445556667778889990001112', size: 115 },
            after: null,
        });
    });

    it('svg остаётся текстом: патч на месте, картинка тоже', async () => {
        const diff = await makeHost().getDiff();
        const icon = diff.files.find((file) => file.path === 'examples/ui/assets/icon.svg');

        expect(icon).toMatchObject({ binary: false, changeType: 'add', additions: 1, deletions: 0 });
        expect(icon?.patch).toContain('+<svg xmlns=');
        expect(icon?.image).toEqual({
            mime: 'image/svg+xml',
            before: null,
            after: { blobId: 'fff0001112223334445556667778889990001112', size: 116 },
        });
    });

    it('getBlob: байты по известному блобу, null по чужому', async () => {
        const { host, shown } = makeContentHost();
        await host.getDiff();

        const bytes = await host.getBlob('bbb0001112223334445556667778889990001112');

        expect(bytes?.length).toBe(108);
        // PNG-сигнатура: `arc show` отдаёт сырые байты, а не текст и не base64.
        expect([...(bytes ?? []).slice(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
        expect(shown()).toEqual(['bbb0001112223334445556667778889990001112']);
        // Блоба нет в changelist итерации — размер неизвестен, и читать его незачем.
        expect(await host.getBlob('no-such-blob')).toBeNull();
        expect(shown()).toEqual(['bbb0001112223334445556667778889990001112']);
    });

    it('getBlob сам дочитывает дифф итерации: карта размеров наполняется его changelist', async () => {
        const host = makeHost();

        const bytes = await host.getBlob('aaa0001112223334445556667778889990001112');

        expect(bytes?.length).toBe(109);
    });

    it('getBlob: сторона за лимитом контракта не читается вовсе', async () => {
        const { host, shown } = makeContentHost(
            {
                bodies: {
                    changelist: () =>
                        JSON.stringify({
                            data: [
                                {
                                    path: 'examples/ui/assets/huge.png',
                                    entry_id: 'eid:file-huge-png',
                                    change_type: 'add',
                                    node_type: 'file',
                                    binary: false,
                                    meta_after: { size: IMAGE_BLOB_MAX_BYTES + 1 },
                                    blob_after: 'huge-png-blob',
                                },
                            ],
                        }),
                },
            },
            { patch: '' },
        );

        expect(await host.getBlob('huge-png-blob')).toBeNull();
        expect(shown()).toEqual([]);
    });

    it('неизвестный fileId — ошибка запроса, а не тихий null', async () => {
        const error = await makeHost()
            .getFileContent('eid:missing')
            .catch((caught: unknown) => caught);

        expect(error).toBeInstanceOf(RpcFailure);
        expect((error as RpcFailure).code).toBe('bad_request');
    });

    it('blame есть у живых файлов и нет у удалённых и бинарных', async () => {
        const diff = await makeHost().getDiff();
        const byPath = new Map(diff.files.map((file) => [file.path, file]));

        expect(byPath.get('examples/ui/packages/grid/src/index.ts')?.blameUrl).toBe(
            'https://a.yandex-team.ru/arcadia/examples/ui/packages/grid/src/index.ts' +
                '?rev=6589b540d27df17e0ce3a9dc0b569a1c2f0999ac&blame=true',
        );
        expect(byPath.get('examples/ui/docs/added.md')?.blameUrl).toContain('/examples/ui/docs/added.md?rev=');
        expect(byPath.get('examples/ui/packages/grid/src/legacy.ts')?.blameUrl).toBeNull();
        expect(byPath.get('examples/ui/assets/logo.png')?.blameUrl).toBeNull();
    });

    it('ссылка на файл в вебе Арканума — на вершине итерации, у всех файлов и без кодирования', async () => {
        const diff = await makeHost().getDiff();
        const byPath = new Map(diff.files.map((file) => [file.path, file]));
        const head = 'c7ee7ba7c6da85838a47d1c481c0036ab3c390f1';

        expect(byPath.get('examples/ui/packages/grid/src/index.ts')?.hostFileUrl).toBe(
            `https://a.yandex-team.ru/review/${String(MOCK_PR_ID)}/files/${head}` +
                '#file-examples/ui/packages/grid/src/index.ts',
        );
        // Удалённого файла и бинарника в списке файлов PR веб не лишает — ссылка есть и у них.
        expect(byPath.get('examples/ui/packages/grid/src/legacy.ts')?.hostFileUrl).toBe(
            `https://a.yandex-team.ru/review/${String(MOCK_PR_ID)}/files/${head}` +
                '#file-examples/ui/packages/grid/src/legacy.ts',
        );
        expect(byPath.get('examples/ui/assets/logo.png')?.hostFileUrl).toContain('#file-examples/ui/assets/logo.png');
    });

    it('без head в commit_ids ссылка ведёт в активную итерацию — без версии', async () => {
        const active = JSON.parse(mockFile('active-diff.json')) as {
            id: number;
            commit_ids: Record<string, string>;
        };
        const host = makeHost({
            bodies: {
                'active-diff': () =>
                    JSON.stringify({
                        data: { id: active.id, commit_ids: { base: active.commit_ids.base, merge: active.commit_ids.merge } },
                    }),
            },
        });

        const diff = await host.getDiff();

        expect(diff.files[0]?.hostFileUrl).toBe(
            `https://a.yandex-team.ru/review/${String(MOCK_PR_ID)}/files#file-${String(diff.files[0]?.path)}`,
        );
    });

    it('у файлов среза ссылка ведёт на вершину head-итерации', async () => {
        const slice = await makeHost().getDiff({
            base: String(MOCK_PREVIOUS_DIFF_SET_ID),
            head: String(MOCK_DIFF_SET_ID),
        });

        expect(slice.files[0]?.hostFileUrl).toBe(
            `https://a.yandex-team.ru/review/${String(MOCK_PR_ID)}/files/c7ee7ba7c6da85838a47d1c481c0036ab3c390f1` +
                '#file-examples/ui/packages/grid/src/index.ts',
        );
    });
});

describe('адаптер Арканума: тенант PR', () => {
    /** Тот же записанный PR, но в Cloudia: и мета, и чекаут `arc` — её. */
    function makeCloudiaHost(options: MockArcanumOptions = {}): ArcanumHost {
        return makeHost({ ...options, tenant: 'cloudia' }, 20, { tenant: 'cloudia' });
    }

    it('ссылка на PR берётся из меты, а не собирается из id', async () => {
        const recorded = JSON.parse(mockFile('pr.json')) as Record<string, unknown>;
        const url = 'https://a.yandex-team.ru/review/777777';
        const host = makeHost({ bodies: { pr: () => JSON.stringify({ data: { ...recorded, url } }) } });

        expect((await host.getPr()).url).toBe(url);
    });

    it('у файлов PR Cloudia blame ведёт в её веб, а ссылка на файл — в тот же PR', async () => {
        const diff = await makeCloudiaHost().getDiff();
        const file = diff.files.find((candidate) => candidate.path === 'examples/ui/packages/grid/src/index.ts');

        expect(file?.blameUrl).toBe(
            'https://a.yandex-team.ru/cloudia/examples/ui/packages/grid/src/index.ts' +
                '?rev=6589b540d27df17e0ce3a9dc0b569a1c2f0999ac&blame=true',
        );
        expect(file?.hostFileUrl).toBe(
            `https://a.yandex-team.ru/review/${String(MOCK_PR_ID)}/files/c7ee7ba7c6da85838a47d1c481c0036ab3c390f1` +
                '#file-examples/ui/packages/grid/src/index.ts',
        );
    });

    it('правила ревью PR Cloudia считаются в её репозитории', async () => {
        const abcPaths: string[] = [];
        const previewRepos: (string | null)[] = [];
        const host = makeCloudiaHost({
            bodies: {
                abc: (request) => {
                    abcPaths.push(request.url.pathname);
                    return mockAbcPaths(request);
                },
                'preview-a-yaml': (request) => {
                    previewRepos.push(request.url.searchParams.get('repo_name'));
                    return mockPreviewAYaml(request);
                },
            },
        });

        await host.getDiff();

        expect(abcPaths).toHaveLength(0);
        expect(abcPaths.every((path) => path.endsWith('/repos/cloudia/abc'))).toBe(true);
        expect(previewRepos).toHaveLength(0);
        expect(previewRepos.every((repo) => repo === 'cloudia')).toBe(true);
    });
});

describe('адаптер Арканума: запись', () => {

    it('мок отвечает 404 на request_changes без diff-set', async () => {
        const fetch = makeMockArcanumFetch();

        const response = await fetch('https://a.yandex-team.ru/api/v1/review-requests/4242/request-for-changes', {
            method: 'POST',
        });

        expect(response.status).toBe(404);
    });
});

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitUntil(condition: () => boolean, timeoutMs = 2000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!condition()) {
        if (Date.now() > deadline) {
            throw new Error('условие не наступило');
        }
        await delay(5);
    }
}

it('читает внешний исходник строго в переданной ревизии', async () => {
    const arc = makeMockArcCli();
    const show = vi.spyOn(arc, 'showText').mockResolvedValue('saved caller');
    const host = new ArcanumHost({ prId: MOCK_PR_ID, fetch: makeMockArcanumFetch(), arc, token: () => Promise.resolve(TOKEN), transport: { retryAttempts: 1 } });
    expect(await host.getSourceAtRevision('service/caller.py', 'pinned-head')).toBe('saved caller');
    expect(show).toHaveBeenCalledWith('arcadia', 'pinned-head:service/caller.py');
});

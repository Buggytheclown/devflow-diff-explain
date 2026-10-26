import type { Iteration, Thread } from '@sherpa/protocol';
import { IMAGE_BLOB_MAX_BYTES, prDiffSchema } from '@sherpa/protocol';
import { describe, expect, it, vi } from 'vitest';

import { RpcFailure } from '../../errors.js';
import { describeReviewHostContract } from '../review-host-contract.js';

import { ArcanumHost } from './arcanum-host.js';
import type { MockArcCall, MockArcOptions } from './mock-arc.js';
import { makeMockArcCli } from './mock-arc.js';
import type {
    MockArcanumControl,
    MockArcanumOptions,
    MockRequest,
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

/** Человек Арканума: фото со Стаффа по логину. */
function staffUser(login: string) {
    return {
        login,
        displayName: null,
        bot: false,
        avatarUrl: `https://center.yandex-team.ru/api/v1/user/${login}/avatar/100.jpg`,
    };
}

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

describeReviewHostContract('ArcanumHost (записанные ответы)', contractHostOf('arcadia'), CONTRACT_OPTIONS);

// Cloudia — тот же Арканум другим тенантом: контракт обязан выполняться и на ней.
describeReviewHostContract(
    'ArcanumHost (Cloudia, записанные ответы)',
    contractHostOf('cloudia'),
    CONTRACT_OPTIONS,
);

/** Подмена preview одного a.yaml: иерархии остальных конфигов остаются записанными. */
function previewWith(configPath: string, body: string): (request: MockRequest) => string {
    return (request) =>
        request.url.searchParams.get('path') === configPath ? body : mockPreviewAYaml(request);
}

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
                publishVerdicts: ['comment', 'ship', 'sticky_ship', 'request_changes'],
                fileViewedSync: true,
                fileContent: true,
                sourceAtRevision: true,
                commentIssues: true,
                commentResolve: true,
                editPublished: true,
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

    it('стики-шип выключается возможностями репозитория', async () => {
        const pr: unknown = JSON.parse(mockFile('pr.json'));
        const host = makeHost({
            bodies: {
                pr: () =>
                    JSON.stringify({
                        data: { ...(pr as Record<string, unknown>), caps: { disable_sticky_ships: true } },
                    }),
            },
        });

        expect((await host.getPr()).capabilities.publishVerdicts).toEqual(['comment', 'ship', 'request_changes']);

        // Хост отказывает сам, не публикуя черновиков: список в UI мог устареть.
        const draft = await host.saveDraft({ body: 'общее', parentId: null, anchor: null });
        await expect(host.publishBatch('sticky_ship')).rejects.toThrow(/Sticky ship/);
        expect((await host.getThreads()).find((thread) => thread.id === draft.id)?.root.draft).toBe(true);
    });

    // Чужой шип виден по `review.reviewers[].action`: ревьюер без действия вердикта
    // не выносил, а незнакомое слово вердиктом не считается.
    it('вердикты ревьюеров переводятся в контракт, неизвестные действия отбрасываются', async () => {
        const pr: unknown = JSON.parse(mockFile('pr.json'));
        const host = makeHost({
            bodies: {
                pr: () =>
                    JSON.stringify({
                        data: {
                            ...(pr as Record<string, unknown>),
                            review: {
                                // Живьём имя приезжает вложенным (`user.name`); плоское — на всякий случай.
                                reviewers: [
                                    { user: { name: 'alice' }, action: 'ship' },
                                    { user: { name: 'lead' }, action: 'sticky_ship' },
                                    { name: 'picky', action: 'waiting_for_changes' },
                                    { user: { name: 'silent' }, action: null },
                                    { user: { name: 'newcomer' }, action: 'уехал_в_отпуск' },
                                ],
                            },
                        },
                    }),
            },
        });

        expect((await host.getPr()).verdicts).toEqual([
            { user: staffUser('alice'), verdict: 'ship' },
            { user: staffUser('lead'), verdict: 'sticky_ship' },
            { user: staffUser('picky'), verdict: 'request_changes' },
        ]);
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

    it('generated — файл, которого не берёт ни одно активное правило ревью', async () => {
        const files = (await makeHost().getDiff()).files;
        const generated = files.filter((file) => file.generated).map((file) => file.path);

        // `huge.md` вычтен правилом docs (`!huge.md`), а правило предка `frontend-everything`
        // с `**` погашено наследованием (`rule_assignees.is_active: false`) — это и есть признак.
        expect(generated).toEqual(['examples/ui/docs/huge.md']);
        // Правил в иерархии нет вовсе («ревью не настроено») — признак не ставится.
        expect(files.find((file) => file.path === 'examples/ui/assets/logo.png')?.generated).toBe(false);
    });

    it('битый глоб гасит одно правило, а не расчёт всего PR', async () => {
        const calls = new Map<string, number>();
        const broken = mockFile('preview-grid.json').replace('**, !ci.a.yaml, !src/legacy.ts', '[oops');
        const host = makeHost({
            calls,
            bodies: {
                'preview-a-yaml': previewWith('examples/ui/packages/grid/a.yaml', broken),
            },
        });

        const files = (await host.getDiff()).files;
        const generated = files.filter((file) => file.generated).map((file) => file.path);

        // Соседний a.yaml посчитан честно: у docs признак на месте.
        expect(generated).toEqual(['examples/ui/docs/huge.md']);
        // А под сломанным конфигом покрытие неизвестно — ни generated, ни «мои».
        expect(files.find((file) => file.path === 'examples/ui/packages/grid/src/index.ts')?.generated).toBe(false);
        expect(await host.ownershipLens()).toMatchObject({ paths: ['examples/ui/docs/added.md'] });
        // Непочинимая строка a.yaml не деградирует дифф: перезагружать его на каждый вызов незачем.
        expect(calls.get('changelist')).toBe(1);
    });

    it('уровень preview без config_path — провал разбора, а не чужой каталог', async () => {
        // Ключ подменён у ближайшего уровня: без него правила считались бы относительно каталога
        // соседнего a.yaml, поэтому схема обязана провалиться, а расчёт — деградировать целиком.
        const mangled = mockFile('preview-docs.json').replace('"config_path"', '"config_path_gone"');
        const host = makeHost({
            bodies: { 'preview-a-yaml': previewWith('examples/ui/docs/a.yaml', mangled) },
        });

        expect((await host.getDiff()).files.some((file) => file.generated)).toBe(false);
        expect(await host.ownershipLens()).toMatchObject({
            paths: [
                'examples/ui/packages/grid/src/index.ts',
                'examples/ui/packages/grid/src/legacy.ts',
            ],
        });
    });

    it('неполный ответ abc — ошибка, а не тихое «ревью не настроено»', async () => {
        const full = JSON.parse(mockFile('abc-paths.json')) as { path: string }[];
        const host = makeHost({
            bodies: {
                abc: () =>
                    JSON.stringify({
                        data: full.filter((item) => item.path !== 'examples/ui/docs/huge.md'),
                    }),
            },
        });

        expect((await host.getDiff()).files.some((file) => file.generated)).toBe(false);
        // Пропавший путь роняет весь расчёт — линза уезжает на каталожный запасной путь.
        expect(await host.ownershipLens()).toMatchObject({
            paths: [
                'examples/ui/packages/grid/src/index.ts',
                'examples/ui/packages/grid/src/legacy.ts',
            ],
        });
    });

    it('провал правил ревью не ставит generated никому и не запирает дифф в кэше', async () => {
        const calls = new Map<string, number>();
        const host = makeHost({ calls, failing: { abc: 500 } });

        expect((await host.getDiff()).files.some((file) => file.generated)).toBe(false);
        // Деградировавший дифф не кэшируется: починившиеся ручки должны дать честный признак.
        await host.getDiff();
        expect(calls.get('changelist')).toBe(2);
    });

    it('при идущем опросе active-diff читается один раз на все методы итерации', async () => {
        const calls = new Map<string, number>();
        const host = makeHost({ calls });
        const stop = host.watchThreads(() => undefined);
        try {
            const diff = await host.getDiff();
            await host.getFileContent(diff.files[0]?.fileId ?? '');
            await host.ownershipLens();
            await host.listIterations();

            expect(calls.get('active-diff')).toBe(1);
        } finally {
            stop();
        }
    });

    it('без опроса active-diff не кэшируется: пуш виден следующим же вызовом', async () => {
        const calls = new Map<string, number>();
        const host = makeHost({ calls });

        await host.getDiff();
        await host.getDiff();

        expect(calls.get('active-diff')).toBe(2);
    });

    it('тик опроса продлевает кэш active-diff, а пуш его сбрасывает', async () => {
        const calls = new Map<string, number>();
        const control: MockArcanumControl = {};
        const host = makeHost({ calls, control }, 20);
        const stop = host.watchThreads(() => undefined);
        try {
            await host.getDiff();
            await new Promise((resolve) => setTimeout(resolve, 70));
            expect((await host.getDiff()).diffId).toBe(String(MOCK_DIFF_SET_ID));
            expect(calls.get('active-diff')).toBe(1);

            control.push?.();
            // Тик опроса видит новый id и сбрасывает кэш; следующий getDiff читает ручку заново.
            await new Promise((resolve) => setTimeout(resolve, 70));
            expect((await host.getDiff()).diffId).toBe(String(MOCK_PUSHED_DIFF_SET_ID));
            expect(calls.get('active-diff')).toBeGreaterThanOrEqual(2);
        } finally {
            stop();
        }
    });

    it('дифф и линзы кэшируются на итерацию', async () => {
        const calls = new Map<string, number>();
        const arcCalls: MockArcCall[] = [];
        const host = makeHost({ calls }, 20, { calls: arcCalls });

        await host.getDiff();
        await host.getDiff();
        await host.ownershipLens();
        await host.extraLenses();

        expect(calls.get('changelist')).toBe(1);
        expect(arcCalls.filter((call) => call.kind === 'diff')).toHaveLength(1);
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

    it('строгие fields-проекции уходят в каждый запрос', async () => {
        const projections: (string | null)[] = [];
        const host = new ArcanumHost({
            prId: MOCK_PR_ID,
            token: () => Promise.resolve(TOKEN),
            arc: makeMockArcCli(),
            transport: { retryAttempts: 1 },
            fetch: (input, init) => {
                projections.push(new URL(input).searchParams.get('fields'));
                return makeMockArcanumFetch()(input, init);
            },
        });

        await host.getPr();
        await host.getThreads();
        await host.getDiff();
        await host.ownershipLens();

        expect(projections).toContain(EXPECTED_FIELDS.pr);
        expect(projections).toContain(EXPECTED_FIELDS.rules);
        expect(projections).toContain(EXPECTED_FIELDS.changelist);
        expect(projections.filter((fields) => fields === EXPECTED_FIELDS.comments)).toHaveLength(2);
        // Без проекции ходят только те, кому её некуда деть: `abc` и preview правил ревью
        // `fields` попросту игнорируют (проверено живьём).
        expect(projections.filter((fields) => fields === null)).toHaveLength(3);
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

    it('пин треда — итерация его исходного якоря', async () => {
        const threads = await makeHost().getThreads();

        const onActive = threads.find((thread) => thread.id === '501');
        expect(onActive?.pinnedTo).toEqual({
            diffId: String(MOCK_DIFF_SET_ID),
            commit: '6589b540d27df17e0ce3a9dc0b569a1c2f0999ac',
        });

        // Тред прошлой итерации: якорь `/comments` называет её, а не активную.
        const outdated = threads.find((thread) => thread.id === '701');
        expect(outdated?.outdated).toBe(true);
        expect(outdated?.pinnedTo).toEqual({
            diffId: String(MOCK_PREVIOUS_DIFF_SET_ID),
            commit: '9f3c1ab77c0f4a2d9b6e51c8d3a7f4b210e6c845',
        });

        // Обсуждение уровня PR к итерации не привязано.
        expect(threads.find((thread) => thread.id === '-70001')?.pinnedTo).toBeNull();
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

describe('адаптер Арканума: треды', () => {
    async function threads(): Promise<Thread[]> {
        return makeHost().getThreads();
    }

    it('дерево, боты, resolved и черновики', async () => {
        const list = await threads();
        const byId = new Map(list.map((thread) => [thread.id, thread]));

        expect([...byId.keys()].sort()).toEqual(['-70001', '501', '601', '602', '701', '802']);

        const discussion = byId.get('501');
        expect(discussion?.root.replies.map((reply) => reply.id)).toEqual(['502', '503']);
        expect(discussion?.root.replies[0]?.author).toEqual({
            login: 'robot-example-reviewer',
            displayName: 'Example AI Review',
            bot: true,
            avatarUrl: 'https://center.yandex-team.ru/api/v1/user/robot-example-reviewer/avatar/100.jpg',
        });
        expect(discussion?.root.draft).toBe(false);

        // Робот без review_system опознаётся по префиксу логина.
        expect(byId.get('-70001')?.root.author.bot).toBe(true);

        expect(byId.get('601')).toMatchObject({ resolved: true, resolvedBy: 'carol' });
        // `dropped` — тоже закрытый issue.
        expect(byId.get('602')?.resolved).toBe(true);
        expect(byId.get('501')?.resolved).toBe(false);
    });

    it('outdated — разность списков, комментарий уровня PR устареть не может', async () => {
        const byId = new Map((await threads()).map((thread) => [thread.id, thread]));

        expect(byId.get('701')?.outdated).toBe(true);
        expect(byId.get('501')?.outdated).toBe(false);
        expect(byId.get('-70001')?.outdated).toBe(false);
        expect(byId.get('-70001')?.anchor).toBeNull();
    });

    it('якорь берётся из активной итерации, удалённые не отдаются, сироты не теряются', async () => {
        const byId = new Map((await threads()).map((thread) => [thread.id, thread]));

        // В списке PR у 601 строка 3, перепривязанный якорь активной итерации — строка 4.
        expect(byId.get('601')?.anchor).toEqual({
            fileId: 'eid:file-moved',
            path: 'examples/ui/docs/moved.md',
            position: { side: 'new', line: 4, size: 2 },
        });
        expect(byId.has('801')).toBe(false);
        // Ответ на удалённый комментарий поднялся в корень, а не пропал вместе с родителем.
        expect(byId.get('802')?.root.body).toContain('осиротел');
    });

    it('поллинг отдаёт новый снапшот, когда треды изменились', async () => {
        let updatedAt = '2026-08-20T20:37:28.641698Z';
        let comments = mockFile('comments-all.json');
        const host = makeHost(
            {
                bodies: {
                    poll: () =>
                        JSON.stringify({ data: { updated_at: updatedAt, active_diff_set: { id: 9001 } } }),
                    'comments-all': () => `{"data":${comments}}`,
                },
            },
            10,
        );

        const snapshots: Thread[][] = [];
        const stop = host.watchThreads((next) => {
            snapshots.push(next);
        });
        await waitUntil(() => snapshots.length === 1);

        // Тик без движения `updated_at` новых снапшотов не приносит.
        await delay(40);
        expect(snapshots).toHaveLength(1);

        const parsed: unknown[] = JSON.parse(comments) as unknown[];
        comments = JSON.stringify([
            ...parsed,
            {
                id: 999,
                user: { name: 'alice' },
                content: 'новый комментарий',
                created_at: '2026-08-20T14:00:00.000000Z',
                published_at: '2026-08-20T14:00:00.000000Z',
            },
        ]);
        updatedAt = '2026-08-20T21:00:00.000000Z';

        await waitUntil(() => snapshots.length === 2);
        expect(snapshots[1]?.some((thread) => thread.id === '999')).toBe(true);
        stop();
    });

    it('упавшее перечитывание не съедает изменение: отпечаток потребляется только после успеха', async () => {
        let updatedAt = '2026-08-20T20:37:28.641698Z';
        let broken = false;
        let extra: unknown[] = [];
        const host = makeHost(
            {
                bodies: {
                    poll: () =>
                        JSON.stringify({ data: { updated_at: updatedAt, active_diff_set: { id: 9001 } } }),
                    'comments-all': () => {
                        if (broken) {
                            return '{"errors":[{"status":"500","message":"mock"}]}';
                        }
                        const parsed: unknown[] = JSON.parse(mockFile('comments-all.json')) as unknown[];
                        return JSON.stringify({ data: [...parsed, ...extra] });
                    },
                },
            },
            10,
        );

        const snapshots: Thread[][] = [];
        const stop = host.watchThreads((next) => {
            snapshots.push(next);
        });
        await waitUntil(() => snapshots.length === 1);

        // PR изменился, но перечитывание тредов моргнуло — снапшота нет.
        broken = true;
        updatedAt = '2026-08-20T21:00:00.000000Z';
        extra = [
            {
                id: 999,
                user: { name: 'alice' },
                content: 'приехал после починки',
                created_at: '2026-08-20T14:00:00.000000Z',
                published_at: '2026-08-20T14:00:00.000000Z',
            },
        ];
        await delay(40);
        expect(snapshots).toHaveLength(1);

        // Отпечаток PR больше не двигается: изменение обязано доехать на первом же удачном тике.
        broken = false;
        await waitUntil(() => snapshots.length === 2);
        expect(snapshots[1]?.some((thread) => thread.id === '999')).toBe(true);
        stop();
    });

    it('ошибка тика не роняет подписку', async () => {
        let broken = true;
        const host = makeHost(
            {
                bodies: {
                    'comments-all': () =>
                        broken ? '{"errors":[{"status":"500","message":"mock"}]}' : `{"data":${mockFile('comments-all.json')}}`,
                },
            },
            10,
        );

        const snapshots: Thread[][] = [];
        const stop = host.watchThreads((next) => {
            snapshots.push(next);
        });
        await delay(30);
        expect(snapshots).toHaveLength(0);

        broken = false;
        await waitUntil(() => snapshots.length === 1);
        stop();
    });
});

/** Ответ `review.rules` с полями призыва; по умолчанию правило зовёт `alice` в grid. */
function summoningRules(
    rules: readonly {
        role: string;
        assign: number;
        ship?: number;
        reviewer?: string;
        config?: string;
    }[],
): string {
    const review = {
        review: {
            rules: rules.map((rule) => ({
                roles: [rule.role],
                configs: [{ path: rule.config ?? '/examples/ui/packages/grid/a.yaml' }],
                assign: rule.assign,
                ship: rule.ship ?? 1,
                reviewers_names: [rule.reviewer ?? 'alice'],
            })),
        },
    };
    return JSON.stringify({ data: review });
}

describe('адаптер Арканума: линзы', () => {
    /** Обе ручки per-file матчинга лежат: линза обязана уехать на каталожный запасной путь. */
    const RULES_DOWN = { abc: 500, 'preview-a-yaml': 500 } as const;

    it('ownership — только применённые правила с моим логином, зона не спорит с линзой', async () => {
        const host = makeHost();
        const diff = await host.getDiff();
        const lens = await host.ownershipLens();

        expect(
            diff.files.find((file) => file.path === 'examples/ui/packages/grid/src/legacy.ts')
                ?.generated,
        ).toBe(false);
        // `legacy.ts` накрыт preview-правилом с моим логином, но этого правила нет среди
        // применённых `review.rules`: в линзу файл не входит, вердикт и границы зоны сохраняются,
        // а `mine` у зоны считается тем же предикатом, что и линза, — иначе зона звала бы «своим»
        // файл, которого нет в «моей зоне».
        // `added.md` — от активного правила предка `/examples/ui/a.yaml` (`docs/added.md`
        // считается относительно каталога предка, а не того a.yaml, что вернул `abc`).
        expect(lens).toEqual({
            id: 'mine',
            label: 'My files',
            paths: ['examples/ui/packages/grid/src/index.ts', 'examples/ui/docs/added.md'],
            available: true,
            note: null,
            zones: [
                {
                    path: 'examples/ui/packages/grid',
                    mine: true,
                    owner: 'modules-team',
                    paths: ['examples/ui/packages/grid/src/index.ts'],
                },
                {
                    path: 'examples/ui/packages/grid/src/legacy.ts',
                    mine: false,
                    owner: 'legacy-keepers',
                    paths: ['examples/ui/packages/grid/src/legacy.ts'],
                },
                {
                    path: 'examples/ui/docs',
                    mine: false,
                    owner: 'docs-owner',
                    paths: ['examples/ui/docs/moved.md', 'examples/ui/docs/renamed.md'],
                },
                {
                    path: 'examples/ui/docs/added.md',
                    mine: true,
                    owner: 'frontend-infra',
                    paths: ['examples/ui/docs/added.md'],
                },
            ],
        });
    });

    it('applied-пары совпадают при ведущем слэше только с одной стороны', async () => {
        const rulesWithoutSlash = mockFile('rules.json').replace(
            '"/examples/ui/packages/grid/a.yaml"',
            '"examples/ui/packages/grid/a.yaml"',
        );
        const previewWithoutSlash = mockFile('preview-grid.json').replace(
            '"/examples/ui/packages/grid/a.yaml"',
            '"examples/ui/packages/grid/a.yaml"',
        );
        const lenses = await Promise.all([
            makeHost({ bodies: { rules: () => `{"data":${rulesWithoutSlash}}` } }).ownershipLens(),
            makeHost({
                bodies: {
                    'preview-a-yaml': previewWith(
                        'examples/ui/packages/grid/a.yaml',
                        previewWithoutSlash,
                    ),
                },
            }).ownershipLens(),
        ]);

        for (const lens of lenses) {
            expect(lens?.paths).toContain('examples/ui/packages/grid/src/index.ts');
            expect(lens?.paths).not.toContain('examples/ui/packages/grid/src/legacy.ts');
        }
    });

    it('preview-правило без ролей остаётся применённым: сверить его с review.rules нечем', async () => {
        const previewWithoutRoles = mockFile('preview-grid.json').replace(
            '"rules": ["example:example_legacy_keeper"]',
            '"roles_missing": []',
        );
        const lens = await makeHost({
            bodies: {
                'preview-a-yaml': previewWith(
                    'examples/ui/packages/grid/a.yaml',
                    previewWithoutRoles,
                ),
            },
        }).ownershipLens();

        expect(lens?.paths).toContain('examples/ui/packages/grid/src/legacy.ts');
    });

    it('недоступный applied-фильтр повторяет только свою ручку, не дорогой дифф', async () => {
        let broken = true;
        const calls = new Map<string, number>();
        const stderr = vi.spyOn(process.stderr, 'write').mockImplementation((): boolean => true);
        const host = makeHost({
            calls,
            bodies: {
                rules: () =>
                    broken
                        ? '{"errors":[{"status":"500","message":"mock"}]}'
                        : `{"data":${mockFile('rules.json')}}`,
            },
        });

        try {
            expect((await host.ownershipLens())?.paths).toContain(
                'examples/ui/packages/grid/src/legacy.ts',
            );
            expect(calls.get('resolve-members')).toBeUndefined();
            expect(
                stderr.mock.calls.some((call) => String(call[0]).includes('использует надмножество')),
            ).toBe(true);

            await host.getDiff();
            broken = false;
            expect((await host.ownershipLens())?.paths).not.toContain(
                'examples/ui/packages/grid/src/legacy.ts',
            );

            expect(calls.get('rules')).toBe(2);
            expect(calls.get('changelist')).toBe(1);
            expect(calls.get('abc')).toBe(1);
            expect(calls.get('preview-a-yaml')).toBe(2);
        } finally {
            stderr.mockRestore();
        }
    });

    it('пустой список applied-правил не обнуляет линзу и не сбрасывает дифф', async () => {
        const calls = new Map<string, number>();
        const stderr = vi.spyOn(process.stderr, 'write').mockImplementation((): boolean => true);
        const host = makeHost({
            calls,
            bodies: { rules: () => '{"data":{"review":{"rules":[]}}}' },
        });
        try {
            expect((await host.ownershipLens())?.paths).toContain(
                'examples/ui/packages/grid/src/legacy.ts',
            );
            expect((await host.ownershipLens())?.paths).toContain(
                'examples/ui/packages/grid/src/legacy.ts',
            );
            expect(
                stderr.mock.calls.some((call) => String(call[0]).includes('правила ревью Арканума пусты')),
            ).toBe(true);
            expect(calls.get('rules')).toBe(2);
            expect(calls.get('changelist')).toBe(1);
        } finally {
            stderr.mockRestore();
        }
    });

    it('линза «мои» — только правила, которые меня призвали (assign > 0 и я в reviewers_names)', async () => {
        // Широкое правило на весь пакет только считает шипы (`assign: 0`) — Арканум не показывает
        // его в причинах призыва, значит и линза не должна. Призвало меня узкое правило.
        const host = makeHost({
            bodies: {
                rules: () =>
                    summoningRules([
                        { role: 'example:example_modules_developer', assign: 0 },
                        { role: 'example:example_legacy_keeper', assign: 1 },
                        {
                            role: 'example:example_frontend_monorepo_infra',
                            assign: 0,
                            config: '/examples/ui/a.yaml',
                        },
                    ]),
            },
        });
        const lens = await host.ownershipLens();

        expect(lens).toMatchObject({
            available: true,
            paths: ['examples/ui/packages/grid/src/legacy.ts'],
        });
        expect(lens?.zones).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ owner: 'legacy-keepers', mine: true }),
                expect.objectContaining({ owner: 'modules-team', mine: false }),
            ]),
        );
    });

    it('призыв без дежурства (ship: 0) — тоже причина', async () => {
        const lens = await makeHost({
            bodies: {
                rules: () =>
                    summoningRules([
                        { role: 'example:example_modules_developer', assign: 1, ship: 0 },
                    ]),
            },
        }).ownershipLens();

        expect(lens?.paths).toEqual(['examples/ui/packages/grid/src/index.ts']);
    });

    it('призвало правило с явными reviewers (без ролей) — линза не обнуляется', async () => {
        // Группа a.yaml с людьми вместо ролей приходит в `review.rules` без `roles` и пар
        // «конфиг × роль» не даёт. Выбросить в этом режиме безролевые preview-правила — значит
        // потерять ровно то правило, которое меня и позвало, и получить пустую линзу.
        const previewWithoutRoles = mockFile('preview-grid.json')
            .replace('"rules": ["example:example_modules_developer"],', '"rules": [],')
            .replace('"example:example_modules_developer": ["bob", "alice"]', '');
        const lens = await makeHost({
            bodies: {
                'preview-a-yaml': previewWith(
                    'examples/ui/packages/grid/a.yaml',
                    previewWithoutRoles,
                ),
                rules: () =>
                    JSON.stringify({
                        data: {
                            review: {
                                rules: [
                                    {
                                        configs: [
                                            { path: '/examples/ui/packages/grid/a.yaml' },
                                        ],
                                        assign: 1,
                                        ship: 1,
                                        reviewers_names: ['alice'],
                                    },
                                ],
                            },
                        },
                    }),
            },
        }).ownershipLens();

        expect(lens?.paths).toContain('examples/ui/packages/grid/src/index.ts');
        expect(lens?.zones).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ owner: 'modules-team', mine: true }),
            ]),
        );
    });

    it('я ревьюер, но меня никто не призвал — линза честно пуста, а не надмножество preview', async () => {
        const calls = new Map<string, number>();
        const host = makeHost({
            calls,
            bodies: {
                rules: () =>
                    summoningRules([{ role: 'example:example_modules_developer', assign: 0 }]),
            },
        });
        const lens = await host.ownershipLens();

        expect(lens).toMatchObject({
            available: false,
            paths: [],
            note: 'No files of this PR are in your review zones.',
        });
        expect(lens?.zones?.every((zone) => !zone.mine)).toBe(true);
        // Результат надёжный, а не деградировавший: повторный вызов не ходит в ручку заново.
        await host.ownershipLens();
        expect(calls.get('rules')).toBe(1);
    });

    it('чужой PR: меня нет ни в одном reviewers_names — линза по членству в ролях', async () => {
        const other = 'carol';
        const stderr = vi.spyOn(process.stderr, 'write').mockImplementation((): boolean => true);
        try {
            const lens = await makeHost({
                bodies: {
                    rules: () =>
                        summoningRules([
                            { role: 'example:example_modules_developer', assign: 1, reviewer: other },
                            {
                                role: 'example:example_docs_owner',
                                assign: 1,
                                reviewer: other,
                                config: '/examples/ui/docs/a.yaml',
                            },
                            {
                                role: 'example:example_frontend_monorepo_infra',
                                assign: 0,
                                reviewer: other,
                                config: '/examples/ui/a.yaml',
                            },
                        ]),
                },
            }).ownershipLens();

            // Ровно то же, что и на записанных ответах без полей призыва.
            expect(lens?.paths).toEqual([
                'examples/ui/packages/grid/src/index.ts',
                'examples/ui/docs/added.md',
            ]);
            expect(
                stderr.mock.calls.some((call) => String(call[0]).includes('вы не в списке ревьюеров')),
            ).toBe(true);
        } finally {
            stderr.mockRestore();
        }
    });

    it('ответ без полей призыва (старый Арканум) — прежнее поведение и без объяснений', async () => {
        const stderr = vi.spyOn(process.stderr, 'write').mockImplementation((): boolean => true);
        try {
            // Записанный `rules.json` полей `assign`/`reviewers_names` не содержит.
            const lens = await makeHost().ownershipLens();

            expect(lens?.paths).toEqual([
                'examples/ui/packages/grid/src/index.ts',
                'examples/ui/docs/added.md',
            ]);
            expect(stderr).not.toHaveBeenCalled();
        } finally {
            stderr.mockRestore();
        }
    });

    it('ownership без логина не приписывает ревьюеру чужие зоны', async () => {
        const calls = new Map<string, number>();
        const lens = await makeHost({ calls, user: null }).ownershipLens();

        expect(lens).toMatchObject({
            available: false,
            paths: [],
            zones: null,
            note: 'Arcanum did not tell who you are — ownership is unavailable.',
        });
        // Правила собрались успешно: null означает неизвестного ревьюера, а не провал расчёта зон.
        expect(calls.get('abc')).toBe(1);
        expect(calls.get('preview-a-yaml')).toBe(2);
    });

    it('мой файл уходит в глубочайшую из моих зон, а не в чужую более глубокую', async () => {
        // Правило соседней команды на `src/**` глубже моего правила на весь пакет и тоже применено
        // к PR: `index.ts` покрыт обоими. Раскладка по глубочайшему правилу вообще увела бы файл в
        // чужую зону — в сегменте «моя зона» он рисовался бы серой строкой «вне вашей зоны».
        const deeperForeignRule = mockFile('preview-grid.json')
            .replace('"subpaths_filter": ["src/legacy.ts"]', '"subpaths_filter": ["src/**"]')
            .replace('["carol", "alice"]', '["carol"]')
            .replace('[{ "login": "carol" }, { "login": "alice" }]', '[{ "login": "carol" }]');
        const rulesWithLegacy = mockFile('rules.json').replace(
            '"roles": ["example:example_modules_developer"]',
            '"roles": ["example:example_modules_developer", "example:example_legacy_keeper"]',
        );
        const lens = await makeHost({
            bodies: {
                rules: () => `{"data":${rulesWithLegacy}}`,
                'preview-a-yaml': previewWith(
                    'examples/ui/packages/grid/a.yaml',
                    deeperForeignRule,
                ),
            },
        }).ownershipLens();

        expect(lens?.paths).toContain('examples/ui/packages/grid/src/index.ts');
        expect(lens?.zones?.find((zone) => zone.owner === 'modules-team')).toEqual({
            path: 'examples/ui/packages/grid',
            mine: true,
            owner: 'modules-team',
            paths: ['examples/ui/packages/grid/src/index.ts'],
        });
        expect(lens?.zones?.find((zone) => zone.owner === 'legacy-keepers')).toEqual({
            path: 'examples/ui/packages/grid/src',
            mine: false,
            owner: 'legacy-keepers',
            paths: ['examples/ui/packages/grid/src/legacy.ts'],
        });
    });

    /** Инвариант UI: сегмент «моя зона» не должен показывать ни одной чужой строки. */
    it('файлы линзы целиком лежат в зонах mine, чужие зоны их не содержат', async () => {
        const lens = await makeHost().ownershipLens();
        const zones = lens?.zones ?? [];
        const mineByZones = new Set(zones.filter((zone) => zone.mine).flatMap((zone) => zone.paths));
        const foreign = zones.filter((zone) => !zone.mine).flatMap((zone) => zone.paths);

        expect([...mineByZones].sort()).toEqual([...(lens?.paths ?? [])].sort());
        expect(foreign.filter((path) => lens?.paths.includes(path))).toEqual([]);
    });

    it('ownership деградирует до каталожной гранулярности, когда правила a.yaml не собрались', async () => {
        for (const failing of [{ abc: 500 }, { 'preview-a-yaml': 500 }]) {
            const lens = await makeHost({ failing }).ownershipLens();

            expect(lens).toMatchObject({
                available: true,
                paths: [
                    'examples/ui/packages/grid/src/index.ts',
                    'examples/ui/packages/grid/src/legacy.ts',
                ],
                zones: null,
            });
        }
    });

    it('ownership выключается, когда не сработал и каталожный путь', async () => {
        const lens = await makeHost({
            failing: { ...RULES_DOWN, 'resolve-members': 500 },
        }).ownershipLens();

        expect(lens).toMatchObject({ available: false, paths: [], zones: null });
        expect(lens?.note).toContain('resolve');
    });

    it('деградировавшая линза не залипает на итерацию: ручка починилась — линза вернулась', async () => {
        let broken = true;
        const brokenBody = (): string => '{"errors":[{"status":"500","message":"mock"}]}';
        const host = makeHost({
            bodies: {
                abc: () => (broken ? brokenBody() : `{"data":${mockFile('abc-paths.json')}}`),
                'resolve-members': () => (broken ? brokenBody() : `{"data":${mockFile('resolve-members.json')}}`),
                pci: () => (broken ? brokenBody() : `{"data":${mockFile('pci.json')}}`),
            },
        });

        // Сломано всё: и per-file, и его запасной путь, и PCI.
        expect(await host.ownershipLens()).toMatchObject({ available: false });
        expect((await host.extraLenses())[0]).toMatchObject({ available: false });

        broken = false;
        expect(await host.ownershipLens()).toMatchObject({
            available: true,
            paths: ['examples/ui/packages/grid/src/index.ts', 'examples/ui/docs/added.md'],
        });
        expect((await host.extraLenses())[0]).toMatchObject({ available: true });
    });

    it('ответ линзы кэшируется на итерацию, пока ручка отвечает', async () => {
        const calls = new Map<string, number>();
        const host = makeHost({ calls });

        await host.ownershipLens();
        await host.ownershipLens();
        await host.extraLenses();
        await host.extraLenses();

        // Матчинг правил считается один раз вместе с диффом: `abc` — батчем, preview — по a.yaml.
        expect(calls.get('abc')).toBe(1);
        expect(calls.get('preview-a-yaml')).toBe(2);
        expect(calls.get('rules')).toBe(1);
        expect(calls.get('pci')).toBe(1);
        // Каталожный путь в норме не нужен вовсе.
        expect(calls.get('resolve-members')).toBeUndefined();
    });

    it('ownership без моих файлов выключен с объяснением', async () => {
        const withoutMe = (request: MockRequest): string =>
            mockPreviewAYaml(request).replaceAll('"alice"', '"erin"');
        const lens = await makeHost({ bodies: { 'preview-a-yaml': withoutMe } }).ownershipLens();

        expect(lens).toMatchObject({ available: false, paths: [] });
        expect(lens?.zones).not.toBeNull();
        expect(lens?.zones?.length).toBeGreaterThan(0);
        expect(lens?.zones?.every((zone) => !zone.mine)).toBe(true);
        expect(lens?.note).toContain('review zones');
    });

    it('PCI — пересечение скоупа с файлами диффа', async () => {
        const [pci] = await makeHost().extraLenses();

        expect(pci).toEqual({
            id: 'pci',
            label: 'PCI DSS',
            paths: ['examples/ui/packages/grid/src/index.ts'],
            available: true,
            note: null,
            zones: null,
        });
    });

    it('PCI без скоупа и при поломке ручки — выключенная линза с разными объяснениями', async () => {
        const [empty] = await makeHost({
            bodies: { pci: () => '{"data":{"commit":{"state":"unknown"},"files":[]}}' },
        }).extraLenses();
        expect(empty).toMatchObject({ available: false, paths: [] });
        expect(empty?.note).toContain('not published');

        const [broken] = await makeHost({ failing: { pci: 500 } }).extraLenses();
        expect(broken).toMatchObject({ available: false, paths: [] });
        expect(broken?.note).toContain('unavailable');
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

    it('тенант и ссылка PR спрашиваются один раз, а после getPr — не спрашиваются вовсе', async () => {
        const calls = new Map<string, number>();
        const host = makeHost({ calls });

        await host.getDiff();
        await host.extraLenses();
        await host.getPr();
        expect(calls.get('pr-ref')).toBe(1);

        const afterMeta = new Map<string, number>();
        const seeded = makeHost({ calls: afterMeta });

        await seeded.getPr();
        await seeded.getDiff();
        // Мета уже назвала и тенант, и ссылку — узкому запросу взяться неоткуда.
        expect(afterMeta.get('pr-ref')).toBeUndefined();
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

        expect(abcPaths).not.toHaveLength(0);
        expect(abcPaths.every((path) => path.endsWith('/repos/cloudia/abc'))).toBe(true);
        expect(previewRepos).not.toHaveLength(0);
        expect(previewRepos.every((repo) => repo === 'cloudia')).toBe(true);
    });

    it('PCI DSS есть только у Аркадии: у Cloudia линзы нет и ручку не дёргают', async () => {
        const cloudiaCalls = new Map<string, number>();

        expect(await makeCloudiaHost({ calls: cloudiaCalls }).extraLenses()).toEqual([]);
        expect(cloudiaCalls.get('pci')).toBeUndefined();

        const arcadiaCalls = new Map<string, number>();
        const lenses = await makeHost({ calls: arcadiaCalls }).extraLenses();

        expect(lenses.map((lens) => lens.id)).toEqual(['pci']);
        expect(arcadiaCalls.get('pci')).toBe(1);
    });
});

describe('адаптер Арканума: запись', () => {
    /** Запрос-мутация вместе с телом и ключом идемпотентности — чем именно адаптер сходил в ручку. */
    interface SeenRequest {
        readonly url: URL;
        readonly method: string;
        readonly body: Record<string, unknown> | null;
        readonly idempotencyKey: string | null;
    }

    function makeWriteHost(options: MockArcanumOptions = {}): {
        host: ArcanumHost;
        seen: SeenRequest[];
    } {
        const seen: SeenRequest[] = [];
        const inner = makeMockArcanumFetch(options);
        const host = new ArcanumHost({
            prId: MOCK_PR_ID,
            arc: makeMockArcCli(),
            token: () => Promise.resolve(TOKEN),
            pollIntervalMs: 20,
            transport: { retryAttempts: 1 },
            fetch: (input, init) => {
                seen.push({
                    url: new URL(input),
                    method: init?.method ?? 'GET',
                    body:
                        typeof init?.body === 'string'
                            ? (JSON.parse(init.body) as Record<string, unknown>)
                            : null,
                    idempotencyKey: new Headers(init?.headers).get('idempotency-key'),
                });
                return inner(input, init);
            },
        });
        return { host, seen };
    }

    function created(seen: readonly SeenRequest[]): SeenRequest[] {
        return seen.filter(
            (request) => request.method === 'POST' && request.url.pathname.endsWith('/comments'),
        );
    }

    it('черновик уровня PR: только текст, ключ идемпотентности, комментарий из ответа', async () => {
        const { host, seen } = makeWriteHost();

        const comment = await host.saveDraft({ body: 'нужен тест на нулевую ширину', parentId: null, anchor: null });

        expect(comment).toMatchObject({
            // Знаковое соглашение хоста: комментарий уровня PR получает отрицательный id.
            id: '-70100',
            body: 'нужен тест на нулевую ширину',
            draft: true,
            author: { login: 'alice', bot: false },
            replies: [],
        });

        const create = created(seen)[0];
        expect(create?.body).toEqual({ content: 'нужен тест на нулевую ширину', draft: true });
        expect(create?.url.searchParams.get('fields')).toBe(EXPECTED_FIELDS.comments);
        expect(create?.idempotencyKey).toMatch(/\S/);
    });

    it.each([
        [true, 'open'],
        [false, 'not_issue'],
    ] as const)('PR-level issue=%s маппится в issue_status=%s', async (issue, issueStatus) => {
        const { host, seen } = makeWriteHost();

        const comment = await host.saveDraft({ body: 'статус выбирает UI', parentId: null, anchor: null, issue });

        expect(created(seen)[0]?.body).toEqual({
            content: 'статус выбирает UI',
            draft: true,
            issue_status: issueStatus,
        });
        expect((await host.getThreads()).find((thread) => thread.id === comment.id)?.resolved).toBe(false);
    });

    it('инлайн-черновик несёт якорь активной итерации', async () => {
        const { host, seen } = makeWriteHost();

        const comment = await host.saveDraft({
            body: 'здесь съезжает индекс',
            parentId: null,
            anchor: {
                fileId: 'eid:file-index',
                path: 'examples/ui/packages/grid/src/index.ts',
                position: { side: 'new', line: 3, size: 2 },
            },
        });

        expect(comment.id).toBe('900');
        expect(created(seen)[0]?.body).toEqual({
            content: 'здесь съезжает индекс',
            draft: true,
            entry_id: 'eid:file-index',
            file_path: 'examples/ui/packages/grid/src/index.ts',
            diff_set_xid: '9001',
            diff_side: 'new',
            diff_line: 3,
            diff_size: 2,
        });
    });

    it('якорь без позиции — комментарий на файл целиком: стороны и строки в теле нет', async () => {
        const { host, seen } = makeWriteHost();

        await host.saveDraft({
            body: 'файл целиком',
            parentId: null,
            anchor: { fileId: 'eid:file-index', path: 'examples/ui/packages/grid/src/index.ts', position: null },
        });

        const body = created(seen)[0]?.body ?? {};
        expect(body).toMatchObject({ entry_id: 'eid:file-index', diff_set_xid: '9001' });
        expect(Object.keys(body)).not.toContain('diff_side');
        expect(Object.keys(body)).not.toContain('diff_line');
    });

    it('parentId — ответ в тред: своя ручка, якорь не передаётся, issue-статус в том же запросе', async () => {
        const { host, seen } = makeWriteHost();

        const reply = await host.saveDraft({
            body: 'согласен',
            parentId: '501',
            // Якорь у ответа игнорируется: тред целиком принадлежит якорю корня.
            anchor: {
                fileId: 'eid:file-index',
                path: 'examples/ui/packages/grid/src/index.ts',
                position: { side: 'new', line: 3, size: 1 },
            },
            issue: true,
        });

        expect(reply).toMatchObject({ id: '900', issue: true, resolved: false });
        const request = seen.find((candidate) => candidate.url.pathname.endsWith('/replies'));
        expect(request?.url.pathname).toBe('/api/v1/review-requests-comments/501/replies');
        expect(request?.body).toEqual({ content: 'согласен', draft: true, issue_status: 'open' });
        expect(request?.idempotencyKey).toMatch(/\S/);
        expect(seen.some((candidate) => candidate.method === 'PATCH')).toBe(false);

        const parent = (await host.getThreads()).find((thread) => thread.id === '501');
        expect(parent?.root.replies.map((child) => child.id)).toEqual(['502', '503', '900']);
    });

    it('ретрай создания идёт с тем же ключом идемпотентности — дубля не будет', async () => {
        const inner = makeMockArcanumFetch();
        const keys: (string | null)[] = [];
        let firstAttempt = true;
        const host = new ArcanumHost({
            prId: MOCK_PR_ID,
            arc: makeMockArcCli(),
            token: () => Promise.resolve(TOKEN),
            transport: { retryAttempts: 3, retryBaseMs: 0, sleep: () => Promise.resolve(), random: () => 0 },
            fetch: (input, init) => {
                if (!new URL(input).pathname.endsWith('/comments') || init?.method !== 'POST') {
                    return inner(input, init);
                }
                keys.push(new Headers(init.headers).get('idempotency-key'));
                if (firstAttempt) {
                    firstAttempt = false;
                    return Promise.resolve(new Response('{"errors":[]}', { status: 503 }));
                }
                return inner(input, init);
            },
        });

        const comment = await host.saveDraft({ body: 'после ретрая', parentId: null, anchor: null });

        expect(keys).toHaveLength(2);
        expect(keys[0]).toBe(keys[1]);
        expect((await host.getThreads()).filter((thread) => thread.root.body === 'после ретрая')).toHaveLength(1);
        expect(comment.id).toBe('-70100');
    });

    it('правка и удаление черновика видны в тредах', async () => {
        const { host, seen } = makeWriteHost();
        const draft = await host.saveDraft({ body: 'первая версия', parentId: null, anchor: null });

        await host.updateDraft(draft.id, 'вторая версия');
        const patched = (await host.getThreads()).find((thread) => thread.id === draft.id);
        expect(patched?.root.body).toBe('вторая версия');
        expect(patched?.root.editedAt).not.toBeNull();

        const patch = seen.find((request) => request.method === 'PATCH');
        expect(patch?.url.pathname).toBe('/api/v1/review-requests-comments/-70100');
        expect(patch?.body).toEqual({ content: 'вторая версия' });
        expect(patch?.url.searchParams.get('fields')).toBe(EXPECTED_FIELDS.commentAck);

        await host.deleteDraft(draft.id);
        expect((await host.getThreads()).some((thread) => thread.id === draft.id)).toBe(false);
        expect(seen.some((request) => request.method === 'DELETE')).toBe(true);
    });

    it.each([
        [true, 'open'],
        [false, 'not_issue'],
    ] as const)('правка черновика issue=%s добавляет issue_status=%s в PATCH', async (issue, issueStatus) => {
        const { host, seen } = makeWriteHost();
        const draft = await host.saveDraft({ body: 'первая версия', parentId: null, anchor: null });

        await host.updateDraft(draft.id, 'вторая версия', issue);

        const patch = seen.find((request) => request.method === 'PATCH');
        expect(patch?.body).toEqual({ content: 'вторая версия', issue_status: issueStatus });
        expect((await host.getThreads()).find((thread) => thread.id === draft.id)?.resolved).toBe(false);
    });

    it('resolve и unresolve — issue_status на корне треда', async () => {
        const { host, seen } = makeWriteHost();

        await host.setThreadResolved('501', true);
        expect((await host.getThreads()).find((thread) => thread.id === '501')).toMatchObject({
            resolved: true,
            resolvedBy: 'alice',
        });

        await host.setThreadResolved('501', false);
        expect((await host.getThreads()).find((thread) => thread.id === '501')?.resolved).toBe(false);

        expect(seen.filter((request) => request.method === 'PATCH').map((request) => request.body)).toEqual([
            { issue_status: 'resolved' },
            { issue_status: 'open' },
        ]);
    });

    it('resolve комментария — issue_status по его id, а не по корню треда', async () => {
        const { host, seen } = makeWriteHost();
        // 601 — закрытый issue, 602 — dropped: оба треда уже закрыты, открываем 601 обратно.
        await host.setCommentResolved('601', false);

        expect((await host.getThreads()).find((thread) => thread.id === '601')?.resolved).toBe(false);
        const patch = seen.find((request) => request.method === 'PATCH');
        expect(patch?.url.pathname).toBe('/api/v1/review-requests-comments/601');
        expect(patch?.body).toEqual({ issue_status: 'open' });
    });

    it('resolve комментария без issue и неизвестного — отказ до всякой записи', async () => {
        const { host, seen } = makeWriteHost();
        await host.getThreads();

        // 502 — ответ бота без issue-статуса.
        const notIssue = await host.setCommentResolved('502', true).catch((caught: unknown) => caught);
        const unknown = await host.setCommentResolved('999999', true).catch((caught: unknown) => caught);

        expect(notIssue).toBeInstanceOf(RpcFailure);
        expect((notIssue as RpcFailure).message).toContain('502');
        expect(unknown).toBeInstanceOf(RpcFailure);
        expect(seen.some((request) => request.method === 'PATCH')).toBe(false);
    });

    it('issue включили только что — resolve перечитывает треды, а не верит старому снапшоту', async () => {
        const { host, seen } = makeWriteHost();
        // Снапшот запомнил 502 без issue, а свитчер включили тем же тиком: отказа быть не должно.
        await host.getThreads();
        await host.updateComment('502', 'Ширина 0 бывает у скрытых колонок.', true);

        await host.setCommentResolved('502', true);

        expect(seen.filter((request) => request.method === 'PATCH').map((request) => request.body)).toEqual([
            { content: 'Ширина 0 бывает у скрытых колонок.', issue_status: 'open' },
            { issue_status: 'resolved' },
        ]);
    });

    it('опубликованный комментарий правится PATCH, а удаляется мягко', async () => {
        const { host, seen } = makeWriteHost();

        await host.updateComment('501', 'переписал замечание');
        expect((await host.getThreads()).find((thread) => thread.id === '501')?.root.body).toBe(
            'переписал замечание',
        );
        expect(seen.find((request) => request.method === 'PATCH')?.body).toEqual({
            content: 'переписал замечание',
        });

        await host.deleteComment('501');
        // Мягкое удаление: `deleted_at` есть, наружу комментарий больше не отдаётся.
        expect((await host.getThreads()).some((thread) => thread.id === '501')).toBe(false);
        expect(seen.some((request) => request.method === 'DELETE')).toBe(true);
    });

    it('ответ PATCH про чужой комментарий — ошибка хоста, а не молчаливый успех', async () => {
        const { host } = makeWriteHost({ bodies: { 'update-comment': () => '{"data":{"id":123}}' } });

        const error = await host.setThreadResolved('501', true).catch((caught: unknown) => caught);

        expect(error).toBeInstanceOf(RpcFailure);
        expect((error as RpcFailure).message).toContain('123');
    });

    it('публикация: знаковые пространства разъезжаются, вердикт применяется после всех', async () => {
        const calls = new Map<string, number>();
        const { host, seen } = makeWriteHost({ calls });
        const prLevel = await host.saveDraft({ body: 'общее', parentId: null, anchor: null });
        const inline = await host.saveDraft({
            body: 'по строке',
            parentId: null,
            anchor: { fileId: 'eid:file-index', path: 'examples/ui/packages/grid/src/index.ts', position: null },
        });

        const result = await host.publishBatch('ship');

        expect(result.failed).toEqual([]);
        // Порядок — как в списке черновиков хоста, а не как в знаковых корзинах запроса.
        expect(result.publishedCommentIds).toEqual([prLevel.id, inline.id]);
        expect(result.verdictApplied).toBe(true);

        const publish = seen.find((request) => request.url.pathname.endsWith('/draft-comments'));
        expect(publish?.url.pathname).toBe('/api/v1/review-requests/draft-comments');
        expect(publish?.body).toEqual({ comment_for_diff_ids: [900], comment_for_review_ids: [-70100] });

        // Свои черновики собираются узкой проекцией: полный список комментариев тут не нужен.
        const collect = seen.find(
            (request) => request.method === 'GET' && request.url.pathname.endsWith('/comments'),
        );
        expect(collect?.url.searchParams.get('fields')).toBe(EXPECTED_FIELDS.draftIds);

        // Шип уходит на активную итерацию, стики не просили.
        const ship = seen.find((request) => request.url.pathname.endsWith('/ship'));
        expect(ship?.url.pathname).toBe('/api/v1/review-requests/4242/diff-sets/9001/ship');
        expect(ship?.url.searchParams.get('sticky')).toBeNull();
        expect(calls.get('ship')).toBe(1);

        // Опубликованное перестало быть черновиком — так же, как в живом ответе (draft исчезает).
        const published = (await host.getThreads()).find((thread) => thread.id === prLevel.id);
        expect(published?.root.draft).toBe(false);
    });

    it('стики-шип — та же ручка с ?sticky=true', async () => {
        const { host, seen } = makeWriteHost();

        expect((await host.publishBatch('sticky_ship')).verdictApplied).toBe(true);

        const ship = seen.find((request) => request.url.pathname.endsWith('/ship'));
        expect(ship?.url.searchParams.get('sticky')).toBe('true');
    });

    it('request_changes уходит на активный diff-set, шипа нет', async () => {
        const calls = new Map<string, number>();
        const { host, seen } = makeWriteHost({ calls });

        expect((await host.publishBatch('request_changes')).verdictApplied).toBe(true);

        const requestChanges = seen.find((request) => request.url.pathname.endsWith('/request-for-changes'));
        expect(requestChanges?.url.pathname).toBe(
            '/api/v1/review-requests/4242/diff-sets/9001/request-for-changes',
        );
        expect(calls.get('request-changes')).toBe(1);
        expect(calls.get('ship')).toBeUndefined();
    });

    it('comment публикует черновики и не применяет вердикта', async () => {
        const calls = new Map<string, number>();
        const { host } = makeWriteHost({ calls });
        const draft = await host.saveDraft({ body: 'общее', parentId: null, anchor: null });

        expect(await host.publishBatch('comment')).toEqual({
            publishedCommentIds: [draft.id],
            failed: [],
            verdictApplied: true,
        });
        expect(calls.get('publish-drafts')).toBe(1);
        expect(calls.get('ship')).toBeUndefined();
        expect(calls.get('request-changes')).toBeUndefined();
    });

    it('comment без черновиков ничего не пишет', async () => {
        const { host, seen } = makeWriteHost();

        expect(await host.publishBatch('comment')).toEqual({ publishedCommentIds: [], failed: [], verdictApplied: true });
        expect(seen.filter((request) => request.method !== 'GET')).toEqual([]);
    });

    it('мок отвечает 404 на request_changes без diff-set', async () => {
        const fetch = makeMockArcanumFetch();

        const response = await fetch('https://a.yandex-team.ru/api/v1/review-requests/4242/request-for-changes', {
            method: 'POST',
        });

        expect(response.status).toBe(404);
    });

    it('без черновиков в ручку публикации не ходим, но вердикт применяем', async () => {
        const calls = new Map<string, number>();
        const { host } = makeWriteHost({ calls });

        const result = await host.publishBatch('ship');

        expect(result).toEqual({ publishedCommentIds: [], failed: [], verdictApplied: true });
        expect(calls.get('publish-drafts')).toBeUndefined();
        expect(calls.get('ship')).toBe(1);
    });

    it('частичная публикация: вердикт не применяется, несдавшийся остаётся черновиком', async () => {
        const calls = new Map<string, number>();
        const { host } = makeWriteHost({
            calls,
            // Ручка опубликовала только комментарий уровня PR — инлайновый не сдался.
            bodies: { 'publish-drafts': () => '{"data":{"published":[-70100]}}' },
        });
        const prLevel = await host.saveDraft({ body: 'общее', parentId: null, anchor: null });
        const inline = await host.saveDraft({
            body: 'по строке',
            parentId: null,
            anchor: { fileId: 'eid:file-index', path: 'examples/ui/packages/grid/src/index.ts', position: null },
        });

        const result = await host.publishBatch('ship');

        expect(result.publishedCommentIds).toEqual([prLevel.id]);
        expect(result.failed).toHaveLength(1);
        expect(result.failed[0]?.commentId).toBe(inline.id);
        expect(result.failed[0]?.message).toMatch(/\S/);
        // Ревью не завершено — вердикт не уехал.
        expect(result.verdictApplied).toBe(false);
        expect(calls.get('ship')).toBeUndefined();

        const stayed = (await host.getThreads()).find((thread) => thread.id === inline.id);
        expect(stayed?.root.draft).toBe(true);
    });

    it('ответ публикации принимается и голым, и в конверте {data}', async () => {
        // Голый — записанная живьём форма, она и стоит в моке по умолчанию.
        const bare = makeWriteHost();
        const bareDraft = await bare.host.saveDraft({ body: 'голый ответ', parentId: null, anchor: null });
        expect(await bare.host.publishBatch('ship')).toEqual({
            publishedCommentIds: [bareDraft.id],
            failed: [],
            verdictApplied: true,
        });

        // Конверт у этой ручки живьём не подтверждён (swagger форму ответа не описывает вовсе):
        // приедет `{data}` — разбор обязан устоять, иначе комментарии опубликованы, а вызов упал.
        const inner = makeMockArcanumFetch();
        const host = new ArcanumHost({
            prId: MOCK_PR_ID,
            arc: makeMockArcCli(),
            token: () => Promise.resolve(TOKEN),
            transport: { retryAttempts: 1 },
            fetch: async (input, init) => {
                const response = await inner(input, init);
                if (!new URL(input).pathname.endsWith('/draft-comments')) {
                    return response;
                }
                return new Response(`{"data":${await response.text()}}`, { status: response.status });
            },
        });

        const draft = await host.saveDraft({ body: 'ответ в конверте', parentId: null, anchor: null });
        expect(await host.publishBatch('ship')).toEqual({
            publishedCommentIds: [draft.id],
            failed: [],
            verdictApplied: true,
        });
    });

    it('ответ публикации потерялся: ретрай не выдаёт опубликованное за несдавшееся', async () => {
        const inner = makeMockArcanumFetch();
        let firstAttempt = true;
        const host = new ArcanumHost({
            prId: MOCK_PR_ID,
            arc: makeMockArcCli(),
            token: () => Promise.resolve(TOKEN),
            transport: { retryAttempts: 3, retryBaseMs: 0, sleep: () => Promise.resolve(), random: () => 0 },
            fetch: async (input, init) => {
                const response = await inner(input, init);
                if (!firstAttempt || !new URL(input).pathname.endsWith('/draft-comments')) {
                    return response;
                }
                // Ручка сработала, а ответ не доехал: повтор уже не найдёт этих черновиков.
                firstAttempt = false;
                await response.text();
                return new Response('{"errors":[]}', { status: 502 });
            },
        });
        const draft = await host.saveDraft({ body: 'общее', parentId: null, anchor: null });

        const result = await host.publishBatch('ship');

        expect(result.publishedCommentIds).toEqual([draft.id]);
        expect(result.failed).toEqual([]);
        expect(result.verdictApplied).toBe(true);
        const published = (await host.getThreads()).find((thread) => thread.id === draft.id);
        expect(published?.root.draft).toBe(false);
    });

    it('перечитывание черновиков сорвалось — верим ответу ручки, а не падаем', async () => {
        const inner = makeMockArcanumFetch();
        let collects = 0;
        const host = new ArcanumHost({
            prId: MOCK_PR_ID,
            arc: makeMockArcCli(),
            token: () => Promise.resolve(TOKEN),
            transport: { retryAttempts: 1 },
            fetch: (input, init) => {
                const url = new URL(input);
                const collecting =
                    (init?.method ?? 'GET') === 'GET' &&
                    url.searchParams.get('fields') === EXPECTED_FIELDS.draftIds;
                if (collecting) {
                    collects += 1;
                    // Первый сбор черновиков нужен публикации, второй — уточнению после неё.
                    if (collects > 1) {
                        return Promise.resolve(new Response('{"errors":[]}', { status: 500 }));
                    }
                }
                if (!url.pathname.endsWith('/draft-comments')) {
                    return inner(input, init);
                }
                return Promise.resolve(new Response('{"published":[]}', { status: 200 }));
            },
        });
        const draft = await host.saveDraft({ body: 'общее', parentId: null, anchor: null });

        const result = await host.publishBatch('ship');

        expect(result.publishedCommentIds).toEqual([]);
        expect(result.failed.map((item) => item.commentId)).toEqual([draft.id]);
        expect(result.verdictApplied).toBe(false);
    });

    it('viewed: PUT с entry_id, точечная правка кэша и общее состояние хоста', async () => {
        const calls = new Map<string, number>();
        const fetchImpl = makeMockArcanumFetch({ calls });
        const bodies: unknown[] = [];
        const options = {
            prId: MOCK_PR_ID,
            arc: makeMockArcCli(),
            token: () => Promise.resolve(TOKEN),
            transport: { retryAttempts: 1 },
            fetch: (input: string, init?: RequestInit) => {
                if (init?.method === 'PUT' && typeof init.body === 'string') {
                    bodies.push(JSON.parse(init.body));
                }
                return fetchImpl(input, init);
            },
        };
        const host = new ArcanumHost(options);
        // Второй адаптер на том же моке: он видит состояние хоста, а не кэш первого.
        const another = new ArcanumHost(options);

        const before = await host.getDiff();
        expect(before.files.find((file) => file.fileId === 'eid:file-moved')?.viewed).toBe(false);

        await host.setFileViewed('eid:file-moved', true);

        expect(bodies).toEqual([{ entry_ids: ['eid:file-moved'], reviewed: true }]);
        expect((await host.getDiff()).files.find((file) => file.fileId === 'eid:file-moved')?.viewed).toBe(true);
        // Кэш итерации правится точечно: changelist и патч ради одного флага не перечитываются.
        expect(calls.get('changelist')).toBe(1);

        expect((await another.getDiff()).files.find((file) => file.fileId === 'eid:file-moved')?.viewed).toBe(true);
    });

    it('токен не утекает в ошибку записи', async () => {
        const { host } = makeWriteHost({ failing: { 'create-comment': 500 } });

        const error = await host
            .saveDraft({ body: 'x', parentId: null, anchor: null })
            .catch((caught: unknown) => caught);

        expect(error).toBeInstanceOf(RpcFailure);
        const failure = error as RpcFailure;
        expect(JSON.stringify([failure.message, failure.details])).not.toContain(TOKEN);
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

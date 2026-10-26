import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { RpcFailure } from '../../errors.js';

import type { FetchLike } from './client.js';
import { BODY_PLACEHOLDER } from './drafts.js';
import { GithubHost } from './github-host.js';
import { memoryIdempotencyStore } from './idempotency-store.js';
import type { MockGithubOptions } from './mock-transport.js';
import { VERDICT_REVIEW_MUTATION } from './queries.js';
import {
    makeMockGithubFetch,
    MOCK_HEAD_OID,
    MOCK_MERGE_BASE,
    MOCK_NUMBER,
    MOCK_OWNER,
    MOCK_REPO,
    MOCK_VIEWER_AVATAR,
} from './mock-transport.js';
import { avatarOf, userOf } from './threads.js';

/**
 * Адаптер GitHub на записанном API: маппинг шапки, диффа и тредов, черновики в pending-ревью,
 * публикация и отметки просмотра. Живых вызовов нет — весь транспорт мок.
 */

const TOKEN = 'test-token-must-never-leak-42';

function makeHost(options: MockGithubOptions = {}, fetchImpl?: FetchLike): GithubHost {
    return new GithubHost({
        owner: MOCK_OWNER,
        repo: MOCK_REPO,
        number: MOCK_NUMBER,
        fetch: fetchImpl ?? makeMockGithubFetch(options),
        token: () => Promise.resolve(TOKEN),
        pollIntervalMs: 20,
        idempotency: memoryIdempotencyStore(),
        transport: { retryAttempts: 1 },
    });
}

function fileUrlAnchor(path: string): string {
    return createHash('sha256').update(path).digest('hex');
}

/** Хост на моке, который попутно записывает переменные названной операции. */
function recordingHost(
    operation: string,
    sink: Record<string, unknown>[],
    options: MockGithubOptions = {},
): GithubHost {
    const inner = makeMockGithubFetch(options);
    return makeHost(options, (url: string, init?: RequestInit) => {
        const raw = typeof init?.body === 'string' ? init.body : '';
        if (raw.includes(operation)) {
            sink.push((JSON.parse(raw) as { variables: Record<string, unknown> }).variables);
        }
        return inner(url, init);
    });
}

/** Тот же мок, но в списке файлов остаются только те, у которых патч есть. */
function onlyPatchedFiles(options: MockGithubOptions = {}): FetchLike {
    const inner = makeMockGithubFetch(options);
    return async (url: string, init?: RequestInit) => {
        const response = await inner(url, init);
        if (!new URL(url).pathname.endsWith('/files')) {
            return response;
        }
        const files = (await response.json()) as { patch?: string }[];
        return new Response(JSON.stringify(files.filter((file) => file.patch !== undefined)), {
            status: 200,
            headers: { 'content-type': 'application/json' },
        });
    };
}

describe('адаптер GitHub: чтение', () => {
    it('шапка PR переводится в контракт словами хоста', async () => {
        const pr = await makeHost().getPr();

        expect(pr).toEqual({
            id: '42',
            url: 'https://github.com/acme/sherpa/pull/42',
            title: 'grid: считаем колонки честно',
            author: { login: 'carol', displayName: 'Carol Danvers', bot: false, avatarUrl: null },
            fromBranch: 'feature/columns',
            toBranch: 'main',
            state: 'open',
            statusLabel: 'open',
            checks: 'passed',
            updatedAt: '2026-09-20T10:15:00.000Z',
            capabilities: {
                publishVerdicts: ['comment', 'ship', 'request_changes'],
                fileViewedSync: true,
                fileContent: true,
                sourceAtRevision: true,
                commentIssues: false,
                commentResolve: false,
                editPublished: true,
                iterations: false,
                blobs: true,
            },
            verdicts: [],
            viewer: { login: 'alice', displayName: 'Alice', bot: false, avatarUrl: MOCK_VIEWER_AVATAR },
        });
    });

    it('личность ревьюера — владелец токена; не ответил — шапки нет', async () => {
        expect((await makeHost().getPr()).viewer).toEqual({
            login: 'alice',
            displayName: 'Alice',
            bot: false,
            avatarUrl: MOCK_VIEWER_AVATAR,
        });
        // `editPublished` держится на личности: шапка без неё соврала бы о правах на правку.
        await expect(makeHost({ viewer: null }).getPr()).rejects.toThrow(/владельца токена/);
    });

    it('фото автора — из `avatarUrl` GitHub, только https', () => {
        expect(userOf({ login: 'bob', __typename: 'User', avatarUrl: MOCK_VIEWER_AVATAR }).avatarUrl).toBe(MOCK_VIEWER_AVATAR);
        expect(userOf({ login: 'ci[bot]', __typename: 'Bot', avatarUrl: MOCK_VIEWER_AVATAR }).avatarUrl).toBe(MOCK_VIEWER_AVATAR);
        expect(avatarOf('http://ghe.local/avatars/u/1')).toBeNull();
        expect(avatarOf(undefined)).toBeNull();
    });

    it('черновик PR и состояния переводятся статусом и state', async () => {
        const draft = await makeHost({ prOverrides: { isDraft: true } }).getPr();
        expect(draft.statusLabel).toBe('draft');
        expect(draft.state).toBe('open');

        const merged = await makeHost({ prOverrides: { state: 'MERGED', merged: true } }).getPr();
        expect(merged.state).toBe('merged');
        expect(merged.statusLabel).toBe('merged');

        const closed = await makeHost({ prOverrides: { state: 'CLOSED' } }).getPr();
        expect(closed.state).toBe('closed');
    });

    it('ветка из форка называется владельцем', async () => {
        const pr = await makeHost({ prOverrides: { headRepositoryOwner: { login: 'bob' } } }).getPr();

        expect(pr.fromBranch).toBe('bob:feature/columns');
    });

    it('сводный статус проверок переводится словами контракта', async () => {
        for (const [state, checks] of [
            ['SUCCESS', 'passed'],
            ['FAILURE', 'failed'],
            ['ERROR', 'failed'],
            ['PENDING', 'pending'],
            ['EXPECTED', 'pending'],
            [null, null],
        ] as const) {
            expect((await makeHost({ prOverrides: { checksState: state } }).getPr()).checks).toBe(checks);
        }
    });

    it('вердикт появляется после публикации с ним', async () => {
        const host = makeHost();
        await host.publishBatch('request_changes');

        expect((await host.getPr()).verdicts).toEqual([
            { user: { login: 'alice', displayName: null, bot: false, avatarUrl: null }, verdict: 'request_changes' },
        ]);
    });

    it('итерация одна, а срез отклоняется понятной ошибкой', async () => {
        const host = makeHost();
        const iterations = await host.listIterations();

        expect(iterations).toEqual([
            {
                diffId: MOCK_HEAD_OID,
                baseCommit: MOCK_MERGE_BASE,
                headCommit: MOCK_HEAD_OID,
                createdAt: '2026-09-20T10:15:00.000Z',
                status: 'active',
            },
        ]);
        await expect(host.getDiff({ base: MOCK_HEAD_OID, head: MOCK_HEAD_OID })).rejects.toThrow(
            /одна итерация/,
        );
    });

    it('файл диффа: вид правки, ссылки в веб и статистика', async () => {
        const diff = await makeHost().getDiff();
        const service = diff.files.find((file) => file.path === 'src/service.ts');

        expect(diff.diffId).toBe(MOCK_HEAD_OID);
        expect(diff.baseCommit).toBe(MOCK_MERGE_BASE);
        expect(service).toMatchObject({
            fileId: 'src/service.ts',
            oldPath: null,
            changeType: 'modify',
            binary: false,
            generated: false,
            additions: 1,
            deletions: 1,
            viewed: false,
            blameUrl: `https://github.com/acme/sherpa/blame/${MOCK_HEAD_OID}/src/service.ts`,
            hostFileUrl: `https://github.com/acme/sherpa/pull/42/files#diff-${fileUrlAnchor('src/service.ts')}`,
            image: null,
        });
        expect(service?.patch).toContain('+    const port = 9090;');
    });

    it('двоичность файла без патча спрашивается у блоба, а не считается по статистике', async () => {
        const calls = new Map<string, number>();
        const files = (await makeHost({ calls }).getDiff()).files;

        expect(files.find((file) => file.path === 'src/generated.bin')).toMatchObject({
            binary: true,
            patch: null,
        });
        // Патча нет, но блоб текстовый — файл просто слишком велик для патча.
        expect(files.find((file) => file.path === 'src/bundle.js')).toMatchObject({
            binary: false,
            patch: null,
            additions: 4000,
        });
        // Чистое переименование: патча и строк нет, но это обычный `.ts`, а не двоичный файл.
        expect(files.find((file) => file.path === 'src/renamed.ts')).toMatchObject({
            binary: false,
            patch: null,
            changeType: 'move',
            oldPath: 'src/old-name.ts',
            additions: 0,
            deletions: 0,
        });
        // Один запрос на весь дифф, а не по одному на файл без патча.
        expect(calls.get('SherpaBlobBinary')).toBe(1);
        // Удалённому файлу blame показывать нечего.
        expect(files.find((file) => file.path === 'src/legacy.ts')?.blameUrl).toBeNull();
    });

    it('блобы не ответили — файл без патча считается текстовым, а не двоичным', async () => {
        const files = (await makeHost({ failing: { SherpaBlobBinary: 500 } }).getDiff()).files;

        expect(files.find((file) => file.path === 'src/generated.bin')?.binary).toBe(false);
    });

    it('дифф, где у всех файлов есть патч, за двоичностью не ходит вовсе', async () => {
        const calls = new Map<string, number>();
        const host = makeHost({}, onlyPatchedFiles({ calls }));

        await host.getDiff();
        expect(calls.get('SherpaBlobBinary')).toBeUndefined();
    });

    it('картинка получает стороны-блобы с размерами, svg остаётся текстом', async () => {
        const files = (await makeHost().getDiff()).files;

        expect(files.find((file) => file.path === 'assets/logo.png')?.image).toEqual({
            mime: 'image/png',
            before: { blobId: `${MOCK_MERGE_BASE}:assets/logo.png`, size: 6 },
            after: { blobId: `${MOCK_HEAD_OID}:assets/logo.png`, size: 7 },
        });
        // У добавленной картинки прежней стороны нет.
        expect(files.find((file) => file.path === 'assets/huge.png')?.image).toMatchObject({
            before: null,
            after: { blobId: `${MOCK_HEAD_OID}:assets/huge.png`, size: 12_000_000 },
        });

        const svg = files.find((file) => file.path === 'assets/icon.svg');
        expect(svg?.binary).toBe(false);
        expect(svg?.patch).toContain('<svg width="2">');
        expect(svg?.image?.mime).toBe('image/svg+xml');
    });

    it('байты стороны: неизвестный адрес и сторона за лимитом — null', async () => {
        const host = makeHost();
        await host.getDiff();

        expect(await host.getBlob('no-such-blob')).toBeNull();
        expect(await host.getBlob(`${MOCK_HEAD_OID}:assets/huge.png`)).toBeNull();
        expect(await host.getBlob(`${MOCK_HEAD_OID}:assets/logo.png`)).toEqual(
            new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0x02, 0x03]),
        );
    });

    it('содержимое файла: текст обеих сторон, картинка и слишком большой — null', async () => {
        const host = makeHost();

        expect(await host.getFileContent('src/service.ts')).toEqual({
            oldText: 'export function serve() {\n    const port = 8080;\n    listen(port);\n    log("up");\n}\n',
            newText: 'export function serve() {\n    const port = 9090;\n    listen(port);\n    log("up");\n}\n',
        });
        // Добавленного файла на базе нет.
        expect(await host.getFileContent('docs/readme.md')).toEqual({
            oldText: null,
            newText: '# Sherpa\n\n',
        });
        expect(await host.getFileContent('assets/logo.png')).toBeNull();
        expect(await host.getFileContent('src/bundle.js')).toBeNull();
        await expect(host.getFileContent('no/such/file.ts')).rejects.toBeInstanceOf(RpcFailure);
    });

    it('треды диффа: якоря, устаревание, resolved и боты', async () => {
        const threads = await makeHost().getThreads();

        expect(threads[0]).toMatchObject({
            id: 'th:PRRT_thread1',
            anchor: {
                fileId: 'src/service.ts',
                path: 'src/service.ts',
                position: { side: 'new', line: 3, size: 1 },
            },
            resolved: false,
            outdated: false,
            pinnedTo: { diffId: MOCK_HEAD_OID, commit: MOCK_HEAD_OID },
        });
        expect(threads[0]?.root.id).toBe('rc:PRRC_1');
        expect(threads[0]?.root.replies.map((reply) => reply.id)).toEqual(['rc:PRRC_2']);
        expect(threads[0]?.root.issue).toBeNull();

        // Устаревший тред: живых координат нет, берём исходные.
        expect(threads[1]).toMatchObject({
            id: 'th:PRRT_thread2',
            anchor: { position: { side: 'old', line: 1, size: 1 } },
            resolved: true,
            resolvedBy: 'bob',
            outdated: true,
        });
        expect(threads[1]?.root.author).toEqual({ login: 'review-bot[bot]', displayName: null, bot: true, avatarUrl: null });
        expect(threads[1]?.root.editedAt).toBe('2026-09-20T09:11:00.000Z');

        // Многострочный якорь: строка — начало, размер — охват.
        expect(threads[2]?.anchor?.position).toEqual({ side: 'new', line: 2, size: 3 });
        // Комментарий к файлу целиком.
        expect(threads[3]?.anchor).toEqual({
            fileId: 'docs/readme.md',
            path: 'docs/readme.md',
            position: null,
        });
    });

    it('обсуждения уровня PR: тело ревью и комментарий задачи', async () => {
        const threads = await makeHost().getThreads();

        expect(threads[4]).toMatchObject({
            id: 'rv:PRR_published',
            anchor: null,
            resolved: false,
            outdated: false,
            pinnedTo: null,
        });
        expect(threads[4]?.root).toMatchObject({
            id: 'rv:PRR_published',
            body: 'Смотрел бегло, вопросы внутри.',
            draft: false,
        });
        expect(threads[5]?.id).toBe('ic:IC_1');
        expect(threads[5]?.root.author.login).toBe('dave');
    });

    it('страницы тредов, ответов и файлов дочитываются до конца', async () => {
        const host = makeHost({ threadPageSize: 1, commentPageSize: 1, filePageSize: 2 });

        const threads = await host.getThreads();
        expect(threads.map((thread) => thread.id)).toEqual([
            'th:PRRT_thread1',
            'th:PRRT_thread2',
            'th:PRRT_thread3',
            'th:PRRT_thread4',
            'rv:PRR_published',
            'ic:IC_1',
        ]);
        expect(threads[0]?.root.replies).toHaveLength(1);
        expect((await host.getDiff()).files).toHaveLength(9);
    });
});

describe('адаптер GitHub: запись', () => {
    it('pending-ревью заводится лениво и одно на все черновики', async () => {
        const calls = new Map<string, number>();
        const host = makeHost({ calls });

        await host.getThreads();
        expect(calls.get('SherpaCreateReview')).toBeUndefined();

        await host.saveDraft({ body: 'Первый', parentId: null, anchor: null });
        await host.saveDraft({
            body: 'Второй',
            parentId: null,
            anchor: { fileId: 'src/service.ts', path: 'src/service.ts', position: { side: 'new', line: 3, size: 1 } },
        });
        expect(calls.get('SherpaCreateReview')).toBe(1);
    });

    it('черновик уровня PR ложится абзацем тела, черновик строки — комментарием треда', async () => {
        const host = makeHost();

        const body = await host.saveDraft({ body: 'Общий вопрос', parentId: null, anchor: null });
        expect(body.id).toMatch(/^rvb:PRR_draft_\d+:1$/);
        expect(body).toMatchObject({ body: 'Общий вопрос', draft: true, issue: null });

        const inline = await host.saveDraft({
            body: 'Строчный вопрос',
            parentId: null,
            anchor: { fileId: 'src/service.ts', path: 'src/service.ts', position: { side: 'old', line: 2, size: 2 } },
        });
        expect(inline.id).toMatch(/^rc:/);
        expect(inline.draft).toBe(true);

        const threads = await host.getThreads();
        const created = threads.find((thread) => thread.root.id === inline.id);
        expect(created?.anchor?.position).toEqual({ side: 'old', line: 2, size: 2 });
        expect(threads.find((thread) => thread.id === body.id)?.root.body).toBe('Общий вопрос');
    });

    it('повтор с тем же ключом идемпотентности не заводит второй черновик', async () => {
        const host = makeHost();
        const options = { idempotencyKey: 'buffer-key-1' };

        const first = await host.saveDraft({ body: 'Повтор', parentId: null, anchor: null }, options);
        const second = await host.saveDraft({ body: 'Повтор', parentId: null, anchor: null }, options);

        expect(second.id).toBe(first.id);
        const threads = await host.getThreads();
        const drafts = threads.flatMap((thread) =>
            [thread.root, ...thread.root.replies].filter((comment) => comment.draft),
        );
        expect(drafts).toHaveLength(1);
    });

    it('сорвавшийся ответ на создание не задваивает черновик: адаптер сверяется с хостом', async () => {
        const inner = makeMockGithubFetch({});
        let breakNext = true;
        const host = makeHost(
            {},
            async (url: string, init?: RequestInit) => {
                const response = await inner(url, init);
                const body = typeof init?.body === 'string' ? init.body : '';
                if (breakNext && body.includes('SherpaUpdateReviewBody')) {
                    // Запись на стороне GitHub уже случилась, а ответ до нас не доехал.
                    breakNext = false;
                    throw new TypeError('fetch failed');
                }
                return response;
            },
        );

        const created = await host.saveDraft({ body: 'Ушло, но ответа нет', parentId: null, anchor: null });
        expect(created.body).toBe('Ушло, но ответа нет');

        const threads = await host.getThreads();
        const drafts = threads.flatMap((thread) =>
            [thread.root, ...thread.root.replies].filter((comment) => comment.draft),
        );
        expect(drafts.map((draft) => draft.id)).toEqual([created.id]);
    });

    it('сверка после сорвавшейся записи тела не принимает за абзац черновик строки', async () => {
        const inner = makeMockGithubFetch({});
        let breakNext = true;
        const host = makeHost({}, async (url: string, init?: RequestInit) => {
            const response = await inner(url, init);
            const body = typeof init?.body === 'string' ? init.body : '';
            if (breakNext && body.includes('SherpaUpdateReviewBody')) {
                breakNext = false;
                throw new TypeError('fetch failed');
            }
            return response;
        });

        // Тот же текст уже лежит черновиком к строке: копипаст фразы — обычное дело.
        await host.saveDraft({
            body: 'Тут то же самое',
            parentId: null,
            anchor: { fileId: 'src/service.ts', path: 'src/service.ts', position: { side: 'new', line: 3, size: 1 } },
        });

        const created = await host.saveDraft({ body: 'Тут то же самое', parentId: null, anchor: null });
        expect(created.id).toMatch(/^rvb:/);
    });

    it('два черновика уровня PR разом не затирают друг друга в теле ревью', async () => {
        const calls = new Map<string, number>();
        const host = makeHost({ calls });

        const [first, second] = await Promise.all([
            host.saveDraft({ body: 'Раз', parentId: null, anchor: null }),
            host.saveDraft({ body: 'Два', parentId: null, anchor: null }),
        ]);

        expect(first.id).not.toBe(second.id);
        // Ленивое создание тоже под очередью: второго pending-ревью у GitHub не бывает.
        expect(calls.get('SherpaCreateReview')).toBe(1);

        const bodies = (await host.getThreads())
            .flatMap((thread) => [thread.root, ...thread.root.replies])
            .filter((comment) => comment.draft)
            .map((comment) => comment.body);
        expect(new Set(bodies)).toEqual(new Set(['Раз', 'Два']));
    });

    it('pending-ревью заводится сразу с телом-заглушкой', async () => {
        const created: Record<string, unknown>[] = [];
        const host = recordingHost('SherpaCreateReview', created);

        await host.saveDraft({
            body: 'Вопрос по строке',
            parentId: null,
            anchor: { fileId: 'src/service.ts', path: 'src/service.ts', position: { side: 'new', line: 3, size: 1 } },
        });

        // Ревью, заведённое без тела, GitHub больше не даёт дописать — заглушка едет сразу.
        expect(created.map((variables) => variables.body)).toEqual([BODY_PLACEHOLDER]);
        // Наружу заглушка комментарием не выходит: обсуждение тут одно, и оно у строки.
        const threads = await host.getThreads();
        expect(threads.filter((thread) => thread.anchor === null && thread.root.draft)).toEqual([]);
    });

    it('после удаления последнего абзаца тело ревью не пустеет и черновик пишется снова', async () => {
        const host = makeHost();
        const first = await host.saveDraft({ body: 'Раз', parentId: null, anchor: null });

        await host.deleteDraft(first.id);
        expect((await host.getThreads()).filter((thread) => thread.root.draft)).toEqual([]);

        // Пустое тело сломало бы ревью навсегда: следующая правка уже не прошла бы.
        const second = await host.saveDraft({ body: 'Два', parentId: null, anchor: null });
        expect(second.body).toBe('Два');
        expect((await host.getThreads()).find((thread) => thread.id === second.id)?.root.body).toBe('Два');
    });

    it('в публикацию едут абзацы с маркерами, а заглушка — нет', async () => {
        const withBody: Record<string, unknown>[] = [];
        const host = recordingHost('SherpaSubmitReview', withBody);
        await host.saveDraft({ body: 'Итог', parentId: null, anchor: null });
        await host.publishBatch('ship');

        expect(withBody.map((variables) => variables.body)).toEqual(['<!-- devflow-diff-explain:draft 1 -->\nИтог']);

        // Черновики только у строк: тело ревью пустое, и заглушке в опубликованном делать нечего.
        const inlineOnly: Record<string, unknown>[] = [];
        const other = recordingHost('SherpaSubmitReview', inlineOnly);
        await other.saveDraft({
            body: 'Вопрос по строке',
            parentId: null,
            anchor: { fileId: 'src/service.ts', path: 'src/service.ts', position: { side: 'new', line: 3, size: 1 } },
        });
        await other.publishBatch('ship');
        expect(inlineOnly.map((variables) => variables.body)).toEqual(['']);
    });

    it('чужое незавершённое ревью без текста — понятный отказ, а не потерянный черновик', async () => {
        const host = makeHost({ pendingReviewBody: '' });

        // Дописать тело такому ревью GitHub не даёт вовсе — молчать об этом нельзя.
        await expect(host.saveDraft({ body: 'Итог', parentId: null, anchor: null })).rejects.toThrow(
            /незавершённое ревью/,
        );
        // Комментарий к строке в него ложится как обычно.
        const inline = await host.saveDraft({
            body: 'Вопрос по строке',
            parentId: null,
            anchor: { fileId: 'src/service.ts', path: 'src/service.ts', position: { side: 'new', line: 3, size: 1 } },
        });
        expect(inline.draft).toBe(true);
    });

    it('начатое на вебе pending-ревью — такой же черновик-абзац: правится и удаляется', async () => {
        const host = makeHost({ pendingReviewBody: 'Черновик из веба.' });

        const thread = (await host.getThreads()).find((candidate) => candidate.root.draft);
        expect(thread?.id).toBe('rvb:PRR_pending_web:0');
        expect(thread?.root.body).toBe('Черновик из веба.');

        // Первая перезапись проставляет маркер, id абзаца от этого не меняется.
        await host.updateDraft('rvb:PRR_pending_web:0', 'Дописал на своей машине.');
        expect((await host.getThreads()).find((candidate) => candidate.root.draft)?.root.body).toBe(
            'Дописал на своей машине.',
        );

        await host.deleteDraft('rvb:PRR_pending_web:0');
        expect((await host.getThreads()).filter((candidate) => candidate.root.draft)).toEqual([]);
    });

    it('правка и удаление абзаца тела не трогают соседей', async () => {
        const host = makeHost();
        const first = await host.saveDraft({ body: 'Раз', parentId: null, anchor: null });
        const second = await host.saveDraft({ body: 'Два', parentId: first.id, anchor: null });

        await host.updateDraft(second.id, 'Два с половиной');
        let root = (await host.getThreads()).find((thread) => thread.id === first.id);
        expect(root?.root.body).toBe('Раз');
        expect(root?.root.replies.map((reply) => reply.body)).toEqual(['Два с половиной']);

        await host.deleteDraft(first.id);
        root = (await host.getThreads()).find((thread) => thread.id === second.id);
        expect(root?.root.body).toBe('Два с половиной');
        expect(root?.root.replies).toEqual([]);
    });

    it('отметка «просмотрено» уходит мутацией и видна в следующем диффе', async () => {
        const calls = new Map<string, number>();
        const host = makeHost({ calls });
        await host.getDiff();

        await host.setFileViewed('src/service.ts', true);
        expect(calls.get('SherpaMarkFileAsViewed')).toBe(1);
        expect((await host.getDiff()).files.find((file) => file.path === 'src/service.ts')?.viewed).toBe(true);

        await host.setFileViewed('src/service.ts', false);
        expect(calls.get('SherpaUnmarkFileAsViewed')).toBe(1);
        expect((await host.getDiff()).files.find((file) => file.path === 'src/service.ts')?.viewed).toBe(false);
    });

    it('resolve есть только у обсуждений строк диффа', async () => {
        const host = makeHost();

        await host.setThreadResolved('th:PRRT_thread1', true);
        expect((await host.getThreads()).find((thread) => thread.id === 'th:PRRT_thread1')?.resolved).toBe(true);

        await expect(host.setThreadResolved('rv:PRR_published', true)).rejects.toThrow(/уровня PR/);
        await expect(host.setThreadResolved('ic:IC_1', true)).rejects.toThrow(/уровня PR/);
    });

    it('текст опубликованного ревью правится, но не удаляется', async () => {
        const host = makeHost();

        await host.updateComment('rv:PRR_published', 'Переписал итог.');
        // Текст без маркеров остаётся одним комментарием — id обсуждения не меняется.
        expect((await host.getThreads()).find((thread) => thread.id === 'rv:PRR_published')?.root.body).toBe(
            'Переписал итог.',
        );
        await expect(host.deleteComment('rv:PRR_published')).rejects.toThrow(/удалять текст ревью/);
    });

    it('опубликованный комментарий задачи правится и удаляется', async () => {
        const host = makeHost();

        await host.updateComment('ic:IC_1', 'Сборка всё-таки упала.');
        expect((await host.getThreads()).find((thread) => thread.id === 'ic:IC_1')?.root.body).toBe(
            'Сборка всё-таки упала.',
        );

        await host.deleteComment('ic:IC_1');
        expect((await host.getThreads()).find((thread) => thread.id === 'ic:IC_1')).toBeUndefined();
    });

    it('опубликованный комментарий строки правится и удаляется вместе с тредом', async () => {
        const host = makeHost();
        const inline = await host.saveDraft({
            body: 'Вопрос по строке',
            parentId: null,
            anchor: { fileId: 'src/service.ts', path: 'src/service.ts', position: { side: 'new', line: 3, size: 1 } },
        });
        await host.publishBatch('request_changes');

        await host.updateComment(inline.id, 'Вопрос снят.');
        const thread = (await host.getThreads()).find((candidate) => candidate.root.id === inline.id);
        expect(thread?.root).toMatchObject({ body: 'Вопрос снят.', draft: false });

        await host.deleteComment(inline.id);
        expect((await host.getThreads()).find((candidate) => candidate.root.id === inline.id)).toBeUndefined();
    });

    it('комментарий, начавший обсуждение строки, не удаляется, пока в нём есть ответы', async () => {
        const host = makeHost();
        const root = await host.saveDraft({
            body: 'Вопрос по строке',
            parentId: null,
            anchor: { fileId: 'src/service.ts', path: 'src/service.ts', position: { side: 'new', line: 3, size: 1 } },
        });
        await host.publishBatch('request_changes');
        const reply = await host.saveDraft({ body: 'И ещё', parentId: root.id, anchor: null });
        await host.publishBatch('request_changes');

        // Корень GitHub удаляет вместе с тредом — ответ ревьюера потерялся бы молча.
        await expect(host.deleteComment(root.id)).rejects.toThrow(/Удалите сначала ответы/);
        expect((await host.getThreads()).find((candidate) => candidate.root.id === root.id)).toBeDefined();

        await host.deleteComment(reply.id);
        await host.deleteComment(root.id);
        expect((await host.getThreads()).find((candidate) => candidate.root.id === root.id)).toBeUndefined();
    });

    it('черновик-корень обсуждения строки тоже не удаляется с ответами', async () => {
        const host = makeHost();
        const root = await host.saveDraft({
            body: 'Вопрос по строке',
            parentId: null,
            anchor: { fileId: 'src/service.ts', path: 'src/service.ts', position: { side: 'new', line: 3, size: 1 } },
        });
        const reply = await host.saveDraft({ body: 'И ещё', parentId: root.id, anchor: null });

        await expect(host.deleteDraft(root.id)).rejects.toThrow(/Удалите сначала ответы/);

        await host.deleteDraft(reply.id);
        await host.deleteDraft(root.id);
        expect((await host.getThreads()).find((candidate) => candidate.root.id === root.id)).toBeUndefined();
    });

    it('абзац опубликованного ревью правится и удаляется перезаписью тела', async () => {
        const host = makeHost();
        const first = await host.saveDraft({ body: 'Раз', parentId: null, anchor: null });
        const second = await host.saveDraft({ body: 'Два', parentId: first.id, anchor: null });
        await host.publishBatch('request_changes');

        // Маркеры в теле остаются после публикации: id абзаца её переживает.
        await host.updateComment(second.id, 'Два с половиной');
        let root = (await host.getThreads()).find((thread) => thread.id === first.id);
        expect(root?.root.body).toBe('Раз');
        expect(root?.root.replies.map((reply) => reply.body)).toEqual(['Два с половиной']);

        await host.deleteComment(first.id);
        root = (await host.getThreads()).find((thread) => thread.id === second.id);
        expect(root?.root.body).toBe('Два с половиной');

        // Удаление последнего абзаца оставляет тело ревью пустым — обсуждения больше нет.
        await host.deleteComment(second.id);
        expect((await host.getThreads()).find((thread) => thread.root.body === 'Два с половиной')).toBeUndefined();
    });

    it('черновик и опубликованное ходят разными ручками', async () => {
        const host = makeHost();
        const draft = await host.saveDraft({ body: 'Черновик', parentId: null, anchor: null });

        await expect(host.updateDraft('ic:IC_1', 'Не моя ручка')).rejects.toThrow(/уже опубликован/);
        await expect(host.deleteDraft('ic:IC_1')).rejects.toThrow(/уже опубликован/);
        await expect(host.updateComment(draft.id, 'Не моя ручка')).rejects.toThrow(/ещё черновик/);
        await expect(host.deleteComment(draft.id)).rejects.toThrow(/ещё черновик/);

        await expect(host.updateDraft('rc:PRRC_404', 'Нет такого')).rejects.toThrow(/нет в обсуждениях/);
        await expect(host.updateComment('нет-префикса', 'Нет такого')).rejects.toThrow(/непонятный id/);
    });

    it('публикация — один сабмит: все черновики уходят вместе с вердиктом', async () => {
        const host = makeHost();
        const body = await host.saveDraft({ body: 'Итог', parentId: null, anchor: null });
        const inline = await host.saveDraft({
            body: 'Вопрос по строке',
            parentId: null,
            anchor: { fileId: 'src/service.ts', path: 'src/service.ts', position: { side: 'new', line: 3, size: 1 } },
        });

        const result = await host.publishBatch('ship');

        expect(result.verdictApplied).toBe(true);
        expect(result.failed).toEqual([]);
        expect(new Set(result.publishedCommentIds)).toEqual(new Set([body.id, inline.id]));

        const threads = await host.getThreads();
        const drafts = threads.flatMap((thread) =>
            [thread.root, ...thread.root.replies].filter((comment) => comment.draft),
        );
        expect(drafts).toEqual([]);
    });

    it('сорвавшийся сабмит: вердикт не применён, черновики остались черновиками', async () => {
        const host = makeHost({ graphqlErrors: { SherpaSubmitReview: 'Can not approve your own pull request' } });
        const draft = await host.saveDraft({ body: 'Итог', parentId: null, anchor: null });

        const result = await host.publishBatch('ship');

        expect(result.verdictApplied).toBe(false);
        expect(result.publishedCommentIds).toEqual([]);
        expect(result.failed.map((entry) => entry.commentId)).toEqual([draft.id]);
        expect(result.failed[0]?.message).toContain('Can not approve your own pull request');
        expect((await host.getThreads()).find((thread) => thread.id === draft.id)?.root.draft).toBe(true);
    });

    it('вердикт без черновиков не заводит pending-ревью', async () => {
        const calls = new Map<string, number>();
        const host = makeHost({ calls });

        const result = await host.publishBatch('ship');

        expect(result).toEqual({ publishedCommentIds: [], failed: [], verdictApplied: true });
        expect(calls.get('SherpaCreateReview')).toBeUndefined();
        expect(calls.get('SherpaVerdictReview')).toBe(1);
    });

    it('стики-шипа у GitHub нет — вердикт отклоняется', async () => {
        await expect(makeHost().publishBatch('sticky_ship')).rejects.toThrow(/стики-шип/);
    });

    it('comment уходит ревью без вердикта, тело — как у вердикта', async () => {
        const submits: Record<string, unknown>[] = [];
        const host = recordingHost('SherpaSubmitReview', submits);
        const draft = await host.saveDraft({ body: 'Итог', parentId: null, anchor: null });

        expect(await host.publishBatch('comment')).toEqual({
            publishedCommentIds: [draft.id],
            failed: [],
            verdictApplied: true,
        });
        expect(submits.map(({ event, body }) => ({ event, body }))).toEqual([
            { event: 'COMMENT', body: '<!-- devflow-diff-explain:draft 1 -->\nИтог' },
        ]);
        // Ревью без вердикта вердиктом ревьюера не считается.
        expect((await host.getPr()).verdicts).toEqual([]);
        expect((await host.getThreads()).find((thread) => thread.id === draft.id)?.root.draft).toBe(false);
    });

    it('comment без черновиков ничего не пишет и pending-ревью с заглушкой не трогает', async () => {
        const calls = new Map<string, number>();
        const host = makeHost({ calls, pendingReviewBody: BODY_PLACEHOLDER });

        expect(await host.publishBatch('comment')).toEqual({ publishedCommentIds: [], failed: [], verdictApplied: true });
        expect(calls.get('SherpaSubmitReview')).toBeUndefined();
        expect(calls.get('SherpaVerdictReview')).toBeUndefined();
        expect(calls.get('SherpaCreateReview')).toBeUndefined();

        // И без pending-ревью вовсе — тоже ни одной мутации.
        const bare = new Map<string, number>();
        expect(await makeHost({ calls: bare }).publishBatch('comment')).toEqual({
            publishedCommentIds: [],
            failed: [],
            verdictApplied: true,
        });
        expect(bare.get('SherpaVerdictReview')).toBeUndefined();
    });

    it('на своём PR доступны только комментарии: GitHub запрещает автору любой вердикт', async () => {
        // Логин сверяется без учёта регистра: GitHub сам его не различает.
        const host = makeHost({ prOverrides: { author: { login: 'Alice', __typename: 'User' } } });
        expect((await host.getPr()).capabilities.publishVerdicts).toEqual(['comment']);

        const draft = await host.saveDraft({ body: 'Итог', parentId: null, anchor: null });
        for (const verdict of ['ship', 'request_changes'] as const) {
            const error = await host.publishBatch(verdict).catch((caught: unknown) => caught);
            expect(error).toBeInstanceOf(RpcFailure);
            expect((error as RpcFailure).code).toBe('bad_request');
        }
        expect((await host.getThreads()).find((thread) => thread.id === draft.id)?.root.draft).toBe(true);

        expect((await host.publishBatch('comment')).publishedCommentIds).toEqual([draft.id]);
    });

    it('мок, как живой GitHub, не даёт автору одобрить свой PR', async () => {
        const fetch = makeMockGithubFetch({ prOverrides: { author: { login: 'alice', __typename: 'User' } } });
        const response = await fetch('https://api.github.com/graphql', {
            method: 'POST',
            body: JSON.stringify({
                query: VERDICT_REVIEW_MUTATION,
                variables: { pullRequestId: 'PR_kwDOSherpa42', commitOID: MOCK_HEAD_OID, event: 'APPROVE' },
            }),
        });

        expect(JSON.stringify(await response.json())).toContain('Can not approve your own pull request');
    });

    it('PR без автора (удалённый аккаунт) — чужой', async () => {
        const host = makeHost({ prOverrides: { author: null as unknown as { login: string; __typename: string } } });

        expect((await host.getPr()).capabilities.publishVerdicts).toEqual(['comment', 'ship', 'request_changes']);
    });

    it('ответ черновиком в опубликованное обсуждение уровня PR отклоняется', async () => {
        await expect(
            makeHost().saveDraft({ body: 'Ответ', parentId: 'ic:IC_1', anchor: null }),
        ).rejects.toThrow(/уровня PR/);
    });

    // Линза владения — `github-ownership.test.ts`: у GitHub она строится по CODEOWNERS.
    it('дополнительных линз у хоста нет', async () => {
        expect(await makeHost().extraLenses()).toEqual([]);
    });
});

it('читает контекст исходника по переданной ревизии, без подмены текущей головой PR', async () => {
    const calls: Record<string, unknown>[] = [];
    const host = recordingHost('SherpaFileContent', calls);
    await host.getSourceAtRevision('service/caller.ts', 'pinned-head');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ oldExpression: 'pinned-head:service/caller.ts', newExpression: 'pinned-head:service/caller.ts' });
});

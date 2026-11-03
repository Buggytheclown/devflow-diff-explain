import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { RpcFailure } from '../../errors.js';

import type { FetchLike } from './client.js';
import { GithubHost } from './github-host.js';
import type { MockGithubOptions } from './mock-transport.js';
import {
    makeMockGithubFetch,
    MOCK_HEAD_OID,
    MOCK_MERGE_BASE,
    MOCK_NUMBER,
    MOCK_OWNER,
    MOCK_REPO,
    MOCK_VIEWER_AVATAR,
} from './mock-transport.js';
import { avatarOf, userOf } from './metadata.js';

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
                publishVerdicts: [],
                fileViewedSync: false,
                fileContent: true,
                sourceAtRevision: true,
                commentIssues: false,
                commentResolve: false,
                editPublished: false,
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
});

describe('адаптер GitHub: запись', () => {

    it('PR без автора (удалённый аккаунт) — чужой', async () => {
        const host = makeHost({ prOverrides: { author: null as unknown as { login: string; __typename: string } } });

        expect((await host.getPr()).capabilities.publishVerdicts).toEqual([]);
    });
});

it('читает контекст исходника по переданной ревизии, без подмены текущей головой PR', async () => {
    const calls: Record<string, unknown>[] = [];
    const host = recordingHost('SherpaFileContent', calls);
    await host.getSourceAtRevision('service/caller.ts', 'pinned-head');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ oldExpression: 'pinned-head:service/caller.ts', newExpression: 'pinned-head:service/caller.ts' });
});

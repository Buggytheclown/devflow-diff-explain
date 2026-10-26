import { existsSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { FixtureHost, makeFixtureHost } from '@sherpa/fixtures';
import type { Comment, UiState } from '@sherpa/protocol';
import {
    rpcErrorSchema,
    uiDraftBufferResponseSchema,
    uiUpdateDraftResponseSchema,
    UI_ENDPOINTS,
    UI_PROGRESS_EVENT,
    UI_REVIEW_EVENT,
    UI_STATE_EVENT,
    uiProgressEventSchema,
    uiPublishResponseSchema,
    uiReviewDiffResponseSchema,
    uiReviewFileContentResponseSchema,
    uiReviewEventSchema,
    uiReviewLensesResponseSchema,
    uiReviewProgressResponseSchema,
    uiReviewWriteAckSchema,
    uiSaveDraftResponseSchema,
    uiSetFileViewedResponseSchema,
    uiSetStopFileViewedResponseSchema,
    uiSetStopViewedResponseSchema,
    uiReviewThreadsResponseSchema,
    uiStateSchema,
} from '@sherpa/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { selectReviewHost } from './hosts/select.js';
import { blobsDirOf, databasePathFor } from './paths.js';
import { sniffImageMime } from './review-routes.js';
import { asRawText, mediumRawResults } from './route/fixture-support.js';
import type { SherpaServer } from './server.js';
import { startServer } from './server.js';
import { get, makeTempSherpaDir, postJson, removeTempSherpaDir } from './test-support.js';

/**
 * Ревью-ручки сервера и SSE-событие об изменении тредов — на фикстурном хосте:
 * prKey `fixture-medium` выбирает его тем же механизмом, что и боевой арканумный ключ.
 */

interface IterationRow {
    diff_id: string;
    status: string;
    diff_json: string;
}

const FIXTURE_PR = 'fixture-medium';
const UNKNOWN_PR = 'unknown-777';

describe('ревью-ручки сервера', () => {
    let sherpaDir: string;
    let servers: SherpaServer[];
    let streams: SseStream[];

    beforeEach(async () => {
        sherpaDir = await makeTempSherpaDir();
        servers = [];
        streams = [];
    });

    afterEach(async () => {
        for (const stream of streams) {
            stream.close();
        }
        for (const server of servers) {
            await server.close();
        }
        await removeTempSherpaDir(sherpaDir);
    });

    async function start(prKey: string, host?: FixtureHost): Promise<SherpaServer> {
        const server = await startServer({
            prKey,
            sherpaDir,
            longPollSeconds: 0.3,
            ...(host === undefined ? {} : { reviewHostFactory: () => ({ name: 'fixture', host }) }),
        });
        servers.push(server);
        return server;
    }

    /** Черновик через ручку сервера; провал записи в хост здесь считается поломкой теста. */
    async function saveDraftVia(server: SherpaServer, body: string, clientKey: string): Promise<Comment> {
        const response = await postJson(
            server.port,
            UI_ENDPOINTS.reviewSaveDraft,
            { draft: { body, parentId: null, anchor: null }, clientKey },
            server.token,
        );
        const saved = uiSaveDraftResponseSchema.parse(await response.json());
        if (saved.outcome !== 'saved') {
            throw new Error(`черновик ${clientKey} ушёл в буфер вместо хоста`);
        }
        return saved.comment;
    }

    async function openEvents(server: SherpaServer): Promise<SseStream> {
        const stream = await openSse(
            `http://127.0.0.1:${String(server.port)}${UI_ENDPOINTS.events}?token=${server.token}`,
        );
        streams.push(stream);
        return stream;
    }

    it('фикстурный prKey отдаёт дифф, треды и линзы', async () => {
        const server = await start(FIXTURE_PR);
        const expected = makeFixtureHost('medium');

        const diff = uiReviewDiffResponseSchema.parse(
            await (await get(server.port, UI_ENDPOINTS.reviewDiff, server.token)).json(),
        );
        const threads = uiReviewThreadsResponseSchema.parse(
            await (await get(server.port, UI_ENDPOINTS.reviewThreads, server.token)).json(),
        );
        const lenses = uiReviewLensesResponseSchema.parse(
            await (await get(server.port, UI_ENDPOINTS.reviewLenses, server.token)).json(),
        );

        expect(diff.diff).toEqual(await expected.getDiff());
        expect(threads.threads).toEqual(await expected.getThreads());
        expect(lenses.ownership).toEqual(await expected.ownershipLens());
        expect(lenses.extra).toEqual(await expected.extraLenses());
    });

    it('дифф активной итерации оседает в локальном хранилище патчей', async () => {
        const server = await start(FIXTURE_PR);
        const expected = await makeFixtureHost('medium').getDiff();

        await (await get(server.port, UI_ENDPOINTS.reviewDiff, server.token)).json();

        // Запись не держит ответ ручки, поэтому её ждём.
        const db = new DatabaseSync(databasePathFor(sherpaDir, FIXTURE_PR), { readOnly: true });
        try {
            const query = db.prepare('SELECT diff_id, status, diff_json FROM iterations');
            let row: IterationRow | undefined;
            const deadline = Date.now() + 2000;
            while (row === undefined && Date.now() < deadline) {
                row = query.get() as IterationRow | undefined;
                await new Promise((resolve) => setTimeout(resolve, 10));
            }

            expect(row?.diff_id).toBe(expected.diffId);
            expect(row?.status).toBe('active');
            expect(JSON.parse(row?.diff_json ?? 'null')).toEqual(expected);
        } finally {
            db.close();
        }
    });

    it('имя хоста видно в состоянии UI', async () => {
        const server = await start(FIXTURE_PR);

        const state = uiStateSchema.parse(await (await get(server.port, UI_ENDPOINTS.state, server.token)).json());

        expect(state.reviewHost).toBe('fixture');
    });

    it('мету PR несёт сам снапшот состояния', async () => {
        const server = await start(FIXTURE_PR);

        const state = await stateWithPr(server);

        expect(state.pr).toEqual(await makeFixtureHost('medium').getPr());
    });

    it('нераспознанный prKey: хоста нет, ручки отвечают no_review_host', async () => {
        const server = await start(UNKNOWN_PR);

        const state = uiStateSchema.parse(await (await get(server.port, UI_ENDPOINTS.state, server.token)).json());
        expect(state.reviewHost).toBeNull();

        for (const endpoint of [
            UI_ENDPOINTS.reviewDiff,
            UI_ENDPOINTS.reviewThreads,
            UI_ENDPOINTS.reviewLenses,
        ]) {
            const response = await get(server.port, endpoint, server.token);
            expect(response.status, endpoint).toBe(404);
            expect(rpcErrorSchema.parse(await response.json()).error.code).toBe('no_review_host');
        }
    });

    it('ревью-ручки закрыты токеном', async () => {
        const server = await start(FIXTURE_PR);

        const response = await get(server.port, UI_ENDPOINTS.reviewDiff);

        expect(response.status).toBe(401);
    });

    describe('содержимое файла', () => {
        it('текстовый файл отдаётся целиком, binary — честным null', async () => {
            const server = await start(FIXTURE_PR);
            const diff = await makeFixtureHost('medium').getDiff();
            const file = diff.files.find((candidate) => candidate.path.endsWith('domain/order.ts'));

            const body = uiReviewFileContentResponseSchema.parse(
                await (
                    await get(
                        server.port,
                        `${UI_ENDPOINTS.reviewFileContent}?fileId=${encodeURIComponent(file?.fileId ?? '')}`,
                        server.token,
                    )
                ).json(),
            );

            expect(body.content?.newText?.length).toBeGreaterThan(0);
            expect(body.content?.oldText?.length).toBeGreaterThan(0);
        });

        it('хост без метода отвечает bad_request с человеческим текстом', async () => {
            // Фикстура edge объявляет `fileContent: false` — метода у хоста нет.
            const server = await start('fixture-edge');
            const file = (await makeFixtureHost('edge').getDiff()).files[0];

            const response = await get(
                server.port,
                `${UI_ENDPOINTS.reviewFileContent}?fileId=${encodeURIComponent(file?.fileId ?? '')}`,
                server.token,
            );

            expect(response.status).toBe(400);
            const body = rpcErrorSchema.parse(await response.json());
            expect(body.error.code).toBe('bad_request');
            expect(body.error.message).toContain('Expand context');
        });

        it('без fileId — bad_request', async () => {
            const server = await start(FIXTURE_PR);

            const response = await get(server.port, UI_ENDPOINTS.reviewFileContent, server.token);

            expect(response.status).toBe(400);
        });
    });

    describe('байты картинки', () => {
        /** Первая сторона первой картинки фикстуры `medium` — png с прозрачностью. */
        async function firstImage(): Promise<{ blobId: string; size: number }> {
            const diff = await makeFixtureHost('medium').getDiff();
            const side = diff.files.flatMap((file) => (file.image?.after === undefined ? [] : [file.image.after]))[0];
            if (side == null) {
                throw new Error('в фикстуре medium нет картинок');
            }
            return side;
        }

        function blobPath(blobId: string): string {
            return `${UI_ENDPOINTS.reviewBlob}?blobId=${encodeURIComponent(blobId)}`;
        }

        it('байты, тип по магическим байтам и вечный immutable-кэш', async () => {
            const server = await start(FIXTURE_PR);
            const side = await firstImage();

            const response = await get(server.port, blobPath(side.blobId), server.token);

            expect(response.status).toBe(200);
            expect(response.headers.get('content-type')).toBe('image/png');
            expect(response.headers.get('content-length')).toBe(String(side.size));
            expect(response.headers.get('cache-control')).toBe('private, max-age=31536000, immutable');
            expect(response.headers.get('x-content-type-options')).toBe('nosniff');
            expect(new Uint8Array(await response.arrayBuffer()).length).toBe(side.size);
        });

        it('svg опознаётся по тексту, а не по расширению пути', async () => {
            const server = await start(FIXTURE_PR);
            const diff = await makeFixtureHost('medium').getDiff();
            const svg = diff.files.find((file) => file.image?.mime === 'image/svg+xml')?.image?.after;

            const response = await get(server.port, blobPath(svg?.blobId ?? ''), server.token);

            expect(response.headers.get('content-type')).toBe('image/svg+xml');
            expect(await response.text()).toContain('<svg');
        });

        it('второй заход не идёт в хост: байты берутся из кэша на диске', async () => {
            const host = makeFixtureHost('medium');
            const side = await firstImage();
            let calls = 0;
            const original = host.getBlob?.bind(host);
            host.getBlob = (blobId) => {
                calls += 1;
                return original?.(blobId) ?? Promise.resolve(null);
            };
            const server = await start(FIXTURE_PR, host);

            await get(server.port, blobPath(side.blobId), server.token);
            const second = await get(server.port, blobPath(side.blobId), server.token);

            expect(second.status).toBe(200);
            expect(new Uint8Array(await second.arrayBuffer()).length).toBe(side.size);
            expect(calls).toBe(1);
            expect(existsSync(path.join(blobsDirOf(sherpaDir, FIXTURE_PR), Buffer.from(side.blobId).toString('base64url')))).toBe(true);
        });

        it('If-None-Match — 304 без тела', async () => {
            const server = await start(FIXTURE_PR);
            const side = await firstImage();

            const first = await get(server.port, blobPath(side.blobId), server.token);
            const etag = first.headers.get('etag') ?? '';
            const second = await fetch(`http://127.0.0.1:${String(server.port)}${blobPath(side.blobId)}`, {
                headers: { authorization: `Bearer ${server.token}`, 'if-none-match': etag },
            });

            expect(etag).toBe(`"${side.blobId}"`);
            expect(second.status).toBe(304);
            expect(await second.text()).toBe('');
        });

        it('неизвестный блоб — not_found, промах в кэш не ложится', async () => {
            const server = await start(FIXTURE_PR);

            const response = await get(server.port, blobPath('no-such-blob'), server.token);

            expect(response.status).toBe(404);
            expect(rpcErrorSchema.parse(await response.json()).error.code).toBe('not_found');
            expect(existsSync(path.join(blobsDirOf(sherpaDir, FIXTURE_PR), Buffer.from('no-such-blob').toString('base64url')))).toBe(false);
        });

        it('сторона за лимитом контракта — тот же not_found', async () => {
            const host = makeFixtureHost('medium');
            // Фикстура отвечает `null` на всё, что больше лимита; здесь это же изображает хост.
            host.getBlob = () => Promise.resolve(null);
            const server = await start(FIXTURE_PR, host);

            const response = await get(server.port, blobPath((await firstImage()).blobId), server.token);

            expect(response.status).toBe(404);
        });

        it('хост без getBlob отвечает bad_request с человеческим текстом', async () => {
            const server = await start('fixture-edge');

            const response = await get(server.port, blobPath('any'), server.token);

            expect(response.status).toBe(400);
            expect(rpcErrorSchema.parse(await response.json()).error.message).toContain('картинки');
        });

        it('без blobId — bad_request', async () => {
            const server = await start(FIXTURE_PR);

            expect((await get(server.port, UI_ENDPOINTS.reviewBlob, server.token)).status).toBe(400);
        });

        it('отказ хоста — host_unavailable, а не 404', async () => {
            const host = makeFixtureHost('medium');
            host.getBlob = () => Promise.reject(new Error('хост прилёг'));
            const server = await start(FIXTURE_PR, host);

            const response = await get(server.port, blobPath((await firstImage()).blobId), server.token);

            expect(response.status).toBe(502);
            expect(rpcErrorSchema.parse(await response.json()).error.code).toBe('host_unavailable');
        });

        it('ручка байтов закрыта токеном', async () => {
            const server = await start(FIXTURE_PR);

            expect((await get(server.port, blobPath('any'))).status).toBe(401);
        });
    });

    it('отказ хоста доезжает как host_unavailable', async () => {
        const broken = makeFixtureHost('medium');
        broken.getDiff = () => Promise.reject(new Error('хост прилёг'));
        const server = await start(FIXTURE_PR, broken);

        const response = await get(server.port, UI_ENDPOINTS.reviewDiff, server.token);

        expect(response.status).toBe(502);
        const body = rpcErrorSchema.parse(await response.json());
        expect(body.error.code).toBe('host_unavailable');
        expect(body.error.message).toContain('хост прилёг');
    });

    describe('запись тредов', () => {
        it('save возвращает созданный Comment и черновик появляется в снапшоте', async () => {
            const server = await start(FIXTURE_PR);

            const response = await postJson(
                server.port,
                UI_ENDPOINTS.reviewSaveDraft,
                { draft: { body: 'новый черновик', parentId: null, anchor: null }, clientKey: 'ck-1' },
                server.token,
            );

            expect(response.status).toBe(200);
            const saved = uiSaveDraftResponseSchema.parse(await response.json());
            if (saved.outcome !== 'saved') {
                throw new Error('черновик обязан был уехать в хост');
            }
            const comment = saved.comment;
            expect(comment).toMatchObject({ body: 'новый черновик', draft: true });
            const threads = uiReviewThreadsResponseSchema.parse(
                await (await get(server.port, UI_ENDPOINTS.reviewThreads, server.token)).json(),
            );
            expect(threads.threads.some((thread) => thread.root.id === comment.id)).toBe(true);
        });

        it('update и delete зовут хост один-в-один', async () => {
            const host = makeFixtureHost('medium');
            const update = vi.spyOn(host, 'updateDraft');
            const remove = vi.spyOn(host, 'deleteDraft');
            const server = await start(FIXTURE_PR, host);
            const created = await saveDraftVia(server, 'черновик', 'ck-update');

            const updated = await postJson(
                server.port,
                UI_ENDPOINTS.reviewUpdateDraft,
                {
                    commentId: created.id,
                    body: 'исправленный черновик',
                    issue: false,
                    clientKey: 'ck-update-2',
                },
                server.token,
            );
            expect(uiUpdateDraftResponseSchema.parse(await updated.json())).toEqual({ outcome: 'saved' });
            expect(update).toHaveBeenCalledWith(created.id, 'исправленный черновик', false);

            const deleted = await postJson(
                server.port,
                UI_ENDPOINTS.reviewDeleteDraft,
                { commentId: created.id },
                server.token,
            );
            expect(uiReviewWriteAckSchema.parse(await deleted.json())).toEqual({ acknowledged: true });
            expect(remove).toHaveBeenCalledWith(created.id);
        });

        it('два update одного черновика доходят до хоста по порядку', async () => {
            const host = makeFixtureHost('medium');
            const created = await host.saveDraft({ body: 'исходный', parentId: null, anchor: null });
            const original = host.updateDraft.bind(host);
            const applied: string[] = [];
            let releaseFirst!: () => void;
            const firstGate = new Promise<void>((resolve) => {
                releaseFirst = resolve;
            });
            host.updateDraft = async (commentId, body) => {
                applied.push(body);
                if (body === 'старый текст') {
                    await firstGate;
                }
                await original(commentId, body);
            };
            const server = await start(FIXTURE_PR, host);

            const first = postJson(
                server.port,
                UI_ENDPOINTS.reviewUpdateDraft,
                { commentId: created.id, body: 'старый текст', clientKey: 'ck-order-1' },
                server.token,
            );
            await expect.poll(() => applied).toEqual(['старый текст']);
            const second = postJson(
                server.port,
                UI_ENDPOINTS.reviewUpdateDraft,
                { commentId: created.id, body: 'новый текст', clientKey: 'ck-order-2' },
                server.token,
            );
            await new Promise((resolve) => setTimeout(resolve, 20));
            expect(applied).toEqual(['старый текст']);

            releaseFirst();
            expect((await first).status).toBe(200);
            expect((await second).status).toBe(200);
            expect(applied).toEqual(['старый текст', 'новый текст']);
        });

        it('неопределённый ответ delete считается успехом, если драфт уже исчез', async () => {
            const host = makeFixtureHost('medium');
            const created = await host.saveDraft({ body: 'удалить', parentId: null, anchor: null });
            const original = host.deleteDraft.bind(host);
            host.deleteDraft = async (commentId) => {
                await original(commentId);
                throw new Error('ответ потерян');
            };
            const server = await start(FIXTURE_PR, host);

            const response = await postJson(
                server.port,
                UI_ENDPOINTS.reviewDeleteDraft,
                { commentId: created.id },
                server.token,
            );

            expect(response.status).toBe(200);
            expect(uiReviewWriteAckSchema.parse(await response.json())).toEqual({ acknowledged: true });
        });

        it('resolve зовёт setThreadResolved', async () => {
            const host = makeFixtureHost('medium');
            const resolve = vi.spyOn(host, 'setThreadResolved');
            const target = (await host.getThreads()).find((thread) => !thread.resolved);
            if (target === undefined) {
                throw new Error('в фикстуре нет открытого треда');
            }
            const server = await start(FIXTURE_PR, host);

            const response = await postJson(
                server.port,
                UI_ENDPOINTS.reviewThreadResolved,
                { threadId: target.id, resolved: true },
                server.token,
            );

            expect(uiReviewWriteAckSchema.parse(await response.json())).toEqual({ acknowledged: true });
            expect(resolve).toHaveBeenCalledWith(target.id, true);
        });

        it('resolve комментария зовёт setCommentResolved', async () => {
            const host = makeFixtureHost('medium');
            const target = await host.saveDraft({ body: 'вопрос', parentId: null, anchor: null, issue: true });
            const resolve = vi.spyOn(host, 'setCommentResolved');
            const server = await start(FIXTURE_PR, host);

            const response = await postJson(
                server.port,
                UI_ENDPOINTS.reviewCommentResolved,
                { commentId: target.id, resolved: true },
                server.token,
            );

            expect(uiReviewWriteAckSchema.parse(await response.json())).toEqual({ acknowledged: true });
            expect(resolve).toHaveBeenCalledWith(target.id, true);
            const thread = (await host.getThreads()).find((candidate) => candidate.id === target.id);
            expect(thread?.root.resolved).toBe(true);
            expect(thread?.resolved).toBe(true);
        });

        it('правка и удаление опубликованного доходят до хоста', async () => {
            const host = makeFixtureHost('medium');
            const server = await start(FIXTURE_PR, host);
            const created = await host.saveDraft({ body: 'опубликую', parentId: null, anchor: null });
            await host.publishBatch('ship');

            const updated = await postJson(
                server.port,
                UI_ENDPOINTS.reviewUpdateComment,
                { commentId: created.id, body: 'опубликовал и переписал' },
                server.token,
            );
            expect(uiReviewWriteAckSchema.parse(await updated.json())).toEqual({ acknowledged: true });
            expect((await host.getThreads()).find((thread) => thread.id === created.id)?.root.body).toBe(
                'опубликовал и переписал',
            );

            const deleted = await postJson(
                server.port,
                UI_ENDPOINTS.reviewDeleteComment,
                { commentId: created.id },
                server.token,
            );
            expect(uiReviewWriteAckSchema.parse(await deleted.json())).toEqual({ acknowledged: true });
            expect((await host.getThreads()).some((thread) => thread.id === created.id)).toBe(false);
        });

        it('хост без возможности отвечает понятной ошибкой, а не падением', async () => {
            // `edge` не резолвит по комментарию; правку опубликованного объявляют все фикстуры,
            // поэтому хост без неё собирается здесь снятием самих методов.
            const host = makeFixtureHost('edge');
            delete host.updateComment;
            delete host.deleteComment;
            const server = await start(FIXTURE_PR, host);

            const resolved = await postJson(
                server.port,
                UI_ENDPOINTS.reviewCommentResolved,
                { commentId: '1', resolved: true },
                server.token,
            );
            const updated = await postJson(
                server.port,
                UI_ENDPOINTS.reviewUpdateComment,
                { commentId: '1', body: 'правка' },
                server.token,
            );
            const deleted = await postJson(
                server.port,
                UI_ENDPOINTS.reviewDeleteComment,
                { commentId: '1' },
                server.token,
            );

            for (const response of [resolved, updated, deleted]) {
                expect(response.status).toBe(400);
                expect(rpcErrorSchema.parse(await response.json()).error.code).toBe('bad_request');
            }
        });

        it('resolve и undo одного треда доходят до хоста по порядку', async () => {
            const host = makeFixtureHost('medium');
            const target = (await host.getThreads()).find((thread) => !thread.resolved);
            if (target === undefined) {
                throw new Error('в фикстуре нет открытого треда');
            }
            const original = host.setThreadResolved.bind(host);
            const applied: boolean[] = [];
            let releaseFirst!: () => void;
            const firstGate = new Promise<void>((resolve) => {
                releaseFirst = resolve;
            });
            host.setThreadResolved = async (threadId, resolved) => {
                applied.push(resolved);
                if (resolved) {
                    await firstGate;
                }
                await original(threadId, resolved);
            };
            const server = await start(FIXTURE_PR, host);

            const first = postJson(
                server.port,
                UI_ENDPOINTS.reviewThreadResolved,
                { threadId: target.id, resolved: true },
                server.token,
            );
            await expect.poll(() => applied).toEqual([true]);
            const second = postJson(
                server.port,
                UI_ENDPOINTS.reviewThreadResolved,
                { threadId: target.id, resolved: false },
                server.token,
            );
            await new Promise((resolve) => setTimeout(resolve, 20));
            expect(applied).toEqual([true]);

            releaseFirst();
            expect((await first).status).toBe(200);
            expect((await second).status).toBe(200);
            expect(applied).toEqual([true, false]);
            expect((await host.getThreads()).find((thread) => thread.id === target.id)?.resolved).toBe(false);
        });

        it('без хоста write-ручка отвечает no_review_host', async () => {
            const server = await start(UNKNOWN_PR);

            const response = await postJson(
                server.port,
                UI_ENDPOINTS.reviewSaveDraft,
                { draft: { body: 'некуда сохранять', parentId: null, anchor: null }, clientKey: 'ck-none' },
                server.token,
            );

            expect(response.status).toBe(404);
            expect(rpcErrorSchema.parse(await response.json()).error.code).toBe('no_review_host');
        });

        // Провал шага «сервер → хост» больше не ошибка ручки: текст ложится в буфер.
        it('отказ хоста на записи черновика возвращает buffered, а не ошибку', async () => {
            const host = makeFixtureHost('medium');
            host.saveDraft = () => Promise.reject(new Error('черновики временно недоступны'));
            const server = await start(FIXTURE_PR, host);

            const response = await postJson(
                server.port,
                UI_ENDPOINTS.reviewSaveDraft,
                { draft: { body: 'не сохранится', parentId: null, anchor: null }, clientKey: 'ck-fail' },
                server.token,
            );

            expect(response.status).toBe(200);
            const body = uiSaveDraftResponseSchema.parse(await response.json());
            expect(body.outcome).toBe('buffered');
            if (body.outcome !== 'buffered') {
                throw new Error('запись обязана была уйти в буфер');
            }
            expect(body.entry).toMatchObject({
                id: 'ck-fail',
                commentId: null,
                state: 'failed',
                attempts: 1,
            });
            expect(body.entry.error).toContain('черновики временно недоступны');

            const buffer = uiDraftBufferResponseSchema.parse(
                await (await get(server.port, UI_ENDPOINTS.reviewDraftBuffer, server.token)).json(),
            );
            expect(buffer.entries.map((entry) => entry.id)).toEqual(['ck-fail']);
        });

        it('повтор довозит буферную запись, а сброс её удаляет', async () => {
            const host = makeFixtureHost('medium', { failDraftWrites: true });
            const server = await start(FIXTURE_PR, host);
            await postJson(
                server.port,
                UI_ENDPOINTS.reviewSaveDraft,
                { draft: { body: 'довезём позже', parentId: null, anchor: null }, clientKey: 'ck-retry' },
                server.token,
            );
            await postJson(
                server.port,
                UI_ENDPOINTS.reviewSaveDraft,
                { draft: { body: 'а этот сбросим', parentId: null, anchor: null }, clientKey: 'ck-discard' },
                server.token,
            );

            host.setFailDraftWrites(false);
            const afterRetry = uiDraftBufferResponseSchema.parse(
                await (
                    await postJson(
                        server.port,
                        UI_ENDPOINTS.reviewDraftBufferRetry,
                        { id: 'ck-retry' },
                        server.token,
                    )
                ).json(),
            );
            expect(afterRetry.entries.map((entry) => entry.id)).toEqual(['ck-discard']);
            const threads = uiReviewThreadsResponseSchema.parse(
                await (await get(server.port, UI_ENDPOINTS.reviewThreads, server.token)).json(),
            );
            expect(threads.threads.some((thread) => thread.root.body === 'довезём позже')).toBe(true);

            const afterDiscard = uiDraftBufferResponseSchema.parse(
                await (
                    await postJson(
                        server.port,
                        UI_ENDPOINTS.reviewDraftBufferDiscard,
                        { id: 'ck-discard' },
                        server.token,
                    )
                ).json(),
            );
            expect(afterDiscard.entries).toEqual([]);
        });

        it('успешная запись сразу двигает ревизию review feed', async () => {
            const host = makeFixtureHost('medium');
            const server = await start(FIXTURE_PR, host);
            const stream = await openEvents(server);
            expect((await stream.next()).event).toBe(UI_STATE_EVENT);
            await nextReview(stream);
            const started = await nextReview(stream);

            await postJson(
                server.port,
                UI_ENDPOINTS.reviewSaveDraft,
                { draft: { body: 'локальный бамп', parentId: null, anchor: null }, clientKey: 'ck-bump' },
                server.token,
            );

            expect((await nextReview(stream)).threadsRevision).toBeGreaterThan(started.threadsRevision);
        });
    });

    describe('публикация ревью', () => {
        it('публикует пакет, применяет вердикт и возвращает итог хоста', async () => {
            const host = makeFixtureHost('medium');
            const draft = await host.saveDraft({ body: 'готово к публикации', parentId: null, anchor: null });
            const server = await start(FIXTURE_PR, host);

            const response = await postJson(
                server.port,
                UI_ENDPOINTS.reviewPublish,
                { verdict: 'ship' },
                server.token,
            );

            expect(response.status).toBe(200);
            expect(uiPublishResponseSchema.parse(await response.json()).result).toEqual({
                publishedCommentIds: [draft.id],
                failed: [],
                verdictApplied: true,
            });
            expect(host.appliedVerdict()).toBe('ship');
        });

        it('свежий статус PR уезжает снапшотом состояния', async () => {
            const server = await start(FIXTURE_PR);
            const stream = await openEvents(server);
            await stateWithPr(server);
            // Первый снапшот канала мог опередить загрузку меты — ждём тот, где она уже есть.
            for (;;) {
                const state = uiStateSchema.parse(JSON.parse((await nextNamed(stream, UI_STATE_EVENT)).data));
                if (state.pr !== null) {
                    expect(state.pr.statusLabel).toBe('review_in_progress');
                    break;
                }
            }

            await postJson(server.port, UI_ENDPOINTS.reviewPublish, { verdict: 'ship' }, server.token);

            // Ручка публикации не ждёт перечитывания меты: свежий статус догоняет отдельным снапшотом.
            for (;;) {
                const pushed = uiStateSchema.parse(JSON.parse((await nextNamed(stream, UI_STATE_EVENT)).data));
                if (pushed.pr?.statusLabel === 'shipped') {
                    break;
                }
            }
        });

        it('частичный провал возвращает несдавшиеся комментарии и не применяет вердикт', async () => {
            const host = makeFixtureHost('medium', { failPublishFor: ['-70001'] });
            const failedDraft = await host.saveDraft({ body: 'этот черновик упадёт', parentId: null, anchor: null });
            const publishedDraft = await host.saveDraft({ body: 'этот черновик опубликуется', parentId: null, anchor: null });
            const server = await start(FIXTURE_PR, host);
            const stream = await openEvents(server);
            expect((await stream.next()).event).toBe(UI_STATE_EVENT);
            await nextReview(stream);
            const started = await nextReview(stream);

            const response = await postJson(
                server.port,
                UI_ENDPOINTS.reviewPublish,
                { verdict: 'request_changes' },
                server.token,
            );

            expect(response.status).toBe(200);
            expect(uiPublishResponseSchema.parse(await response.json()).result).toEqual({
                publishedCommentIds: [publishedDraft.id],
                failed: [
                    {
                        commentId: failedDraft.id,
                        message: 'фикстура: публикация этого комментария настроена падать',
                    },
                ],
                verdictApplied: false,
            });
            expect(host.appliedVerdict()).toBeNull();
            expect((await nextReview(stream)).threadsRevision).toBeGreaterThan(started.threadsRevision);
        });

        it('без хоста отвечает no_review_host', async () => {
            const server = await start(UNKNOWN_PR);

            const response = await postJson(
                server.port,
                UI_ENDPOINTS.reviewPublish,
                { verdict: 'ship' },
                server.token,
            );

            expect(response.status).toBe(404);
            expect(rpcErrorSchema.parse(await response.json()).error.code).toBe('no_review_host');
        });

        it('отказ publishBatch доезжает как host_unavailable', async () => {
            const host = makeFixtureHost('medium');
            host.publishBatch = () => Promise.reject(new Error('публикация временно недоступна'));
            const server = await start(FIXTURE_PR, host);

            const response = await postJson(
                server.port,
                UI_ENDPOINTS.reviewPublish,
                { verdict: 'sticky_ship' },
                server.token,
            );

            expect(response.status).toBe(502);
            const body = rpcErrorSchema.parse(await response.json());
            expect(body.error.code).toBe('host_unavailable');
            expect(body.error.message).toContain('публикация временно недоступна');
        });
    });

    describe('прогресс чтения', () => {
        async function readProgress(server: SherpaServer): Promise<{
            files: { fileId: string; viewed: boolean | null; seenRanges: unknown[] }[];
            stops: { stopId: string; viewed: boolean }[];
            progressRevision: number;
        }> {
            const response = await get(server.port, UI_ENDPOINTS.reviewProgress, server.token);
            expect(response.status).toBe(200);
            return uiReviewProgressResponseSchema.parse(await response.json());
        }

        async function setViewed(server: SherpaServer, fileId: string, viewed: boolean): Promise<Response> {
            return postJson(server.port, UI_ENDPOINTS.reviewFileViewed, { fileId, viewed }, server.token);
        }

        async function setStopViewed(
            server: SherpaServer,
            stopId: string,
            viewed: boolean,
            ranges: { fileId: string; side: 'old' | 'new'; start: number; end: number }[] = [],
        ): Promise<Response> {
            return postJson(server.port, UI_ENDPOINTS.reviewStopViewed, { stopId, viewed, ranges }, server.token);
        }

        async function setStopFileViewed(
            server: SherpaServer,
            body: {
                stopId: string;
                fileId: string;
                viewed: boolean;
                snapshotId?: string;
                ranges?: { side: 'old' | 'new'; start: number; end: number }[];
            },
        ): Promise<Response> {
            return postJson(
                server.port,
                UI_ENDPOINTS.reviewStopFileViewed,
                { ranges: [], ...body },
                server.token,
            );
        }

        /**
         * Готовый маршрут фикстуры: отметки остановок ключуются снапшотом,
         * поэтому без маршрута их просто некуда записать.
         */
        async function completeRoute(server: SherpaServer): Promise<void> {
            server.workerRegistry.register('w-progress', 'claude-code', 'opus-5');
            await server.route.warmup();
            const raw = mediumRawResults();
            const next = (type: string): number =>
                server.queue.listTasks().find((task) => task.type === type && task.status === 'queued')?.id ?? 0;
            const skeleton = next('route.skeleton');
            server.queue.next('w-progress');
            server.queue.complete('w-progress', skeleton, asRawText(raw.skeleton));
            for (const section of raw.sections) {
                const taskId = next('route.section');
                server.queue.next('w-progress');
                server.queue.complete('w-progress', taskId, asRawText(section));
            }
        }

        async function mirrorViewed(
            server: SherpaServer,
            entries: readonly { fileId: string; viewed: boolean }[],
        ): Promise<Response> {
            return postJson(server.port, UI_ENDPOINTS.reviewViewedMirror, { entries }, server.token);
        }

        it('пустой PR: записей нет, ревизия ноль', async () => {
            const server = await start(FIXTURE_PR);

            expect(await readProgress(server)).toMatchObject({ files: [], stops: [], progressRevision: 0 });
        });

        it('отметка остановки без маршрута не пишется: снапшота, к которому её привязать, нет', async () => {
            const server = await start(UNKNOWN_PR);

            const written = await setStopViewed(server, 's01', true, [
                { fileId: 'file-1', side: 'new', start: 10, end: 14 },
            ]);

            expect(written.status).toBe(200);
            expect(uiSetStopViewedResponseSchema.parse(await written.json()).progressRevision).toBe(0);
            expect(await readProgress(server)).toMatchObject({ files: [], stops: [], progressRevision: 0 });
        });

        it('отметка остановки пишет её диапазоны', async () => {
            const server = await start(FIXTURE_PR);
            await completeRoute(server);

            const written = await setStopViewed(server, 's01', true, [
                { fileId: 'file-1', side: 'new', start: 10, end: 14 },
                { fileId: 'file-2', side: 'old', start: 3, end: 3 },
            ]);

            expect(written.status).toBe(200);
            expect(uiSetStopViewedResponseSchema.parse(await written.json()).progressRevision).toBe(1);
            const progress = await readProgress(server);
            expect(progress.stops).toEqual([{ stopId: 's01', viewed: true }]);
            expect(progress.files).toEqual(
                expect.arrayContaining([
                    { fileId: 'file-1', viewed: null, seenRanges: [{ side: 'new', start: 10, end: 14 }] },
                    { fileId: 'file-2', viewed: null, seenRanges: [{ side: 'old', start: 3, end: 3 }] },
                ]),
            );
        });

        it('снятие отметки убирает диапазоны своей остановки и не трогает чужие', async () => {
            const server = await start(FIXTURE_PR);
            await completeRoute(server);
            await setStopViewed(server, 's01', true, [{ fileId: 'file-1', side: 'new', start: 10, end: 14 }]);
            await setStopViewed(server, 's02', true, [{ fileId: 'file-1', side: 'new', start: 40, end: 41 }]);

            // Диапазоны в запросе снятия игнорируются — удаляются сохранённые.
            expect((await setStopViewed(server, 's01', false, [{ fileId: 'file-1', side: 'new', start: 1, end: 2 }])).status).toBe(200);

            const progress = await readProgress(server);
            expect(progress.stops).toEqual([
                { stopId: 's01', viewed: false },
                { stopId: 's02', viewed: true },
            ]);
            expect(progress.files).toEqual([
                { fileId: 'file-1', viewed: null, seenRanges: [{ side: 'new', start: 40, end: 41 }] },
            ]);
        });

        it('отметка остановки переживает перезапуск сервера', async () => {
            const first = await start(FIXTURE_PR);
            await completeRoute(first);
            await setStopViewed(first, 's01', true, [{ fileId: 'file-1', side: 'new', start: 5, end: 9 }]);
            await first.close();
            servers.splice(servers.indexOf(first), 1);

            const restarted = await start(FIXTURE_PR);
            const progress = await readProgress(restarted);

            expect(progress.stops).toEqual([{ stopId: 's01', viewed: true }]);
            expect(progress.files).toEqual([
                { fileId: 'file-1', viewed: null, seenRanges: [{ side: 'new', start: 5, end: 9 }] },
            ]);
        });

        it('повторная отметка остановки тем же набором не двигает ревизию в SSE-канале', async () => {
            const server = await start(FIXTURE_PR);
            await completeRoute(server);
            const stream = await openEvents(server);
            const ranges = [
                { fileId: 'file-1', side: 'new' as const, start: 10, end: 14 },
                { fileId: 'file-2', side: 'old' as const, start: 1, end: 2 },
            ];

            expect((await nextProgress(stream)).progressRevision).toBe(0);

            await setStopViewed(server, 's01', true, ranges);
            expect((await nextProgress(stream)).progressRevision).toBe(1);

            await setStopViewed(server, 's01', true, [...ranges].reverse());
            await expect(nextProgress(stream, 300)).rejects.toThrow(/не дождались/);
        });

        it('отметка файла в остановке пишет диапазоны карточки без пина файла, снятие снимает остановку', async () => {
            const server = await start(FIXTURE_PR);
            await completeRoute(server);
            await setStopViewed(server, 's01', true, [
                { fileId: 'file-1', side: 'new', start: 10, end: 14 },
                { fileId: 'file-2', side: 'new', start: 1, end: 2 },
            ]);

            const marked = await setStopFileViewed(server, {
                stopId: 's02',
                fileId: 'file-1',
                viewed: true,
                ranges: [{ side: 'new', start: 40, end: 41 }],
            });
            expect(marked.status).toBe(200);
            expect(uiSetStopFileViewedResponseSchema.parse(await marked.json()).progressRevision).toBe(2);

            expect((await setStopFileViewed(server, { stopId: 's01', fileId: 'file-1', viewed: false })).status).toBe(200);

            const progress = await readProgress(server);
            expect(progress.stops).toEqual([{ stopId: 's01', viewed: false }]);
            expect(progress.files).toEqual(
                expect.arrayContaining([
                    { fileId: 'file-1', viewed: null, seenRanges: [{ side: 'new', start: 40, end: 41 }] },
                    { fileId: 'file-2', viewed: null, seenRanges: [{ side: 'new', start: 1, end: 2 }] },
                ]),
            );
        });

        it('отметка файла в остановке от прежнего снапшота или без маршрута ничего не пишет', async () => {
            const unrouted = await start(UNKNOWN_PR);
            const orphan = await setStopFileViewed(unrouted, {
                stopId: 's01',
                fileId: 'file-1',
                viewed: true,
                ranges: [{ side: 'new', start: 10, end: 14 }],
            });
            expect(orphan.status).toBe(200);
            expect(uiSetStopFileViewedResponseSchema.parse(await orphan.json()).progressRevision).toBe(0);

            const server = await start(FIXTURE_PR);
            await completeRoute(server);
            const stale = await setStopFileViewed(server, {
                stopId: 's01',
                fileId: 'file-1',
                viewed: true,
                snapshotId: 'прежний-снапшот',
                ranges: [{ side: 'new', start: 10, end: 14 }],
            });

            expect(stale.status).toBe(200);
            expect(uiSetStopFileViewedResponseSchema.parse(await stale.json()).progressRevision).toBe(0);
            expect(await readProgress(server)).toMatchObject({ files: [], stops: [], progressRevision: 0 });
        });

        it('прогресс работает и без ревью-хоста', async () => {
            const server = await start(UNKNOWN_PR);

            const written = await setViewed(server, 'file-1', true);

            expect(written.status).toBe(200);
            expect((await readProgress(server)).files).toEqual([
                { fileId: 'file-1', viewed: true, seenRanges: [] },
            ]);
        });

        it('отметка и её снятие переживают перезапуск сервера', async () => {
            const first = await start(FIXTURE_PR);
            const [file, other] = await fileIds(first);
            if (file === undefined || other === undefined) {
                throw new Error('в фикстурном диффе меньше двух файлов');
            }

            const marked = uiSetFileViewedResponseSchema.parse(await (await setViewed(first, file, true)).json());
            expect(marked.progressRevision).toBe(1);
            // Явное снятие — тоже запись: un-pin generated-дефолта обязан пережить перезагрузку.
            await setViewed(first, other, false);
            await first.close();
            servers.splice(servers.indexOf(first), 1);

            // Тот же каталог стейта и тот же prKey — сервер поднимается над той же БД.
            const restarted = await start(FIXTURE_PR);
            const after = await readProgress(restarted);
            expect(after.files).toEqual(
                expect.arrayContaining([
                    { fileId: file, viewed: true, seenRanges: [] },
                    { fileId: other, viewed: false, seenRanges: [] },
                ]),
            );
            // Ревизия монотонна от старта процесса, а не от содержимого хранилища.
            expect(after.progressRevision).toBe(0);
        });

        it('хост с fileViewedSync получает зеркало отметки', async () => {
            const host = makeFixtureHost('medium');
            const server = await start(FIXTURE_PR, host);
            const file = (await firstFileId(server)) ?? '';

            expect((await setViewed(server, file, true)).status).toBe(200);

            await expect
                .poll(async () => (await host.getDiff()).files.find((candidate) => candidate.fileId === file)?.viewed)
                .toBe(true);
        });

        it('хост без fileViewedSync: запись только локальная', async () => {
            const host = makeFixtureHost('small');
            const server = await start('fixture-small', host);
            const file = (await firstFileId(server)) ?? '';

            expect((await setViewed(server, file, true)).status).toBe(200);

            expect((await readProgress(server)).files).toEqual([{ fileId: file, viewed: true, seenRanges: [] }]);
            expect((await host.getDiff()).files.find((candidate) => candidate.fileId === file)?.viewed).toBeNull();
        });

        it('ручка зеркала отдаёт весь батч хосту и не меняет локальный прогресс', async () => {
            const host = makeFixtureHost('medium');
            const applied: { fileId: string; viewed: boolean }[] = [];
            const original = host.setFileViewed?.bind(host);
            if (original === undefined) {
                throw new Error('фикстурный хост medium обязан уметь fileViewedSync');
            }
            host.setFileViewed = async (fileId, viewed) => {
                await original(fileId, viewed);
                applied.push({ fileId, viewed });
            };
            const server = await start(FIXTURE_PR, host);
            const [first, second] = await fileIds(server);
            if (first === undefined || second === undefined) {
                throw new Error('в фикстурном диффе меньше двух файлов');
            }
            const before = await readProgress(server);
            const entries = [
                { fileId: first, viewed: true },
                { fileId: second, viewed: false },
            ];

            const response = await mirrorViewed(server, entries);

            expect(response.status).toBe(200);
            expect(uiReviewWriteAckSchema.parse(await response.json())).toEqual({ acknowledged: true });
            await expect.poll(() => applied).toEqual(expect.arrayContaining(entries));
            expect(applied).toHaveLength(entries.length);
            expect(await readProgress(server)).toEqual(before);
        });

        it('ручка зеркала без fileViewedSync подтверждает no-op и не меняет прогресс', async () => {
            const host = makeFixtureHost('small');
            expect(host.setFileViewed).toBeUndefined();
            const server = await start('fixture-small', host);
            const file = (await firstFileId(server)) ?? '';
            const before = await readProgress(server);

            const response = await mirrorViewed(server, [{ fileId: file, viewed: true }]);

            expect(response.status).toBe(200);
            expect(uiReviewWriteAckSchema.parse(await response.json())).toEqual({ acknowledged: true });
            expect(await readProgress(server)).toEqual(before);
            expect((await host.getDiff()).files.find((candidate) => candidate.fileId === file)?.viewed).toBeNull();
        });

        it('ручка зеркала без ревью-хоста тоже подтверждает no-op', async () => {
            const server = await start(UNKNOWN_PR);

            const response = await mirrorViewed(server, [{ fileId: 'file-1', viewed: true }]);

            expect(response.status).toBe(200);
            expect(uiReviewWriteAckSchema.parse(await response.json())).toEqual({ acknowledged: true });
            expect(await readProgress(server)).toMatchObject({ files: [], stops: [], progressRevision: 0 });
        });

        it('провал зеркала не откатывает запись и не рвёт ответ', async () => {
            const host = makeFixtureHost('medium');
            const server = await start(FIXTURE_PR, host);
            const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

            try {
                // Файла с таким id в диффе нет — фикстурный хост отвечает отказом.
                const response = await setViewed(server, 'нет-такого-файла', true);

                expect(response.status).toBe(200);
                expect((await readProgress(server)).files).toEqual([
                    { fileId: 'нет-такого-файла', viewed: true, seenRanges: [] },
                ]);
                await expect
                    .poll(() => stderr.mock.calls.map((call) => String(call[0])).join(''))
                    .toContain('хост не принял отметку');
            } finally {
                stderr.mockRestore();
            }
        });

        it('запись двигает ревизию в SSE-канале', async () => {
            // Ключ без хоста: событие прогресса от хоста не зависит, а зеркалить отметку некому.
            const server = await start(UNKNOWN_PR);
            const stream = await openEvents(server);

            expect((await nextProgress(stream)).progressRevision).toBe(0);

            await setViewed(server, 'file-1', true);
            expect((await nextProgress(stream)).progressRevision).toBe(1);

            // Повторная отметка тем же значением ничего не меняет — события нет.
            await setViewed(server, 'file-1', true);
            await expect(nextProgress(stream, 300)).rejects.toThrow(/не дождались/);
        });

        it('две противоположные отметки одного файла зеркалятся по порядку', async () => {
            const host = makeFixtureHost('medium');
            const applied: boolean[] = [];
            const original = host.setFileViewed?.bind(host);
            if (original === undefined) {
                throw new Error('фикстурный хост medium обязан уметь fileViewedSync');
            }
            // Первая отметка долгая: без очереди вторая легла бы в хост раньше неё.
            host.setFileViewed = async (fileId, viewed) => {
                if (viewed) {
                    await new Promise((resolve) => setTimeout(resolve, 50));
                }
                await original(fileId, viewed);
                applied.push(viewed);
            };

            const server = await start(FIXTURE_PR, host);
            const file = (await firstFileId(server)) ?? '';

            await setViewed(server, file, true);
            await setViewed(server, file, false);

            await expect.poll(() => applied).toEqual([true, false]);
            expect((await host.getDiff()).files.find((candidate) => candidate.fileId === file)?.viewed).toBe(false);
        });
    });

    describe('SSE-событие ревью', () => {
        it('новый клиент сразу получает текущую ревизию, мутация тредов её двигает', async () => {
            const host = makeFixtureHost('medium');
            const server = await start(FIXTURE_PR, host);
            const stream = await openEvents(server);

            expect((await stream.next()).event).toBe(UI_STATE_EVENT);
            const first = await nextReview(stream);
            // Подписка на хост поднялась первым клиентом и уже принесла начальный снапшот.
            const started = await nextReview(stream);
            expect(started.threadsRevision).toBeGreaterThan(first.threadsRevision);

            await host.saveDraft({ body: 'черновик из теста', parentId: null, anchor: null });

            const afterDraft = await nextReview(stream);
            expect(afterDraft.threadsRevision).toBeGreaterThan(started.threadsRevision);

            const threads = uiReviewThreadsResponseSchema.parse(
                await (await get(server.port, UI_ENDPOINTS.reviewThreads, server.token)).json(),
            );
            expect(threads.threads.some((thread) => thread.root.body === 'черновик из теста')).toBe(true);
        });

        it('без хоста ревью-событий в канале нет', async () => {
            const server = await start(UNKNOWN_PR);
            const stream = await openEvents(server);

            expect((await stream.next()).event).toBe(UI_STATE_EVENT);
            // Прогресс чтения локальный — его событие в канале есть и без хоста, ревью-события нет.
            await expect(nextReview(stream, 300)).rejects.toThrow(/не дождались/);
        });
    });
});

describe('выбор хоста по ключу PR', () => {
    it('арканумный ключ, фикстурный ключ и всё остальное', () => {
        expect(selectReviewHost('arcanum-15138703')?.name).toBe('arcanum');
        expect(selectReviewHost('fixture-medium')?.name).toBe('fixture');
        expect(selectReviewHost('fixture-edge')?.host).toBeInstanceOf(FixtureHost);

        expect(selectReviewHost('arcanum-не-число')).toBeNull();
        expect(selectReviewHost('arcanum-0042')).toBeNull();
        expect(selectReviewHost('fixture-неизвестная')).toBeNull();
        expect(selectReviewHost('unknown-777')).toBeNull();
    });
});

/** Ближайшее событие с нужным именем: прочие события канала пропускаются, а не ломают ожидание. */
/** Id файлов диффа хоста: они непрозрачные, и в тестах берутся у самого хоста. */
async function fileIds(server: SherpaServer): Promise<string[]> {
    const diff = uiReviewDiffResponseSchema.parse(
        await (await get(server.port, UI_ENDPOINTS.reviewDiff, server.token)).json(),
    );
    return diff.diff.files.map((file) => file.fileId);
}

async function firstFileId(server: SherpaServer): Promise<string | undefined> {
    return (await fileIds(server))[0];
}

/** Мета PR наполняется вне сборки снапшота — до её появления `pr` честно пуст. */
async function stateWithPr(server: SherpaServer): Promise<UiState> {
    const deadline = Date.now() + 2000;
    for (;;) {
        const state = uiStateSchema.parse(
            await (await get(server.port, UI_ENDPOINTS.state, server.token)).json(),
        );
        if (state.pr !== null) {
            return state;
        }
        if (Date.now() > deadline) {
            throw new Error('мета PR не доехала до снапшота состояния');
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
}

async function nextNamed(stream: SseStream, name: string, timeoutMs = 2000): Promise<SseEvent> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const event = await stream.next(Math.max(deadline - Date.now(), 1));
        if (event.event === name) {
            return event;
        }
    }
}

async function nextReview(stream: SseStream, timeoutMs?: number): Promise<{ threadsRevision: number }> {
    return uiReviewEventSchema.parse(JSON.parse((await nextNamed(stream, UI_REVIEW_EVENT, timeoutMs)).data));
}

async function nextProgress(stream: SseStream, timeoutMs?: number): Promise<{ progressRevision: number }> {
    return uiProgressEventSchema.parse(JSON.parse((await nextNamed(stream, UI_PROGRESS_EVENT, timeoutMs)).data));
}

interface SseEvent {
    readonly event: string;
    readonly data: string;
}

interface SseStream {
    readonly next: (timeoutMs?: number) => Promise<SseEvent>;
    readonly close: () => void;
}

/** Минимальный SSE-клиент: `EventSource` в Node нет, а события в тестах читаются по одному. */
async function openSse(url: string): Promise<SseStream> {
    const controller = new AbortController();
    const response = await fetch(url, { signal: controller.signal });
    if (response.status !== 200 || response.body === null) {
        throw new Error(`SSE-канал не открылся: ${String(response.status)}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const ready: SseEvent[] = [];
    let buffer = '';

    return {
        next: async (timeoutMs = 2000) => {
            const deadline = Date.now() + timeoutMs;
            for (;;) {
                const event = ready.shift();
                if (event !== undefined) {
                    return event;
                }
                if (Date.now() > deadline) {
                    throw new Error('не дождались события SSE');
                }

                // Типы стрима из lib.dom и @types/node расходятся — фиксируем форму чанка сами.
                const chunk: { done: boolean; value?: Uint8Array } = await Promise.race([
                    reader.read(),
                    new Promise<{ done: boolean }>((resolve) =>
                        setTimeout(() => {
                            resolve({ done: false });
                        }, Math.max(deadline - Date.now(), 0)),
                    ),
                ]);
                if (chunk.done) {
                    throw new Error('SSE-канал закрылся раньше ожидаемого события');
                }
                buffer += decoder.decode(chunk.value, { stream: true });

                let boundary = buffer.indexOf('\n\n');
                while (boundary !== -1) {
                    ready.push(parseSseEvent(buffer.slice(0, boundary)));
                    buffer = buffer.slice(boundary + 2);
                    boundary = buffer.indexOf('\n\n');
                }
            }
        },
        close: () => {
            controller.abort();
        },
    };
}

function parseSseEvent(raw: string): SseEvent {
    let event = 'message';
    const data: string[] = [];
    for (const line of raw.split('\n')) {
        if (line.startsWith('event: ')) {
            event = line.slice('event: '.length);
        } else if (line.startsWith('data: ')) {
            data.push(line.slice('data: '.length));
        }
    }
    return { event, data: data.join('\n') };
}

/**
 * Тип картинки определяется по содержимому, а не по расширению: байты уезжают в браузер, и
 * `nosniff` не даст ему исправить наш промах.
 */
describe('sniffImageMime', () => {
    const cases: [string, number[] | string][] = [
        ['image/png', [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]],
        ['image/jpeg', [0xff, 0xd8, 0xff, 0xe0]],
        ['image/gif', [0x47, 0x49, 0x46, 0x38, 0x39, 0x61]],
        ['image/bmp', [0x42, 0x4d, 0x36, 0x00]],
        ['image/x-icon', [0x00, 0x00, 0x01, 0x00, 0x01]],
        ['image/svg+xml', '<svg xmlns="http://www.w3.org/2000/svg"></svg>'],
        ['image/svg+xml', '﻿<?xml version="1.0"?>\n<!-- рисунок -->\n<svg></svg>'],
        ['application/octet-stream', [0x00, 0x01, 0x02, 0x03]],
        ['application/octet-stream', '<html><body>не картинка</body></html>'],
    ];

    it.each(cases)('%s', (mime, source) => {
        const bytes = typeof source === 'string' ? new TextEncoder().encode(source) : Uint8Array.from(source);
        expect(sniffImageMime(bytes)).toBe(mime);
    });

    it('webp опознаётся по паре RIFF…WEBP, а не по одному RIFF', () => {
        const riff = [0x52, 0x49, 0x46, 0x46, 0x10, 0x00, 0x00, 0x00];

        expect(sniffImageMime(Uint8Array.from([...riff, 0x57, 0x45, 0x42, 0x50]))).toBe('image/webp');
        expect(sniffImageMime(Uint8Array.from([...riff, 0x57, 0x41, 0x56, 0x45]))).toBe('application/octet-stream');
    });
});

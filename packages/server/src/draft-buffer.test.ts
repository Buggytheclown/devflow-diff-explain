import { makeFixtureHost } from '@sherpa/fixtures';
import type { CommentDraft } from '@sherpa/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SherpaDatabase } from './db.js';
import { openDatabase } from './db.js';
import { DraftBufferStore, DraftBufferWriter, retryDelayMs } from './draft-buffer.js';
import { makeTempSherpaDir, removeTempSherpaDir } from './test-support.js';

/**
 * Буфер черновиков: провал записи в хост оставляет текст на сервере, а довозчик
 * повторяет его сам — по таймеру, по кнопке и при следующем старте сервера.
 */

const DRAFT: CommentDraft = { body: 'нужен тест на буфер', parentId: null, anchor: null };

describe('буфер черновиков', () => {
    let sherpaDir: string;
    let db: SherpaDatabase;
    let bumps: number;

    beforeEach(async () => {
        sherpaDir = await makeTempSherpaDir();
        db = openDatabase(`${sherpaDir}/draft-buffer.db`);
        bumps = 0;
    });

    afterEach(async () => {
        db.close();
        await removeTempSherpaDir(sherpaDir);
        vi.useRealTimers();
    });

    function makeWriter(host: ReturnType<typeof makeFixtureHost> | null, store = new DraftBufferStore({ db })) {
        const writer = new DraftBufferWriter({
            host,
            store,
            reviewFeed: {
                bumpLocalWrite: () => {
                    bumps += 1;
                    return bumps;
                },
            },
            log: () => undefined,
        });
        return { writer, store };
    }

    it('успешная запись не оставляет строки в буфере', async () => {
        const { writer, store } = makeWriter(makeFixtureHost('medium'));

        const result = await writer.write({ id: 'ck-1', draft: DRAFT, commentId: null });

        expect(result.outcome).toBe('saved');
        expect(store.list()).toEqual([]);
        expect(bumps).toBe(1);
    });

    it('отказ хоста оставляет запись failed с текстом ошибки и будит вкладки', async () => {
        const host = makeFixtureHost('medium', { failDraftWrites: true });
        const { writer, store } = makeWriter(host);

        const result = await writer.write({ id: 'ck-1', draft: DRAFT, commentId: null });

        expect(result).toMatchObject({ outcome: 'buffered' });
        expect(store.list()).toMatchObject([{ id: 'ck-1', state: 'failed', attempts: 1, commentId: null }]);
        expect(store.get('ck-1')?.error).toContain('отказывается принимать черновики');
        expect(bumps).toBe(1);
    });

    it('повтор по таймеру довозит запись, когда хост ожил', async () => {
        vi.useFakeTimers();
        const host = makeFixtureHost('medium', { failDraftWrites: true });
        const { writer, store } = makeWriter(host);
        await writer.write({ id: 'ck-1', draft: DRAFT, commentId: null });

        host.setFailDraftWrites(false);
        await vi.advanceTimersByTimeAsync(retryDelayMs(1));

        expect(store.list()).toEqual([]);
        expect((await host.getThreads()).some((thread) => thread.root.body === DRAFT.body)).toBe(true);
        writer.close();
    });

    it('пауза перед повтором растёт: 10 с, 30 с, минута и дальше по минуте', () => {
        expect([retryDelayMs(1), retryDelayMs(2), retryDelayMs(3), retryDelayMs(9)]).toEqual([
            10_000, 30_000, 60_000, 60_000,
        ]);
    });

    it('ключ идемпотентности один на все попытки записи', async () => {
        const host = makeFixtureHost('medium', { failDraftWrites: true });
        const { writer, store } = makeWriter(host);
        await writer.write({ id: 'ck-1', draft: DRAFT, commentId: null });
        const key = store.idempotencyKeyOf('ck-1');

        await writer.retry('ck-1');
        expect(store.idempotencyKeyOf('ck-1')).toBe(key);

        const keys: (string | undefined)[] = [];
        host.setFailDraftWrites(false);
        const original = host.saveDraft.bind(host);
        host.saveDraft = (draft, options) => {
            keys.push(options?.idempotencyKey);
            return original(draft, options);
        };
        await writer.retry('ck-1');

        expect(keys).toEqual([key]);
        expect(store.list()).toEqual([]);
    });

    it('повтор по кнопке довозит запись прямо сейчас', async () => {
        const host = makeFixtureHost('medium', { failDraftWrites: true });
        const { writer, store } = makeWriter(host);
        await writer.write({ id: 'ck-1', draft: DRAFT, commentId: null });

        host.setFailDraftWrites(false);
        await writer.retry('ck-1');

        expect(store.list()).toEqual([]);
        writer.close();
    });

    it('сброс удаляет запись, не трогая хост', async () => {
        const host = makeFixtureHost('medium', { failDraftWrites: true });
        const { writer, store } = makeWriter(host);
        await writer.write({ id: 'ck-1', draft: DRAFT, commentId: null });

        await writer.discard('ck-1');

        expect(store.list()).toEqual([]);
        host.setFailDraftWrites(false);
        expect((await host.getThreads()).some((thread) => thread.root.body === DRAFT.body)).toBe(false);
    });

    // Сброс идёт той же очередью, что и попытки: черновик, созданный уже улетевшим вызовом,
    // не должен пережить отказ ревьюера и уехать при шипе.
    it('сброс во время летящей записи убирает созданный черновик', async () => {
        const host = makeFixtureHost('medium');
        const { writer, store } = makeWriter(host);
        const saveDraft = host.saveDraft.bind(host);
        let release = (): void => undefined;
        const inFlight = new Promise<void>((resolve) => {
            release = resolve;
        });
        host.saveDraft = async (draft, options) => {
            await inFlight;
            return saveDraft(draft, options);
        };

        const write = writer.write({ id: 'ck-1', draft: DRAFT, commentId: null });
        const discard = writer.discard('ck-1');
        release();
        await write;
        await discard;

        expect(store.list()).toEqual([]);
        expect((await host.getThreads()).some((thread) => thread.root.body === DRAFT.body)).toBe(false);
    });

    // Композер держит `clientKey`, пока не узнает об успехе, а узнать о довозе по таймеру он может
    // уже после того, как ревьюер дописал текст. Второй записи на хосте от этого быть не должно.
    it('запись тем же ключом после довоза правит созданный черновик, а не создаёт второй', async () => {
        const host = makeFixtureHost('medium');
        const { writer, store } = makeWriter(host);

        const first = await writer.write({ id: 'ck-1', draft: DRAFT, commentId: null });
        const second = await writer.write({
            id: 'ck-1',
            draft: { ...DRAFT, body: 'дописал ещё абзац' },
            commentId: null,
        });

        const created = first.outcome === 'saved' ? first.comment : null;
        expect(created).not.toBeNull();
        expect(second.outcome === 'saved' ? second.comment?.id : null).toBe(created?.id);
        expect(store.list()).toEqual([]);
        const mine = (await host.getThreads()).filter(
            (thread) => thread.root.body === DRAFT.body || thread.root.body === 'дописал ещё абзац',
        );
        expect(mine.map((thread) => thread.root.body)).toEqual(['дописал ещё абзац']);
    });

    // То же, но запись догоняет ещё летящее создание: адресат у неё выясняется в очереди, а не
    // при постановке в неё, иначе она ушла бы в хост вторым созданием.
    it('запись, догнавшая летящее создание, правит его, а не создаёт второй черновик', async () => {
        const host = makeFixtureHost('medium');
        const { writer, store } = makeWriter(host);
        const saveDraft = host.saveDraft.bind(host);
        let release = (): void => undefined;
        const inFlight = new Promise<void>((resolve) => {
            release = resolve;
        });
        host.saveDraft = async (draft, options) => {
            await inFlight;
            return saveDraft(draft, options);
        };

        const creating = writer.write({ id: 'ck-1', draft: DRAFT, commentId: null });
        const editing = writer.write({
            id: 'ck-1',
            draft: { ...DRAFT, body: 'дописал ещё абзац' },
            commentId: null,
        });
        release();
        const created = await creating;
        const edited = await editing;

        expect(created.outcome === 'saved' ? created.comment?.id : null).toBeDefined();
        expect(edited.outcome === 'saved' ? edited.comment?.id : null).toBe(
            created.outcome === 'saved' ? created.comment?.id : null,
        );
        expect(store.list()).toEqual([]);
        const mine = (await host.getThreads()).filter(
            (thread) => thread.root.body === DRAFT.body || thread.root.body === 'дописал ещё абзац',
        );
        expect(mine.map((thread) => thread.root.body)).toEqual(['дописал ещё абзац']);
    });

    // Ответ хоста на создание может потеряться после того, как хост его принял. Повтор с тем же
    // ключом идемпотентности вернёт прежний комментарий — со старым телом, если ревьюер успел
    // дописать текст. Отчитаться об успехе таким телом значит потерять текст молча.
    it('повтор после потерянного ответа догоняет черновик новым текстом', async () => {
        const host = makeFixtureHost('medium');
        const { writer, store } = makeWriter(host);
        const saveDraft = host.saveDraft.bind(host);
        const byKey = new Map<string, Awaited<ReturnType<typeof saveDraft>>>();
        let dropResponse = true;
        // Хост с ключом идемпотентности: дубля не создаёт, но и текст повтора не применяет.
        host.saveDraft = async (draft, options) => {
            const known = byKey.get(options?.idempotencyKey ?? '');
            if (known !== undefined) {
                return known;
            }
            const created = await saveDraft(draft, options);
            byKey.set(options?.idempotencyKey ?? '', created);
            if (dropResponse) {
                dropResponse = false;
                throw new Error('ответ хоста потерялся');
            }
            return created;
        };

        const lost = await writer.write({ id: 'ck-1', draft: DRAFT, commentId: null });
        expect(lost.outcome).toBe('buffered');

        const saved = await writer.write({
            id: 'ck-1',
            draft: { ...DRAFT, body: 'дописал ещё абзац' },
            commentId: null,
        });

        expect(saved).toMatchObject({ outcome: 'saved', comment: { body: 'дописал ещё абзац' } });
        expect(store.list()).toEqual([]);
        const mine = (await host.getThreads()).filter(
            (thread) => thread.root.body === DRAFT.body || thread.root.body === 'дописал ещё абзац',
        );
        expect(mine.map((thread) => thread.root.body)).toEqual(['дописал ещё абзац']);
        writer.close();
    });

    // Черновика больше нет — довозить его правку некуда; иначе запись висела бы вечно и не
    // давала отшипить PR, а сбросить её было бы нечем (композера у неё уже не будет).
    it('удаление черновика снимает его недоставленную правку из буфера', async () => {
        const host = makeFixtureHost('medium');
        const { writer, store } = makeWriter(host);
        const created = await host.saveDraft({ body: 'первая версия', parentId: null, anchor: null });

        host.setFailDraftWrites(true);
        await writer.write({
            id: 'ck-edit',
            draft: { body: 'вторая версия', parentId: null, anchor: null },
            commentId: created.id,
        });
        expect(store.list()).toHaveLength(1);

        host.setFailDraftWrites(false);
        await host.deleteDraft(created.id);
        writer.forgetComment(created.id);

        expect(store.list()).toEqual([]);
    });

    // `issue: undefined` в правке значит «не менять», а не «забыть про переключение, которое
    // мы ещё не довезли».
    it('правка без названного issue сохраняет недовезённое переключение', async () => {
        const host = makeFixtureHost('medium', { failDraftWrites: true });
        const { writer, store } = makeWriter(host);
        await writer.write({
            id: 'ck-edit',
            draft: { body: 'вторая версия', parentId: null, anchor: null, issue: false },
            commentId: 'comment-42',
        });

        await writer.write({
            id: 'ck-edit',
            draft: { body: 'третья версия', parentId: null, anchor: null },
            commentId: 'comment-42',
        });

        expect(store.get('ck-edit')?.draft).toMatchObject({ body: 'третья версия', issue: false });
    });

    it('правка черновика, который ещё не создан, остаётся созданием в той же записи', async () => {
        const host = makeFixtureHost('medium', { failDraftWrites: true });
        const { writer, store } = makeWriter(host);
        await writer.write({ id: 'ck-1', draft: DRAFT, commentId: null });

        await writer.write({
            id: 'ck-1',
            draft: { ...DRAFT, body: 'дописал ещё абзац' },
            commentId: 'comment-42',
        });

        expect(store.list()).toMatchObject([{ id: 'ck-1', commentId: null }]);
        expect(store.get('ck-1')?.draft.body).toBe('дописал ещё абзац');
    });

    it('новый writer над той же БД подхватывает записи после перезапуска', async () => {
        vi.useFakeTimers();
        const host = makeFixtureHost('medium', { failDraftWrites: true });
        const first = makeWriter(host);
        await first.writer.write({ id: 'ck-1', draft: DRAFT, commentId: null });
        first.writer.close();

        host.setFailDraftWrites(false);
        const second = makeWriter(host, new DraftBufferStore({ db }));
        second.writer.start();
        await vi.advanceTimersByTimeAsync(retryDelayMs(1));

        expect(second.store.list()).toEqual([]);
        expect((await host.getThreads()).some((thread) => thread.root.body === DRAFT.body)).toBe(true);
        second.writer.close();
    });

    it('правка существующего черновика уходит в хост как updateDraft', async () => {
        const host = makeFixtureHost('medium');
        const { writer, store } = makeWriter(host);
        const created = await host.saveDraft({ body: 'первая версия', parentId: null, anchor: null });

        const result = await writer.write({
            id: 'ck-edit',
            draft: { body: 'вторая версия', parentId: null, anchor: null },
            commentId: created.id,
        });

        expect(result).toEqual({ outcome: 'saved', comment: null });
        expect(store.list()).toEqual([]);
        const threads = await host.getThreads();
        expect(threads.find((thread) => thread.root.id === created.id)?.root.body).toBe('вторая версия');
    });
});

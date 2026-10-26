import type { Comment, DraftBufferEntry, Thread, UiSaveDraftResponse } from '@sherpa/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ComposerTransport } from './composer.js';
import { closePublishedComposers, composerControllerFor, createComposerController } from './composer.js';
import { openNewComposer, openReply } from './thread-list.tsx';
import { createThreadStore } from './store.js';

/** Ответы ручек черновиков: хост принял запись. */
const SAVED = { outcome: 'saved' } as const;
function saved(comment: Comment): UiSaveDraftResponse {
    return { outcome: 'saved', comment };
}

/** Ответ «хост не принял, текст в буфере сервера». */
function bufferedEntry(id: string, body: string, error = 'хост прилёг'): DraftBufferEntry {
    return {
        id,
        draft: {
            body,
            parentId: null,
            anchor: { fileId: 'f1', path: 'app.ts', position: { side: 'new', line: 10, size: 1 } },
        },
        commentId: null,
        state: 'failed',
        error,
        attempts: 1,
        createdAt: '2026-09-03T10:00:00.000Z',
        updatedAt: '2026-09-03T10:00:00.000Z',
    };
}

const CREATED: Comment = {
    id: 'draft-1',
    author: { login: 'alice', displayName: 'Alice Ingram', bot: false, avatarUrl: null },
    body: 'первый',
    draft: true,
    issue: null,
    resolved: null,
    createdAt: '2026-08-24T10:00:00.000Z',
    editedAt: null,
    replies: [],
};

const THREAD: Thread = {
    id: 'thread-1',
    anchor: null,
    resolved: false,
    resolvedBy: null,
    outdated: false,
    pinnedTo: null,
    root: { ...CREATED, id: 'root-1', draft: false },
};

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((onResolve, onReject) => {
        resolve = onResolve;
        reject = onReject;
    });
    return { promise, resolve, reject };
}

function setup() {
    const store = createThreadStore([], new Set(['f1']));
    store.openComposer({
        key: 'new:f1:new:10',
        threadId: null,
        parentId: null,
        anchor: { fileId: 'f1', path: 'app.ts', position: { side: 'new', line: 10, size: 1 } },
        text: '',
        commentId: null,
        status: 'idle',
        slow: false,
        confirmDiscard: false,
        resolvedAtOpen: false,
    });
    const save = vi.fn<ComposerTransport['save']>(() => Promise.resolve(saved(CREATED)));
    const update = vi.fn<ComposerTransport['update']>(() => Promise.resolve(SAVED));
    const remove = vi.fn(() => Promise.resolve());
    const discardBuffered = vi.fn(() => Promise.resolve());
    const controller = createComposerController({
        store,
        key: 'new:f1:new:10',
        transport: { save, update, delete: remove, discardBuffered },
    });
    return { store, controller, save, update, remove, discardBuffered };
}

const EDIT_KEY = 'edit:draft-1';

/** Запись буфера на правку своего черновика. */
function editEntry(id: string, body: string): DraftBufferEntry {
    return { ...bufferedEntry(id, body), commentId: 'draft-1', draft: { body, parentId: null, anchor: null } };
}

/** Композер правки своего черновика: как его открывает `openDraftEditor`. */
function setupEditComposer(issue?: boolean) {
    const store = createThreadStore([], new Set(['f1']));
    store.openComposer({
        key: EDIT_KEY,
        threadId: 'thread-1',
        parentId: null,
        anchor: null,
        ...(issue === undefined ? {} : { issue }),
        text: 'на хосте лежит это',
        originalText: 'на хосте лежит это',
        commentId: 'draft-1',
        status: 'saved',
        slow: false,
        confirmDiscard: false,
        resolvedAtOpen: false,
    });
    const save = vi.fn<ComposerTransport['save']>(() => Promise.resolve(saved(CREATED)));
    const update = vi.fn<ComposerTransport['update']>(() => Promise.resolve(SAVED));
    const remove = vi.fn(() => Promise.resolve());
    const discardBuffered = vi.fn(() => Promise.resolve());
    const controller = createComposerController({
        store,
        key: EDIT_KEY,
        transport: { save, update, delete: remove, discardBuffered },
    });
    return { store, controller, save, update, remove, discardBuffered };
}

function setupIssueComposer(kind: 'new' | 'reply') {
    const store = createThreadStore(kind === 'reply' ? [THREAD] : [], new Set(['f1']));
    const key = kind === 'new' ? 'new:f1:new:10' : `reply:${THREAD.id}`;
    if (kind === 'new') {
        openNewComposer(
            store,
            key,
            { fileId: 'f1', path: 'app.ts', position: { side: 'new', line: 10, size: 1 } },
            true,
        );
    } else {
        openReply(store, THREAD, true, null);
    }
    const save = vi.fn(() => Promise.resolve(saved(CREATED)));
    const update = vi.fn(() => Promise.resolve(SAVED));
    const remove = vi.fn(() => Promise.resolve());
    const controller = createComposerController({ store, key, transport: { save, update, delete: remove } });
    return { store, controller, save, update };
}

afterEach(() => {
    vi.useRealTimers();
});

describe('машина композера', () => {
    it('новый тред по умолчанию сохраняется с issue: true', async () => {
        const { controller, save } = setupIssueComposer('new');

        controller.input('первый');
        await controller.saveNow();

        expect(save).toHaveBeenCalledWith(
            {
                body: 'первый',
                parentId: null,
                anchor: { fileId: 'f1', path: 'app.ts', position: { side: 'new', line: 10, size: 1 } },
                issue: true,
            },
            expect.any(String),
        );
    });

    it('выключенный issue до первого сохранения уходит в save', async () => {
        const { controller, save } = setupIssueComposer('new');

        controller.setIssue(false);
        controller.input('не требует ответа');
        await controller.saveNow();

        expect(save).toHaveBeenCalledWith(expect.objectContaining({ issue: false }), expect.any(String));
    });

    it('смена issue после первого сохранения уходит в update при следующем сохранении', async () => {
        const { controller, update } = setupIssueComposer('new');
        controller.input('первый');
        await controller.saveNow();

        controller.setIssue(false);
        await controller.saveNow();

        expect(update).toHaveBeenCalledWith('draft-1', 'первый', false, expect.any(String));
    });

    it('сохранение текста после create не отправляет issue повторно', async () => {
        const { controller, update } = setupIssueComposer('new');
        controller.input('первый');
        await controller.saveNow();

        controller.input('второй');
        await controller.saveNow();

        expect(update.mock.calls.map((call) => call.slice(0, 2))).toEqual([['draft-1', 'второй']]);
    });

    it('сохранение текста после смены issue не отправляет его повторно', async () => {
        const { controller, update } = setupIssueComposer('new');
        controller.input('первый');
        await controller.saveNow();
        controller.setIssue(false);
        await controller.saveNow();

        controller.input('второй');
        await controller.saveNow();

        expect(update.mock.calls.map((call) => call.slice(0, 3))).toEqual([
            ['draft-1', 'первый', false],
            ['draft-1', 'второй', undefined],
        ]);
    });

    it('возврат issue к записанному значению не отправляет его снова', async () => {
        const { controller, update } = setupIssueComposer('new');
        controller.input('первый');
        await controller.saveNow();

        controller.setIssue(false);
        controller.setIssue(true);
        controller.input('второй');
        await controller.saveNow();

        expect(update.mock.calls.map((call) => call.slice(0, 2))).toEqual([['draft-1', 'второй']]);
    });

    it('ответ по умолчанию сохраняется с issue: true', async () => {
        const { controller, save } = setupIssueComposer('reply');

        controller.input('ответ');
        await controller.saveNow();

        expect(save).toHaveBeenCalledWith(
            { body: 'ответ', parentId: 'root-1', anchor: null, issue: true },
            expect.any(String),
        );
    });

    it('выключенный issue у ответа уходит в save', async () => {
        const { controller, save } = setupIssueComposer('reply');

        controller.setIssue(false);
        controller.input('ответ');
        await controller.saveNow();

        expect(save).toHaveBeenCalledWith(expect.objectContaining({ issue: false }), expect.any(String));
    });

    it('сохраняет только по явному действию: первый раз save, дальше update', async () => {
        vi.useFakeTimers();
        const { controller, save, update } = setup();

        controller.input('первый');
        await vi.advanceTimersByTimeAsync(5000);
        expect(save).not.toHaveBeenCalled();
        await controller.saveNow();
        expect(save).toHaveBeenCalledTimes(1);

        controller.input('второй');
        await vi.advanceTimersByTimeAsync(5000);
        expect(update).not.toHaveBeenCalled();
        await controller.saveNow();
        expect(update).toHaveBeenCalledWith('draft-1', 'второй', undefined, expect.any(String));
    });

    it('Отмена после сохранения закрывает композер и не удаляет Comment', async () => {
        const { store, controller, update, remove } = setup();
        controller.input('текст');
        await controller.saveNow();
        controller.input('изменение');

        controller.escape();
        expect(store.getComposer('new:f1:new:10')?.confirmDiscard).toBe(true);
        await controller.confirmDiscard();

        expect(update).toHaveBeenCalledWith('draft-1', 'текст', undefined, expect.any(String));
        expect(remove).not.toHaveBeenCalled();
        expect(store.getComposer('new:f1:new:10')).toBeNull();
    });

    it('провал сохраняет текст и даёт повторить', async () => {
        const { store, controller, save } = setup();
        save.mockRejectedValueOnce(new Error('нет сети'));
        controller.input('не потерять');

        expect(await controller.saveNow()).toBe(false);
        expect(store.getComposer('new:f1:new:10')).toMatchObject({
            text: 'не потерять',
            status: 'error',
        });
        expect(await controller.retry()).toBe(true);
    });

    // Сервер не ответил — текст остаётся в поле, а повтор уходит тем же `clientKey`, поэтому
    // дубля не будет даже если первый запрос всё-таки дошёл.
    it('провал запроса оставляет текст в поле, повтор идёт с тем же clientKey', async () => {
        const { store, controller, save } = setup();
        save.mockRejectedValueOnce(new Error('сервер не ответил'));
        controller.input('возможно сохранился');
        await controller.saveNow();

        expect(store.getComposer('new:f1:new:10')).toMatchObject({
            text: 'возможно сохранился',
            status: 'error',
        });
        const firstKey = save.mock.calls[0]?.[1];
        expect(firstKey).toEqual(expect.any(String));

        expect(await controller.retry()).toBe(true);
        expect(save.mock.calls[1]?.[1]).toBe(firstKey);
    });

    it('после закрытия новый экземпляр контроллера снова принимает ввод', async () => {
        const { store, controller, save, update, remove } = setup();
        controller.input('первый');
        await controller.saveNow(true);
        expect(store.getComposer('new:f1:new:10')).toBeNull();

        store.openComposer({
            key: 'new:f1:new:10',
            threadId: null,
            parentId: null,
            anchor: { fileId: 'f1', path: 'app.ts', position: { side: 'new', line: 10, size: 1 } },
            text: '',
            commentId: null,
            status: 'idle',
            slow: false,
            confirmDiscard: false,
            resolvedAtOpen: false,
        });
        const reopened = createComposerController({
            store,
            key: 'new:f1:new:10',
            transport: { save, update, delete: remove },
        });
        reopened.input('второй');

        expect(store.getComposer('new:f1:new:10')?.text).toBe('второй');
    });

    it('Esc по стёртому тексту просит подтверждение и возвращает сохранённый текст', async () => {
        const { store, controller, update, remove } = setup();
        controller.input('ой, не то');
        await controller.saveNow();
        controller.input('');

        controller.escape();
        expect(store.getComposer('new:f1:new:10')?.confirmDiscard).toBe(true);
        await controller.confirmDiscard();

        expect(store.getComposer('new:f1:new:10')).toBeNull();
        expect(update).toHaveBeenCalledWith('draft-1', 'ой, не то', undefined, expect.any(String));
        expect(remove).not.toHaveBeenCalled();
    });

    it('ввод во время save остаётся несохранённым до следующего явного действия', async () => {
        const { store, controller, save, update } = setup();
        const pendingSave = deferred<UiSaveDraftResponse>();
        save.mockImplementationOnce(() => pendingSave.promise);
        controller.input('первый');
        const saving = controller.saveNow();

        controller.input('второй');
        pendingSave.resolve(saved(CREATED));
        await saving;

        expect(store.getComposer('new:f1:new:10')).toMatchObject({ text: 'второй', status: 'idle' });
        expect(update).not.toHaveBeenCalled();
        await controller.saveNow();
        expect(update).toHaveBeenCalledWith('draft-1', 'второй', undefined, expect.any(String));
    });

    it('ответ старого save не помечает новый текст сохранённым', async () => {
        const { store, controller, save, update } = setup();
        const pendingSave = deferred<UiSaveDraftResponse>();
        save.mockImplementationOnce(() => pendingSave.promise);
        controller.input('первый');
        const saving = controller.saveNow();

        controller.input('второй');
        pendingSave.resolve(saved(CREATED));
        await saving;

        expect(store.getComposer('new:f1:new:10')).toMatchObject({ text: 'второй', status: 'idle' });
        expect(update).not.toHaveBeenCalled();
    });

    it('ответ старого save не помечает очищенное поле сохранённым', async () => {
        const { store, controller, save, update } = setup();
        const pendingSave = deferred<UiSaveDraftResponse>();
        save.mockImplementationOnce(() => pendingSave.promise);
        controller.input('первый');
        const saving = controller.saveNow();

        controller.input('');
        expect(store.getComposer('new:f1:new:10')).toMatchObject({ text: '', status: 'saving' });
        expect(store.getComposerGuardSnapshot().pending).toBe(true);

        pendingSave.resolve(saved(CREATED));
        await saving;

        expect(store.getComposer('new:f1:new:10')).toMatchObject({
            text: '',
            commentId: 'draft-1',
            status: 'idle',
        });
        expect(store.getComposerGuardSnapshot().pending).toBe(true);
        expect(update).not.toHaveBeenCalled();
    });

    it('один контроллер переживает ремаунт, пока композер открыт', () => {
        const { store, save, update, remove } = setup();
        const transport = { save, update, delete: remove };

        const first = composerControllerFor({ store, key: 'new:f1:new:10', transport });
        const remounted = composerControllerFor({ store, key: 'new:f1:new:10', transport });

        expect(remounted).toBe(first);
    });

    it('после закрытия кэш отдаёт новый контроллер для нового открытия', async () => {
        const { store, save, update, remove } = setup();
        const transport = { save, update, delete: remove };
        const first = composerControllerFor({ store, key: 'new:f1:new:10', transport });
        first.input('закрыть');
        await first.saveNow(true);
        store.openComposer({
            key: 'new:f1:new:10',
            threadId: null,
            parentId: null,
            anchor: { fileId: 'f1', path: 'app.ts', position: { side: 'new', line: 10, size: 1 } },
            text: '',
            commentId: null,
            status: 'idle',
            slow: false,
            confirmDiscard: false,
            resolvedAtOpen: false,
        });

        const reopened = composerControllerFor({ store, key: 'new:f1:new:10', transport });

        expect(reopened).not.toBe(first);
    });

    it('публикация закрывает сохранённый композер и забывает его контроллер', async () => {
        const store = createThreadStore([], new Set(['f1']));
        const key = 'new:f1:new:10';
        store.openComposer({
            key,
            threadId: null,
            parentId: null,
            anchor: { fileId: 'f1', path: 'app.ts', position: { side: 'new', line: 10, size: 1 } },
            text: '',
            commentId: null,
            status: 'idle',
            slow: false,
            confirmDiscard: false,
            resolvedAtOpen: false,
        });
        const transport = {
            save: vi.fn(() => Promise.resolve(saved(CREATED))),
            update: vi.fn(() => Promise.resolve(SAVED)),
            delete: vi.fn(() => Promise.resolve()),
        };
        const first = composerControllerFor({ store, key, transport });
        first.input('опубликовать');
        await first.saveNow();

        closePublishedComposers(store, ['draft-1']);
        expect(store.getComposer(key)).toBeNull();

        store.openComposer({
            key,
            threadId: null,
            parentId: null,
            anchor: { fileId: 'f1', path: 'app.ts', position: { side: 'new', line: 10, size: 1 } },
            text: '',
            commentId: null,
            status: 'idle',
            slow: false,
            confirmDiscard: false,
            resolvedAtOpen: false,
        });
        const reopened = composerControllerFor({ store, key, transport });
        reopened.input('новый текст');

        expect(reopened).not.toBe(first);
        expect(store.getComposer(key)?.text).toBe('новый текст');
    });

    it('закрытие во время первого save удаляет полученный id, не добавляя драфт', async () => {
        const { store, controller, save, remove } = setup();
        const pendingSave = deferred<UiSaveDraftResponse>();
        save.mockImplementationOnce(() => pendingSave.promise);
        controller.input('не сохранять');
        const saving = controller.saveNow();
        const discarding = controller.confirmDiscard();

        pendingSave.resolve(saved(CREATED));
        await expect(saving).resolves.toBe(true);
        await expect(discarding).resolves.toBe(true);

        expect(remove).toHaveBeenCalledWith('draft-1');
        expect(store.getSnapshot().threads).toEqual([]);
        expect(store.getComposer('new:f1:new:10')).toBeNull();
    });

    it('saveNow ждёт поставленный в очередь последний текст', async () => {
        const { store, controller, update } = setup();
        controller.input('исходный');
        await controller.saveNow();
        const firstUpdate = deferred<typeof SAVED>();
        const lastUpdate = deferred<typeof SAVED>();
        update.mockImplementationOnce(() => firstUpdate.promise).mockImplementationOnce(() => lastUpdate.promise);

        controller.input('промежуточный');
        void controller.saveNow();
        controller.input('последний');
        let completed = false;
        const savingLast = controller.saveNow(true).then((saved) => {
            completed = true;
            return saved;
        });

        firstUpdate.resolve(SAVED);
        await vi.waitFor(() => {
            expect(update).toHaveBeenLastCalledWith('draft-1', 'последний', undefined, expect.any(String));
        });
        expect(completed).toBe(false);
        expect(store.getComposer('new:f1:new:10')).not.toBeNull();

        lastUpdate.resolve(SAVED);
        await expect(savingLast).resolves.toBe(true);
        expect(store.getComposer('new:f1:new:10')).toBeNull();
    });

    it('restore ждёт активное сохранение и возвращает исходный текст последним update', async () => {
        const { store, controller, update } = setup();
        controller.input('исходный');
        await controller.saveNow();
        const pendingUpdate = deferred<typeof SAVED>();
        update.mockImplementationOnce(() => pendingUpdate.promise);

        controller.input('испорченный');
        void controller.saveNow();
        const restoring = controller.restore('исходный');

        expect(store.getComposer('new:f1:new:10')).toMatchObject({ text: 'испорченный', status: 'saving' });
        pendingUpdate.resolve(SAVED);
        await expect(restoring).resolves.toBe(true);

        expect(update.mock.calls.map((call) => call.slice(0, 2))).toEqual([
            ['draft-1', 'испорченный'],
            ['draft-1', 'исходный'],
        ]);
        expect(store.getSnapshot().threads[0]?.root.body).toBe('исходный');
        expect(store.getComposer('new:f1:new:10')).toBeNull();
    });

    it('провал restore не заменяет набранный текст исходным', async () => {
        const { store, controller, update } = setup();
        controller.input('исходный');
        await controller.saveNow();
        controller.input('не потерять');
        update.mockRejectedValueOnce(new Error('нет сети'));

        await expect(controller.restore('исходный')).resolves.toBe(false);

        expect(store.getComposer('new:f1:new:10')).toMatchObject({ text: 'не потерять', status: 'error' });
        expect(store.getSnapshot().threads[0]?.root.body).toBe(CREATED.body);
    });
});

// Буфер черновиков: хост отказал, сервер текст принял и довезёт сам.
describe('композер и буфер черновиков', () => {
    it('ответ buffered оставляет композер открытым и не заводит черновик в тредах', async () => {
        const { store, controller, save } = setup();
        const entry = bufferedEntry('ck-1', 'подождёт связи');
        save.mockResolvedValueOnce({ outcome: 'buffered', entry });

        controller.input('подождёт связи');
        expect(await controller.saveNow(true)).toBe(false);

        expect(store.getComposer('new:f1:new:10')).toMatchObject({
            text: 'подождёт связи',
            status: 'buffered',
            commentId: null,
            bufferEntry: entry,
        });
        expect(store.getSnapshot().threads).toEqual([]);
    });

    it('буферный композер не держит гард ухода со страницы', async () => {
        const { store, controller, save } = setup();
        save.mockResolvedValueOnce({ outcome: 'buffered', entry: bufferedEntry('ck-1', 'подождёт связи') });

        controller.input('подождёт связи');
        await controller.saveNow();

        expect(store.getComposerGuardSnapshot().pending).toBe(false);
    });

    it('повтор буферной записи уходит тем же clientKey и закрывает композер при успехе', async () => {
        const { store, controller, save } = setup();
        save.mockResolvedValueOnce({ outcome: 'buffered', entry: bufferedEntry('ck-1', 'подождёт связи') });
        controller.input('подождёт связи');
        await controller.saveNow();
        const clientKey = save.mock.calls[0]?.[1];

        expect(await controller.retry()).toBe(true);

        expect(save.mock.calls[1]?.[1]).toBe(clientKey);
        expect(store.getComposer('new:f1:new:10')).toMatchObject({ status: 'saved', commentId: 'draft-1' });
    });

    it('правка буферного текста сохраняет статус и уезжает в ту же запись', async () => {
        const { store, controller, save } = setup();
        save.mockResolvedValueOnce({ outcome: 'buffered', entry: bufferedEntry('ck-1', 'первый вариант') });
        controller.input('первый вариант');
        await controller.saveNow();
        const clientKey = save.mock.calls[0]?.[1];

        controller.input('второй вариант');
        expect(store.getComposer('new:f1:new:10')).toMatchObject({ text: 'второй вариант', status: 'buffered' });

        save.mockResolvedValueOnce({ outcome: 'buffered', entry: bufferedEntry('ck-1', 'второй вариант') });
        await controller.saveNow();
        expect(save.mock.calls[1]).toEqual([expect.objectContaining({ body: 'второй вариант' }), clientKey]);
    });

    it('сброс буферного композера снимает запись на сервере и закрывает поле', async () => {
        const { store, controller, save, remove, discardBuffered } = setup();
        save.mockResolvedValueOnce({ outcome: 'buffered', entry: bufferedEntry('ck-1', 'больше не нужен') });
        controller.input('больше не нужен');
        await controller.saveNow();

        await expect(controller.confirmDiscard()).resolves.toBe(true);

        expect(discardBuffered).toHaveBeenCalledWith('ck-1');
        expect(remove).not.toHaveBeenCalled();
        expect(store.getComposer('new:f1:new:10')).toBeNull();
    });

    // Правка не доехала до хоста — там лежит исходный текст. «Сбросить» обязано снять запись,
    // а не удалить сам черновик: удалять его ревьюер не просил.
    it('сброс буферной правки снимает запись, а не удаляет черновик на хосте', async () => {
        const { store, controller, update, remove, discardBuffered } = setupEditComposer();
        update.mockResolvedValueOnce({ outcome: 'buffered', entry: editEntry('ck-edit', 'правка') });

        controller.input('правка');
        await controller.saveNow();
        expect(store.getComposer(EDIT_KEY)).toMatchObject({ status: 'buffered' });

        await expect(controller.confirmDiscard()).resolves.toBe(true);

        expect(discardBuffered).toHaveBeenCalledWith('ck-edit');
        expect(remove).not.toHaveBeenCalled();
        expect(store.getComposer(EDIT_KEY)).toBeNull();
    });

    // Возврат к исходному тексту при живой записи — тоже снятие записи: писать в лежащий хост
    // то, что там и так лежит, незачем.
    it('откат буферной правки к исходному тексту снимает запись без записи в хост', async () => {
        const { controller, update, discardBuffered } = setupEditComposer();
        update.mockResolvedValueOnce({ outcome: 'buffered', entry: editEntry('ck-edit', 'правка') });
        controller.input('правка');
        await controller.saveNow();
        update.mockClear();

        await expect(controller.restore('на хосте лежит это')).resolves.toBe(true);

        expect(update).not.toHaveBeenCalled();
        expect(discardBuffered).toHaveBeenCalledWith('ck-edit');
    });

    // Issue засекается по факту записи: провал оставляет переключение незаписанным, и повтор
    // обязан послать его снова — иначе на хосте останется старый статус.
    it('issue, не доехавший до хоста, уходит и со следующей попыткой', async () => {
        const { controller, update } = setupEditComposer(true);
        update.mockResolvedValueOnce({ outcome: 'buffered', entry: editEntry('ck-edit', 'правка') });

        controller.setIssue(false);
        controller.input('правка');
        await controller.saveNow();
        expect(update.mock.calls[0]?.[2]).toBe(false);

        await controller.retry();

        expect(update.mock.calls[1]?.[2]).toBe(false);
    });
});

import type { DraftBufferEntry, Thread } from '@sherpa/protocol';
import { describe, expect, it } from 'vitest';

import {
    composerKeyOfBufferEntry,
    restoreBufferedComposers,
    staleBufferedComposers,
    syncBufferedComposers,
} from './draft-buffer.js';
import { createThreadStore } from './store.js';

/** Возврат буфера черновиков в композеры: ключ, якорь, текст, статус. */

function entry(patch: Partial<DraftBufferEntry> & Pick<DraftBufferEntry, 'id'>): DraftBufferEntry {
    return {
        draft: { body: 'текст черновика', parentId: null, anchor: null },
        commentId: null,
        state: 'failed',
        error: 'хост прилёг',
        attempts: 1,
        createdAt: '2026-09-03T10:00:00.000Z',
        updatedAt: '2026-09-03T10:00:00.000Z',
        ...patch,
    };
}

const LINE_ANCHOR = { fileId: 'f1', path: 'app.ts', position: { side: 'new' as const, line: 42, size: 3 } };

const REPLY_THREAD = replyThread();

describe('ключ композера буферной записи', () => {
    it('комментарий к строке едет по ключу своей первой строки', () => {
        expect(
            composerKeyOfBufferEntry(entry({ id: 'ck-1', draft: { body: 'x', parentId: null, anchor: LINE_ANCHOR } }), []),
        ).toBe('new:f1:new:42');
    });

    it('ответ едет по ключу треда, комментарий к PR — по своему', () => {
        expect(
            composerKeyOfBufferEntry(entry({ id: 'ck-2', draft: { body: 'x', parentId: 'root-1', anchor: null } }), [
                REPLY_THREAD,
            ]),
        ).toBe('reply:root-1');
        expect(composerKeyOfBufferEntry(entry({ id: 'ck-3' }), [])).toBe('new:pr');
    });

    // Ответ бывает вложенным: композера с id вложенного сообщения нет, композер у треда один.
    it('ответ под вложенным сообщением едет по ключу того же треда', () => {
        expect(
            composerKeyOfBufferEntry(entry({ id: 'ck-2', draft: { body: 'x', parentId: 'reply-2', anchor: null } }), [
                REPLY_THREAD,
            ]),
        ).toBe('reply:root-1');
    });

    it('ответ в тред, которого в снапшоте нет, места композера не имеет', () => {
        expect(
            composerKeyOfBufferEntry(entry({ id: 'ck-2', draft: { body: 'x', parentId: 'reply-2', anchor: null } }), []),
        ).toBeNull();
    });

    it('правка своего черновика едет по ключу редактора черновика', () => {
        expect(composerKeyOfBufferEntry(entry({ id: 'ck-4', commentId: 'draft-9' }), [])).toBe('edit:draft-9');
    });
});

describe('восстановление композеров из буфера', () => {
    it('открывает композер с текстом, якорем и статусом buffered', () => {
        const store = createThreadStore([], new Set(['f1']));
        const record = entry({ id: 'ck-1', draft: { body: 'не потерялось', parentId: null, anchor: LINE_ANCHOR } });

        expect(restoreBufferedComposers(store, [record])).toEqual(['new:f1:new:42']);

        expect(store.getComposer('new:f1:new:42')).toMatchObject({
            text: 'не потерялось',
            status: 'buffered',
            clientKey: 'ck-1',
            // Диапазон выделения переживает восстановление: ключ композера знает только первую строку.
            anchor: LINE_ANCHOR,
        });
    });

    it('не перетирает композер, в котором ревьюер печатает', () => {
        const store = createThreadStore([], new Set(['f1']));
        const record = entry({ id: 'ck-1', draft: { body: 'старое', parentId: null, anchor: LINE_ANCHOR } });
        restoreBufferedComposers(store, [record]);
        store.updateComposer('new:f1:new:42', { text: 'уже дописал' });

        restoreBufferedComposers(store, [record]);

        expect(store.getComposer('new:f1:new:42')?.text).toBe('уже дописал');
    });

    it('закрывает нетронутый композер, когда его запись сервер довёз', () => {
        const store = createThreadStore([], new Set(['f1']));
        const record = entry({ id: 'ck-1', draft: { body: 'довезли', parentId: null, anchor: LINE_ANCHOR } });
        restoreBufferedComposers(store, [record]);

        expect(staleBufferedComposers(store, []).close).toEqual(['new:f1:new:42']);
        syncBufferedComposers(store, []);

        expect(store.getComposer('new:f1:new:42')).toBeNull();
    });

    it('дописанный текст переживает довоз записи: композер остаётся с несохранённым текстом', () => {
        const store = createThreadStore([], new Set(['f1']));
        restoreBufferedComposers(store, [
            entry({ id: 'ck-1', draft: { body: 'довезли', parentId: null, anchor: LINE_ANCHOR } }),
        ]);
        store.updateComposer('new:f1:new:42', { text: 'довезли и ещё абзац' });

        syncBufferedComposers(store, []);

        expect(store.getComposer('new:f1:new:42')).toMatchObject({
            text: 'довезли и ещё абзац',
            status: 'idle',
            bufferEntry: null,
            // Ключ записи остаётся: сохранение тем же ключом сервер превратит в правку уже
            // созданного черновика, а не во второй черновик с почти тем же текстом.
            clientKey: 'ck-1',
        });
    });

    // Без исходного текста «сбросить» у восстановленной правки означало бы удаление черновика
    // на хосте: композер правки не знает, к чему возвращаться.
    it('правка восстанавливается вместе с исходным текстом своего черновика', () => {
        const store = createThreadStore([draftThread('draft-9', 'на хосте лежит это')], new Set(['f1']));
        const record = entry({
            id: 'ck-edit',
            commentId: 'draft-9',
            draft: { body: 'правка, которую не довезли', parentId: null, anchor: null },
        });

        expect(restoreBufferedComposers(store, [record])).toEqual(['edit:draft-9']);

        expect(store.getComposer('edit:draft-9')).toMatchObject({
            text: 'правка, которую не довезли',
            originalText: 'на хосте лежит это',
            threadId: 'thread-draft-9',
            commentId: 'draft-9',
            status: 'buffered',
        });
    });

    // Флаг issue в записи — это то, что ещё не доехало до хоста: свитчер обязан встать как был.
    it('возвращает композеру состояние свитчера issue', () => {
        const store = createThreadStore([REPLY_THREAD], new Set(['f1']));
        const record = entry({
            id: 'ck-issue',
            draft: { body: 'замечание', parentId: 'root-1', anchor: null, issue: false },
        });

        restoreBufferedComposers(store, [record]);

        expect(store.getComposer('reply:root-1')?.issue).toBe(false);
    });

    // Композер ответа у треда один: буферный ответ под вложенным сообщением обязан вернуться
    // в него же, иначе на экране его никто не нарисует.
    it('ответ под вложенным сообщением возвращается в композер треда, под своё сообщение', () => {
        const store = createThreadStore([REPLY_THREAD], new Set(['f1']));
        const record = entry({
            id: 'ck-nested',
            draft: { body: 'ответ вложенному', parentId: 'reply-2', anchor: null },
        });

        expect(restoreBufferedComposers(store, [record])).toEqual(['reply:root-1']);

        expect(store.getComposer('reply:root-1')).toMatchObject({
            text: 'ответ вложенному',
            threadId: 'root-1',
            parentId: 'reply-2',
            replyUnder: 'reply-2',
            status: 'buffered',
        });
    });

    it('правка без своего комментария в тредах не восстанавливается', () => {
        const store = createThreadStore([], new Set(['f1']));

        expect(restoreBufferedComposers(store, [entry({ id: 'ck-edit', commentId: 'draft-9' })])).toEqual([]);
        expect(store.getComposer('edit:draft-9')).toBeNull();
    });
});

/** Тред с одним ответом; id треда равен id корня, как у Арканума. */
function replyThread(): Thread {
    const base = draftThread('root-1', 'корень треда');
    const root = { ...base.root, draft: false };
    return {
        ...base,
        id: 'root-1',
        root: { ...root, replies: [{ ...root, id: 'reply-2', body: 'ответ в треде' }] },
    };
}

/** Тред из одного черновика: минимум, нужный восстановлению правки. */
function draftThread(commentId: string, body: string): Thread {
    return {
        id: `thread-${commentId}`,
        anchor: null,
        resolved: false,
        resolvedBy: null,
        outdated: false,
        pinnedTo: null,
        root: {
            id: commentId,
            author: { login: 'alice', displayName: null, bot: false, avatarUrl: null },
            body,
            createdAt: '2026-09-03T09:00:00.000Z',
            editedAt: null,
            draft: true,
            issue: null,
            resolved: null,
            replies: [],
        },
    };
}

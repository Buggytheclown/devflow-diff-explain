import type { Comment, DraftBufferEntry, Thread } from '@sherpa/protocol';

import { closeComposersByKey } from './composer.js';
import { draftEditComposerKey } from './draft-editor.tsx';
import type { ComposerSnapshot, ThreadStore } from './store.js';
import { PR_COMPOSER_KEY, replyComposerKey } from './thread-list.tsx';

/**
 * Возврат буфера черновиков в композеры. Сервер помнит текст, который хост ещё не
 * принял; после перезагрузки вкладки он обязан оказаться в композере на той же строке.
 *
 * Ключ строится ровно как у живого композера — иначе восстановленный и новый композеры
 * оказались бы двумя разными окнами на одну строку.
 */

/**
 * Ключ композера буферной записи; `null` — записи не соответствует ни одно место композера
 * (ответ, чей тред снапшот ещё не привёз).
 */
export function composerKeyOfBufferEntry(entry: DraftBufferEntry, threads: readonly Thread[]): string | null {
    if (entry.commentId !== null) {
        return draftEditComposerKey(entry.commentId);
    }
    const { parentId, anchor } = entry.draft;
    if (parentId !== null) {
        // Композер ответа у треда один и ключом знает тред, а не родителя: родителем бывает
        // любое сообщение дерева, и композера с его id нет ни у кода, ни в модалке.
        const parent = locate(threads, parentId);
        return parent === null ? null : replyComposerKey(parent.thread.id);
    }
    if (anchor === null) {
        return PR_COMPOSER_KEY;
    }
    const position = anchor.position;
    return position === null
        ? PR_COMPOSER_KEY
        : `new:${anchor.fileId}:${position.side}:${String(position.line)}`;
}

/**
 * Композер буферной записи: текст, якорь и статус «сохраним, когда связь вернётся».
 *
 * Правка (`commentId !== null`) восстанавливается только вместе со своим комментарием: из него
 * берётся исходный текст, без которого отмена правки означала бы удаление черновика на хосте.
 */
export function composerOfBufferEntry(
    entry: DraftBufferEntry,
    threads: readonly Thread[],
): ComposerSnapshot | null {
    const key = composerKeyOfBufferEntry(entry, threads);
    if (key === null) {
        return null;
    }
    const { draft } = entry;
    const edited = entry.commentId === null ? null : locate(threads, entry.commentId);
    if (entry.commentId !== null && edited === null) {
        return null;
    }
    const parent = draft.parentId === null ? null : locate(threads, draft.parentId);
    // Issue-статус берётся из записи, а у правки — из самого комментария, как в `openDraftEditor`.
    const issue = draft.issue ?? edited?.comment.issue ?? undefined;
    return {
        key,
        threadId: edited?.thread.id ?? parent?.thread.id ?? null,
        parentId: draft.parentId,
        // Ответ возвращается под то же сообщение, под которым его писали (§3, §4).
        ...(parent === null ? {} : { replyUnder: draft.parentId }),
        // Диапазон выделения хранится в записи целиком: ключ композера знает только первую строку.
        anchor: draft.anchor,
        ...(issue === undefined ? {} : { issue }),
        text: draft.body,
        ...(edited === null ? {} : { originalText: edited.comment.body }),
        commentId: entry.commentId,
        status: 'buffered',
        clientKey: entry.id,
        bufferEntry: entry,
        slow: false,
        confirmDiscard: false,
        resolvedAtOpen: edited?.thread.resolved ?? false,
    };
}

/**
 * Открывает композеры буферных записей, которых на экране ещё нет. Композер с тем же
 * `clientKey` уже открыт — не трогаем: там ревьюер печатает прямо сейчас.
 */
export function restoreBufferedComposers(
    store: ThreadStore,
    entries: readonly DraftBufferEntry[],
    threads: readonly Thread[] = store.getSnapshot().threads,
): string[] {
    const opened: string[] = [];
    for (const entry of entries) {
        const composer = composerOfBufferEntry(entry, threads);
        if (composer === null) {
            continue;
        }
        const existing = store.getComposer(composer.key);
        if (existing !== null && existing.clientKey === entry.id) {
            // Тот же композер: обновляем только запись буфера, текст остаётся набранным.
            store.updateComposer(composer.key, { bufferEntry: entry });
            continue;
        }
        if (existing !== null) {
            continue;
        }
        store.openComposer(composer);
        opened.push(composer.key);
    }
    return opened;
}

/**
 * Композеры, которых буфер больше не знает: их запись сервер довёз, и черновик уже виден
 * карточкой в тредах. Текст, изменённый ревьюером после провала, композер сохраняет — там
 * работа, которую в довезённой записи не отразить.
 */
export function staleBufferedComposers(
    store: ThreadStore,
    entries: readonly DraftBufferEntry[],
): { readonly close: readonly string[]; readonly release: readonly string[] } {
    const known = new Set(entries.map((entry) => entry.id));
    const close: string[] = [];
    const release: string[] = [];
    for (const composer of store.listComposers()) {
        if (composer.status !== 'buffered' || (composer.clientKey !== undefined && known.has(composer.clientKey))) {
            continue;
        }
        (composer.text === composer.bufferEntry?.draft.body ? close : release).push(composer.key);
    }
    return { close, release };
}

/** Сверяет открытые композеры с буфером: чего нет — открыть, что довезено — закрыть. */
export function syncBufferedComposers(
    store: ThreadStore,
    entries: readonly DraftBufferEntry[],
    threads: readonly Thread[] = store.getSnapshot().threads,
): void {
    const stale = staleBufferedComposers(store, entries);
    closeComposersByKey(store, stale.close);
    for (const key of stale.release) {
        // `clientKey` остаётся: запись довезена, и сохранение тем же ключом сервер превратит
        // в правку созданного черновика — второго черновика с почти тем же текстом не будет.
        store.updateComposer(key, { status: 'idle', bufferEntry: null });
    }
    restoreBufferedComposers(store, entries, threads);
}

/** Комментарий и его тред по id; `null` — в снапшоте его нет. */
function locate(
    threads: readonly Thread[],
    commentId: string,
): { readonly thread: Thread; readonly comment: Comment } | null {
    const visit = (comment: Comment): Comment | null => {
        if (comment.id === commentId) {
            return comment;
        }
        for (const reply of comment.replies) {
            const found = visit(reply);
            if (found !== null) {
                return found;
            }
        }
        return null;
    };
    for (const thread of threads) {
        const comment = visit(thread.root);
        if (comment !== null) {
            return { thread, comment };
        }
    }
    return null;
}

import {
    deleteReviewComment,
    deleteReviewDraft,
    discardDraftBufferEntry,
    retryDraftBufferEntry,
    saveReviewDraft,
    setReviewCommentResolved,
    updateReviewComment,
    updateReviewDraft,
} from '../api.js';
import type { ComposerTransport } from './composer.js';

/** Один транспорт композеров на все вью: ручки одни и те же, отличается только токен. */
export function createComposerTransport(token: string): ComposerTransport {
    return {
        save: (draft, clientKey) => saveReviewDraft(token, draft, clientKey),
        update: (commentId, body, issue, clientKey) => updateReviewDraft(token, commentId, body, issue, clientKey),
        delete: (commentId) => deleteReviewDraft(token, commentId),
        discardBuffered: async (id) => {
            await discardDraftBufferEntry(token, id);
        },
        retryBuffered: async (id) => {
            await retryDraftBufferEntry(token, id);
        },
    };
}

/**
 * Записи по уже опубликованному комментарию: resolve его issue, правка и удаление. Буфера
 * черновиков у них нет — провал возвращается вызывающему как ошибка.
 */
export interface PublishedCommentTransport {
    setResolved(commentId: string, resolved: boolean): Promise<void>;
    update(commentId: string, body: string, issue?: boolean): Promise<void>;
    delete(commentId: string): Promise<void>;
}

export function createPublishedCommentTransport(token: string): PublishedCommentTransport {
    return {
        setResolved: (commentId, resolved) => setReviewCommentResolved(token, commentId, resolved),
        update: (commentId, body, issue) => updateReviewComment(token, commentId, body, issue),
        delete: (commentId) => deleteReviewComment(token, commentId),
    };
}

const composerTransports = new WeakMap<PublishedCommentTransport, ComposerTransport>();

/**
 * Опубликованный комментарий правится тем же редактором, что и черновик: композер работает
 * на транспорте, поэтому его хватает подменить. Создания здесь не бывает — редактор всегда
 * открывается на существующем `commentId`; буфера черновиков у опубликованного нет, и ответ
 * всегда `saved`: провал прилетает ошибкой и показывается под сообщением.
 */
export function publishedCommentComposerTransport(published: PublishedCommentTransport): ComposerTransport {
    const existing = composerTransports.get(published);
    if (existing !== undefined) {
        return existing;
    }
    const created: ComposerTransport = {
        save: () => Promise.reject(new Error('published comments are edited, not created')),
        update: async (commentId, body, issue) => {
            await published.update(commentId, body, issue);
            return { outcome: 'saved' };
        },
        delete: (commentId) => published.delete(commentId),
    };
    composerTransports.set(published, created);
    return created;
}

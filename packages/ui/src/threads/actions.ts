import type { ComposerTransport } from './composer.js';
import { resolvedWriterFor } from './resolved-writer.js';
import type { ThreadStore } from './store.js';
import type { ThreadActions } from './thread-list.tsx';
import type { PublishedCommentTransport } from './transport.js';

/**
 * Действия тредов поверх стора: черновики транспортом, resolve — писателем с очередью
 * и откатом. Собираются одинаково для полного диффа и для маршрута: обе вью работают
 * с одним стором, и вторая копия этой обвязки разъехалась бы с первой.
 *
 * `published` — записи по уже опубликованному комментарию (резолв его issue, правка,
 * удаление). Что из этого доступно, решают `capabilities.commentResolve` и
 * `capabilities.editPublished`: без них соответствующих действий в UI нет.
 */
export interface PublishedCommentActions {
    readonly transport: PublishedCommentTransport;
    readonly commentResolve: boolean;
    readonly editPublished: boolean;
}

export function createThreadActions(
    store: ThreadStore,
    transport: ComposerTransport,
    resolve: (threadId: string, resolved: boolean) => Promise<void>,
    published?: PublishedCommentActions,
    commentIssues = false,
): ThreadActions {
    const writer = resolvedWriterFor(store, 'thread', {
        read: (threadId) => store.getSnapshot().threads.find((thread) => thread.id === threadId)?.resolved ?? false,
        readConfirmed: store.getServerResolved,
        apply: (threadId, resolved) => {
            store.setResolved(threadId, resolved);
        },
        rollback: store.restoreResolved,
        shouldRollback: (threadId) => store.hasResolvedOverride(threadId),
        send: resolve,
    });
    if (published === undefined) {
        return { transport, commentIssues, resolve: writer.write, resolveComment: null, published: null };
    }
    const commentWriter = resolvedWriterFor(store, 'comment', {
        read: store.getCommentResolved,
        readConfirmed: store.getServerCommentResolved,
        apply: store.setCommentResolved,
        rollback: store.restoreCommentResolved,
        shouldRollback: (commentId) => store.hasCommentResolvedOverride(commentId),
        send: (commentId, resolved) => published.transport.setResolved(commentId, resolved),
    });
    return {
        transport,
        commentIssues,
        resolve: writer.write,
        resolveComment: published.commentResolve ? commentWriter.write : null,
        published: published.editPublished ? published.transport : null,
    };
}

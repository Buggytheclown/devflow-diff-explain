import type { Comment, Thread } from '@sherpa/protocol';
import type { ReactNode } from 'react';
import { useCallback, useMemo, useSyncExternalStore } from 'react';

import type { ComposerTransport } from './composer.js';
import { CommentComposer } from './comment-composer.tsx';
import type { ComposerLayout } from './composer-markdown.js';
import type { ComposerSnapshot, ThreadStore } from './store.js';

export function draftEditComposerKey(commentId: string): string {
    return `edit:${commentId}`;
}

/**
 * Открывает правку комментария на месте его текста — своего черновика или своего уже
 * опубликованного (docs/design/SPEC-changes-2026-09-20.md §3). Редактор один; куда уедет
 * текст, решает транспорт, который передаёт вызывающий.
 */
export function openDraftEditor(store: ThreadStore, thread: Thread, comment: Comment): void {
    const key = draftEditComposerKey(comment.id);
    const replyComposer = store.getComposer(`reply:${thread.id}`);
    if (store.getComposer(key) !== null || replyComposer?.commentId === comment.id) {
        return;
    }
    // Issue есть у любого комментария, включая ответы; `null` отдают только хосты без `commentIssues`.
    const issue = comment.issue;
    store.openComposer({
        key,
        threadId: thread.id,
        parentId: null,
        anchor: null,
        ...(issue === null ? {} : { issue }),
        ...(comment.draft ? {} : { published: true }),
        text: comment.body,
        originalText: comment.body,
        commentId: comment.id,
        status: 'saved',
        savedAt: Date.parse(comment.editedAt ?? comment.createdAt),
        slow: false,
        confirmDiscard: false,
        resolvedAtOpen: thread.resolved,
    });
}

/** Активная правка из стора — переживает виртуализацию и закрывается вместе с композером. */
export function useActiveDraftEditor(store: ThreadStore, commentIds: readonly string[]): string | null {
    const keys = useMemo(() => commentIds.map(draftEditComposerKey), [commentIds]);
    const subscribe = useCallback(
        (listener: () => void) => {
            const unsubscribes = keys.map((key) => store.subscribeComposer(key, listener));
            return () => {
                for (const unsubscribe of unsubscribes) {
                    unsubscribe();
                }
            };
        },
        [keys, store],
    );
    const getSnapshot = useCallback(
        () => commentIds.find((commentId) => store.getComposer(draftEditComposerKey(commentId)) !== null) ?? null,
        [commentIds, store],
    );
    return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export function DraftEditor({
    comment,
    store,
    transport,
    placeholder,
    inputLabel,
    footerHint,
    initialLayout,
}: {
    comment: Comment;
    store: ThreadStore;
    transport: ComposerTransport;
    placeholder: string;
    inputLabel: string;
    footerHint?: ReactNode;
    initialLayout?: ComposerLayout;
}) {
    const key = draftEditComposerKey(comment.id);
    const composer = useComposerSnapshot(store, key);
    if (composer === null) {
        return null;
    }
    return (
        <CommentComposer
            composer={composer}
            store={store}
            transport={transport}
            placeholder={placeholder}
            inputLabel={inputLabel}
            saveLabel="thread.composer.saveChanges"
            closeOnSave
            {...(footerHint === undefined ? {} : { footerHint })}
            {...(initialLayout === undefined ? {} : { initialLayout })}
            restoreOnCancel={composer.originalText ?? comment.body}
        />
    );
}

function useComposerSnapshot(store: ThreadStore, key: string): ComposerSnapshot | null {
    const subscribe = useCallback((listener: () => void) => store.subscribeComposer(key, listener), [key, store]);
    const getSnapshot = useCallback(() => store.getComposer(key), [key, store]);
    return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

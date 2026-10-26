import type { Comment, Thread } from '@sherpa/protocol';
import { describe, expect, it } from 'vitest';

import { draftEditComposerKey, openDraftEditor } from './draft-editor.tsx';
import { createThreadStore } from './store.js';

function comment(id: string, issue: boolean | null): Comment {
    return {
        id,
        author: { login: 'alice', displayName: 'Alice Ingram', bot: false, avatarUrl: null },
        body: `текст ${id}`,
        draft: true,
        issue,
        resolved: issue === null ? null : false,
        createdAt: '2026-08-31T10:00:00.000Z',
        editedAt: null,
        replies: [],
    };
}

function thread(root: Comment): Thread {
    return { id: root.id, anchor: null, resolved: false, resolvedBy: null, outdated: false, pinnedTo: null, root };
}

describe('правка своего черновика', () => {
    it('открывает переключатель issue в состоянии хоста', () => {
        for (const issue of [true, false]) {
            const root = comment('root', issue);
            const store = createThreadStore([thread(root)], new Set());
            openDraftEditor(store, thread(root), root);
            expect(store.getComposer(draftEditComposerKey(root.id))?.issue).toBe(issue);
        }
    });

    it('без issue-статуса хоста переключателя нет', () => {
        const root = comment('root', null);
        const store = createThreadStore([thread(root)], new Set());
        openDraftEditor(store, thread(root), root);
        expect(store.getComposer(draftEditComposerKey(root.id))?.issue).toBeUndefined();
    });

    it('у ответа переключатель свой: правка открывает его в состоянии комментария', () => {
        for (const issue of [true, false]) {
            const reply = comment('reply', issue);
            const root = { ...comment('root', true), replies: [reply] };
            const store = createThreadStore([thread(root)], new Set());
            openDraftEditor(store, thread(root), reply);
            expect(store.getComposer(draftEditComposerKey(reply.id))?.issue).toBe(issue);
        }
    });
});

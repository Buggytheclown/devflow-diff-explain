import { fixtureIteration } from '@sherpa/fixtures';
import type { Comment, Thread } from '@sherpa/protocol';
import { useCallback, useState, useSyncExternalStore } from 'react';

import { CommentComposer } from '../../threads/comment-composer.tsx';
import type { ComposerTransport } from '../../threads/composer.js';
import type { ComposerLayout } from '../../threads/composer-markdown.js';
import { ThreadList } from '../../threads/thread-list.tsx';
import type { ComposerSnapshot } from '../../threads/store.js';
import { createThreadStore } from '../../threads/store.js';

const DATA = fixtureIteration('medium');
const THREAD = firstThread();
const FILE_IDS = new Set(DATA.diff.files.map((file) => file.fileId));
const SAVED_AT = Date.parse('2026-08-28T14:02:00');
const DRAFT: Comment = {
    id: 'gallery-composer-draft',
    author: { login: 'alice', displayName: 'Alice Ingram', bot: false, avatarUrl: null },
    body: 'Проверю ещё один край перед Ship.',
    draft: true,
    issue: true,
    resolved: null,
    createdAt: '2026-08-28T14:02:00.000Z',
    editedAt: null,
    replies: [],
};
const TRANSPORT: ComposerTransport = {
    save: () => Promise.resolve({ outcome: 'saved', comment: DRAFT }),
    update: () => Promise.resolve({ outcome: 'saved' }),
    delete: () => Promise.resolve(),
};

function firstThread(): Thread {
    const thread = DATA.threads[0];
    if (thread === undefined) {
        throw new Error('Галерее композера нужен тред из fixture-medium.');
    }
    return thread;
}

export const COMMENT_COMPOSER_STATES = [
    { id: 'composer-rest', title: 'покой — тред без композера, вход по «Ответить»', render: () => <CollapsedState draft={false} /> },
    { id: 'composer-empty', title: 'открыт, плейсхолдер', render: () => <OpenState layout="visual" kind="empty" /> },
    { id: 'composer-visual', title: 'текст, Визуально', render: () => <OpenState layout="visual" kind="saved" /> },
    { id: 'composer-markdown', title: 'текст, Markdown', render: () => <OpenState layout="markdown" kind="saved" /> },
    { id: 'composer-error', title: 'ошибка автосейва', render: () => <OpenState layout="markdown" kind="error" /> },
    { id: 'composer-confirm', title: 'подтверждение удаления черновика', render: () => <OpenState layout="visual" kind="confirm" /> },
    { id: 'composer-issue-open', title: 'новый комментарий · issue открыт', render: () => <IssueState issue /> },
    { id: 'composer-issue-off', title: 'новый комментарий · issue выключен', render: () => <IssueState issue={false} /> },
    { id: 'composer-no-issue', title: 'новый комментарий · хост без issue', render: () => <IssueState /> },
    { id: 'composer-reply-issue', title: 'ответ в тред · свитчер issue', render: () => <OpenState layout="visual" kind="saved" issue /> },
    { id: 'composer-closed-draft', title: 'черновик сохранён, поле закрыто · чипы draft и issue', render: () => <CollapsedState draft /> },
] as const;

function OpenState({
    layout,
    kind,
    issue = false,
}: {
    layout: ComposerLayout;
    kind: 'empty' | 'saved' | 'error' | 'confirm';
    /** Ответ на хосте с `commentIssues`: тот же свитчер, что у нового комментария. */
    issue?: boolean;
}) {
    const [store] = useState(() => {
        const created = createThreadStore([], FILE_IDS);
        const text = kind === 'empty' ? '' : '**Guard** надо строить внутри unit of work — иначе `None` остаётся достижим.';
        const snapshot: ComposerSnapshot = {
            key: composerKey(layout, kind, issue),
            threadId: THREAD.id,
            parentId: THREAD.root.id,
            anchor: null,
            ...(issue ? { issue: true } : {}),
            text,
            commentId: kind === 'saved' ? DRAFT.id : null,
            status: kind === 'error' ? 'error' : kind === 'saved' ? 'saved' : 'idle',
            savedAt: kind === 'saved' ? SAVED_AT : null,
            slow: false,
            confirmDiscard: kind === 'confirm',
            resolvedAtOpen: false,
        };
        created.openComposer(snapshot);
        return created;
    });
    // Живая подписка, как в ThreadList: без неё ввод в галерее обновляет стор,
    // а композер продолжает получать протухший снапшот.
    const key = composerKey(layout, kind, issue);
    const subscribe = useCallback((listener: () => void) => store.subscribeComposer(key, listener), [key, store]);
    const getSnapshot = useCallback(() => store.getComposer(key), [key, store]);
    const composer = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
    if (composer === null) {
        return null;
    }
    return (
        <div className="gallery-composer">
            <CommentComposer
                composer={composer}
                store={store}
                transport={TRANSPORT}
                placeholder="Ответить в тред"
                inputLabel="Ответ в тред"
                initialLayout={layout}
            />
        </div>
    );
}

function composerKey(layout: ComposerLayout, kind: string, issue: boolean): string {
    return `gallery:${layout}:${kind}${issue ? ':issue' : ''}`;
}

function IssueState({ issue }: { issue?: boolean }) {
    const [store] = useState(() => {
        const created = createThreadStore([], FILE_IDS);
        created.openComposer({
            key: `gallery:issue:${issue === undefined ? 'unsupported' : String(issue)}`,
            threadId: null,
            parentId: null,
            anchor: null,
            ...(issue === undefined ? {} : { issue }),
            text: 'Проверить нулевую ширину до Ship.',
            commentId: null,
            status: 'idle',
            slow: false,
            confirmDiscard: false,
            resolvedAtOpen: false,
        });
        return created;
    });
    const key = `gallery:issue:${issue === undefined ? 'unsupported' : String(issue)}`;
    const subscribe = useCallback((listener: () => void) => store.subscribeComposer(key, listener), [key, store]);
    const getSnapshot = useCallback(() => store.getComposer(key), [key, store]);
    const composer = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
    if (composer === null) {
        return null;
    }
    return (
        <div className="gallery-composer">
            <CommentComposer
                composer={composer}
                store={store}
                transport={TRANSPORT}
                placeholder="Общее замечание по PR — не привязано к строке"
                inputLabel="Новый комментарий"
                initialLayout="markdown"
            />
        </div>
    );
}

function CollapsedState({ draft }: { draft: boolean }) {
    const [store] = useState(() => createThreadStore([], FILE_IDS));
    const thread: Thread = draft
        ? { ...THREAD, root: { ...THREAD.root, replies: [...THREAD.root.replies, DRAFT] } }
        : THREAD;
    return (
        <div className="gallery-composer">
            <ThreadList
                threads={[thread]}
                store={store}
                actions={{ transport: TRANSPORT, commentIssues: true, resolve: () => Promise.resolve(true) }}
                now={Date.parse('2026-08-28T14:02:00.000Z')}
            />
        </div>
    );
}

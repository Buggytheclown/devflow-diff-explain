import { fixtureIteration } from '@sherpa/fixtures';
import type { Comment, Thread } from '@sherpa/protocol';
import type { ReactNode } from 'react';
import { useMemo, useSyncExternalStore } from 'react';

import { toParseRequest } from '../../diff/model.js';
import { parseFileDiff } from '../../diff/parse.js';
import type { FileCardActions } from '../../diff-view/file-card.tsx';
import { FileCard } from '../../diff-view/file-card.tsx';
import type { DiffMode } from '../../diff-view/store.js';
import { readStateOf } from '../../progress/read-state.js';
import { useCardThreads } from '../../threads/card-threads.tsx';
import type { ComposerTransport } from '../../threads/composer.js';
import { openDraftEditor } from '../../threads/draft-editor.tsx';
import { createThreadStore } from '../../threads/store.js';
import { openNewComposer } from '../../threads/thread-list.tsx';

const DATA = fixtureIteration('medium');
const FILE = fileForGallery();
const MODEL = parseFileDiff(toParseRequest(FILE));
const POSITION = { side: 'new' as const, line: 48, size: 1 };
const NOW = Date.parse('2026-08-31T12:00:00.000Z');
const TRANSPORT: ComposerTransport = {
    save: () => Promise.reject(new Error('галерея не сохраняет')),
    update: () => Promise.resolve({ outcome: 'saved' }),
    delete: () => Promise.resolve(),
};
const ACTIONS: FileCardActions = {
    onViewed: () => Promise.resolve(null),
    onExpand: (_fileId, _request) => Promise.resolve({ feedback: null, content: null, expansion: new Map() }),
    onRetryParse: () => undefined,
    onOpenFile: () => undefined,
    onShowWhitespace: () => undefined,
    onToggleMarkdown: () => undefined,
    onSelectStart: () => undefined,
    onSelectExtend: () => undefined,
};

export interface LineCommentGalleryState {
    readonly id: string;
    readonly title: string;
    readonly render: () => ReactNode;
}

export const LINE_COMMENT_STATES: readonly LineCommentGalleryState[] = [
    {
        id: 'line-composer-unified',
        title: 'композер под строкой · unified',
        render: () => <LineCommentState mode="unified" />,
    },
    {
        id: 'line-composer-split',
        title: 'композер под строкой · split',
        render: () => <LineCommentState mode="split" />,
    },
    {
        id: 'line-draft-editing',
        title: 'свой черновик правится на месте у строки',
        render: () => <LineCommentState mode="unified" editing />,
    },
];

function LineCommentState({ mode, editing = false }: { mode: DiffMode; editing?: boolean }) {
    const draft = useMemo(() => lineDraft(), []);
    const store = useMemo(() => {
        const created = createThreadStore(editing ? [draft] : [], new Set([FILE.fileId]));
        if (editing) {
            openDraftEditor(created, draft, draft.root);
        } else {
            openNewComposer(created, `new:${FILE.fileId}:new:48`, {
                fileId: FILE.fileId,
                path: FILE.path,
                position: POSITION,
            }, true);
        }
        return created;
    }, [draft, editing]);
    const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
    const composers = useSyncExternalStore(
        store.subscribeComposers,
        store.getComposersSnapshot,
        store.getComposersSnapshot,
    );
    const { threadsUnderHeader, renderAfterLine } = useCardThreads({
        model: MODEL,
        rowsShown: true,
        threads: snapshot.byFile.get(FILE.fileId) ?? [],
        composers: composers.byFile.get(FILE.fileId) ?? [],
        store,
        actions: { transport: TRANSPORT, resolve: () => Promise.resolve(true) },
        now: NOW,
        onFocusThread: () => undefined,
        initialLayout: 'visual',
    });

    return (
        <div className="gallery__viewport">
            <div style={{ padding: 24 }}>
                <FileCard
                    file={FILE}
                    model={MODEL}
                    mode={mode}
                    content={null}
                    contentAvailable={false}
                    expansion={new Map()}
                    read={readStateOf({ file: FILE, record: null })}
                    opened
                    showWhitespace={false}
                    markdown={false}
                    selection={null}
                    threadsUnderHeader={threadsUnderHeader}
                    renderAfterLine={renderAfterLine}
                    actions={ACTIONS}
                />
            </div>
        </div>
    );
}

function fileForGallery() {
    const file = DATA.diff.files.find((candidate) => candidate.path === 'services/orders/src/api/handlers.ts');
    if (file === undefined) {
        throw new Error('фикстуре medium нужен handlers.ts');
    }
    return file;
}

function lineDraft(): Thread {
    const root: Comment = {
        id: 'gallery-line-draft',
        author: { login: 'alice', displayName: 'Alice Ingram', bot: false, avatarUrl: null },
        body: 'Граница окна должна проверяться до вычисления remainingMs.',
        draft: true,
        // Корень треда несёт issue-статус хоста — правка открывает переключатель в его состоянии.
        issue: true,
        resolved: false,
        createdAt: '2026-08-31T11:42:00.000Z',
        editedAt: null,
        replies: [],
    };
    return {
        id: 'gallery-line-thread',
        root,
        resolved: false,
        resolvedBy: null,
        outdated: false,
        pinnedTo: null,
        anchor: { fileId: FILE.fileId, path: FILE.path, position: POSITION },
    };
}

import type { AgentNote, ChatAnchor, FileDiff } from '@sherpa/protocol';
import type { ReactNode } from 'react';
import { useMemo, useSyncExternalStore } from 'react';

import { useT } from '../../i18n/index.js';
import { parseFileDiff } from '../../diff/parse.js';
import type { FileCardActions } from '../../diff-view/file-card.tsx';
import { FileCard } from '../../diff-view/file-card.tsx';
import { useCardNotes } from '../../notes/card-notes.tsx';
import { noteComposerAnchor, noteComposerKey, noteDraftText } from '../../notes/note-draft.js';
import { readStateOf } from '../../progress/read-state.js';
import { useCardThreads } from '../../threads/card-threads.tsx';
import type { ComposerTransport } from '../../threads/composer.js';
import { createSessionStore } from '../../session/session-store.js';
import { createThreadStore } from '../../threads/store.js';
import { openNewComposer } from '../../threads/thread-list.tsx';

const FILE: FileDiff = {
    fileId: 'gallery-note-draft-file',
    path: 'src/review/cache.ts',
    oldPath: null,
    changeType: 'modify',
    binary: false,
    additions: 3,
    deletions: 1,
    generated: false,
    viewed: false,
    blameUrl: null,
    hostFileUrl: null,
    image: null,
    patch: [
        '@@ -40,3 +40,5 @@',
        ' const cached = readCache(key);',
        '-return cached;',
        '+if (cached !== null) {',
        '+    return cached;',
        '+}',
        ' return load(key);',
        '',
    ].join('\n'),
};
const MODEL = parseFileDiff(FILE);
const NOTE_ANCHOR: ChatAnchor = {
    diffId: 'gallery-iteration',
    fileId: FILE.fileId,
    path: FILE.path,
    side: 'new',
    start: 41,
    end: 43,
};
const NOTE: AgentNote = {
    id: 41,
    exchangeId: 141,
    anchor: NOTE_ANCHOR,
    text: [
        'Проверка отделяет попадание в кеш от загрузки данных.',
        '',
        'Быстрый путь сохраняется, поведение промаха не меняется.',
    ].join('\n'),
    lostAnchor: false,
    origin: { commit: 'abcdef1', anchor: NOTE_ANCHOR },
    createdAt: '2026-09-01T10:04:00.000Z',
};
const NOW = Date.parse('2026-09-01T10:05:00.000Z');
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

export interface AgentNoteDraftGalleryState {
    readonly id: string;
    readonly title: string;
    readonly render: () => ReactNode;
}

export const AGENT_NOTE_DRAFT_STATES: readonly AgentNoteDraftGalleryState[] = [
    {
        id: 'agent-note-draft',
        title: 'черновик комментария из заметки',
        render: () => <NoteDraftState />,
    },
];

/** Заметка осталась на месте, под ней — несохранённый композер с её цитатой. */
function NoteDraftState() {
    const t = useT();
    const session = useMemo(
        () =>
            createSessionStore({
                initial: { view: 'diff', filter: 'all', notesExpanded: new Set([String(NOTE.id)]) },
            }),
        [],
    );
    const store = useMemo(() => {
        const created = createThreadStore([], new Set([FILE.fileId]));
        openNewComposer(
            created,
            noteComposerKey(NOTE.anchor),
            noteComposerAnchor(NOTE.anchor),
            true,
            noteDraftText(NOTE, t),
        );
        return created;
    }, [t]);
    const threadSnapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
    const composers = useSyncExternalStore(
        store.subscribeComposers,
        store.getComposersSnapshot,
        store.getComposersSnapshot,
    );
    const { threadsUnderHeader, renderAfterLine: renderThreads } = useCardThreads({
        model: MODEL,
        rowsShown: true,
        threads: threadSnapshot.byFile.get(FILE.fileId) ?? [],
        composers: composers.byFile.get(FILE.fileId) ?? [],
        store,
        actions: { transport: TRANSPORT, resolve: () => Promise.resolve(true) },
        now: NOW,
        onFocusThread: () => undefined,
        initialLayout: 'visual',
    });
    const { notesUnderHeader, renderAfterLine: renderNotes } = useCardNotes({
        model: MODEL,
        rowsShown: true,
        notes: [NOTE],
        placement: 'nearest',
        session,
        actions: {
            onOpenInChat: () => undefined,
            onTurnIntoDraft: () => undefined,
            onDelete: () => Promise.reject(new Error('галерея не удаляет заметки')),
        },
    });

    // Порядок слотов под строкой — как в карточке файла: сначала треды и композеры, затем заметки.
    const renderAfterLine = (side: 'old' | 'new', line: number): ReactNode => {
        const threads = renderThreads(side, line);
        const notes = renderNotes(side, line);
        return threads === null && notes === null ? null : (
            <>
                {threads}
                {notes}
            </>
        );
    };

    return (
        <div className="gallery__viewport">
            <div style={{ padding: 24 }}>
                <FileCard
                    file={FILE}
                    model={MODEL}
                    mode="unified"
                    content={null}
                    contentAvailable={false}
                    expansion={new Map()}
                    read={readStateOf({ file: FILE, record: null })}
                    opened
                    showWhitespace={false}
                    markdown={false}
                    selection={null}
                    threadsUnderHeader={
                        threadsUnderHeader === null && notesUnderHeader === null ? null : (
                            <>
                                {threadsUnderHeader}
                                {notesUnderHeader}
                            </>
                        )
                    }
                    renderAfterLine={renderAfterLine}
                    actions={ACTIONS}
                />
            </div>
        </div>
    );
}

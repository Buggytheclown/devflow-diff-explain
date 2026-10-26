import { fixtureIteration } from '@sherpa/fixtures';
import type { DraftBufferEntry, Thread } from '@sherpa/protocol';
import type { ReactNode } from 'react';
import { useMemo } from 'react';

import { ReviewActionBar } from '../../components/review-action-bar.tsx';
import { ShipVerdictBanner } from '../../components/ship-verdict-banner.tsx';
import { createDiffViewStore } from '../../diff-view/store.js';
import { SettingsProvider } from '../../settings/context.tsx';
import { createUiSettingsStore } from '../../settings/settings-store.js';
import { NewCommentComposer, openPrComposer } from '../../threads/thread-list.tsx';
import { createThreadStore } from '../../threads/store.js';

/**
 * Буфер черновиков и сводка шипа. Композер в статусе «сохраним, когда связь вернётся»,
 * панель с гардом ship, баннер чужого шипа.
 */

const DATA = fixtureIteration('medium');
const GALLERY_NOW = Date.parse('2026-09-03T12:03:00.000Z');
const TRANSPORT = {
    save: () => Promise.reject(new Error('галерея не пишет в хост')),
    update: () => Promise.reject(new Error('галерея не пишет в хост')),
    delete: () => Promise.reject(new Error('галерея не пишет в хост')),
};

const BUFFERED: DraftBufferEntry = {
    id: 'ck-gallery',
    draft: { body: 'Тут нужна проверка на пустой список.', parentId: null, anchor: null },
    commentId: null,
    state: 'failed',
    error: 'Арканум: 502 Bad Gateway',
    attempts: 2,
    createdAt: '2026-09-03T11:58:00.000Z',
    updatedAt: '2026-09-03T12:00:00.000Z',
};

export interface DraftBufferGalleryState {
    readonly id: string;
    readonly group: string;
    readonly title: string;
    readonly render: () => ReactNode;
}

export const DRAFT_BUFFER_STATES: readonly DraftBufferGalleryState[] = [
    {
        id: 'draft-buffer-composer',
        group: 'Буфер черновиков',
        title: 'композер: сохраним, когда связь вернётся',
        render: () => <BufferedComposerState />,
    },
    {
        id: 'draft-buffer-action-bar',
        group: 'Буфер черновиков',
        title: 'панель: ship ждёт недовезённые черновики',
        render: () => <BufferedBarState />,
    },
    {
        id: 'ship-verdict-banner',
        group: 'Буфер черновиков',
        title: 'баннер: кто-то шипнул раньше',
        render: () => (
            <ShipVerdictBanner
                event={{ login: 'lead', displayName: 'Лия Лейн', observedAt: GALLERY_NOW - 3 * 60_000 }}
                now={GALLERY_NOW}
                onDismiss={() => undefined}
            />
        ),
    },
];

function BufferedComposerState() {
    const settings = useMemo(() => createUiSettingsStore({ initial: { composerLayout: 'markdown' } }), []);
    const store = useMemo(() => {
        const created = createThreadStore([], new Set());
        openPrComposer(created, true);
        created.updateComposer('new:pr', {
            text: BUFFERED.draft.body,
            status: 'buffered',
            clientKey: BUFFERED.id,
            bufferEntry: BUFFERED,
        });
        return created;
    }, []);

    return (
        <SettingsProvider store={settings}>
            <div style={{ maxWidth: 720 }}>
                <NewCommentComposer composerKey="new:pr" store={store} transport={TRANSPORT} />
            </div>
        </SettingsProvider>
    );
}

function BufferedBarState() {
    const diffStore = useMemo(() => createDiffViewStore({ files: DATA.diff.files }), []);
    const threadStore = useMemo(
        () => createThreadStore(withDraft(DATA.threads), new Set(DATA.diff.files.map((file) => file.fileId))),
        [],
    );

    return (
        <ReviewActionBar
            pr={DATA.pr}
            diff={DATA.diff}
            diffStore={diffStore}
            threadStore={threadStore}
            connection="online"
            hostName="FixtureHost"
            reviewHost="fixture"
            composerTransport={TRANSPORT}
            draftBuffer={[BUFFERED]}
            onPublish={() => Promise.reject(new Error('галерея не пишет в хост'))}
            onComplete={() => undefined}
        />
    );
}

/** Черновик в наборе тредов: панель показывает счётчик, а не «нет неопубликованных». */
function withDraft(threads: readonly Thread[]): Thread[] {
    const first = threads[0];
    if (first === undefined) {
        throw new Error('для состояния панели нужен хотя бы один тред');
    }
    return [{ ...first, root: { ...first.root, draft: true } }, ...threads.slice(1)];
}

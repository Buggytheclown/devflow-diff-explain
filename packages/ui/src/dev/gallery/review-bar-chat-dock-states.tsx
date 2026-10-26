import { chatFixtures, fixtureIteration } from '@sherpa/fixtures';
import type { AgentNote, ChatExchange, Thread, WorkerStatus } from '@sherpa/protocol';
import type { ReactNode } from 'react';
import { useMemo } from 'react';

import { ChatPanel } from '../../components/chat-panel.tsx';
import { useChatDock } from '../../components/dock.js';
import { ReviewActionBar } from '../../components/review-action-bar.tsx';
import { createDiffViewStore } from '../../diff-view/store.js';
import { createThreadStore } from '../../threads/store.js';

/**
 * Плавающая панель действий рядом с чатом. Два кадра под разные вьюпорты —
 * пристыкованный чат (снимать на 1440 и 1280) и чат-оверлей со скримом (снимать на 1024).
 * Класс стыковки на корне ставит тот же хук, что и приложение (`useChatDock`), поэтому
 * `--dock-*` и слои здесь считаются ровно теми же правилами.
 */

const DATA = fixtureIteration('medium');
const CHAT = chatFixtures('medium');
const EXCHANGES: readonly ChatExchange[] = CHAT?.exchanges ?? [];
const NOTES: readonly AgentNote[] = CHAT?.notes ?? [];
const GALLERY_NOW = Date.parse('2026-08-24T12:00:00.000Z');
const WORKER: WorkerStatus = {
    kind: 'connected',
    workerId: 'gallery-worker',
    harness: 'claude-code',
    model: 'opus-5',
    registeredAt: '2026-08-24T09:00:00.000Z',
    lastSeenAt: '2026-08-24T11:59:00.000Z',
};
const TRANSPORT = {
    save: () => Promise.reject(new Error('галерея не пишет в хост')),
    update: () => Promise.reject(new Error('галерея не пишет в хост')),
    delete: () => Promise.reject(new Error('галерея не пишет в хост')),
};

export interface ReviewBarChatDockGalleryState {
    readonly id: string;
    readonly group: string;
    readonly title: string;
    readonly render: () => ReactNode;
}

export const REVIEW_BAR_CHAT_DOCK_STATES: readonly ReviewBarChatDockGalleryState[] = [
    {
        id: 'review-bar-chat-docked',
        group: 'Завершение ревью',
        title: 'панель и пристыкованный чат (≥1280)',
        render: () => <DockState overlay={false} />,
    },
    {
        id: 'review-bar-chat-overlay',
        group: 'Завершение ревью',
        title: 'панель под скримом чата-оверлея (<1280)',
        render: () => <DockState overlay />,
    },
    {
        id: 'review-bar-issue-drafts',
        group: 'Завершение ревью',
        title: 'счётчик черновиков с хвостом «· 2 issues», меню шипа открыто',
        render: () => <IssueDraftsState />,
    },
];

/** Хвост «· N issues» у счётчика черновиков (SPEC-changes-2026-09-20 §1). */
function IssueDraftsState() {
    const diffStore = useMemo(() => createDiffViewStore({ files: DATA.diff.files }), []);
    const threadStore = useMemo(
        () => createThreadStore(withIssueDrafts(DATA.threads), new Set(DATA.diff.files.map((file) => file.fileId))),
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
            onPublish={() => Promise.reject(new Error('галерея не пишет в хост'))}
            onComplete={() => undefined}
            defaultMenuOpen
        />
    );
}

/**
 * Кадр «панель + открытый чат». `overlay` рисует скрим узкого вьюпорта: сам режим выбирает
 * медиазапрос по ширине окна, флаг лишь добавляет в кадр то, что в приложении рисует `app.tsx`.
 */
function DockState({ overlay }: { overlay: boolean }) {
    useChatDock(true);

    const diffStore = useMemo(() => createDiffViewStore({ files: DATA.diff.files }), []);
    const threadStore = useMemo(
        () => createThreadStore(withDraft(DATA.threads), new Set(DATA.diff.files.map((file) => file.fileId))),
        [],
    );

    return (
        <>
            {overlay ? <div className="gallery-dock-scrim" /> : null}
            <div className={`gallery-dock-chat${overlay ? ' gallery-dock-chat--overlay' : ''}`}>
                <ChatPanel
                    worker={WORKER}
                    tasks={[]}
                    exchanges={EXCHANGES}
                    notes={NOTES}
                    loading={false}
                    error={null}
                    reconnectCommand="/sherpa fixture-medium"
                    anchor={null}
                    focusRequest={0}
                    scrollRequest={null}
                    viewDiffId={DATA.diff.diffId}
                    onScrollRequestHandled={() => undefined}
                    onClose={() => undefined}
                    onRemoveAnchor={() => undefined}
                    onAsk={() => Promise.reject(new Error('в галерее вопросы не уходят'))}
                    onCancel={() => Promise.resolve()}
                    onRetry={() => Promise.resolve()}
                    onNavigate={() => undefined}
                    onNavigateToNote={() => undefined}
                    now={GALLERY_NOW}
                />
            </div>
            <ReviewActionBar
                pr={DATA.pr}
                diff={DATA.diff}
                diffStore={diffStore}
                threadStore={threadStore}
                connection="online"
                hostName="FixtureHost"
                reviewHost="fixture"
                composerTransport={TRANSPORT}
                onPublish={() => Promise.reject(new Error('галерея не пишет в хост'))}
                onComplete={() => undefined}
                chatOpen
            />
        </>
    );
}

/** Два черновика с флагом issue: счётчик получает хвост, остальные треды — как в фикстуре. */
function withIssueDrafts(threads: readonly Thread[]): Thread[] {
    const [first, second, ...rest] = threads;
    if (first === undefined || second === undefined) {
        throw new Error('для состояния счётчика нужны два треда');
    }
    return [
        { ...first, root: { ...first.root, draft: true, issue: true } },
        { ...second, root: { ...second.root, draft: true, issue: true } },
        ...rest,
    ];
}

/** Черновик в наборе тредов: панель показывает счётчик, а не «нет неопубликованных». */
function withDraft(threads: readonly Thread[]): Thread[] {
    const first = threads[0];
    if (first === undefined) {
        throw new Error('для состояния панели нужен хотя бы один тред');
    }
    return [{ ...first, root: { ...first.root, draft: true } }, ...threads.slice(1)];
}

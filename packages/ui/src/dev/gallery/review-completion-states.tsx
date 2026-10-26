import { fixtureIteration } from '@sherpa/fixtures';
import type { PrMeta, Thread, UiSettings, Verdict } from '@sherpa/protocol';
import { localHostName } from '@sherpa/protocol';
import type { ReactNode } from 'react';
import { useMemo } from 'react';

import type { PublicationFailure } from '../../components/review-action-model.js';
import { ReviewActionBar } from '../../components/review-action-bar.tsx';
import type { ReviewCompletion } from '../../components/review-action-bar.tsx';
import { ReviewComplete } from '../../components/review-complete.tsx';
import { createDiffViewStore } from '../../diff-view/store.js';
import { SettingsProvider } from '../../settings/context.tsx';
import { createUiSettingsStore } from '../../settings/settings-store.js';
import { createThreadStore } from '../../threads/store.js';

const DATA = fixtureIteration('medium');
const DRAFT_THREADS = withDraft(DATA.threads);
const COMPLETION: ReviewCompletion = {
    verdict: 'ship',
    prId: DATA.pr.id,
    headCommit: DATA.diff.headCommit,
    hostName: 'FixtureHost',
    reviewHost: 'fixture',
    publishedComments: 2,
    publishedReplies: 1,
    route: null,
    progress: {
        filesSeen: 16,
        filesTotal: 18,
        linesSeen: 780,
        linesTotal: 862,
        percentSeen: 90,
    },
    openThreads: 0,
    firstOpenThreadId: null,
};
const FAILURE: PublicationFailure = {
    verdict: 'request_changes',
    failedCount: 2,
    message: null,
    comments: [
        { commentId: '-70001', body: 'Граница здесь остаётся непроверенной.', message: 'fixture publish failed' },
        { commentId: '-70002', body: 'Нужен тест на повторную запись.', message: 'fixture publish failed' },
    ],
};
/** Своего PR на GitHub и локального ревью: вердиктов нет, только Comment. */
const COMMENT_ONLY: readonly Verdict[] = ['comment'];
/** Локальное ревью с `devflow-diff-explain up --local --verdicts`: Request changes и Ship, без Comment. */
const LOCAL_VERDICTS: readonly Verdict[] = ['request_changes', 'ship'];
const TRANSPORT = {
    save: () => Promise.reject(new Error('галерея не пишет в хост')),
    update: () => Promise.reject(new Error('галерея не пишет в хост')),
    delete: () => Promise.reject(new Error('галерея не пишет в хост')),
};

export interface ReviewCompletionGalleryState {
    readonly id: string;
    readonly group: string;
    readonly title: string;
    readonly render: () => ReactNode;
}

export const REVIEW_COMPLETION_STATES: readonly ReviewCompletionGalleryState[] = [
    {
        id: 'review-bar-drafts',
        group: 'Завершение ревью',
        title: 'панель с черновиками: все режимы, действующий Ship',
        render: () => <BarState threads={DRAFT_THREADS} />,
    },
    {
        id: 'review-bar-no-drafts',
        group: 'Завершение ревью',
        title: 'панель без черновиков',
        render: () => <BarState threads={[]} />,
    },
    {
        id: 'review-ship-menu',
        group: 'Завершение ревью',
        title: 'меню шипа с гардом: Ship, Sticky ship, Comment',
        render: () => <BarState threads={DRAFT_THREADS} menuOpen />,
    },
    {
        id: 'review-bar-comment-mode',
        group: 'Завершение ревью',
        title: 'действующий режим Comment, остальные режимы в меню',
        render: () => <BarState threads={DRAFT_THREADS} shipMode="comment" />,
    },
    {
        id: 'review-sticky-unavailable',
        group: 'Завершение ревью',
        title: 'Sticky ship недоступен',
        render: () => (
            <BarState threads={DRAFT_THREADS} menuOpen verdicts={['comment', 'ship', 'request_changes']} />
        ),
    },
    {
        id: 'review-bar-comment-only',
        group: 'Завершение ревью',
        title: 'только Comment: свой PR на GitHub, кнопка без каретки',
        render: () => <BarState threads={DRAFT_THREADS} verdicts={COMMENT_ONLY} />,
    },
    {
        id: 'review-bar-comment-only-empty',
        group: 'Завершение ревью',
        title: 'только Comment, черновиков нет',
        render: () => <BarState threads={[]} verdicts={COMMENT_ONLY} />,
    },
    {
        id: 'review-bar-local',
        group: 'Завершение ревью',
        title: 'локальное ревью: черновики уходят агенту',
        render: () => <BarState threads={DRAFT_THREADS} verdicts={COMMENT_ONLY} reviewHost={localHostName('arc')} />,
    },
    {
        id: 'review-bar-local-verdicts',
        group: 'Завершение ревью',
        title: 'локальное ревью с вердиктами: Request changes и Ship без каретки',
        render: () => <BarState threads={DRAFT_THREADS} verdicts={LOCAL_VERDICTS} reviewHost={localHostName('arc')} />,
    },
    {
        id: 'review-bar-local-verdicts-empty',
        group: 'Завершение ревью',
        title: 'локальное ревью с вердиктами, черновиков нет: Ship доступен',
        render: () => <BarState threads={[]} verdicts={LOCAL_VERDICTS} reviewHost={localHostName('arc')} />,
    },
    {
        id: 'review-publish-error',
        group: 'Завершение ревью',
        title: 'частичный провал публикации',
        render: () => <BarState threads={DRAFT_THREADS} failure={FAILURE} />,
    },
    {
        id: 'review-complete',
        group: 'Завершение ревью',
        title: 'Review complete',
        render: () => <CompleteState completion={COMPLETION} />,
    },
    {
        id: 'review-complete-comment',
        group: 'Завершение ревью',
        title: 'Review complete без вердикта',
        render: () => (
            <CompleteState
                completion={{ ...COMPLETION, verdict: 'comment', openThreads: 2, firstOpenThreadId: 'thread-open' }}
            />
        ),
    },
    {
        id: 'review-complete-local',
        group: 'Завершение ревью',
        title: 'Review complete локального ревью',
        render: () => (
            <CompleteState
                completion={{ ...COMPLETION, reviewHost: localHostName('arc'), hostName: 'локальный чекаут' }}
            />
        ),
    },
    {
        id: 'review-complete-open-thread',
        group: 'Завершение ревью',
        title: 'Review complete с открытым тредом',
        render: () => (
            <CompleteState
                completion={{
                    ...COMPLETION,
                    verdict: 'sticky_ship',
                    openThreads: 3,
                    firstOpenThreadId: 'thread-open',
                }}
            />
        ),
    },
];

function withDraft(threads: readonly Thread[]): Thread[] {
    const first = threads[0];
    if (first === undefined) {
        throw new Error('для состояния панели нужен хотя бы один тред');
    }
    return [{ ...first, root: { ...first.root, draft: true } }, ...threads.slice(1)];
}

interface FixtureReviewActionBarProps {
    readonly threads: readonly Thread[];
    readonly menuOpen?: boolean;
    readonly failure?: PublicationFailure | null;
    readonly verdicts?: readonly Verdict[];
    readonly reviewHost?: string;
    /** Сохранённый режим сплит-кнопки; без него — настройки страницы. */
    readonly shipMode?: UiSettings['shipMode'];
}

/** Настоящая панель действий на фикстуре `medium`: её показывают карточки завершения и тур. */
export function FixtureReviewActionBar({
    threads,
    menuOpen = false,
    failure = null,
    verdicts = DATA.pr.capabilities.publishVerdicts,
    reviewHost = 'fixture',
    shipMode,
}: FixtureReviewActionBarProps) {
    const diffStore = useMemo(() => createDiffViewStore({ files: DATA.diff.files }), []);
    const threadStore = useMemo(
        () => createThreadStore(threads, new Set(DATA.diff.files.map((file) => file.fileId))),
        [threads],
    );
    const pr = useMemo<PrMeta>(
        () => ({ ...DATA.pr, capabilities: { ...DATA.pr.capabilities, publishVerdicts: [...verdicts] } }),
        [verdicts],
    );
    const settings = useMemo(
        () => (shipMode === undefined ? null : createUiSettingsStore({ loaded: true, initial: { shipMode } })),
        [shipMode],
    );
    const bar = (
        <ReviewActionBar
            pr={pr}
            diff={DATA.diff}
            diffStore={diffStore}
            threadStore={threadStore}
            connection="online"
            hostName="FixtureHost"
            reviewHost={reviewHost}
            composerTransport={TRANSPORT}
            onPublish={() => Promise.reject(new Error('галерея не пишет в хост'))}
            onComplete={() => undefined}
            defaultMenuOpen={menuOpen}
            initialFailure={failure}
        />
    );
    return settings === null ? bar : <SettingsProvider store={settings}>{bar}</SettingsProvider>;
}

function BarState(props: FixtureReviewActionBarProps) {
    return (
        <div className="gallery__viewport gallery-review-actions">
            <FixtureReviewActionBar {...props} />
        </div>
    );
}

function CompleteState({ completion }: { completion: ReviewCompletion }) {
    return (
        <div className="gallery__viewport gallery-review-complete">
            <ReviewComplete completion={completion} onOpenThread={() => undefined} onOpenFullDiff={() => undefined} />
        </div>
    );
}

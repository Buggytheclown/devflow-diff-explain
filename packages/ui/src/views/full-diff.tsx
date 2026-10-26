import type {
    AgentNote,
    FileContent,
    FileDiff,
    PrDiff,
    PrMeta,
    RouteSnapshot,
    Thread,
    UiChatAskAnchor,
    UiReviewLensesResponse,
    UiReviewProgressResponse,
} from '@sherpa/protocol';
import type { CSSProperties, ReactNode } from 'react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';

import {
    fetchFileContent,
    setReviewThreadResolved,
} from '../api.js';
import { placeRangeQuestion } from '../components/chat-prompts.js';
import type { PrHeaderCounts } from '../components/pr-header.tsx';
import { PrHeader, prHeaderCounts } from '../components/pr-header.tsx';
import { chatAnchorFromSelection, SelectionPopover } from '../components/selection-popover.tsx';
import type { AuthorLens } from '../components/toolbar-controls.tsx';
import { ToolbarRightCluster } from '../components/toolbar-controls.tsx';
import type { DiffClient } from '../diff/client.js';
import { createDiffClient } from '../diff/client.js';
import type { DiffFileModel } from '../diff/model.js';
import { toParseRequest } from '../diff/model.js';
import { expandContext } from '../diff-view/context-expansion.js';
import type { HunkExpandRequest } from '../diff-view/hunk-expansion.js';
import { hunkContextRequests } from '../diff-view/hunk-expansion.js';
import type { FileExpansion } from '../diff-view/expand.js';
import type { Feedback } from '../diff-view/file-card.tsx';
import { shownFileModel } from '../diff-view/file-card.tsx';
import type { DiffListHandle } from '../diff-view/file-list.tsx';
import { DiffFileList } from '../diff-view/file-list.tsx';
import { findLineRow, flashRow, lineAt } from '../diff-view/line-target.js';
import { selectedLineRange } from '../diff-view/selection.js';
import type { DiffViewSnapshot, DiffViewStore } from '../diff-view/store.js';
import { createDiffViewStore, fileCollapseReason } from '../diff-view/store.js';
import '../diff-view/diff-view.css';
import type { FileFilter } from '../filters/lens-filters.js';
import {
    ALL_FILTER_ID,
    buildFileFilters,
    filterFiles,
    findFilter,
    PCI_FILTER_ID,
    selectFilter,
    zeroResultText,
} from '../filters/lens-filters.js';
import { readFragmentParam } from '../fragment.js';
import { PENDING_DELAY_MS, useDelayedPending } from '../components/use-delayed-pending.js';
import { useReadOnlyIteration } from '../iterations/read-only.tsx';
import type { MessageKey } from '../i18n/index.js';
import { shortCommit, useT } from '../i18n/index.js';
import { useTurnNoteIntoDraft } from '../notes/use-note-draft.js';
import type { PaletteNavigation } from '../palette/diff-source.tsx';
import { usePrStateStore } from '../pr-state/context.tsx';
import { collapsedFromMap, collapsedToMap } from '../pr-state/pr-state-store.js';
import { readSelectionLink } from '../selection-link.js';
import { createProgressWriter } from '../progress/progress-writer.js';
import type { ProgressWriter, StopFileWriterHooks, StopWriterHooks } from '../progress/progress-writer.js';
import { buildRouteMargin } from '../route/margin-model.js';
import type { MarginStripActions } from '../route/route-margin.tsx';
import type { SessionStore } from '../session/session-store.js';
import { useUiSettingsStore } from '../settings/context.tsx';
import { usePointerTarget, useShortcut } from '../shortcuts/context.tsx';
import { neighbourId, unreadNeighbourId } from '../shortcuts/navigation.js';
import type { ComposerTransport } from '../threads/composer.js';
import { createComposerTransport, createPublishedCommentTransport } from '../threads/transport.js';
import type { PublishedCommentTransport } from '../threads/transport.js';
import { authorDisplayName, threadFileId, threadIsVisible } from '../threads/model.js';
import { persistentThreadStore } from '../threads/persistent-store.js';
import { createThreadActions } from '../threads/actions.js';
import { openFileComposer, openNewComposer, openReply, OutsideThreads } from '../threads/thread-list.tsx';
import type { ThreadActions } from '../threads/thread-list.tsx';
import type { ThreadStore } from '../threads/store.js';
import type { FileOutlineModel, FileTreeCursor, OutlineEntry } from '../tree/file-panel.tsx';
import { FilePanel } from '../tree/file-panel.tsx';
import './full-diff.css';

/**
 * Вью «Полный дифф» (docs/design/README.md §10): шапка PR и липкий тулбар идут во всю ширину, ниже стоят
 * панель с деревом файлов и карточки диффа. Фильтр — одна модель на дерево и на карточки, живёт в сессионном
 * сторе и потому переживает перезагрузку через фрагмент URL.
 */

export interface FullDiffViewProps {
    readonly token: string;
    readonly prKey: string;
    readonly session: SessionStore;
    readonly pr: PrMeta | null;
    /** Сырые патчи грузятся на уровне App, чтобы палитра работала поверх любой вью. */
    readonly diff: PrDiff | null;
    readonly diffError: string | null;
    readonly lenses: UiReviewLensesResponse | null;
    readonly lensesError: string | null;
    readonly progress: UiReviewProgressResponse | null;
    readonly progressError: string | null;
    /** Общий writer из App: один экземпляр для панели и Full diff. */
    readonly progressWriter: ProgressWriter | null;
    readonly store: DiffViewStore | null;
    /** Общий разборщик приложения; без него вью поднимает свой воркер (галерея, тесты). */
    readonly parse?: (file: FileDiff) => Promise<DiffFileModel>;
    readonly threadStore: ThreadStore | null;
    readonly agentConnected: boolean;
    readonly onAskSelection: (anchor: UiChatAskAnchor) => void;
    readonly isSelectionPending: (anchor: UiChatAskAnchor | null) => boolean;
    readonly onSelectionAnchorChange: (anchor: UiChatAskAnchor | null) => void;
    /**
     * Подставить вопрос в композер чата (docs/design/README.md §10): штрихованная полоса спрашивает про свой
     * диапазон. Вопрос не отправляется — его дочитывает и шлёт ревьюер.
     */
    readonly onComposeQuestion?: (text: string, anchor?: UiChatAskAnchor) => void;
    readonly notes?: readonly AgentNote[];
    readonly onOpenNoteInChat?: (note: AgentNote) => void;
    readonly onDeleteNote?: (noteId: number) => Promise<void>;
    readonly selectionNavigationRequest?: number;
    readonly paletteNavigation?: PaletteNavigation | null;
    readonly onPaletteActiveFileChange?: (fileId: string | null) => void;
    readonly onFilterChangeHandler?: (handler: ((id: string) => void) | null) => void;
    /**
     * Готовый маршрут для полей ридера (docs/design/README.md §10). Только `ready`: в `filling` покрытие
     * недостроено, и «не размещено» врало бы про незанятый слот плана. Нет снапшота — нет и слоя.
     */
    readonly routeSnapshot?: RouteSnapshot | null;
    readonly onJumpToStop?: ((stopId: string) => void) | undefined;
    /** PR ниже порога маршрута: тихая нота в шапке ридера (docs/design/SPEC-elements.md §4.1). */
    readonly smallPr?: boolean;
    /** Правый край шапки PR: пикер снапшотов из App (docs/design/README.md §1). */
    readonly headerAside?: ReactNode;
    /** Вкладка смотрит срез между итерациями: коммиты его сторон. */
    readonly slice?: SliceCommits | null;
    /** Выход из среза: пустой срез и ошибка ручки возвращают к активной итерации. */
    readonly onActiveIteration?: () => void;
    /** Задержка скелетона (docs/design/SPEC-elements.md §3: до 200 мс ничего); 0 — галерея показывает его сразу. */
    readonly skeletonDelayMs?: number;
}

export interface SliceCommits {
    readonly baseCommit: string;
    readonly headCommit: string;
}

export function FullDiffView({
    token,
    prKey,
    session,
    pr,
    diff,
    diffError,
    lenses,
    lensesError,
    progress,
    progressError,
    progressWriter,
    store,
    parse: sharedParse,
    threadStore,
    agentConnected,
    onAskSelection,
    isSelectionPending,
    onSelectionAnchorChange,
    onComposeQuestion,
    notes = EMPTY_NOTES,
    onOpenNoteInChat = EMPTY_OPEN_NOTE,
    onDeleteNote = EMPTY_DELETE_NOTE,
    selectionNavigationRequest = 0,
    paletteNavigation = null,
    onPaletteActiveFileChange,
    onFilterChangeHandler,
    routeSnapshot = null,
    onJumpToStop,
    smallPr = false,
    headerAside,
    slice = null,
    onActiveIteration,
    skeletonDelayMs = SKELETON_DELAY_MS,
}: FullDiffViewProps) {
    const t = useT();
    const clientRef = useRef<DiffClient | null>(null);
    // Свой воркер — только без общего разборщика App: поднимается первым разбором и закрывается
    // вместе с вью. Ссылка, а не `useMemo`: закрытый клиент не воскресает, а StrictMode монтирует вью дважды.
    useEffect(
        () => () => {
            clientRef.current?.close();
            clientRef.current = null;
        },
        [],
    );

    const diffId = diff?.diffId ?? null;
    const ownParse = useCallback(
        (file: FileDiff) => {
            clientRef.current ??= createDiffClient();
            return clientRef.current.parseFile(diffId ?? '', toParseRequest(file));
        },
        [diffId],
    );
    const parse = sharedParse ?? ownParse;
    const loadContent = useCallback((fileId: string) => fetchFileContent(token, fileId), [token]);
    const threadTransport = useMemo(() => createComposerTransport(token), [token]);
    const publishedTransport = useMemo(() => createPublishedCommentTransport(token), [token]);
    const resolveThread = useCallback(
        (threadId: string, resolved: boolean) => setReviewThreadResolved(token, threadId, resolved),
        [token],
    );
    const [fragmentTarget, setFragmentTarget] = useState(() => ({
        fileId: readFragmentParam(window.location.hash, 'file'),
        threadId: readFragmentParam(window.location.hash, 'thread'),
        selection: readSelectionLink(window.location.hash),
    }));
    useEffect(() => {
        const read = (): void => {
            setFragmentTarget({
                fileId: readFragmentParam(window.location.hash, 'file'),
                threadId: readFragmentParam(window.location.hash, 'thread'),
                selection: readSelectionLink(window.location.hash),
            });
        };
        window.addEventListener('hashchange', read);
        return () => {
            window.removeEventListener('hashchange', read);
        };
    }, []);
    const requestedSelectionTarget = useMemo(
        () =>
            selectionNavigationRequest === 0 ? fragmentTarget.selection : readSelectionLink(window.location.hash),
        [fragmentTarget.selection, selectionNavigationRequest],
    );
    const failure = diffError ?? lensesError ?? (progress === null ? progressError : null);
    // Хром вью один и тот же на всех кадрах: шапка PR с индикатором и панель на месте, пока грузится
    // или не сложилось содержимое (docs/design/SPEC-elements.md §3 — приземление данных не двигает раскладку).
    const frame = { pr, counts: diff === null ? null : prHeaderCounts(diff), headerAside };
    if (failure !== null) {
        return (
            <StatusFrame {...frame}>
                <p className="full-diff__status">{failure}</p>
                {slice === null || onActiveIteration === undefined ? null : (
                    <ActiveIterationAction onActiveIteration={onActiveIteration} />
                )}
            </StatusFrame>
        );
    }
    // Пустой срез — честный экран, а не пустой список файлов: между итерациями ничего нет.
    if (slice !== null && diff !== null && diff.files.length === 0) {
        return (
            <StatusFrame {...frame}>
                <div className="full-diff__zero">
                    <p className="full-diff__zero-text">
                        {t('fullDiff.sliceEmpty', shortCommit(slice.baseCommit), shortCommit(slice.headCommit))}
                    </p>
                    {onActiveIteration === undefined ? null : (
                        <button type="button" className="ctl ctl--secondary full-diff__zero-action" onClick={onActiveIteration}>
                            {t('iteration.toActive')}
                        </button>
                    )}
                </div>
            </StatusFrame>
        );
    }
    // Пустой PR (docs/design/SPEC-elements.md §4.1): изменений нет вовсе — честный экран вместо пустого списка файлов.
    // Панель действий живёт уровнем выше и остаётся на месте: шипнуть пустой PR можно.
    if (slice === null && diff !== null && diff.files.length === 0) {
        return (
            <StatusFrame {...frame}>
                <EmptyPrNotice />
            </StatusFrame>
        );
    }
    if (
        pr === null ||
        diff === null ||
        lenses === null ||
        progress === null ||
        progressWriter === null ||
        store === null ||
        threadStore === null
    ) {
        return (
            <StatusFrame {...frame}>
                <DiffSkeleton delayMs={skeletonDelayMs} note={slice === null ? null : SLICE_LOADING_NOTE} />
            </StatusFrame>
        );
    }

    return (
        <DiffWorkspace
            pr={pr}
            diff={diff}
            lenses={lenses}
            progress={progress}
            prKey={prKey}
            session={session}
            store={store}
            threadStore={threadStore}
            paletteNavigation={paletteNavigation}
            {...(onPaletteActiveFileChange === undefined ? {} : { onPaletteActiveFileChange })}
            {...(onFilterChangeHandler === undefined ? {} : { onFilterChangeHandler })}
            parse={parse}
            loadContent={loadContent}
            progressWriter={progressWriter}
            threadTransport={threadTransport}
            publishedTransport={publishedTransport}
            onResolveThread={resolveThread}
            initialFileId={requestedSelectionTarget?.fileId ?? fragmentTarget.fileId}
            initialThreadId={fragmentTarget.threadId}
            initialSelectionTarget={requestedSelectionTarget}
            selectionNavigationRequest={selectionNavigationRequest}
            agentConnected={agentConnected}
            onAskSelection={onAskSelection}
            isSelectionPending={isSelectionPending}
            onSelectionAnchorChange={onSelectionAnchorChange}
            {...(onComposeQuestion === undefined ? {} : { onComposeQuestion })}
            notes={notes}
            onOpenNoteInChat={onOpenNoteInChat}
            onDeleteNote={onDeleteNote}
            routeSnapshot={routeSnapshot}
            onJumpToStop={onJumpToStop}
            smallPr={smallPr}
            {...(headerAside === undefined ? {} : { headerAside })}
            slice={slice}
        />
    );
}

/** Задержка скелетона: до 200 мс не мигаем ничем (docs/design/SPEC-elements.md §3). */
const SKELETON_DELAY_MS = PENDING_DELAY_MS;

/**
 * Срез считает хост (у Арканума 2.8–3.7 с), поэтому ожидание объясняется словами. Хост здесь
 * не назван: UI хостов не различает, а имя есть только в состоянии App.
 */
const SLICE_LOADING_NOTE: MessageKey = 'fullDiff.slice.loading';

/**
 * Рамка статусного кадра: шапка PR со своим `aside` (индикатор среза и пикер остаются на месте
 * все секунды ожидания), тот же тулбар и та же пара «панель файлов + колонка карточек», что
 * и у загруженной вью. Счётчиков до диффа нет — мета-строка идёт без них.
 */
function StatusFrame({
    pr,
    counts,
    headerAside,
    children,
}: {
    pr: PrMeta | null;
    counts: PrHeaderCounts | null;
    headerAside?: ReactNode;
    children: ReactNode;
}) {
    const t = useT();
    return (
        <main className="full-diff full-diff--status">
            {pr === null ? null : (
                <PrHeader
                    pr={pr}
                    counts={counts}
                    pci={null}
                    pciActive={false}
                    onTogglePci={NO_PCI_TOGGLE}
                    aside={headerAside}
                />
            )}
            <div className="full-diff__toolbar">
                <h1 className="full-diff__title">{t('view.diff')}</h1>
            </div>
            <div className="full-diff__body">
                <div className="full-diff__panel-placeholder" aria-hidden="true" />
                <div className="full-diff__main">{children}</div>
            </div>
        </main>
    );
}

/** Экран пустого PR (docs/design/SPEC-elements.md §4.1); те же две строки показывает Обзор. */
export function EmptyPrNotice() {
    const t = useT();
    return (
        <div className="full-diff__zero full-diff__zero--empty-pr">
            <p className="full-diff__zero-text">{t('emptyPr.title')}</p>
            <p className="full-diff__zero-note">{t('emptyPr.text')}</p>
        </div>
    );
}

/** В статусном кадре чипа PCI нет: линзы к этому моменту ещё не сложились. */
const NO_PCI_TOGGLE = (): void => undefined;

function ActiveIterationAction({ onActiveIteration }: { onActiveIteration: () => void }) {
    const t = useT();
    return (
        <div className="full-diff__status-actions">
            <button type="button" className="ctl ctl--secondary full-diff__zero-action" onClick={onActiveIteration}>
                {t('iteration.toActive')}
            </button>
        </div>
    );
}

/**
 * Скелетон списка файлов (docs/design/SPEC-elements.md §3: «per-file skeleton cards, 3 visible»). Первые 200 мс —
 * ничего, чтобы быстрый ответ не мигал; высота карточки равна свёрнутой карточке файла,
 * поэтому приземление данных не двигает раскладку.
 */
function DiffSkeleton({ delayMs, note }: { delayMs: number; note: MessageKey | null }) {
    const t = useT();
    const shown = useDelayedPending(true, delayMs);

    if (!shown) {
        return null;
    }
    return (
        <div className="full-diff__skeleton" role="status" aria-label={t('fullDiff.skeleton.aria')}>
            {note === null ? null : <p className="full-diff__skeleton-note">{t(note)}</p>}
            {SKELETON_CARDS.map((card) => (
                <div key={card} className="diff-skeleton-card" aria-hidden="true">
                    <div className="diff-skeleton-card__head" />
                    <div className="diff-skeleton-card__row" />
                </div>
            ))}
        </div>
    );
}

const SKELETON_CARDS = [0, 1, 2] as const;

/** «Раскрыть файл» в срезе: содержимое головы к его `fileId` не привязать. */
const SLICE_NO_CONTENT_REASON: MessageKey = 'fullDiff.slice.noContent';

/** «Спросить агента» в срезе: якорь вопроса лёг бы на `fileId`, которого в итерации нет. */
const SLICE_NO_ASK_REASON: MessageKey = 'fullDiff.slice.noAsk';

export interface DiffWorkspaceProps {
    readonly pr: PrMeta;
    readonly diff: PrDiff;
    readonly lenses: UiReviewLensesResponse;
    /** Стартовый прогресс чтения; без него стор поднимается на умолчаниях (галерея передаёт стор). */
    readonly progress?: UiReviewProgressResponse;
    readonly threads?: readonly Thread[];
    readonly prKey: string;
    readonly session: SessionStore;
    /** См. комментарий у `parse` в `diff-view/file-list.tsx`. */
    readonly parse: (file: FileDiff) => Promise<DiffFileModel>;
    readonly loadContent: (fileId: string) => Promise<FileContent | null>;
    /** Запись отметки для автономного workspace (галерея и тесты). */
    readonly onSetViewed?: (fileId: string, viewed: boolean) => Promise<number>;
    /** В приложении один writer создаётся уровнем выше и переживает ремаунт Full diff. */
    readonly progressWriter?: ProgressWriter;
    /** Перечитывание прогресса по SSE-событию для автономного workspace. */
    readonly reloadProgress?: () => Promise<UiReviewProgressResponse>;
    readonly progressRevision?: number | null;
    readonly reloadThreads?: () => Promise<readonly Thread[]>;
    readonly threadsRevision?: number | null;
    readonly threadTransport?: ComposerTransport;
    /** Записи по опубликованным комментариям; без него резолва, правки и удаления в UI нет. */
    readonly publishedTransport?: PublishedCommentTransport;
    readonly onResolveThread?: (threadId: string, resolved: boolean) => Promise<void>;
    readonly initialFileId?: string | null;
    readonly initialThreadId?: string | null;
    readonly initialSelectionTarget?: { readonly fileId: string; readonly side: 'old' | 'new'; readonly start: number } | null;
    readonly selectionNavigationRequest?: number;
    readonly agentConnected?: boolean;
    readonly onAskSelection?: (anchor: UiChatAskAnchor) => void;
    readonly isSelectionPending?: (anchor: UiChatAskAnchor | null) => boolean;
    readonly onSelectionAnchorChange?: (anchor: UiChatAskAnchor | null) => void;
    /** См. `FullDiffViewProps.onComposeQuestion`; без него у полосы нет кнопки «разложить». */
    readonly onComposeQuestion?: (text: string, anchor?: UiChatAskAnchor) => void;
    readonly notes?: readonly AgentNote[];
    readonly onOpenNoteInChat?: (note: AgentNote) => void;
    readonly onDeleteNote?: (noteId: number) => Promise<void>;
    /** Готовый маршрут на полях ридера (docs/design/README.md §10); null — Full diff как без маршрута. */
    readonly routeSnapshot?: RouteSnapshot | null;
    readonly onJumpToStop?: ((stopId: string) => void) | undefined;
    /** См. `FullDiffViewProps.smallPr`. */
    readonly smallPr?: boolean;
    /** См. `FullDiffViewProps.headerAside`. */
    readonly headerAside?: ReactNode;
    /**
     * Вкладка смотрит срез между итерациями: `fileId` там из другого пространства
     * имён, поэтому содержимое файлов хосту не заказывается.
     */
    readonly slice?: SliceCommits | null;
    /** Фиксированные часы для галереи; в приложении снимаются при монтировании вью. */
    readonly threadNow?: number;
    /** Стор дифф-вью; без него создаётся свой. Галерея передаёт заранее наполненный. */
    readonly store?: DiffViewStore;
    readonly threadStore?: ThreadStore;
    readonly paletteNavigation?: PaletteNavigation | null;
    readonly onPaletteActiveFileChange?: (fileId: string | null) => void;
    readonly onFilterChangeHandler?: (handler: ((id: string) => void) | null) => void;
    /** Только галерея: группа «вне диффа» в подвале должна попасть в кадр раскрытой. */
    readonly outsideThreadsOpen?: boolean;
}

export function DiffWorkspace(props: DiffWorkspaceProps) {
    const t = useT();
    const {
        pr,
        diff,
        lenses,
        prKey,
        session,
        parse,
        loadContent,
        onSetViewed = EMPTY_SET_VIEWED,
        reloadProgress,
        progressRevision = null,
        reloadThreads,
        threadsRevision = null,
        initialFileId = null,
        initialThreadId = null,
        initialSelectionTarget = null,
        selectionNavigationRequest = 0,
        agentConnected = false,
        onAskSelection = EMPTY_ASK_SELECTION,
        isSelectionPending = NO_SELECTION_PENDING,
        onSelectionAnchorChange = NO_SELECTION_ANCHOR_CHANGE,
        onComposeQuestion,
        notes = EMPTY_NOTES,
        onOpenNoteInChat = EMPTY_OPEN_NOTE,
        onDeleteNote = EMPTY_DELETE_NOTE,
        routeSnapshot = null,
        onJumpToStop,
        paletteNavigation = null,
        onPaletteActiveFileChange,
        onFilterChangeHandler,
        outsideThreadsOpen = false,
        slice = null,
    } = props;
    /** Содержимое файлов заказывается по `fileId` итерации: у среза они из чужого пространства. */
    const contentAvailable = pr.capabilities.fileContent && slice === null;
    // По той же причине в срезе не спрашивают агента: якорь вопроса лёг бы на `fileId`, которого
    // в активной итерации нет, и ответная заметка потеряла бы свой файл. Выделение не уезжает и
    // в композер чата — заякорить его там нечем.
    const selectionAnchorChange = slice === null ? onSelectionAnchorChange : NO_SELECTION_ANCHOR_CHANGE;
    const [threadNow] = useState(() => props.threadNow ?? Date.now());
    // Свёрнутость карточек — из состояния PR на сервере; снимок берётся один раз, чтобы
    // опоздавший ответ ручки не пересоздал стор под ревьюером.
    const prState = usePrStateStore();
    const initialCollapsed = useMemo(() => collapsedToMap(prState.getSnapshot().diffCollapsed), [prState]);

    const initialProgress = props.progress;
    const settings = useUiSettingsStore();
    const createdStore = useMemo(
        () =>
            createDiffViewStore({
                files: diff.files,
                ...(initialProgress === undefined ? {} : { progress: initialProgress.files }),
                collapsed: initialCollapsed,
                // Свой стор здесь только у галереи и тестов, но режим и им берётся из настроек.
                diffMode: settings.getSnapshot().diffMode,
                onDiffModeChange: (mode) => {
                    settings.update({ diffMode: mode });
                },
            }),
        [diff, initialCollapsed, initialProgress, settings],
    );
    const store = props.store ?? createdStore;
    const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot);
    useEffect(() => {
        // Со своим стором вью не владеет свёрнутостью: её пишет тот, кто стор создал (App).
        if (props.store === undefined) {
            prState.update({ diffCollapsed: collapsedFromMap(snapshot.collapsePreferences) });
        }
    }, [prState, props.store, snapshot.collapsePreferences]);
    useEffect(() => {
        if (props.store !== undefined && props.progressWriter === undefined && initialProgress !== undefined) {
            store.setProgress(initialProgress.files);
        }
    }, [initialProgress, props.progressWriter, props.store, store]);
    const fileIds = useMemo(() => new Set(diff.files.map((file) => file.fileId)), [diff.files]);
    const initialThreads = props.threads ?? EMPTY_THREADS;
    const threadStore = useMemo(
        () => props.threadStore ?? persistentThreadStore(prKey, diff.diffId, initialThreads, fileIds),
        [diff.diffId, fileIds, initialThreads, prKey, props.threadStore],
    );
    useEffect(() => {
        if (props.threads !== undefined) {
            threadStore.setServerThreads(props.threads);
        }
    }, [props.threads, threadStore]);
    const threadSnapshot = useSyncExternalStore(threadStore.subscribe, threadStore.getSnapshot);
    const threadTransport = props.threadTransport ?? EMPTY_THREAD_TRANSPORT;
    const publishedTransport = props.publishedTransport;
    const resolveThread = props.onResolveThread ?? EMPTY_RESOLVE;
    const { commentIssues, commentResolve, editPublished } = pr.capabilities;
    const threadActions = useMemo<ThreadActions>(
        () =>
            createThreadActions(
                threadStore,
                threadTransport,
                resolveThread,
                publishedTransport === undefined
                    ? undefined
                    : { transport: publishedTransport, commentResolve, editPublished },
                commentIssues,
            ),
        [
            commentIssues,
            commentResolve,
            editPublished,
            publishedTransport,
            resolveThread,
            threadStore,
            threadTransport,
        ],
    );
    const turnNoteIntoDraft = useTurnNoteIntoDraft({
        threadStore,
        clearSelection: store.clearSelection,
        commentIssues: pr.capabilities.commentIssues,
    });
    const noteActions = useMemo(
        () => ({ onOpenInChat: onOpenNoteInChat, onTurnIntoDraft: turnNoteIntoDraft, onDelete: onDeleteNote }),
        [onDeleteNote, onOpenNoteInChat, turnNoteIntoDraft],
    );
    const { filter: filterId, threadAuthor } = useSyncExternalStore(session.subscribe, session.getSnapshot);
    const filters = useMemo(
        () =>
            buildFileFilters({
                files: diff.files,
                ownership: lenses.ownership,
                extra: lenses.extra,
                t,
                zoneSource: lenses.ownershipSource,
            }),
        [diff.files, lenses, t],
    );
    const filter = selectFilter(filters, filterId);

    // Незнакомый или выключенный фильтр из адреса чинится в самом адресе: иначе ссылка
    // продолжала бы обещать вид, которого нет.
    useEffect(() => {
        if (filter.id !== filterId) {
            session.setFilter(filter.id);
        }
    }, [filter.id, filterId, session]);

    // Верхняя карточка вьюпорта: по ней вью понимает, какой файл ревьюер читает прямо сейчас.
    // Нужна и смене фильтра («kept in view», docs/design/SPEC-elements.md §2.7), и переходу к следующему файлу после
    // отметки, поэтому дублируется в ref — обработчики видят её без пересборки.
    const [topFileId, setTopFileId] = useState<string | null>(null);
    const topRef = useRef<string | null>(null);
    useEffect(() => {
        topRef.current = topFileId;
    }, [topFileId]);

    // Прогресс чтения: оптимистичная запись, откат по провалу и сходимость вкладок по SSE.
    // Порядок записей, откат и учёт ревизий держит `ProgressWriter` — вью только рисует.
    const [writesSettled, setWritesSettled] = useState(0);
    const [writeError, setWriteError] = useState<{ fileId: string; viewed: boolean } | null>(null);
    const createdWriter = useMemo(
        () =>
            createProgressWriter({
                initialRevision: initialProgress?.progressRevision ?? 0,
                read: (fileId) => store.getSnapshot().progress.get(fileId) ?? null,
                apply: store.markViewed,
                restore: store.restoreProgress,
                send: onSetViewed,
                // Отметок остановок в полном диффе нет: маршрут живёт на своей вью.
                stops: NO_STOP_WRITES,
                stopFiles: NO_STOP_FILE_WRITES,
                // Записи в полёте откладывают перечитку — её решение пересматривается после ответа.
                onSettled: () => {
                    setWritesSettled((settled) => settled + 1);
                },
            }),
        [initialProgress?.progressRevision, onSetViewed, store],
    );
    const writer = props.progressWriter ?? createdWriter;

    /**
     * Файл, от которого экран уходит к следующему после отметки. Сам переход считается и
     * запускается эффектом: в обработчике список ещё живёт старыми высотами карточек. Список
     * получает этот же id и не якорится на схлопнувшуюся карточку.
     */
    const [advanceFrom, setAdvanceFrom] = useState<string | null>(null);

    const markViewed = useCallback(
        async function mark(fileId: string, viewed: boolean): Promise<Feedback> {
            setWriteError(null);
            // «Прокрутка следует за сворачиванием»: отмечен файл,
            // который ревьюер сейчас читает, — экран идёт к следующему. Снятие отметки, отметка
            // любого другого файла и неинтерактивные переключения прокрутку не трогают.
            if (viewed && fileId === topRef.current) {
                setAdvanceFrom(fileId);
            }
            if (await writer.write(fileId, viewed)) {
                return null;
            }
            // Оптимизм не оправдался: контрол уже вернулся в прежнее состояние (docs/design/SPEC-elements.md §1.2),
            // осталось предложить повтор.
            return { text: t('diff.file.notSaved'), retry: () => mark(fileId, viewed) };
        },
        [t, writer],
    );

    /**
     * Запись из дерева: у строки дерева нет своего места под подсказку, поэтому провал показывает
     * панель — карточка отмеченного файла может быть даже не в DOM (виртуализация).
     */
    const writeFromTree = useCallback(
        (fileId: string, viewed: boolean) => {
            void markViewed(fileId, viewed).then((feedback) => {
                setWriteError(feedback === null ? null : { fileId, viewed });
            });
        },
        [markViewed],
    );

    // Тогл клавишей `v`: состояние читается из стора, потому что клавиша приходит без него.
    const toggleViewed = useCallback(
        (fileId: string) => {
            writeFromTree(fileId, store.getSnapshot().readState.get(fileId)?.state !== 'read');
        },
        [store, writeFromTree],
    );

    // `writesSettled` в зависимостях ради отложенного решения: событие своей записи приходит
    // раньше ответа ручки, и без повторного захода оно осталось бы лишним запросом.
    useEffect(() => {
        if (reloadProgress === undefined || !writer.shouldReload(progressRevision)) {
            return;
        }
        let alive = true;
        const mark = writer.beginReload();
        void reloadProgress().then(
            (response) => {
                const merged = alive ? writer.finishReload(response, mark) : null;
                if (merged !== null) {
                    store.setProgress(merged.files);
                }
            },
            () => {
                // Прогресс не перечитался — на экране остаётся последнее известное состояние.
            },
        );
        return () => {
            alive = false;
        };
    }, [progressRevision, writesSettled, reloadProgress, store, writer]);

    const seenThreadsRevision = useRef<number | null>(null);
    const [threadsReloadAttempt, setThreadsReloadAttempt] = useState(0);
    useEffect(() => {
        if (
            reloadThreads === undefined ||
            threadsRevision === null ||
            threadsRevision === seenThreadsRevision.current
        ) {
            return;
        }
        let alive = true;
        let retry: ReturnType<typeof setTimeout> | null = null;
        void reloadThreads().then(
            (threads) => {
                if (alive) {
                    threadStore.setServerThreads(threads);
                    seenThreadsRevision.current = threadsRevision;
                    setThreadsReloadAttempt(0);
                }
            },
            () => {
                if (alive) {
                    // Ревизия не помечена увиденной: тот же снапшот повторяем без новой записи в хосте.
                    retry = setTimeout(() => {
                        setThreadsReloadAttempt((attempt) => attempt + 1);
                    }, Math.min(1000 * 2 ** threadsReloadAttempt, 15_000));
                }
            },
        );
        return () => {
            alive = false;
            if (retry !== null) {
                clearTimeout(retry);
            }
        };
    }, [reloadThreads, threadStore, threadsReloadAttempt, threadsRevision]);

    const [scrollElement, setScrollElement] = useState<HTMLElement | null>(null);
    const [scrollMarginElement, setScrollMarginElement] = useState<HTMLElement | null>(null);
    const listRef = useRef<DiffListHandle | null>(null);
    const [toolbarHeight, setToolbarHeight] = useState<number | null>(null);
    const [viewportHeight, setViewportHeight] = useState<number | null>(null);

    // Панель дерева получает высоту скроллпорта, а не окна: над вью могут стоять top bar и баннер.
    useLayoutEffect(() => {
        if (scrollElement === null) {
            return;
        }
        const report = (): void => {
            setViewportHeight(scrollElement.clientHeight);
        };
        report();
        const observer = new ResizeObserver(report);
        observer.observe(scrollElement);
        return () => {
            observer.disconnect();
        };
    }, [scrollElement]);
    const linkedThread = useMemo(
        () => threadSnapshot.threads.find((thread) => thread.id === initialThreadId) ?? null,
        [initialThreadId, threadSnapshot.threads],
    );
    // `fileId` треда — из активной итерации, поэтому в прошлой файл ищется по `path`.
    const linkedFileId = useMemo(
        () => (linkedThread === null ? null : threadFileId(linkedThread, threadSnapshot.iterationLayout)),
        [linkedThread, threadSnapshot.iterationLayout],
    );
    const [keptFileId, setKeptFileId] = useState<string | null>(null);

    // Пометка снимается следующей прокруткой ревьюера (docs/design/SPEC-elements.md §2.7). Собственную доводку списка
    // отличает сам список: программная прокрутка сюда не приходит.
    const onScroll = useCallback(() => {
        setKeptFileId(null);
    }, []);

    // Файл, к которому надо вернуть прокрутку после перекладки списка. Прокрутить прямо в
    // обработчике нельзя: список ещё живёт старым набором файлов, и индекс был бы чужой.
    const pendingScroll = useRef<string | null>(null);

    const changeFilter = useCallback(
        (id: string) => {
            const next = selectFilter(filters, id);
            if (next.id === filter.id) {
                return;
            }
            const top = topRef.current;
            const kept = top !== null && next.fileIds !== null && !next.fileIds.has(top) ? top : null;
            setKeptFileId(kept);
            // Ничто под курсором не исчезает (docs/design/SPEC-elements.md §2.7) и прокрутка держится за верхнюю
            // карточку (docs/design/SPEC-elements.md §2.6): после смены фильтра список возвращается к ней сам.
            pendingScroll.current = kept ?? top;
            session.setFilter(next.id);
        },
        [filter.id, filters, session],
    );
    useEffect(() => {
        if (onFilterChangeHandler === undefined) {
            return;
        }
        onFilterChangeHandler(changeFilter);
        return () => {
            onFilterChangeHandler(null);
        };
    }, [changeFilter, onFilterChangeHandler]);

    const shown = useMemo(() => {
        const ids = filter.fileIds;
        if (ids === null) {
            return diff.files;
        }
        return diff.files.filter(
            (file) =>
                ids.has(file.fileId) ||
                file.fileId === keptFileId ||
                file.fileId === linkedFileId ||
                file.fileId === initialFileId,
        );
    }, [diff.files, filter, initialFileId, keptFileId, linkedFileId]);
    const treeFiles = useMemo(() => filterFiles(diff.files, filter), [diff.files, filter]);

    useEffect(() => {
        if (initialThreadId === null) {
            return;
        }
        if (linkedFileId !== null) {
            void listRef.current?.scrollToFile(linkedFileId);
        }
        const selector = `#thread-${CSS.escape(initialThreadId)}`;
        const scroll = (): boolean => {
            const element = document.querySelector<HTMLElement>(selector);
            if (element === null) {
                return false;
            }
            element.scrollIntoView({ block: 'center' });
            element.focus({ preventScroll: true });
            return true;
        };
        if (scroll()) {
            return;
        }
        const observer = new MutationObserver(() => {
            if (scroll()) {
                observer.disconnect();
            }
        });
        observer.observe(document.body, { childList: true, subtree: true });
        return () => {
            observer.disconnect();
        };
    }, [
        initialThreadId,
        linkedFileId,
        shown,
        snapshot.expansion,
        snapshot.models,
        snapshot.whitespaceShown,
    ]);

    // Эффект, а не вызов из обработчика: к этому моменту список уже перерисован новым набором
    // файлов, и его императивная ручка знает нужный индекс.
    useEffect(() => {
        const target = pendingScroll.current;
        if (target === null) {
            return;
        }
        pendingScroll.current = null;
        void listRef.current?.scrollToFile(target);
    }, [shown]);

    // Переход к следующему файлу после отметки. Цель считается здесь, а не в обработчике:
    // к этому моменту отметка уже в сторе и видно, какие карточки ниже свёрнуты. Кадром позже —
    // чтобы список успел заменить замер свернувшейся карточки её новой оценкой.
    useEffect(() => {
        if (advanceFrom === null) {
            return;
        }
        const snapshot = store.getSnapshot();
        const next = nextFileToAdvance(shown, advanceFrom, (file) => fileCollapseReason(snapshot, file) !== null);
        if (next === null) {
            setAdvanceFrom(null);
            return;
        }
        const frame = requestAnimationFrame(() => {
            setAdvanceFrom(null);
            // Свёртку цели не трогаем: переход не разворачивает ни просмотренный, ни generated.
            void listRef.current?.scrollToFile(next, { reveal: false });
        });
        return () => {
            cancelAnimationFrame(frame);
        };
    }, [advanceFrom, shown, store]);

    const pci = findFilter(filters, PCI_FILTER_ID);
    // Ссылка обязана быть стабильной: от неё зависит пересборка дерева.
    const emptyIds = useMemo(() => new Set<string>(), []);
    const pciFileIds = pci?.fileIds ?? emptyIds;
    const mineFileIds = useMemo(() => {
        const { ownership } = lenses;
        if (ownership?.available !== true) {
            return null;
        }
        const paths = new Set(ownership.paths);
        return new Set(diff.files.filter((file) => paths.has(file.path)).map((file) => file.fileId));
    }, [diff.files, lenses]);

    /**
     * Маршрут на полях (docs/design/README.md §10). Карта файл→остановки считается по якорям и стоит сразу,
     * непокрытые диапазоны — по разобранным патчам, поэтому файлы, до которых ревьюер не
     * доскроллил, разбираются фоном: иначе числа футер-ноты не сошлись бы никогда.
     */
    const [failedParse, setFailedParse] = useState<ReadonlySet<string>>(EMPTY_FILE_IDS);
    // «Уже разбирали» — свойство конкретного стора: модели живут в нём, и при смене диффа
    // (стор пересоздаётся) те же fileId нужно разобрать заново, иначе они навсегда останутся
    // недосчитанными в ноте.
    const backgroundParsed = useRef<{ store: DiffViewStore; ids: Set<string> }>({ store, ids: new Set() });
    useEffect(() => {
        if (backgroundParsed.current.store !== store) {
            backgroundParsed.current = { store, ids: new Set() };
            setFailedParse((previous) => (previous.size === 0 ? previous : EMPTY_FILE_IDS));
        }
        if (routeSnapshot === null) {
            return;
        }
        const timer = setTimeout(() => {
            const parsed = backgroundParsed.current.ids;
            for (const file of diff.files) {
                if (parsed.has(file.fileId) || store.getSnapshot().models.has(file.fileId)) {
                    continue;
                }
                parsed.add(file.fileId);
                void parse(file).then(
                    (model) => {
                        store.setModel(file.fileId, model);
                    },
                    () => {
                        // Патч не разобрался: его строки в счёт не войдут, и нота скажет об этом.
                        setFailedParse((previous) => new Set(previous).add(file.fileId));
                    },
                );
            }
        }, BACKGROUND_PARSE_DELAY);
        return () => {
            clearTimeout(timer);
        };
    }, [diff.files, parse, routeSnapshot, store]);
    const routeMargin = useMemo(
        () =>
            routeSnapshot === null
                ? null
                : buildRouteMargin({
                      snapshot: routeSnapshot,
                      files: diff.files,
                      models: snapshot.models,
                      failed: failedParse,
                  }),
        [diff.files, failedParse, routeSnapshot, snapshot.models],
    );
    // Точка входа полосы (docs/design/README.md §10): вопрос с якорем ровно на этот диапазон. Пока такой вопрос
    // в полёте, полоса показывает чип — тем же признаком, что и поповер выделения.
    const marginActions = useMemo<MarginStripActions | null>(
        () =>
            onComposeQuestion === undefined
                ? null
                : {
                      agentConnected,
                      isPending: isSelectionPending,
                      onAskToPlace: (anchor) => {
                          onComposeQuestion(placeRangeQuestion(anchor, t), anchor);
                      },
                  },
        [agentConnected, isSelectionPending, onComposeQuestion, t],
    );

    const [focusedLine, setFocusedLine] = useState<{
        fileId: string;
        side: 'old' | 'new';
        line: number;
    } | null>(null);
    const [selectedFileId, setSelectedFileId] = useState<string | null>(null);
    const activePaletteFileId = focusedLine?.fileId ?? selectedFileId ?? topFileId;
    useEffect(() => {
        onPaletteActiveFileChange?.(activePaletteFileId);
    }, [activePaletteFileId, onPaletteActiveFileChange]);

    const openFile = useCallback(
        (fileId: string) => {
            setSelectedFileId(fileId);
            if (!shown.some((file) => file.fileId === fileId)) {
                pendingScroll.current = fileId;
                setKeptFileId(null);
                session.setFilter(ALL_FILTER_ID);
                return;
            }
            void listRef.current?.scrollToFile(fileId);
        },
        [session, shown],
    );

    const lineNavigationCleanup = useRef<(() => void) | null>(null);
    const lineNavigationId = useRef(0);
    useEffect(
        () => () => {
            lineNavigationId.current += 1;
            lineNavigationCleanup.current?.();
        },
        [],
    );
    const goToLine = useCallback(
        async (fileId: string, side: 'old' | 'new', line: number, highlight = true): Promise<void> => {
            lineNavigationId.current += 1;
            const navigationId = lineNavigationId.current;
            lineNavigationCleanup.current?.();
            lineNavigationCleanup.current = null;

            // Любая свёртка обязана раскрыться до прокрутки и поиска DOM-цели (docs/design/SPEC-elements.md §2.11).
            store.revealFile(fileId);
            store.openFile(fileId);
            store.showWhitespace(fileId);
            const converged = await (listRef.current?.scrollToFile(fileId) ?? Promise.resolve(false));
            if (!converged || navigationId !== lineNavigationId.current) {
                return;
            }

            let observer: MutationObserver | null = null;
            let timeout: ReturnType<typeof setTimeout> | null = null;
            const stop = (): void => {
                observer?.disconnect();
                observer = null;
                if (timeout !== null) {
                    clearTimeout(timeout);
                    timeout = null;
                }
                if (lineNavigationCleanup.current === stop) {
                    lineNavigationCleanup.current = null;
                }
            };
            const reveal = (): boolean => {
                // Класс обязателен: `data-file` несёт и строка дерева — она стоит в разметке раньше
                // карточки и без него перехватывала бы поиск строки.
                const card = document.querySelector<HTMLElement>(`.file-card[data-file="${CSS.escape(fileId)}"]`);
                if (card === null) {
                    return false;
                }
                const row = findLineRow(card, side, line);
                if (row === null) {
                    return false;
                }
                row.scrollIntoView({ block: 'center' });
                if (highlight) {
                    flashRow(row);
                }
                stop();
                return true;
            };

            lineNavigationCleanup.current = stop;
            if (reveal()) {
                return;
            }

            let expansionStarted = false;
            const expandHiddenContext = (): void => {
                if (expansionStarted || !store.getSnapshot().models.has(fileId)) {
                    return;
                }
                expansionStarted = true;
                void expandContext({
                    store,
                    fileId,
                    request: { kind: 'file' },
                    contentAvailable,
                    loadContent,
                    t,
                }).then(() => {
                    if (navigationId === lineNavigationId.current) {
                        reveal();
                    }
                });
            };
            observer = new MutationObserver(() => {
                if (!reveal()) {
                    expandHiddenContext();
                }
            });
            observer.observe(document.body, { childList: true, subtree: true });
            timeout = setTimeout(stop, LINE_NAVIGATION_SEARCH_MS);
            expandHiddenContext();
        },
        [contentAvailable, loadContent, store, t],
    );
    const openedSelectionTarget = useRef<string | null>(null);
    useEffect(() => {
        if (initialSelectionTarget === null) {
            openedSelectionTarget.current = null;
            return;
        }
        const key = `${initialSelectionTarget.fileId}:${initialSelectionTarget.side}:${String(initialSelectionTarget.start)}:${String(selectionNavigationRequest)}`;
        if (openedSelectionTarget.current === key) {
            return;
        }
        openedSelectionTarget.current = key;
        void goToLine(initialSelectionTarget.fileId, initialSelectionTarget.side, initialSelectionTarget.start, false);
    }, [goToLine, initialSelectionTarget, selectionNavigationRequest]);

    const handledPaletteNavigation = useRef<number | null>(null);
    useEffect(() => {
        const navigation = paletteNavigation;
        if (navigation === null || handledPaletteNavigation.current === navigation.id) {
            return;
        }
        const { target } = navigation;
        setSelectedFileId(target.fileId);
        if (!shown.some((file) => file.fileId === target.fileId)) {
            // Не ставим обычный pendingScroll: он предназначен для удержания позиции при фильтре
            // и не должен выстрелить позже после уже выполненного перехода палитры.
            pendingScroll.current = null;
            setKeptFileId(null);
            session.setFilter(ALL_FILTER_ID);
            return;
        }

        handledPaletteNavigation.current = navigation.id;
        if (target.kind === 'file') {
            void listRef.current?.scrollToFile(target.fileId);
        } else {
            void goToLine(target.fileId, target.side, target.line);
        }
    }, [goToLine, paletteNavigation, session, shown]);

    // Аутлайн однофайлового PR: ханки уже разобранной модели (docs/design/SPEC-elements.md §2.20).
    const only = diff.files.length === 1 ? diff.files[0] : undefined;
    // Единственный файл, отфильтрованный прочь, — уже не аутлайн: панель обязана сказать,
    // что в этом фильтре пусто.
    const outline = useMemo(
        () =>
            only === undefined || treeFiles.length === 0
                ? null
                : outlineOf(snapshot.models.get(only.fileId) ?? null),
        [only, treeFiles, snapshot.models],
    );
    const openHunk = useCallback(
        (index: number) => {
            if (only === undefined) {
                return;
            }
            // Навигации по символам нет, и это её приближение: карточка однофайлового PR всегда
            // в DOM, поэтому до начала ханка достаточно доскроллить нативно.
            document
                .querySelector(`.file-card[data-file="${CSS.escape(only.fileId)}"] [data-hunk="${String(index)}"]`)
                ?.scrollIntoView({ block: 'start' });
        },
        [only],
    );

    const [focusedThreadId, setFocusedThreadId] = useState<string | null>(null);
    // Правило «под курсором или под фокусом» одно на все команды вью.
    const pointer = usePointerTarget();
    // Отмечать просмотренным можно только в активной итерации.
    const readOnly = useReadOnlyIteration();
    const treeCursor = useRef<FileTreeCursor | null>(null);
    const focusLine = useCallback((fileId: string, side: 'old' | 'new', line: number) => {
        setFocusedLine({ fileId, side, line });
        setSelectedFileId(fileId);
    }, []);
    const blurLine = useCallback(() => {
        setFocusedLine(null);
    }, []);
    const commentLine = useCallback(
        (fileId: string, side: 'old' | 'new', line: number) => {
            const file = diff.files.find((candidate) => candidate.fileId === fileId);
            if (file === undefined) {
                return;
            }
            const position = commentPosition(snapshot.selection, shownModelOf(snapshot, fileId), fileId, side, line);
            const key = `new:${fileId}:${position.side}:${String(position.line)}`;
            openNewComposer(threadStore, key, { fileId, path: file.path, position }, pr.capabilities.commentIssues);
            // Диапазон переехал в композер: живое выделение больше не нужно, а оставленное
            // держало бы карандаш строки видимым и подмешивалось бы в следующий комментарий.
            store.clearSelection();
        },
        [diff.files, pr.capabilities.commentIssues, snapshot, store, threadStore],
    );

    const commentFile = useCallback(
        (fileId: string) => {
            const file = diff.files.find((candidate) => candidate.fileId === fileId);
            if (file !== undefined) {
                openFileComposer(threadStore, fileId, file.path, pr.capabilities.commentIssues);
            }
        },
        [diff.files, pr.capabilities.commentIssues, threadStore],
    );

    /**
     * Цель команд «под курсором» (docs/design/SPEC-elements.md §5): строка под мышью, а если мышь не двигалась
     * после последней смены фокуса — сфокусированная. Считается в момент нажатия: курсор мог
     * стоять на месте, пока контент под ним уезжал колесом.
     */
    const targetLine = useCallback(
        (): { readonly fileId: string; readonly side: 'old' | 'new'; readonly line: number } | null =>
            lineAt(pointer.hovered()) ?? focusedLine,
        [focusedLine, pointer],
    );
    const targetThreadId = useCallback(
        (): string | null => pointer.target('[data-thread-id]')?.getAttribute('data-thread-id') ?? focusedThreadId,
        [focusedThreadId, pointer],
    );
    /**
     * Файл для `v`: карточка или строка дерева под мышью; когда под мышью файла нет — строка
     * под курсором дерева, пока дерево держит фокус; иначе карточка, внутри которой фокус.
     */
    const targetFileId = useCallback((): string | null => {
        const hoveredFile = fileIdAt(pointer.hovered());
        if (hoveredFile !== null) {
            return hoveredFile;
        }
        const cursor = treeCursor.current?.cursorFileId() ?? null;
        if (cursor !== null) {
            return cursor;
        }
        return typeof document === 'undefined' ? null : fileIdAt(document.activeElement);
    }, [pointer]);

    useShortcut({
        id: 'thread.commentLine',
        keys: ['c'],
        label: 'shortcut.thread.commentLine',
        scope: 'full-diff',
        section: 'comments',
        when: () => targetLine() !== null,
        action: () => {
            const line = targetLine();
            if (line !== null) {
                commentLine(line.fileId, line.side, line.line);
            }
        },
    });
    useShortcut({
        id: 'thread.reply',
        keys: ['r'],
        label: 'shortcut.thread.reply',
        scope: 'full-diff',
        section: 'comments',
        when: () => targetThreadId() !== null,
        action: () => {
            const threadId = targetThreadId();
            const thread = threadSnapshot.threads.find((candidate) => candidate.id === threadId);
            if (thread !== undefined) {
                openReply(threadStore, thread, commentIssues);
            }
        },
    });
    /**
     * `v` объявлена здесь, а не в панели дерева: целей у неё две — карточка файла и строка
     * дерева, — а команда в реестре обязана быть одна. В прошлой итерации отметок нет.
     */
    useShortcut({
        id: 'diff.markViewed',
        keys: ['v'],
        label: 'shortcut.diff.markViewed',
        scope: 'full-diff',
        section: 'reading',
        when: () => !readOnly && targetFileId() !== null,
        action: () => {
            const fileId = targetFileId();
            if (fileId !== null) {
                toggleViewed(fileId);
            }
        },
    });

    const searchRef = useRef<HTMLInputElement | null>(null);
    useShortcut({
        id: 'diff.filterFiles',
        keys: ['f'],
        label: 'shortcut.diff.filterFiles',
        scope: 'full-diff',
        section: 'navigation',
        action: () => {
            searchRef.current?.focus();
        },
    });

    // --- Клавиши перемещения по полному диффу (docs/design/SPEC-elements.md §5) ---

    /**
     * Прокрутка к файлу без разворачивания: `j`/`k`/`n`/`p` ведут по списку так же, как переход
     * после отметки, — свёрнутую цель не трогают.
     */
    const goToFileQuietly = useCallback((fileId: string | null) => {
        if (fileId !== null) {
            void listRef.current?.scrollToFile(fileId, { reveal: false });
        }
    }, []);
    useShortcut({
        id: 'diff.nextFile',
        keys: ['j'],
        label: 'shortcut.diff.nextFile',
        scope: 'full-diff',
        section: 'navigation',
        action: () => {
            goToFileQuietly(neighbourId(shown, topRef.current, 1, fileIdOf));
        },
    });
    useShortcut({
        id: 'diff.prevFile',
        keys: ['k'],
        label: 'shortcut.diff.prevFile',
        scope: 'full-diff',
        section: 'navigation',
        action: () => {
            goToFileQuietly(neighbourId(shown, topRef.current, -1, fileIdOf));
        },
    });
    /**
     * `n`/`p` — следующий непрочитанный файл. `partial` считается непросмотренным: у него
     * остались невиденные строки. Гранулярность — файл: к внутрифайловым диапазонам клавиши
     * не ведут.
     */
    const goToUnread = useCallback(
        (direction: 1 | -1) => {
            const readState = store.getSnapshot().readState;
            goToFileQuietly(
                unreadNeighbourId(
                    shown,
                    topRef.current,
                    direction,
                    fileIdOf,
                    (file) => readState.get(file.fileId)?.state !== 'read',
                ),
            );
        },
        [goToFileQuietly, shown, store],
    );
    useShortcut({
        id: 'diff.nextUnread',
        keys: ['n'],
        label: 'shortcut.diff.nextUnread',
        scope: 'full-diff',
        section: 'reading',
        action: () => {
            goToUnread(1);
        },
    });
    useShortcut({
        id: 'diff.prevUnread',
        keys: ['p'],
        label: 'shortcut.diff.prevUnread',
        scope: 'full-diff',
        section: 'reading',
        action: () => {
            goToUnread(-1);
        },
    });
    const targetHunkRequests = useCallback((): readonly HunkExpandRequest[] => {
        const line = targetLine();
        if (line === null) {
            return [];
        }
        const model = shownModelOf(store.getSnapshot(), line.fileId);
        return model === null ? [] : hunkContextRequests(model, line.side, line.line);
    }, [store, targetLine]);
    useShortcut({
        id: 'diff.expandContext',
        keys: ['e'],
        label: 'shortcut.diff.expandContext',
        scope: 'full-diff',
        section: 'reading',
        when: () => targetHunkRequests().length > 0,
        action: () => {
            const line = targetLine();
            if (line === null) {
                return;
            }
            const fileId = line.fileId;
            for (const request of targetHunkRequests()) {
                void expandContext({
                    store,
                    fileId,
                    request: { kind: 'gap', ...request },
                    contentAvailable,
                    loadContent,
                    t,
                });
            }
        },
    });

    const threadVisible = useCallback(
        (thread: Thread) => thread.id === initialThreadId || threadIsVisible(thread, threadAuthor),
        [initialThreadId, threadAuthor],
    );
    const outsideThreads = threadSnapshot.outside.filter(
        (thread) => threadSnapshot.keptVisible.has(thread.id) || threadVisible(thread),
    );

    const selectedFile =
        snapshot.selection === null
            ? null
            : (diff.files.find((file) => file.fileId === snapshot.selection?.fileId) ?? null);
    const selectedModel = selectedFile === null ? null : shownModelOf(snapshot, selectedFile.fileId);
    const layoutStyle =
        toolbarHeight === null && viewportHeight === null
            ? undefined
            : ({
                  ...(toolbarHeight === null
                      ? {}
                      : { '--full-diff-toolbar-height': `${String(toolbarHeight)}px` }),
                  ...(viewportHeight === null
                      ? {}
                      : { '--full-diff-viewport-height': `${String(viewportHeight)}px` }),
              } as CSSProperties);

    return (
        <main
            className="full-diff selection-popover-host"
            ref={setScrollElement}
            data-shown-files={treeFiles.length}
            /* Потолок код-панелей (`--diff-max`) считается по фактическому режиму, а не по настройке. */
            data-diff-mode={snapshot.effectiveMode}
            style={layoutStyle}
        >
            <PrHeader
                ref={setScrollMarginElement}
                pr={pr}
                counts={prHeaderCounts(diff)}
                pci={pci?.available === true ? pci : null}
                pciActive={filter.id === PCI_FILTER_ID}
                onTogglePci={() => {
                    changeFilter(filter.id === PCI_FILTER_ID ? ALL_FILTER_ID : PCI_FILTER_ID);
                }}
                {...(props.headerAside === undefined ? {} : { aside: props.headerAside })}
            />

            <FullDiffToolbar
                store={store}
                filters={filters}
                filter={filter}
                onFilter={changeFilter}
                authorLens={
                    threadAuthor === null
                        ? null
                        : {
                              name: authorDisplayName(threadSnapshot.threads, threadAuthor),
                              onClear: () => {
                                  session.setThreadAuthor(null);
                              },
                          }
                }
                smallPr={props.smallPr ?? false}
                onHeight={setToolbarHeight}
            />

            <div className="full-diff__body">
                <FilePanel
                    files={treeFiles}
                    filters={filters}
                    activeFilter={filter}
                    onFilter={changeFilter}
                    pciFileIds={pciFileIds}
                    mineFileIds={mineFileIds}
                    readState={snapshot.readState}
                    route={routeMargin}
                    onJumpToStop={onJumpToStop}
                    activeFileId={topFileId}
                    onOpenFile={openFile}
                    onToggleViewed={toggleViewed}
                    writeError={
                        writeError === null
                            ? null
                            : {
                                  text: t('diff.file.notSaved'),
                                  onRetry: () => {
                                      writeFromTree(writeError.fileId, writeError.viewed);
                                  },
                              }
                    }
                    outline={outline}
                    onOpenHunk={openHunk}
                    inputRef={searchRef}
                    cursorRef={treeCursor}
                />

                <div className="full-diff__main">
                    {/* Пустой результат — про сам фильтр, а не про список: объяснение живёт рядом
                        с карточкой, оставленной на экране, а не вместо неё (docs/design/SPEC-elements.md §2.7). */}
                    {treeFiles.length === 0 ? (
                        <div className="full-diff__zero">
                            <p className="full-diff__zero-text">{zeroResultText(filter, t)}</p>
                            <button
                                type="button"
                                className="ctl ctl--secondary full-diff__zero-action"
                                onClick={() => {
                                    changeFilter(ALL_FILTER_ID);
                                }}
                            >
                                {t('lens.showAll')}
                            </button>
                        </div>
                    ) : null}

                    {/* Список не размонтируется никогда: вместе с ним уехали бы отметки о заказанном
                        разборе и о том, что прокрутка к файлу из ссылки уже случилась. */}
                    <DiffFileList
                        ref={listRef}
                        scrollElement={scrollElement}
                        scrollMarginElement={scrollMarginElement}
                        scrollPaddingStart={toolbarHeight ?? 0}
                        files={shown}
                        store={store}
                        contentAvailable={contentAvailable}
                        noContentReason={slice === null ? undefined : t(SLICE_NO_CONTENT_REASON)}
                        parse={parse}
                        loadContent={loadContent}
                        onViewed={markViewed}
                        session={session}
                        notes={notes}
                        noteActions={noteActions}
                        threadStore={threadStore}
                        threadActions={threadActions}
                        threadVisible={threadVisible}
                        onCommentLine={commentLine}
                        onCommentFile={commentFile}
                        onLineFocus={focusLine}
                        onLineBlur={blurLine}
                        onFocusThread={setFocusedThreadId}
                        threadNow={threadNow}
                        outsideThreads={
                            <OutsideThreads
                                threads={outsideThreads}
                                store={threadStore}
                                actions={threadActions}
                                now={threadNow}
                                initialThreadId={initialThreadId}
                                defaultOpen={outsideThreadsOpen}
                                onFocusThread={setFocusedThreadId}
                            />
                        }
                        initialFileId={linkedFileId ?? initialFileId}
                        keptFileId={keptFileId}
                        advancingFileId={advanceFrom}
                        onTopFileChange={setTopFileId}
                        onScroll={onScroll}
                        routeMargin={routeMargin}
                        marginActions={marginActions}
                        onJumpToStop={onJumpToStop}
                    />
                </div>
            </div>
            {snapshot.selection === null || selectedFile === null || selectedModel === null ? null : (
                <SelectionPopover
                    key={`${snapshot.selection.fileId}:${snapshot.selection.side ?? ''}:${snapshot.selection.anchor}:${snapshot.selection.focus}`}
                    host={scrollElement}
                    diffId={diff.diffId}
                    file={selectedFile}
                    model={selectedModel}
                    selection={snapshot.selection}
                    dragging={snapshot.selectionDragging}
                    agentConnected={agentConnected}
                    inFlight={isSelectionPending(
                        chatAnchorFromSelection(selectedFile, selectedModel, snapshot.selection, diff.diffId),
                    )}
                    onAsk={onAskSelection}
                    askDisabledReason={slice === null ? null : t(SLICE_NO_ASK_REASON)}
                    onSelectionAnchorChange={selectionAnchorChange}
                    onComment={(side, line) => {
                        commentLine(selectedFile.fileId, side, line);
                    }}
                    onClear={store.clearSelection}
                />
            )}
        </main>
    );
}

/** Липкий тулбар полного диффа с собственным замером высоты (docs/design/README.md §1 и §10). */
export function FullDiffToolbar({
    store,
    filters,
    filter,
    onFilter,
    authorLens = null,
    smallPr,
    onHeight,
}: {
    store: DiffViewStore;
    filters: readonly FileFilter[];
    filter: FileFilter;
    onFilter: (id: string) => void;
    authorLens?: AuthorLens | null;
    smallPr: boolean;
    onHeight?: ((height: number) => void) | undefined;
}) {
    const t = useT();
    const ref = useRef<HTMLDivElement | null>(null);

    // Замер до отрисовки: иначе первый кадр уедет на запасную высоту из full-diff.css.
    // Стартовое значение снимается вручную — ResizeObserver в фоновой вкладке молчит.
    useLayoutEffect(() => {
        const element = ref.current;
        if (element === null || onHeight === undefined) {
            return;
        }
        const report = (): void => {
            onHeight(element.getBoundingClientRect().height);
        };
        report();
        const observer = new ResizeObserver(report);
        observer.observe(element);
        return () => {
            observer.disconnect();
        };
    }, [onHeight]);

    return (
        <div className="full-diff__toolbar" ref={ref}>
            <div className="full-diff__heading">
                <h1 className="full-diff__title">{t('view.diff')}</h1>
                <span className="full-diff__subtitle">{t('fullDiff.subtitle')}</span>
            </div>
            {smallPr ? <span className="full-diff__small-pr">{t('route.smallPr.chip')}</span> : null}
            <span className="full-diff__spacer" />
            <ToolbarRightCluster
                store={store}
                filters={filters}
                filter={filter}
                onFilter={onFilter}
                authorLens={authorLens}
            />
        </div>
    );
}

const EMPTY_THREADS: readonly Thread[] = [];
const EMPTY_NOTES: readonly AgentNote[] = [];
const EMPTY_OPEN_NOTE = (): void => undefined;
const EMPTY_DELETE_NOTE = (): Promise<void> => Promise.reject(new Error('deleting notes is unavailable here'));
const EMPTY_FILE_IDS: ReadonlySet<string> = new Set();
const EMPTY_EXPANSION: FileExpansion = new Map();

/** Пауза перед фоновым разбором остальных файлов: первый кадр она уступает видимым карточкам. */
const BACKGROUND_PARSE_DELAY = 300;
/** После раскрытия контекста DOM-цель ждём ограниченно: виртуализатор может её не создать. */
const LINE_NAVIGATION_SEARCH_MS = 3000;

const EMPTY_THREAD_TRANSPORT: ComposerTransport = {
    save: () => Promise.reject(new Error('writing drafts is unavailable in this state')),
    update: () => Promise.reject(new Error('writing drafts is unavailable in this state')),
    delete: () => Promise.reject(new Error('writing drafts is unavailable in this state')),
};
const EMPTY_RESOLVE = (): Promise<void> => Promise.reject(new Error('resolve is unavailable in this state'));
const EMPTY_SET_VIEWED = (): Promise<number> =>
    Promise.reject(new Error('marking viewed is unavailable in this state'));
const EMPTY_ASK_SELECTION = (): void => undefined;
const NO_SELECTION_PENDING = (): boolean => false;
const fileIdOf = (file: { readonly fileId: string }): string => file.fileId;

/** Файл, которому принадлежит элемент: карточка списка или строка дерева несут `data-file`. */
function fileIdAt(element: Element | null): string | null {
    return element?.closest<HTMLElement>('[data-file]')?.dataset.file ?? null;
}
const NO_SELECTION_ANCHOR_CHANGE = (): void => undefined;
/** Полный дифф остановок и их карточек не отмечает: контролов для этого у него нет. */
const NO_STOP_WRITES: StopWriterHooks = {
    read: () => null,
    apply: () => undefined,
    restore: () => undefined,
    send: () => Promise.reject(new Error('marking a stop viewed is unavailable on the full diff')),
};
const NO_STOP_FILE_WRITES: StopFileWriterHooks = {
    apply: () => undefined,
    send: () => Promise.reject(new Error('marking a stop file viewed is unavailable on the full diff')),
};

/**
 * Файл, к которому уходит экран после отметки: ближайший развёрнутый ниже по текущему порядку и
 * фильтру, а если ниже все свёрнуты — просто следующий. `null` — отмеченный файл последний,
 * прокрутки не будет.
 */
export function nextFileToAdvance<T extends { readonly fileId: string }>(
    files: readonly T[],
    fileId: string,
    collapsed: (file: T) => boolean,
): string | null {
    const index = files.findIndex((file) => file.fileId === fileId);
    if (index < 0) {
        return null;
    }
    const rest = files.slice(index + 1);
    return (rest.find((file) => !collapsed(file)) ?? rest[0])?.fileId ?? null;
}

function shownModelOf(snapshot: DiffViewSnapshot, fileId: string): DiffFileModel | null {
    return shownFileModel(
        snapshot.models.get(fileId) ?? null,
        snapshot.content.get(fileId) ?? null,
        snapshot.expansion.get(fileId) ?? EMPTY_EXPANSION,
    );
}

export function commentPosition(
    selection: { fileId: string; anchor: string; focus: string } | null,
    model: DiffFileModel | null,
    fileId: string,
    side: 'old' | 'new',
    line: number,
): { side: 'old' | 'new'; line: number; size: number } {
    if (selection?.fileId !== fileId || model === null) {
        return { side, line, size: 1 };
    }
    const range = selectedLineRange(model, selection, side);
    if (range === null || line < range.line || line >= range.line + range.size) {
        return { side, line, size: 1 };
    }
    return { side, ...range };
}

/**
 * Пункты аутлайна подписаны диапазоном строк новой стороны из заголовка `@@`.
 *
 * Разбора ещё нет и оглавлять нечего — разные ответы: первый временный, второй окончательный,
 * и панель обязана говорить их разными словами.
 */
function outlineOf(model: DiffFileModel | null): FileOutlineModel {
    if (model === null) {
        return { state: 'parsing' };
    }
    if (model.content.kind === 'binary') {
        return { state: 'empty', reason: 'fullDiff.outline.binary' };
    }
    if (model.content.kind === 'none') {
        return { state: 'empty', reason: model.malformed ? MALFORMED_REASON : 'fullDiff.outline.noText' };
    }

    const entries: OutlineEntry[] = [];
    let index = 0;
    for (const block of model.content.blocks) {
        if (block.kind !== 'hunk') {
            continue;
        }
        const label = `${String(block.newStart)}–${String(block.newStart + Math.max(block.newCount, 1) - 1)}`;
        entries.push({ index, label });
        index += 1;
    }
    if (entries.length === 0) {
        return { state: 'empty', reason: model.malformed ? MALFORMED_REASON : 'fullDiff.outline.noHunks' };
    }
    return { state: 'ready', entries };
}

const MALFORMED_REASON: MessageKey = 'fullDiff.outline.malformed';

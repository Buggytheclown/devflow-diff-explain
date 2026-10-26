import type {
    AgentNote,
    FileContent,
    FileDiff,
    PrDiff,
    PrMeta,
    RouteSnapshot,
    RouteTier,
    UiChatAskAnchor,
    UiGenerationCap,
    UiReviewLensesResponse,
    UiSeenRange,
    UiStopSeenRange,
} from '@sherpa/protocol';
import type { CSSProperties, ReactNode } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';

import { PrHeader, prHeaderCounts } from '../../components/pr-header.tsx';
import { chatAnchorFromSelection, SelectionPopover } from '../../components/selection-popover.tsx';
import type { DiffFileModel } from '../../diff/model.js';
import type { Feedback } from '../../diff-view/file-card.tsx';
import type { DiffViewStore } from '../../diff-view/store.js';
import { viewedCollapsible } from '../../diff-view/store.js';
import { useSelectionLifecycle } from '../../diff-view/use-selection.js';
import '../../diff-view/diff-view.css';
import { useT } from '../../i18n/index.js';
import { useReadOnlyIteration } from '../../iterations/read-only.tsx';
import type { StopLink } from '../../markdown/markdown.tsx';
import { SnapshotPill } from '../../iterations/snapshot-picker.tsx';
import type { ViewingLabel } from '../../iterations/viewing.js';
import {
    ALL_FILTER_ID,
    buildFileFilters,
    findFilter,
    PCI_FILTER_ID,
    selectFilter,
    zeroResultText,
} from '../../filters/lens-filters.js';
import { useTurnNoteIntoDraft } from '../../notes/use-note-draft.js';
import { createProgressWriter } from '../../progress/progress-writer.js';
import type { ProgressWriter } from '../../progress/progress-writer.js';
import { readStateOf } from '../../progress/read-state.js';
import type { StopProgressStore } from '../../progress/stop-progress-store.js';
import { createStopProgressStore } from '../../progress/stop-progress-store.js';
import { buildCoverageStrip } from '../../route/coverage-model.js';
import type { RouteEntry, RouteFileGroup, RouteStopView } from '../../route/route-model.js';
import { generationProgress } from '../../route/generation.js';
import { snapshotFilling } from '../../route/other-stop.js';
import type { RouteSummary } from '../../route/route-summary.js';
import {
    buildRouteModel,
    changeFilterAvailable,
    countStopComments,
    entryGroups,
    entryMatchesChangeFilter,
    otherMatchesFilter,
    stopMatchesFilter,
} from '../../route/route-model.js';
import { cardReadState } from '../../route/stop-coverage.js';
import type { SessionStore } from '../../session/session-store.js';
import { createThreadActions } from '../../threads/actions.js';
import type { ComposerTransport } from '../../threads/composer.js';
import type { PublishedCommentTransport } from '../../threads/transport.js';
import type { ThreadStore } from '../../threads/store.js';
import { OutsideThreads } from '../../threads/thread-list.tsx';
import type { ThreadActions } from '../../threads/thread-list.tsx';
import { CoverageStrip } from './coverage-strip.tsx';
import { OtherSection } from './other-section.tsx';
import { RouteToolbar } from './route-toolbar.tsx';
import { stopChangeThreads } from './stop-card.tsx';
import { collapsedKey, entryId } from './stop-lookup.js';
import { collapsedStopShown, StopSection } from './stop-section.tsx';
import { useRouteJump } from './use-route-jump.js';
import { useRouteParse } from './use-route-parse.js';
import { useRouteReveal } from './use-route-reveal.js';
import { useRouteShortcuts } from './use-route-shortcuts.js';
import { useStopCards } from './use-stop-cards.tsx';
import { useStopViewed } from './use-stop-viewed.js';
import './route.css';

/**
 * Рисующая половина вью «Маршрут»: работает на чистых пропсах, поэтому её показывает и галерея
 * состояний. Сама она держит только модель маршрута, линзы и разметку, а работу раздаёт хукам:
 * `use-route-parse` (разбор патчей), `use-route-jump` (прокрутка и якоря), `use-route-reveal`
 * (довести цель перехода до видимого), `use-stop-viewed` (отметка остановки), `use-stop-cards`
 * (карточки файлов и фокус) и `use-route-shortcuts` (клавиши). Порядок вызовов хуков менять
 * нельзя: от него зависит порядок эффектов и регистрации команд.
 */

export interface RouteWorkspaceProps {
    readonly pr: PrMeta;
    readonly diff: PrDiff;
    readonly lenses: UiReviewLensesResponse;
    readonly snapshot: RouteSnapshot;
    /** См. `RouteViewProps.agentStopped`. */
    readonly agentStopped?: boolean;
    readonly session: SessionStore;
    readonly store: DiffViewStore;
    readonly threadStore: ThreadStore;
    /** В приложении writer и стор отметок создаются уровнем выше; в галерее — самим workspace. */
    readonly progressWriter?: ProgressWriter;
    readonly stopProgress?: StopProgressStore;
    /** Первый серверный снимок прогресса уже применён; автономный workspace стартует готовым. */
    readonly progressLoaded?: boolean;
    /** Стартовые отметки остановок для галереи и тестов (в приложении их приносит сервер). */
    readonly initialStopViewed?: readonly string[];
    readonly onSetViewed?: (fileId: string, viewed: boolean) => Promise<number>;
    readonly onSetStopViewed?: (
        stopId: string,
        viewed: boolean,
        ranges: readonly UiStopSeenRange[],
    ) => Promise<number>;
    readonly onSetStopFileViewed?: (
        stopId: string,
        fileId: string,
        viewed: boolean,
        ranges: readonly UiSeenRange[],
    ) => Promise<number>;
    readonly parse: (file: FileDiff) => Promise<DiffFileModel>;
    readonly loadContent: (fileId: string) => Promise<FileContent | null>;
    readonly threadTransport?: ComposerTransport;
    /** Записи по опубликованным комментариям; без него резолва, правки и удаления в UI нет. */
    readonly publishedTransport?: PublishedCommentTransport;
    readonly onResolveThread?: (threadId: string, resolved: boolean) => Promise<void>;
    /** См. комментарий у `threadNow` в `views/full-diff.tsx`. */
    readonly threadNow?: number;
    readonly navigation?: { readonly id: number; readonly stopId: string } | null;
    readonly initialSelectionTarget?: { readonly fileId: string; readonly side: 'old' | 'new'; readonly start: number } | null;
    readonly selectionNavigationRequest?: number;
    readonly agentConnected?: boolean;
    readonly onAskSelection?: (anchor: UiChatAskAnchor) => void;
    readonly isSelectionPending?: (anchor: UiChatAskAnchor | null) => boolean;
    readonly onSelectionAnchorChange?: (anchor: UiChatAskAnchor | null) => void;
    /** См. `RouteViewProps.onComposeQuestion`; без него у «Прочего» нет кнопки «разложить». */
    readonly onComposeQuestion?: (text: string) => void;
    readonly notes?: readonly AgentNote[];
    readonly onOpenNoteInChat?: (note: AgentNote) => void;
    readonly onDeleteNote?: (noteId: number) => Promise<void>;
    readonly onUnderExplained?: (value: boolean) => void;
    readonly onFillStop?: (planIndex: number) => void;
    readonly onRouteSummary?: (summary: RouteSummary) => void;
    /** Стартовое «оставлена на экране»: так галерея рисует состояние фильтра без клика. */
    readonly initialKeptStopId?: string | null;
    /** См. `RouteViewProps.onOpenThread`. */
    readonly onOpenThread?: (threadId: string) => void;
    /** См. `RouteViewProps.headerAside`. */
    readonly headerAside?: ReactNode;
    /** См. `RouteViewProps.generationCap`. */
    readonly generationCap?: UiGenerationCap | null;
}

export function RouteWorkspace(props: RouteWorkspaceProps) {
    const t = useT();
    const {
        pr,
        diff,
        lenses,
        snapshot,
        agentStopped = false,
        session,
        store,
        threadStore,
        parse,
        loadContent,
        onSetViewed = EMPTY_SET_VIEWED,
        onSetStopViewed = EMPTY_SET_STOP_VIEWED,
        onSetStopFileViewed = EMPTY_SET_STOP_FILE_VIEWED,
        progressLoaded = true,
        navigation = null,
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
        onUnderExplained,
        onFillStop,
        onRouteSummary,
        onOpenThread,
    } = props;
    // Прошлая итерация только читается: отметки и дозаполнение стопов недоступны.
    const readOnly = useReadOnlyIteration();
    const [threadNow] = useState(() => props.threadNow ?? Date.now());
    // Третьим аргументом — тот же снимок: сторы изоморфны, и вью рисуется статически в тестах.
    const diffSnapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
    const threadSnapshot = useSyncExternalStore(threadStore.subscribe, threadStore.getSnapshot, threadStore.getSnapshot);
    const composersSnapshot = useSyncExternalStore(
        threadStore.subscribeComposers,
        threadStore.getComposersSnapshot,
        threadStore.getComposersSnapshot,
    );
    const {
        filter: filterId,
        preset,
        routeFilter,
        stops: stopState,
    } = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot);

    const threadsById = useMemo(
        () => new Map(threadSnapshot.threads.map((thread) => [thread.id, thread])),
        [threadSnapshot.threads],
    );

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
    const notesByFile = useMemo(() => {
        const grouped = new Map<string, AgentNote[]>();
        for (const note of notes) {
            const bucket = grouped.get(note.anchor.fileId);
            if (bucket === undefined) {
                grouped.set(note.anchor.fileId, [note]);
            } else {
                bucket.push(note);
            }
        }
        return grouped;
    }, [notes]);

    const initialStopViewed = props.initialStopViewed;
    const createdStopProgress = useMemo(
        () =>
            createStopProgressStore(
                (initialStopViewed ?? []).map((stopId) => ({ stopId, viewed: true })),
            ),
        [initialStopViewed],
    );
    const stopProgress = props.stopProgress ?? createdStopProgress;
    const stopViewed = useSyncExternalStore(
        stopProgress.subscribe,
        stopProgress.getSnapshot,
        stopProgress.getSnapshot,
    );

    const createdWriter = useMemo(
        () =>
            createProgressWriter({
                initialRevision: 0,
                read: (fileId) => store.getSnapshot().progress.get(fileId) ?? null,
                apply: store.markViewed,
                restore: store.restoreProgress,
                send: onSetViewed,
                stops: {
                    read: (stopId) => stopProgress.getSnapshot().get(stopId) ?? null,
                    apply: stopProgress.setViewed,
                    restore: stopProgress.restore,
                    send: onSetStopViewed,
                },
                stopFiles: { apply: store.applySeenRanges, send: onSetStopFileViewed },
                // Перечитку прогресса по SSE держит App; автономный workspace (галерея) её не ведёт.
                onSettled: () => undefined,
            }),
        [onSetStopFileViewed, onSetStopViewed, onSetViewed, stopProgress, store],
    );
    const writer = props.progressWriter ?? createdWriter;
    const markViewed = useCallback(
        async function mark(fileId: string, viewed: boolean): Promise<Feedback> {
            if (await writer.write(fileId, viewed)) {
                return null;
            }
            return { text: t('route.stop.notSaved'), retry: () => mark(fileId, viewed) };
        },
        [t, writer],
    );
    const markStopFile = useCallback(
        async function mark(
            stopId: string,
            fileId: string,
            viewed: boolean,
            ranges: readonly UiSeenRange[],
        ): Promise<Feedback> {
            if (await writer.writeStopFile(stopId, fileId, viewed, ranges)) {
                return null;
            }
            return { text: t('route.stop.notSaved'), retry: () => mark(stopId, fileId, viewed, ranges) };
        },
        [t, writer],
    );

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
    const pci = findFilter(filters, PCI_FILTER_ID);

    const { parseErrors, failedFiles, requestParse, retryParse, retryFailed, expand } = useRouteParse({
        files: diff.files,
        store,
        parse,
        loadContent,
        contentAvailable: pr.capabilities.fileContent,
    });

    const model = useMemo(
        () =>
            buildRouteModel({
                snapshot,
                files: diff.files,
                models: diffSnapshot.models,
                failed: failedFiles,
                preset,
            }),
        [diff.files, diffSnapshot.models, failedFiles, preset, snapshot],
    );
    // Маршрут ещё достраивается: фазу видно по самому снапшоту — статусы слотов её и несут.
    const filling = useMemo(() => snapshotFilling(snapshot), [snapshot]);
    const progress = useMemo(() => generationProgress(snapshot), [snapshot]);
    const stopIdsKey = useMemo(() => model.entries.map(entryId).join(' '), [model.entries]);
    const otherStopId = useMemo(
        () => model.entries.find((entry) => entry.kind === 'other')?.view.stop.id ?? null,
        [model.entries],
    );
    const uncoveredLines = model.totals.uncovered;
    // Пока хоть один файл не разобран, непокрытое ещё не посчитано: и полоса, и числа наружу
    // ждут разбора, иначе гардрейл и итог ревью зафиксировали бы промежуточные «100% объяснено».
    const settled = model.totals.pendingFiles === 0;
    // Остановки в порядке рендера (он зависит от пресета и подъёма «Прочего») и непокрытое
    // нужны панели действий и итогу ревью — отдаём их наружу.
    useEffect(() => {
        if (!settled) {
            return;
        }
        onRouteSummary?.({
            stopIds: stopIdsKey === '' ? [] : stopIdsKey.split(' '),
            otherStopId,
            uncoveredLines,
        });
    }, [onRouteSummary, otherStopId, settled, stopIdsKey, uncoveredLines]);

    const underExplained = model.promoted;
    useEffect(() => {
        onUnderExplained?.(underExplained);
        // Баннер поднимает App, а знает о нём только вью: уходя, вью обязано его погасить —
        // иначе он висел бы над приглашением после смены фазы или ревью.
        return () => {
            onUnderExplained?.(false);
        };
    }, [onUnderExplained, underExplained]);

    // Выделение строк начинают карточки, а заканчивает окно: тот же хук, что у полного диффа.
    useSelectionLifecycle(store);

    const {
        containerRef,
        setContainer,
        popoverHost,
        settling,
        topStopRef,
        keyboardStopRef,
        flashStopId,
        jumpStopId,
        updateTopStop,
        requestJump,
    } = useRouteJump(preset);
    const [keptStopId, setKeptStopId] = useState<string | null>(props.initialKeptStopId ?? null);
    const [otherOpen, setOtherOpen] = useState(false);
    /** Замер тулбара: до первого замера офсет липкой колонки держит запасное значение из `route.css`. */
    const [toolbarHeight, setToolbarHeight] = useState<number | null>(null);
    /**
     * Видимая высота вью: от неё считается потолок прибитой колонки остановки. Берётся со
     * скроллпорта, а не с окна, — над вью стоят верхняя панель и баннеры.
     */
    const [viewportHeight, setViewportHeight] = useState<number | null>(null);
    const [openedCollapsed, setOpenedCollapsed] = useState<ReadonlySet<string>>(new Set());
    /** Временно развёрнутые просмотренные карточки файлов: ключ — остановка и файл вместе. */
    const [openedViewed, setOpenedViewed] = useState<ReadonlySet<string>>(new Set());
    // Развёртка живёт, пока карточка просмотрена: снова отмеченная, она свернётся.
    useEffect(() => {
        const snapshot = { progress: diffSnapshot.progress, readState: diffSnapshot.readState };
        setOpenedViewed((previous) => {
            if (previous.size === 0) {
                return previous;
            }
            const kept = new Set<string>();
            for (const entry of model.entries) {
                for (const group of entryGroups(entry)) {
                    const key = collapsedKey(entryId(entry), group.fileId);
                    if (previous.has(key) && viewedCollapsible(cardReadState(group, snapshot))) {
                        kept.add(key);
                    }
                }
            }
            return kept.size === previous.size ? previous : kept;
        });
    }, [diffSnapshot.progress, diffSnapshot.readState, model.entries]);

    useEffect(() => {
        const element = containerRef.current;
        if (element === null || typeof ResizeObserver === 'undefined') {
            return;
        }
        const report = (): void => {
            setViewportHeight(element.clientHeight);
        };
        // Стартовое значение снимается вручную — ResizeObserver в фоновой вкладке молчит.
        report();
        const observer = new ResizeObserver(report);
        observer.observe(element);
        return () => {
            observer.disconnect();
        };
    }, [containerRef]);

    const matches = useCallback(
        (entry: RouteEntry, ids: ReadonlySet<string> | null): boolean =>
            entry.kind === 'stop' ? stopMatchesFilter(entry.view, ids) : otherMatchesFilter(entry.view, ids),
        [],
    );
    /**
     * Фильтр «что нового с прошлого захода» (docs/design/README.md §9). Недействителен, когда классифицированных
     * стопов нет: маршрут остаётся целым, чипа нет, в адрес значение не уходит.
     */
    const changeFilterOn = routeFilter === 'new' && changeFilterAvailable(model.entries);
    const shown = useMemo(
        () =>
            model.entries.filter(
                (entry) =>
                    (entryMatchesChangeFilter(entry, changeFilterOn) && matches(entry, filter.fileIds)) ||
                    entryId(entry) === keptStopId,
            ),
        [changeFilterOn, filter.fileIds, keptStopId, matches, model.entries],
    );

    const handleScroll = useCallback(() => {
        // Пометка «оставлена на экране» снимается прокруткой ревьюера, но не своей доводкой.
        if (settling.current === 0) {
            setKeptStopId(null);
            keyboardStopRef.current = null;
        }
        updateTopStop();
    }, [keyboardStopRef, settling, updateTopStop]);

    const changeFilter = useCallback(
        (id: string) => {
            const next = selectFilter(filters, id);
            if (next.id === filter.id) {
                return;
            }
            const top = topStopRef.current?.stopId ?? null;
            const entry = model.entries.find((candidate) => entryId(candidate) === top) ?? null;
            setKeptStopId(entry !== null && !matches(entry, next.fileIds) ? entryId(entry) : null);
            session.setFilter(next.id);
        },
        [filter.id, filters, matches, model.entries, session, topStopRef],
    );

    const { expandStop, openFile, anchorReachable, openAnchor } = useRouteReveal({
        model,
        fileIds: filter.fileIds,
        matches,
        session,
        store,
        stopProgress,
        setOtherOpen,
        openedCollapsed,
        setOpenedCollapsed,
        setOpenedViewed,
        expand,
        requestJump,
        initialSelectionTarget,
        selectionNavigationRequest,
    });

    // Верхняя остановка нужна смене фильтра и до первой прокрутки (docs/design/SPEC-elements.md §2.7).
    useEffect(() => {
        updateTopStop();
    }, [shown, updateTopStop]);

    // Якорь смены пресета снимается в момент самого переключения, пока в DOM ещё прежний
    // порядок: подписка на стор просыпается до перерисовки. Ждать события прокрутки нельзя —
    // оно приходит только когда браузер рисует кадр (в фоновой вкладке кадров нет).
    useEffect(() => {
        let last = session.getSnapshot().preset;
        return session.subscribe(() => {
            const next = session.getSnapshot().preset;
            if (next !== last) {
                last = next;
                updateTopStop();
            }
        });
    }, [session, updateTopStop]);

    /**
     * Фильтр «что нового» переключают снаружи вью — кнопкой баннера второго захода и чипом, —
     * поэтому его смену ловит та же подписка на стор: она просыпается до перерисовки, пока в DOM
     * ещё прежний набор остановок. Дальше как у файлового фильтра: верхнюю остановку, которую
     * новый фильтр прячет, вью оставляет на экране (docs/design/SPEC-elements.md §2.7).
     */
    useEffect(() => {
        let last = session.getSnapshot().routeFilter;
        return session.subscribe(() => {
            const next = session.getSnapshot().routeFilter;
            if (next === last) {
                return;
            }
            last = next;
            updateTopStop();
            const top = topStopRef.current?.stopId ?? null;
            const entry = model.entries.find((candidate) => entryId(candidate) === top) ?? null;
            const nextChangeOn = next === 'new' && changeFilterAvailable(model.entries);
            const shownNext =
                entry !== null && entryMatchesChangeFilter(entry, nextChangeOn) && matches(entry, filter.fileIds);
            setKeptStopId(entry === null || shownNext ? null : entryId(entry));
        });
    }, [filter.fileIds, matches, model.entries, session, topStopRef, updateTopStop]);

    const handledNavigation = useRef<number | null>(null);
    useEffect(() => {
        if (navigation === null || handledNavigation.current === navigation.id) {
            return;
        }
        handledNavigation.current = navigation.id;
        // Остановка могла быть спрятана фильтром: показать её — часть перехода.
        const entry = model.entries.find((candidate) => entryId(candidate) === navigation.stopId) ?? null;
        if (entry !== null && !matches(entry, filter.fileIds)) {
            session.setFilter(ALL_FILTER_ID);
        }
        requestJump(navigation.stopId, null);
    }, [filter.fileIds, matches, model.entries, navigation, requestJump, session]);

    /** Прыжок к остановке из полосы покрытия: спрятанную фильтром сперва возвращаем на экран. */
    const jumpToStop = useCallback(
        (stopId: string) => {
            const entry = model.entries.find((candidate) => entryId(candidate) === stopId) ?? null;
            if (entry !== null && !matches(entry, filter.fileIds)) {
                session.setFilter(ALL_FILTER_ID);
            }
            requestJump(stopId, null);
        },
        [filter.fileIds, matches, model.entries, requestJump, session],
    );

    /**
     * Переход по внутренней ссылке описания остановки: `#stop-N` ведёт к остановке плана,
     * `#file-<path>` — к файлу тем же прыжком, что и файловый чип. Файл ищется сперва среди
     * файлов самой остановки: один и тот же путь в разных остановках ведёт к своей карточке.
     * Ссылка в никуда (нет такой остановки, нет такого файла) не делает ничего.
     */
    const openStopLink = useCallback(
        (stopId: string, link: StopLink) => {
            if (link.kind === 'stop') {
                const entry =
                    model.entries.find((candidate) => candidate.view.stop.planIndex === link.planIndex) ?? null;
                if (entry !== null) {
                    jumpToStop(entryId(entry));
                }
                return;
            }
            const own = model.entries.find((candidate) => entryId(candidate) === stopId) ?? null;
            const target =
                own !== null && fileIdByPath(own, link.path) !== null
                    ? own
                    : (model.entries.find((candidate) => fileIdByPath(candidate, link.path) !== null) ?? null);
            const fileId = target === null ? null : fileIdByPath(target, link.path);
            if (target !== null && fileId !== null) {
                openFile(entryId(target), fileId);
            }
        },
        [jumpToStop, model.entries, openFile],
    );

    const { markStop, stopFailures, announcement, unfilledEntry, viewedStops } = useStopViewed({
        model,
        filling,
        stopViewed,
        fileIds: filter.fileIds,
        matches,
        session,
        stopProgress,
        writer,
        progressLoaded,
        diffSnapshot,
        requestJump,
    });

    /** Свёрнута ли остановка: отметка, ручная свёртка `x` или свёртка low-тира по умолчанию. */
    const collapsedOf = useCallback(
        (view: RouteStopView): boolean => {
            const id = view.stop.id;
            if (stopViewed.get(id) === true) {
                return !stopState.expandedViewed.has(id);
            }
            return stopState.collapsed.has(id) || (view.stop.tier === 'low' && !stopState.expanded.has(id));
        },
        [stopState, stopViewed],
    );
    const toggleCollapse = useCallback(
        (entry: RouteEntry) => {
            const stopId = entryId(entry);
            if (entry.kind === 'other') {
                setOtherOpen((open) => !open);
                return;
            }
            if (!collapsedOf(entry.view)) {
                if (stopViewed.get(stopId) === true) {
                    session.setViewedStopExpanded(stopId, false);
                } else if (entry.view.stop.tier === 'low') {
                    session.setStopExpanded(stopId, false);
                } else {
                    session.setStopCollapsed(stopId, true);
                }
                return;
            }
            expandStop(stopId);
        },
        [collapsedOf, expandStop, session, stopViewed],
    );

    // --- Полоса покрытия (docs/design/SPEC-elements.md §2.4) ---

    const coverage = useMemo(
        () => buildCoverageStrip({ totals: model.totals, entries: model.entries, t }),
        [model.entries, model.totals, t],
    );
    const [hoverTier, setHoverTier] = useState<RouteTier | null>(null);
    const markedStops = useMemo<ReadonlySet<string>>(
        () =>
            new Set(
                hoverTier === null
                    ? []
                    : (coverage.segments.find((segment) => segment.tier === hoverTier)?.stopIds ?? []),
            ),
        [coverage.segments, hoverTier],
    );

    const [selectionCard, setSelectionCard] = useState<{ readonly stopId: string; readonly group: RouteFileGroup } | null>(
        null,
    );
    useEffect(() => {
        if (diffSnapshot.selection === null) {
            setSelectionCard(null);
        }
    }, [diffSnapshot.selection]);

    const {
        cardFor,
        busyFileIds,
        stopLayoutKey,
        commentLine,
        focusedLine,
        focusedThreadId,
        selectedShownModel,
        visibleByFile,
        iterationLayout,
    } = useStopCards({
        files: diff.files,
        capabilities: pr.capabilities,
        session,
        store,
        threadStore,
        threadActions,
        threadNow,
        diffSnapshot,
        threadSnapshot,
        composersSnapshot,
        preset,
        noteActions,
        notesByFile,
        parseErrors,
        openedCollapsed,
        setOpenedCollapsed,
        openedViewed,
        setOpenedViewed,
        containerRef,
        selectionCard,
        setSelectionCard,
        expand,
        retryParse,
        markViewed,
        markStopFile,
        requestJump,
    });

    useRouteShortcuts({
        model,
        shown,
        readOnly,
        stopProgress,
        unfilledEntry,
        markStop,
        toggleCollapse,
        focusedLine,
        focusedThreadId,
        threads: threadSnapshot.threads,
        threadStore,
        commentIssues,
        commentLine,
        session,
        changeFilterOn,
        keyboardStopRef,
        topStopRef,
        jumpToStop,
        diffSnapshot,
        openedCollapsed,
        expand,
    });

    /** Первая остановка плана: её колонка диффа с DOM не снимается — это точка входа и якорь тура. */
    const firstStopId = shown.find((entry) => entry.kind === 'stop')?.view.stop.id ?? null;
    /**
     * Первая свёртка low-остановки — цель шага 02 тура. Отбор повторяет условия рендера
     * плашки: у просмотренной на её месте строка-сводка, у незаполненной — скелет, у остановки
     * с дрейфом или без файлов — своя строка. Иначе целью стала бы остановка, которая плашку
     * не рисует, и шаг зря вставал бы на запасное место мимо настоящих свёрток ниже.
     */
    const tourFoldStopId = useMemo(
        () =>
            shown.find(
                (entry) =>
                    entry.kind === 'stop' &&
                    entry.view.stop.tier === 'low' &&
                    stopViewed.get(entry.view.stop.id) !== true &&
                    collapsedOf(entry.view) &&
                    collapsedStopShown(entry.view, entryId(entry) === keptStopId ? null : filter.fileIds),
            )?.view.stop.id ?? null,
        [collapsedOf, filter.fileIds, keptStopId, shown, stopViewed],
    );

    const outsideThreads = threadSnapshot.outside;
    const selectedFile =
        diffSnapshot.selection === null
            ? null
            : (diff.files.find((file) => file.fileId === diffSnapshot.selection?.fileId) ?? null);
    const selectedModel =
        selectedFile === null
            ? null
            : (selectedShownModel ?? diffSnapshot.models.get(selectedFile.fileId) ?? null);

    return (
        <main
            className="route selection-popover-host"
            id="view-route"
            ref={setContainer}
            onScroll={handleScroll}
            /* Потолок код-панелей (`--diff-max`) считается по фактическому режиму, а не по настройке. */
            data-diff-mode={diffSnapshot.effectiveMode}
            style={
                toolbarHeight === null && viewportHeight === null
                    ? undefined
                    : ({
                          ...(toolbarHeight === null
                              ? {}
                              : { '--route-toolbar-height': `${String(toolbarHeight)}px` }),
                          ...(viewportHeight === null
                              ? {}
                              : { '--route-viewport-height': `${String(viewportHeight)}px` }),
                      } as CSSProperties)
            }
        >
            <PrHeader
                pr={pr}
                counts={prHeaderCounts(diff)}
                pci={pci?.available === true ? pci : null}
                pciActive={filter.id === PCI_FILTER_ID}
                onTogglePci={() => {
                    changeFilter(filter.id === PCI_FILTER_ID ? ALL_FILTER_ID : PCI_FILTER_ID);
                }}
                aside={props.headerAside ?? <SnapshotPill label={pillLabelOf(snapshot)} />}
            />

            <RouteToolbar
                store={store}
                preset={preset}
                onHeight={setToolbarHeight}
                onPreset={session.setPreset}
                filters={filters}
                filter={filter}
                onFilter={changeFilter}
                changeFilterOn={changeFilterOn}
                onClearChangeFilter={() => {
                    session.setRouteFilter('all');
                }}
                generationCap={props.generationCap ?? null}
                strip={
                    <CoverageStrip
                        model={settled && !filling ? coverage : null}
                        loading={
                            filling
                                ? { kind: 'plan', ready: progress.ready, total: progress.total }
                                : {
                                      kind: 'diff',
                                      ready: diff.files.length - model.totals.pendingFiles,
                                      total: diff.files.length,
                                  }
                        }
                        viewedStops={viewedStops}
                        totalStops={model.stopCount}
                        onJump={jumpToStop}
                        onHoverTier={setHoverTier}
                    />
                }
            />

            <div className="route__stops">
                {shown.length === 0 ? (
                    <div className="route__zero">
                        <p className="route__zero-text">{zeroResultText(filter, t)}</p>
                        <button
                            type="button"
                            className="ctl ctl--secondary route__zero-action"
                            onClick={() => {
                                changeFilter(ALL_FILTER_ID);
                            }}
                        >
                            {t('lens.showAll')}
                        </button>
                    </div>
                ) : null}

                {shown.map((entry) =>
                    entry.kind === 'stop' ? (
                        <StopSection
                            key={entry.view.stop.id}
                            view={entry.view}
                            first={entry.view.stop.id === firstStopId}
                            tourFold={entry.view.stop.id === tourFoldStopId}
                            busyFileIds={busyFileIds}
                            layoutKeyOf={stopLayoutKey}
                            jumping={jumpStopId === entry.view.stop.id}
                            entries={model.entries}
                            stopCount={model.stopCount}
                            comments={countStopComments(entry.view, visibleByFile, iterationLayout)}
                            changeThreads={stopChangeThreads(entry.view.stop.change, threadsById, t)}
                            {...(onOpenThread === undefined ? {} : { onOpenThread })}
                            fileIds={entryId(entry) === keptStopId ? null : filter.fileIds}
                            keptInView={entryId(entry) === keptStopId}
                            viewed={stopViewed.get(entry.view.stop.id) === true}
                            pending={entry.view.pending}
                            parseFailed={entry.view.parseFailed}
                            filledBeforeStop={agentStopped}
                            collapsed={collapsedOf(entry.view)}
                            collapsedManually={stopState.collapsed.has(entry.view.stop.id)}
                            marked={markedStops.has(entry.view.stop.id)}
                            failedViewed={stopFailures.get(entry.view.stop.id) ?? null}
                            flash={flashStopId === entry.view.stop.id}
                            readStateOf={(fileId) =>
                                diffSnapshot.readState.get(fileId) ??
                                readStateOf({
                                    file: diff.files.find((file) => file.fileId === fileId) ?? EMPTY_FILE,
                                    record: null,
                                })
                            }
                            onViewed={(value) => {
                                void markStop(entry.view.stop.id, value);
                            }}
                            {...(onFillStop === undefined || filling ? {} : { onFillStop })}
                            onExpand={() => {
                                expandStop(entry.view.stop.id);
                            }}
                            onOpenFile={openFile}
                            onOpenLink={openStopLink}
                            onVisible={requestParse}
                            renderCard={cardFor}
                            testCodeShown={stopState.testCode.has(entry.view.stop.id)}
                            onToggleTestCode={() => {
                                session.setStopTestCode(
                                    entry.view.stop.id,
                                    !stopState.testCode.has(entry.view.stop.id),
                                );
                            }}
                            anchorReachable={(fileId, line) =>
                                anchorReachable(entry.view.stop.id, fileId, line)
                            }
                            onOpenAnchor={(fileId, line) => {
                                openAnchor(entry.view.stop.id, fileId, line);
                            }}
                        />
                    ) : (
                        <OtherSection
                            key={entry.view.stop.id}
                            view={entry.view}
                            stopCount={model.stopCount}
                            pending={model.totals.pendingFiles > 0}
                            parseFailed={model.totals.failedFiles > 0}
                            filling={filling}
                            failedFiles={model.totals.failedFiles}
                            onRetryFailed={retryFailed}
                            agentConnected={agentConnected}
                            {...(onComposeQuestion === undefined ? {} : { onComposeQuestion })}
                            opened={otherOpen}
                            fileIds={entryId(entry) === keptStopId ? null : filter.fileIds}
                            keptInView={entryId(entry) === keptStopId}
                            viewed={stopViewed.get(entry.view.stop.id) === true}
                            marked={markedStops.has(entry.view.stop.id)}
                            failedViewed={stopFailures.get(entry.view.stop.id) ?? null}
                            flash={flashStopId === entry.view.stop.id}
                            onViewed={(value) => {
                                void markStop(entry.view.stop.id, value);
                            }}
                            onOpen={() => {
                                setOtherOpen((open) => !open);
                            }}
                            renderCard={cardFor}
                        />
                    ),
                )}

                {/* Треды вне диффа — те же, что в полном диффе: список у них один на PR. */}
                <OutsideThreads threads={outsideThreads} store={threadStore} actions={threadActions} now={threadNow} />
            </div>

            {diffSnapshot.selection === null || selectedFile === null || selectedModel === null ? null : (
                <SelectionPopover
                    key={`${diffSnapshot.selection.fileId}:${diffSnapshot.selection.side ?? ''}:${diffSnapshot.selection.anchor}:${diffSnapshot.selection.focus}`}
                    host={popoverHost}
                    diffId={diff.diffId}
                    file={selectedFile}
                    model={selectedModel}
                    selection={diffSnapshot.selection}
                    dragging={diffSnapshot.selectionDragging}
                    agentConnected={agentConnected}
                    inFlight={isSelectionPending(
                        chatAnchorFromSelection(selectedFile, selectedModel, diffSnapshot.selection, diff.diffId),
                    )}
                    onAsk={onAskSelection}
                    onSelectionAnchorChange={onSelectionAnchorChange}
                    onComment={(side, line) => {
                        commentLine(selectedFile.fileId, side, line);
                    }}
                    onClear={store.clearSelection}
                />
            )}

            <span className="visually-hidden" role="status" aria-live="polite">
                {announcement}
            </span>
        </main>
    );
}

/** Файл записи маршрута по пути ссылки; `null` — этой записи такой файл не принадлежит. */
function fileIdByPath(entry: RouteEntry, path: string): string | null {
    const files: readonly { readonly path: string; readonly fileId: string }[] = entry.view.files;
    return files.find((file) => file.path === path)?.fileId ?? null;
}

/** Индикатор без пикера: снапшот на экране и есть текущий (галерея, автономный workspace). */
function pillLabelOf(snapshot: RouteSnapshot): ViewingLabel {
    return { kind: 'snapshot', commit: snapshot.commit, status: 'current' };
}

/** Дефолты необязательных пропов заметок: вызывающие без чата (галерея, тесты) их не передают. */
export const EMPTY_NOTES: readonly AgentNote[] = [];
export const EMPTY_OPEN_NOTE = (): void => undefined;
export const EMPTY_DELETE_NOTE = (): Promise<void> => Promise.reject(new Error('deleting notes is unavailable here'));

const EMPTY_FILE = {
    generated: false,
    viewed: false,
    additions: 0,
    deletions: 0,
} as const;
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
const NO_SELECTION_ANCHOR_CHANGE = (): void => undefined;
const EMPTY_SET_STOP_VIEWED = (): Promise<number> =>
    Promise.reject(new Error('marking a stop viewed is unavailable in this state'));
const EMPTY_SET_STOP_FILE_VIEWED = (): Promise<number> =>
    Promise.reject(new Error('marking a stop file viewed is unavailable in this state'));

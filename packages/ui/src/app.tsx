import type { DraftBufferEntry } from '@sherpa/protocol';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';

import './app.css';
import { MessageScreen } from './components/message-screen.tsx';
import { fetchDraftBuffer, sendFeedback, setReviewThreadResolved } from './api.js';
import { buildBannerSources } from './app/banners.tsx';
import {
    EMPTY_ITERATIONS,
    EMPTY_THREADS,
    hostDisplayName,
    isLocalHost,
    reviewStateForKeys,
    sliceReviewState,
} from './app/review-state.js';
import { useAuditFilter } from './app/use-audit-filter.js';
import { useChat } from './app/use-chat.js';
import { useDiffStore } from './app/use-diff-store.js';
import { useRouteUncovered } from './app/use-route-uncovered.js';
import { useIterationPicker } from './app/use-iteration-picker.tsx';
import { useProgressWriter } from './app/use-progress-writer.js';
import { useReviewData, useReviewState } from './app/use-review-data.js';
import { useRouteGeneration } from './app/use-route-generation.js';
import { useShipVerdict } from './app/use-ship-verdict.js';
import { agentPillView } from './components/agent-pill-view.js';
import { auditScopeBannerVisible } from './components/audit-banner.tsx';
import { BannerSlot } from './components/banner-slot.tsx';
import { ChatPanel } from './components/chat-panel.tsx';
import { useChatDock } from './components/dock.js';
import { usePrCommentsGate } from './components/pr-comments-gate.js';
import { routeLocaleBannerVisible } from './components/route-locale-banner.tsx';
import { reconnectCommand } from './components/reconnect-command.js';
import type { ReviewCompletion } from './components/review-action-bar.tsx';
import {
    reviewActionBarVisible,
    ReviewActionBar,
} from './components/review-action-bar.tsx';
import { useUpdateCheckCommand, useUpdateToast } from './components/update-state.js';
import { UpdateToast } from './components/update-toast.tsx';
import { ReviewComplete } from './components/review-complete.tsx';
import { ShortcutCheatsheet } from './components/shortcut-cheatsheet.tsx';
import { TopBar } from './components/top-bar.tsx';
import { ReviewHostProvider } from './app/review-host-context.tsx';
import { BlobLoaderProvider } from './diff-view/blob-loader.tsx';
import { expandFileContext } from './diff-view/expand.js';
import { findAgentNote, flashAgentNote, revealWhenReady } from './diff-view/line-target.js';
import {
    buildFileFilters,
    filterFiles,
    filterStats,
    findFilter,
    PCI_FILTER_ID,
} from './filters/lens-filters.js';
import { updateFragment } from './fragment.js';
import { useLocale, useT } from './i18n/index.js';
import { useLocaleCommands } from './i18n/locale-commands.js';
import { ReadOnlyIterationProvider, SLICE_READ_ONLY_REASON } from './iterations/read-only.tsx';
import { ThreadPinProvider } from './iterations/thread-pin.tsx';
import type { ThreadPinContextValue } from './iterations/thread-pin.tsx';
import {
    activeIterationDiffId,
    fallbackSnapshots,
    resolveViewing,
    VIEWING_CURRENT,
} from './iterations/viewing.js';
import {
    TourHost,
    tourAnchorEpoch,
    TourScaffold,
    useTourActive,
    useTourReplayCommand,
} from './onboarding/index.js';
import { CommandPalette } from './palette/command-palette.tsx';
import type { PaletteDiffSource, PaletteNavigation, PaletteNavigationTarget } from './palette/diff-source.tsx';
import { breadcrumbFor, documentTitleFor } from './pr-key.js';
import type { ReportedRouteSummary, RouteSummary } from './route/route-summary.js';
import { routeFactsForSnapshot } from './route/route-summary.js';
import type { OtherStopFacts } from './route/other-stop.js';
import { visibleStops } from './route/other-stop.js';
import type { SessionStore } from './session/session-store.js';
import type { ViewId } from './session/views.js';
import { useShortcut, useShortcutRegistry } from './shortcuts/context.tsx';
import type { ShortcutScope } from './shortcuts/registry.js';
import type { Store } from './store.js';
import { attachComposerBeforeUnload } from './threads/before-unload.js';
import { syncBufferedComposers } from './threads/draft-buffer.js';
import { createThreadActions } from './threads/actions.js';
import { createComposerTransport, createPublishedCommentTransport } from './threads/transport.js';
import type { ThreadActions } from './threads/thread-list.tsx';
import { persistentThreadStore } from './threads/persistent-store.js';
import type { ThreadStore } from './threads/store.js';
import { UI_VERSION } from './version.js';
import { FullDiffView } from './views/full-diff.tsx';
import { secondPassBannerVisible } from './views/route/iteration-banners.tsx';
import { RouteCommands, RouteGenerateCommand, RoutePresetCommand } from './views/route/route-commands.tsx';
import { RouteFailedView, RouteReadingView } from './views/route/route-generating.tsx';
import { RouteView } from './views/route/route-view.tsx';
import { IterationWithoutRoute, SliceWithoutOverview, ViewFrame } from './views/view-frames.tsx';

/** Подписка на стор, которого ещё нет: ссылка обязана быть постоянной. */
const noSubscribe = (): (() => void) => () => undefined;

/** Область реестра шорткатов по открытому вью (docs/design/SPEC-elements.md §5). */
const SCOPE_OF_VIEW: Readonly<Record<ViewId, ShortcutScope>> = {
    overview: 'overview',
    route: 'route',
    diff: 'full-diff',
};

/** Главная страница читает серверный и сессионный сторы через `useSyncExternalStore`. */
export interface AppProps {
    readonly store: Store;
    readonly session: SessionStore;
    readonly token: string;
}

export function App({ store, session, token }: AppProps) {
    const t = useT();
    /** Эффективный язык вкладки: он же язык генерации маршрута и ответов чата. */
    const uiLocale = useLocale();
    // Смена языка — команды палитры в группе «Шерпа»: своего поповера настроек в дизайне нет.
    useLocaleCommands();
    const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot);
    const { view, filter: filterId, preset, routeFilter, viewing, paletteOpen, chatOpen } = useSyncExternalStore(
        session.subscribe,
        session.getSnapshot,
    );
    const viewSelection = useSyncExternalStore(
        session.subscribeViewSelection,
        session.getViewSelectionSnapshot,
        session.getViewSelectionSnapshot,
    );
    // Открытый чат сужает колонку контента: по классу CSS считает `--dock-*` и слои панели действий.
    useChatDock(chatOpen);
    // Область реестра шорткатов = открытое вью: одна и та же клавиша значит на них разное.
    const shortcutRegistry = useShortcutRegistry();
    useEffect(() => {
        shortcutRegistry?.setActiveScope(SCOPE_OF_VIEW[view]);
    }, [shortcutRegistry, view]);
    const state = snapshot.state;
    const reviewReady = state !== null;
    // Команда палитры «Проверить обновления»; сам тост — ниже, он ждёт конца тура.
    const [paletteStatus, setPaletteStatus] = useState<string | null>(null);
    useUpdateCheckCommand({
        token,
        current: state?.update?.current ?? UI_VERSION,
        onStatus: setPaletteStatus,
    });
    // Вкладка браузера несёт PR (№37): до прихода меты — номер из ключа, пустой она не бывает.
    const documentTitle = state === null ? null : documentTitleFor(state.prKey, state.pr);
    const reviewHost = state?.reviewHost ?? null;
    /** Локальное ревью: PR здесь нет, и про ушедшую итерацию UI говорит своими словами. */
    const localHost = isLocalHost(reviewHost);
    const reviewKey = `${token}\u0000${reviewHost ?? 'none'}`;
    const chatKey = [reviewKey, state?.prKey ?? 'none'].join(':');

    // --- Выбор итерации: список снапшотов, разрешение выбора, ключ данных вкладки ---

    const {
        snapshotsState,
        setSnapshotsState,
        facts,
        setActiveFacts,
        applyActiveRoute,
        reviewState,
        setReviewState,
    } = useReviewState(reviewKey, reviewHost);
    const snapshotsLoaded = snapshotsState.key === reviewKey && snapshotsState.loaded;
    const snapshots = useMemo(
        () => (snapshotsState.key === reviewKey ? snapshotsState.list : null) ?? fallbackSnapshots(facts.snapshot),
        [facts.snapshot, reviewKey, snapshotsState],
    );
    const iterations = state?.iterations ?? EMPTY_ITERATIONS;
    // Маршрут читается из уже сохранённого состояния: разрешение выбора не ждёт его перечитки,
    // а параметры ручек от маршрута и не зависят — только подписи.
    const storedRoute = reviewState.key === reviewKey ? reviewState.route : null;
    const resolved = useMemo(
        () =>
            resolveViewing({
                viewing,
                snapshots,
                iterations,
                route: storedRoute,
                activeDiffId: facts.diffId,
                activeCommit: facts.commit,
                snapshotsLoaded,
                activeLoaded: facts.routeSettled,
            }),
        [facts.commit, facts.diffId, facts.routeSettled, iterations, snapshots, snapshotsLoaded, storedRoute, viewing],
    );
    // Активная итерация PR: она же — точка отсчёта для пинов тредов.
    const activeDiffId = useMemo(
        () => activeIterationDiffId({ iterations, activeDiffId: facts.diffId }),
        [facts.diffId, iterations],
    );
    const viewDiffId = resolved.diffId;
    /** Итерация, глазами которой раскладываются заметки: выбранная, а по умолчанию — активная. */
    const notesDiffId = viewDiffId ?? activeDiffId;
    const viewSnapshotId = resolved.snapshotId;
    const viewPending = resolved.pending;
    const readOnly = resolved.readOnly;
    /** Вкладка смотрит срез между итерациями: дифф грузится ручкой `base`/`head`. */
    const sliceBase = resolved.slice?.base ?? null;
    const sliceHead = resolved.slice?.head ?? null;
    /**
     * Ключ перечитки диффа и линз без параметров: своей ревизии у них нет, о пуше они узнают
     * только отсюда. Пока снапшот маршрута построен для прошлой итерации, ключ держит её дифф
     * (якоря стопов адресуют файлы по `fileId` своей итерации) и переезжает
     * с приёмкой нового скелета; без снапшота — по активной итерации из состояния.
     * `activeDiffId` не годится: его запасной `facts.diffId` берётся из ответа самого диффа
     * и гонял бы запрос дважды на открытии. Выбранную итерацию, снапшот и срез ключ не двигает.
     */
    const activeIterationKey = useMemo(() => {
        if (viewDiffId !== null || sliceBase !== null) {
            return null;
        }
        const active = iterations.find((iteration) => iteration.status === 'active')?.diffId ?? null;
        return active === null ? null : (facts.snapshot?.diffId ?? active);
    }, [facts.snapshot, iterations, sliceBase, viewDiffId]);
    const viewKey = [reviewKey, viewDiffId ?? '', viewSnapshotId ?? '', sliceBase ?? '', sliceHead ?? ''].join('\u0000');
    const storedReview = reviewStateForKeys(reviewState, reviewKey, viewKey);
    /**
     * Данные вкладки. У среза нет ни прогресса, ни линз, ни тредов: его `fileId` — отдельное
     * пространство имён, и ручки итерации к нему неприменимы. Пустые заглушки
     * стоят вместо них, иначе Full diff ждал бы того, чего не будет.
     */
    const currentReview = useMemo(
        () => (sliceBase === null ? storedReview : sliceReviewState(storedReview)),
        [sliceBase, storedReview],
    );
    // Выбор из адреса не нашёлся ни в списке, ни в текущем состоянии: показываем текущее.
    useEffect(() => {
        if (resolved.unknown) {
            session.setViewing(VIEWING_CURRENT);
        }
    }, [resolved.unknown, session]);
    const currentDiff = currentReview.diff;
    const viewedMirrorAvailable = state?.pr?.capabilities.fileViewedSync === true;
    /** Хост отдаёт срезы между итерациями: без этого Shift+клик в пикере срез не строит. */
    const interdiffAvailable = state?.pr?.capabilities.iterations === true;
    /** Байты картинок: без `capabilities.blobs` карточка-картинка не рисуется вовсе. */
    const blobsAvailable = state?.pr?.capabilities.blobs === true;
    const routeSnapshotId = currentReview.route?.snapshot?.snapshotId ?? null;
    const prKey = state?.prKey ?? null;
    const { diffStore, loadBlob, parse } = useDiffStore({ diff: currentDiff, prKey, blobsAvailable, token });
    /*
     * Фактический режим диффа приложению нужен ровно для одного: он меняет потолок код-панелей,
     * а значит и рамку тура. Подписка отдаёт строку — на прочие обновления стора (разбор моделей,
     * прогресс) React не перерисовывает: значение то же.
     */
    const effectiveDiffMode = useSyncExternalStore(
        diffStore?.subscribe ?? noSubscribe,
        () => diffStore?.getSnapshot().effectiveMode ?? 'unified',
    );
    const { progressWriter, stopProgress, mirroredFileWrites, progressWritesSettled } = useProgressWriter({
        viewKey,
        diffStore,
        routeSnapshotId,
        token,
        readOnly,
    });
    const [activeFileId, setActiveFileId] = useState<string | null>(null);
    const [paletteNavigation, setPaletteNavigation] = useState<PaletteNavigation | null>(null);
    const navigationId = useRef(0);
    /** Переход к остановке из палитры: вью маршрута доводит прокрутку по растущему `id`. */
    const [routeNavigation, setRouteNavigation] = useState<{ id: number; stopId: string } | null>(null);
    const routeNavigationId = useRef(0);
    /** Маршрут объясняет меньше половины диффа — баннер поднимает слот уведомлений (docs/design/SPEC-elements.md §4.3). */
    const [routeUnderExplained, setRouteUnderExplained] = useState(false);
    /**
     * Числа маршрута от вью: остановки в порядке рендера и непокрытое для гардрейла и итога ревью.
     * Отчёт живёт и вне вкладки, но только для своего снапшота.
     */
    const [routeSummaryState, setRouteSummaryState] = useState<
        ({ readonly key: string } & ReportedRouteSummary) | null
    >(null);
    // Любой session.setView, включая повторный выбор текущего таба, снимает Review complete.
    const [completionState, setCompletionState] = useState<{
        key: string;
        viewSelection: number;
        value: ReviewCompletion;
    } | null>(null);
    const completion =
        completionState?.key === reviewKey && completionState.viewSelection === viewSelection
            ? completionState.value
            : null;

    useEffect(() => {
        if (documentTitle !== null) {
            document.title = documentTitle;
        }
    }, [documentTitle]);

    const { refreshRoute } = useReviewData({
        token,
        reviewKey,
        viewKey,
        reviewReady,
        reviewHost,
        routeRevision: snapshot.routeRevision,
        progressRevision: snapshot.progressRevision,
        threadsRevision: snapshot.threadsRevision,
        viewDiffId,
        viewSnapshotId,
        viewPending,
        sliceBase,
        sliceHead,
        activeIterationKey,
        readOnly,
        currentDiff,
        progress: currentReview.progress,
        viewedMirrorAvailable,
        diffStore,
        progressWriter,
        stopProgress,
        mirroredFileWrites,
        progressWritesSettled,
        setSnapshotsState,
        setActiveFacts,
        setReviewState,
        applyActiveRoute,
        setActiveFileId,
        setPaletteNavigation,
    });

    const threadFileIds = useMemo(
        () => new Set(currentDiff?.files.map((file) => file.fileId) ?? []),
        [currentDiff],
    );
    /**
     * Нарисован дифф прошлой итерации: `fileId` там свой, а треды приезжают один раз для
     * активной итерации — раскладка ищет файл по `path` и держит у строк только треды пина.
     */
    const threadIterationLayout = useMemo(
        () =>
            currentDiff === null || activeDiffId === null || currentDiff.diffId === activeDiffId
                ? null
                : {
                      diffId: currentDiff.diffId,
                      fileIdByPath: new Map(currentDiff.files.map((file) => [file.path, file.fileId])),
                  },
        [activeDiffId, currentDiff],
    );
    const serverThreads = currentReview.threads ?? EMPTY_THREADS;
    /**
     * Ключ стора тредов: у среза `diffId` совпадает с итерацией его головы, поэтому свой ключ —
     * иначе пустой список тредов среза затирал бы треды и открытые композеры этой итерации.
     */
    const threadStoreKey =
        sliceBase === null ? (currentDiff?.diffId ?? null) : `${sliceBase}..${sliceHead ?? ''}`;
    const threadStore = useMemo<ThreadStore | null>(
        () =>
            currentDiff === null || state === null || threadStoreKey === null
                ? null
                : persistentThreadStore(
                      state.prKey,
                      threadStoreKey,
                      serverThreads,
                      threadFileIds,
                      threadIterationLayout,
                  ),
        [currentDiff, serverThreads, state, threadFileIds, threadIterationLayout, threadStoreKey],
    );
    // Пуш переводит открытую итерацию из активной в прошлую: стор остаётся тот же (в нём
    // живут открытые композеры), меняется только раскладка.
    useEffect(() => {
        threadStore?.setIterationLayout(threadIterationLayout);
    }, [threadIterationLayout, threadStore]);
    useEffect(() => {
        if (threadStore !== null && currentReview.threads !== null) {
            threadStore.setServerThreads(currentReview.threads);
        }
    }, [currentReview.threads, threadStore]);
    // «Своё» у опубликованных комментариев считается по личности ревьюера из меты PR.
    const viewerLogin = state?.pr?.viewer?.login ?? null;
    useEffect(() => {
        threadStore?.setViewer(viewerLogin);
    }, [threadStore, viewerLogin]);
    useEffect(() => (threadStore === null ? undefined : attachComposerBeforeUnload(threadStore)), [threadStore]);
    const composerTransport = useMemo(() => createComposerTransport(token), [token]);
    const publishedTransport = useMemo(() => createPublishedCommentTransport(token), [token]);
    const resolveThread = useCallback(
        (threadId: string, resolved: boolean) => setReviewThreadResolved(token, threadId, resolved),
        [token],
    );
    /**
     * Действия тредов для модалки «Комментарии к PR»: она живёт рядом с панелью действий,
     * а не во вью диффа, и собственной обвязки резолва и правки у неё нет. Очередь записи
     * привязана к стору, поэтому вторым набором действий она не раздваивается.
     */
    const prCapabilities = state?.pr?.capabilities ?? null;
    const prThreadActions = useMemo<ThreadActions | null>(
        () =>
            threadStore === null || prCapabilities === null
                ? null
                : createThreadActions(
                      threadStore,
                      composerTransport,
                      resolveThread,
                      {
                          transport: publishedTransport,
                          commentResolve: prCapabilities.commentResolve,
                          editPublished: prCapabilities.editPublished,
                      },
                      prCapabilities.commentIssues,
                  ),
        [composerTransport, prCapabilities, publishedTransport, resolveThread, threadStore],
    );

    const { shipVerdict, shipVerdictNow, setShipVerdict, publishHere } = useShipVerdict(
        state?.pr?.verdicts ?? null,
        token,
    );

    /**
     * Буфер черновиков читается вместе с тредами: то же событие `review`, тот же токен.
     * Провал чтения не показывается отдельно — на экране остаётся последний известный буфер,
     * а следующая ревизия перечитает его заново.
     */
    const [draftBuffer, setDraftBuffer] = useState<readonly DraftBufferEntry[]>(EMPTY_DRAFT_BUFFER);
    useEffect(() => {
        if (!reviewReady || reviewHost === null) {
            return;
        }
        let alive = true;
        void fetchDraftBuffer(token).then(
            (entries) => {
                if (alive) {
                    setDraftBuffer(entries);
                }
            },
            () => undefined,
        );
        return () => {
            alive = false;
        };
    }, [reviewHost, reviewReady, snapshot.threadsRevision, token]);
    // Буферные записи возвращаются в композеры на своих якорях: после перезагрузки вкладки
    // текст обязан оказаться на той же строке.
    // Треды в зависимостях не для перерисовки: и правка черновика, и ответ восстанавливаются
    // только вместе со своим комментарием в снапшоте, а он приезжает своим чередом.
    useEffect(() => {
        if (threadStore !== null) {
            syncBufferedComposers(threadStore, draftBuffer);
        }
    }, [currentReview.threads, draftBuffer, threadStore]);

    const { setDiffFilterHandler, showAllAuditFiles } = useAuditFilter(session);

    const navigateFromPalette = useCallback(
        (target: PaletteNavigationTarget) => {
            navigationId.current += 1;
            setPaletteNavigation({ id: navigationId.current, target });
            session.setView('diff');
        },
        [session],
    );
    const paletteSource = useMemo<PaletteDiffSource | null>(() => {
        if (currentDiff === null || diffStore === null) {
            return null;
        }
        return {
            files: currentDiff.files,
            activeFileId,
            searchModels: () => {
                const snapshot = diffStore.getSnapshot();
                return new Map(
                    [...snapshot.models].map(([fileId, model]) => [
                        fileId,
                        expandFileContext(
                            model,
                            snapshot.content.get(fileId) ?? null,
                            snapshot.expansion.get(fileId) ?? new Map(),
                        ),
                    ]),
                );
            },
            goToFile: (fileId) => {
                navigateFromPalette({ kind: 'file', fileId });
            },
            goToLine: (fileId, side, line) => {
                navigateFromPalette({ kind: 'line', fileId, side, line });
            },
            toggleDiffMode: () => {
                const current = diffStore.getSnapshot().diffMode;
                diffStore.setDiffMode(current === 'unified' ? 'split' : 'unified');
            },
        };
    }, [activeFileId, currentDiff, diffStore, navigateFromPalette]);

    const filters = useMemo(
        () =>
            currentDiff === null || currentReview.lenses === null
                ? []
                : buildFileFilters({
                      files: currentDiff.files,
                      ownership: currentReview.lenses.ownership,
                      extra: currentReview.lenses.extra,
                      t,
                  }),
        [currentDiff, currentReview.lenses, t],
    );
    const pci = findFilter(filters, PCI_FILTER_ID);
    const pciStats = currentDiff === null || pci === null ? null : filterStats(currentDiff.files, pci);
    const pciPaths =
        currentDiff === null || pci === null ? [] : filterFiles(currentDiff.files, pci).map((file) => file.path);
    const auditKey = `${reviewKey}\u0000${filterId}`;
    const [dismissedAuditKey, setDismissedAuditKey] = useState<string | null>(null);
    useEffect(() => {
        const timer = window.setTimeout(() => {
            setDismissedAuditKey(null);
        }, 0);
        return () => {
            window.clearTimeout(timer);
        };
    }, [filterId, reviewKey]);
    const auditVisible = auditScopeBannerVisible(
        view,
        filterId,
        dismissedAuditKey === auditKey,
        pciStats?.files ?? 0,
    );

    // --- Генерация маршрута: ручки, долгая задача, дефолтная вью малого PR ---

    const route = currentReview.route;
    // Тур стартует, как только есть снапшот и дифф: маршрута он не ждёт.
    const tourActive = useTourActive(state !== null && currentDiff !== null);

    const {
        routePhase,
        routeKind,
        generating,
        cancelling,
        routeActionError,
        startGeneration,
        fillStop,
        cancelGeneration,
        now,
        longRunning,
        actionErrorInPlace,
        generateAvailable,
    } = useRouteGeneration({
        route,
        token,
        uiLocale,
        t,
        session,
        view,
        tasks: state?.tasks,
        tourActive,
        refreshRoute,
    });

    /**
     * Снапшот, на котором стоят числа ревью: завершённый маршрут с `contentHash`. Старый готовый
     * снапшот остаётся таким и во время перестройки; новый частичный до `ready` сюда не попадает.
     */
    const routeSnapshot = route?.snapshot?.contentHash == null ? null : route.snapshot;
    /** Что рисует вкладка «Маршрут»: любой живой снапшот, включая старый во время перестройки. */
    const routeViewSnapshot = routeKind === 'workspace' && !resolved.routeless ? (route?.snapshot ?? null) : null;
    /**
     * Кап генерации (docs/design/SPEC-elements.md §4.1). Сервер считает его по активному снапшоту, поэтому в режиме
     * чтения прошлой итерации он молчит: там на экране чужой маршрут.
     */
    const generationCap = readOnly ? null : (state?.generationCap ?? null);
    /**
     * Баннер второго захода закрыт для этого снапшота: он описывает фильтр, а такие закрывают
     * (docs/design/SPEC-elements.md §2.21). Дизмисс живёт в сессии вкладки и снимается сам, когда приедет новый снапшот.
     */
    const [dismissedSecondPass, setDismissedSecondPass] = useState<string | null>(null);
    const secondPassVisible = secondPassBannerVisible(
        view,
        routeSnapshot,
        route?.stale ?? null,
        dismissedSecondPass,
        readOnly,
    );
    /** Классифицированные остановки готового снапшота: их считает баннер второго захода. */
    const routeChangedStops = routeSnapshot?.stops.filter((stop) => stop.change !== null).length ?? 0;
    /** Есть ли на готовом снапшоте классифицированные остановки — от этого зависит фильтр «что нового». */
    const routeHasChanges = routeChangedStops > 0;
    /**
     * На готовом снапшоте без классифицированных остановок фильтр «что нового» недействителен
     * и сбрасывается: иначе он висел бы в адресе и молча включился бы на следующем заходе,
     * где классификация появится, — хотя ревьюер его тогда не включал.
     */
    useEffect(() => {
        if (routeFilter === 'new' && routeSnapshot !== null && !routeHasChanges) {
            session.setRouteFilter('all');
        }
    }, [routeFilter, routeHasChanges, routeSnapshot, session]);

    const {
        pickerMenuRows,
        selectViewing,
        openIterationWithoutRoute,
        sliceCommits,
        backToActiveIteration,
        snapshotPill,
    } = useIterationPicker({
        session,
        snapshots,
        iterations,
        factsDiffId: facts.diffId,
        factsCommit: facts.commit,
        interdiffAvailable,
        localHost,
        resolved,
        now,
    });

    const agentConnected = state?.worker.kind === 'connected';
    const {
        chatData,
        currentChat,
        currentChatComposer,
        setChatComposerContext,
        chatFocusRequest,
        chatPrefillRequest,
        chatScrollRequest,
        chatAnchorNavigationRequest,
        noteFocusRequest,
        openNoteInChat,
        lostNoteIds,
        firstLostNote,
        notesInCode,
        isSelectionPending,
        selectChatAnchor,
        openChatForSelection,
        composeRouteQuestion,
        composeDiffQuestion,
        closeChat,
        toggleChat,
        handleChatScrollRequest,
        askChat,
        cancelChat,
        retryChat,
        deleteNote,
        navigateChatAnchor,
        navigateToNote,
        paletteChat,
    } = useChat({
        chatKey,
        token,
        uiLocale,
        session,
        reviewHost,
        reviewReady,
        chatRevision: snapshot.chatRevision,
        view,
        notesDiffId,
        sliceBase,
        currentDiff,
        now,
        agentConnected,
    });

    const [dismissedNotesLost, setDismissedNotesLost] = useState<string | null>(null);
    /**
     * «Оставить» на баннере языка маршрута: память вкладки, ключ — id снапшота.
     * Новый снапшот на чужом языке спросит заново.
     */
    const [keptRouteLocale, setKeptRouteLocale] = useState<string | null>(null);
    const routeLocaleVisible = routeLocaleBannerVisible({
        route,
        uiLocale,
        generating,
        keptSnapshotId: keptRouteLocale,
        readOnly,
    });
    /** Почему «Перестроить» недоступно; `undefined` — доступно. */
    const routeLocaleRebuildBlocked = generateAvailable
        ? undefined
        : route?.smallPr === true
          ? t('route.smallPr.notGenerated')
          : t('route.locale.rebuild.unavailable');

    const bannerSources = buildBannerSources({
        view,
        reviewHost,
        session,
        now,
        readOnly,
        resolved,
        route,
        routePhase,
        generating,
        cancelling,
        generateAvailable,
        startGeneration,
        cancelGeneration,
        routeActionError,
        actionErrorInPlace,
        openIterationWithoutRoute,
        routeSnapshot,
        routeChangedStops,
        secondPassVisible,
        onDismissSecondPass: setDismissedSecondPass,
        routeUnderExplained,
        lostNoteIds,
        firstLostNote,
        dismissedNotesLost,
        onDismissNotesLost: setDismissedNotesLost,
        openNoteInChat,
        shipVerdict,
        shipVerdictNow,
        onDismissShipVerdict: () => {
            setShipVerdict(null);
        },
        generationCap,
        routeLocaleVisible,
        routeLocaleRebuildBlocked,
        onKeepRouteLocale: () => {
            setKeptRouteLocale(route?.snapshot?.snapshotId ?? null);
        },
        auditVisible,
        auditKey,
        pci,
        pciStats,
        pciPaths,
        showAllAuditFiles,
        onDismissAudit: setDismissedAuditKey,
    });
    const stopViewed = useSyncExternalStore(
        stopProgress.subscribe,
        stopProgress.getSnapshot,
        stopProgress.getSnapshot,
    );
    /**
     * Видно ли «Прочее» (`otherStopVisible`) в Обзоре, палитре, туре и панели действий — по тем же
     * моделям, что у вью маршрута, но без его монтирования: дифф разбирается фоном.
     */
    const routeUncovered = useRouteUncovered({
        diff: currentDiff,
        store: diffStore,
        snapshot: route?.snapshot ?? null,
        parse,
    });
    const conflictFiles = useMemo(
        () => currentDiff?.files.filter((file) => file.changeType === 'conflict').length ?? 0,
        [currentDiff],
    );
    const routeOtherFacts = useMemo<OtherStopFacts>(
        () => ({ uncovered: routeUncovered, conflictFiles }),
        [conflictFiles, routeUncovered],
    );
    const reportedRouteSummary = routeSummaryState?.key === reviewKey ? routeSummaryState : null;
    const routeSummary = useMemo(
        () =>
            routeSnapshot === null ? null : routeFactsForSnapshot(routeSnapshot, reportedRouteSummary, routeOtherFacts),
        [reportedRouteSummary, routeOtherFacts, routeSnapshot],
    );
    const reportRouteSummary = useCallback(
        (value: RouteSummary) => {
            // Пока маршрут заполняется, его числа промежуточные: гардрейл и итог ревью
            // подхватят их, когда фаза станет `ready` (зависимость на фазу перезапустит отчёт).
            if (routePhase === 'ready' && routeSnapshot !== null) {
                setRouteSummaryState({ key: reviewKey, snapshotId: routeSnapshot.snapshotId, value });
            }
        },
        [reviewKey, routePhase, routeSnapshot],
    );
    const jumpToStop = useCallback(
        (stopId: string) => {
            routeNavigationId.current += 1;
            setRouteNavigation({ id: routeNavigationId.current, stopId });
            session.setView('route');
        },
        [session],
    );

    const [cheatsheetOpen, setCheatsheetOpen] = useState(false);
    useShortcut({
        id: 'help.cheatsheet',
        keys: ['?'],
        label: 'shortcut.help.cheatsheet',
        scope: 'global',
        section: 'navigation',
        action: () => {
            setCheatsheetOpen(true);
        },
    });
    useEffect(() => {
        if (noteFocusRequest === null || (view !== 'route' && view !== 'diff')) {
            return;
        }

        return revealWhenReady(() => {
            const root =
                view === 'route'
                    ? document.querySelector<HTMLElement>('#view-route')
                    : document.querySelector<HTMLElement>('.full-diff');
            const note = root === null ? null : findAgentNote(root, noteFocusRequest.noteId);
            if (note === null) {
                return false;
            }
            note.scrollIntoView({ block: 'center' });
            flashAgentNote(note);
            return true;
        }, NOTE_FOCUS_SEARCH_MS);
    }, [noteFocusRequest, view]);

    const selectView = useCallback(
        (next: ViewId) => {
            session.setView(next);
        },
        [session],
    );
    const completeReview = useCallback(
        (value: ReviewCompletion) => {
            // Свежий статус PR после публикации сервер перечитывает сам и шлёт снапшотом.
            setCompletionState({ key: reviewKey, viewSelection: session.getViewSelectionSnapshot(), value });
        },
        [reviewKey, session],
    );
    /** Открыть тред по id: фрагмент `thread` плюс переход на полный дифф — там его и видно. */
    const openThreadInDiff = useCallback(
        (threadId: string) => {
            window.location.hash = updateFragment(window.location.hash, { thread: threadId, file: null });
            session.setView('diff');
        },
        [session],
    );
    /**
     * «Показать на старом коммите» (docs/design/SPEC-elements.md §2.17): итерация пина на вкладке полного диффа —
     * маршрута у неё, как правило, нет. Выбор и `thread` уезжают одним патчем фрагмента,
     * иначе смена итерации сняла бы `thread` как якорь чужого диффа.
     */
    const openThreadAtIteration = useCallback(
        (diffId: string, threadId: string) => {
            session.setView('diff');
            session.setViewing({ kind: 'diff', diffId }, { thread: threadId, file: null });
            // Адрес пишется через replaceState, а он слушателей `hashchange` не будит.
            window.dispatchEvent(new Event('hashchange'));
        },
        [session],
    );
    // Модалка комментариев к PR: её открывают панель действий и карточка обсуждения (§1e п.5).
    const prComments = usePrCommentsGate();
    const threadPin = useMemo<ThreadPinContextValue>(
        () => ({ activeDiffId, viewingDiffId: currentDiff?.diffId ?? null, openAtPin: openThreadAtIteration }),
        [activeDiffId, currentDiff, openThreadAtIteration],
    );

    /** Шаг 06 тура открывает панель чата и закрывает её, уходя с шага (docs/design/SPEC-onboarding-2026-09-02.md §2). */
    const openChatPanel = useCallback(() => {
        session.setChatOpen(true);
    }, [session]);
    /** Ключ прохода: «показать онбординг заново» пересоздаёт хост, и тур начинается с 01. */
    const [tourReplays, setTourReplays] = useState(0);
    const replayTour = useCallback(() => {
        setTourReplays((count) => count + 1);
    }, []);
    useTourReplayCommand(replayTour, agentConnected);
    const tourEpoch = tourAnchorEpoch({
        view,
        routeKind,
        anyStopFilled:
            routeViewSnapshot !== null &&
            visibleStops(routeViewSnapshot, routeOtherFacts).some((stop) => stop.status === 'ready'),
        chatOpen,
        completed: completion !== null,
        diffMode: effectiveDiffMode,
        locale: uiLocale,
    });
    /**
     * Каркас тура вместо пустой вкладки маршрута: пока маршрута нет, целям шагов 01–03
     * не на чём стоять. У малого PR и у прошлой итерации маршрута не будет вовсе — там
     * каркас соврал бы, и шаги честно уходят на запасную позицию.
     */
    const tourScaffoldVisible =
        tourActive &&
        view === 'route' &&
        completion === null &&
        !resolved.routeless &&
        (routeKind === 'invitation' || routeKind === 'reading' || routeKind === 'failed');
    // Тост обновления ждёт конца тура: поверх него он не показывается.
    const updateToast = useUpdateToast(state?.update ?? null, tourActive);

    if (snapshot.connection === 'fatal') {
        return (
            <MessageScreen title={t('app.stopped')}>
                <p>{snapshot.error}</p>
            </MessageScreen>
        );
    }

    if (state === null) {
        return (
            <MessageScreen title={t('app.name')}>
                <p>{snapshot.connection === 'connecting' ? t('app.connecting') : t('app.reconnecting')}</p>
            </MessageScreen>
        );
    }

    const reviewActionBarDataReady =
        currentReview.progress !== null &&
        currentReview.threads !== null &&
        currentDiff !== null &&
        diffStore !== null &&
        threadStore !== null;
    const showReviewActionBar = reviewActionBarVisible({
        completed: completion !== null,
        reviewHost,
        pr: state.pr,
        dataReady: reviewActionBarDataReady,
    });

    return (
        <ReviewHostProvider value={reviewHost}>
        <BlobLoaderProvider loadBlob={loadBlob}>
        <ReadOnlyIterationProvider
            readOnly={readOnly}
            {...(sliceBase === null ? {} : { reason: SLICE_READ_ONLY_REASON })}
        >
            <ThreadPinProvider value={threadPin}>
            <TopBar
                version={UI_VERSION}
                update={state.update}
                onOpenUpdate={updateToast.reopen}
                breadcrumb={breadcrumbFor(state.prKey, state.pr)}
                agent={agentPillView(state.worker, state.tasks, t)}
                reconnectCommand={reconnectCommand(state.prKey)}
                chatOpen={chatOpen}
                onToggleChat={toggleChat}
                view={view}
                onSelectView={selectView}
                onOpenSearch={() => {
                    session.setPaletteOpen(true);
                }}
                agentConnected={agentConnected}
                onReplayTour={replayTour}
                feedback={state.feedback}
                feedbackContext={{
                    uiVersion: UI_VERSION,
                    prKey: state.prKey,
                    view,
                    routePhase: routePhase ?? 'none',
                    worker: state.worker,
                }}
                onSendFeedback={(request) => sendFeedback(token, request)}
            />

            <div className="app-workspace">
                <div className="app-workspace__content">
            {snapshot.connection === 'reconnecting' ? (
                <div className="connection-banner">
                    <div className="connection-banner__title">{t('app.reconnecting')}</div>
                    <p>{t('app.reconnecting.text')}</p>
                </div>
            ) : null}

            <BannerSlot sources={bannerSources} />

            {completion !== null ? (
                <ReviewComplete
                    completion={completion}
                    onOpenThread={openThreadInDiff}
                    onOpenFullDiff={() => {
                        session.setView('diff');
                    }}
                />
            ) : view === 'diff' ? (
                <FullDiffView
                    token={token}
                    prKey={state.prKey}
                    session={session}
                    pr={state.pr}
                    diff={currentDiff}
                    diffError={currentReview.diffError}
                    lenses={currentReview.lenses}
                    lensesError={currentReview.lensesError}
                    progress={currentReview.progress}
                    progressError={currentReview.progressError}
                    progressWriter={progressWriter}
                    store={diffStore}
                    parse={parse}
                    threadStore={threadStore}
                    agentConnected={state.worker.kind === 'connected'}
                    onAskSelection={openChatForSelection}
                    isSelectionPending={isSelectionPending}
                    onSelectionAnchorChange={selectChatAnchor}
                    onComposeQuestion={composeDiffQuestion}
                    notes={notesInCode}
                    onOpenNoteInChat={openNoteInChat}
                    onDeleteNote={deleteNote}
                    selectionNavigationRequest={chatAnchorNavigationRequest}
                    paletteNavigation={paletteNavigation}
                    onFilterChangeHandler={setDiffFilterHandler}
                    onPaletteActiveFileChange={(fileId) => {
                        if (fileId !== null) {
                            setActiveFileId(fileId);
                        }
                    }}
                    routeSnapshot={resolved.routeless ? null : routeSnapshot}
                    onJumpToStop={jumpToStop}
                    smallPr={route?.smallPr === true}
                    headerAside={snapshotPill}
                    slice={sliceCommits}
                    onActiveIteration={backToActiveIteration}
                />
            ) : view === 'overview' && sliceCommits !== null ? (
                <SliceWithoutOverview
                    slice={sliceCommits}
                    onReadDiff={() => {
                        session.setView('diff');
                    }}
                />
            ) : view === 'route' && resolved.routeless ? (
                <IterationWithoutRoute
                    commit={resolved.label?.commit ?? null}
                    slice={sliceCommits}
                    onReadDiff={() => {
                        session.setView('diff');
                    }}
                />
            ) : view === 'route' && routeKind === 'workspace' && routeViewSnapshot !== null ? (
                <RouteView
                    token={token}
                    session={session}
                    pr={state.pr}
                    diff={currentDiff}
                    diffError={currentReview.diffError}
                    lenses={currentReview.lenses}
                    lensesError={currentReview.lensesError}
                    progress={currentReview.progress}
                    progressError={currentReview.progressError}
                    progressWriter={progressWriter}
                    stopProgress={stopProgress}
                    store={diffStore}
                    parse={parse}
                    threadStore={threadStore}
                    snapshot={routeViewSnapshot}
                    agentConnected={state.worker.kind === 'connected'}
                    onAskSelection={openChatForSelection}
                    isSelectionPending={isSelectionPending}
                    onSelectionAnchorChange={selectChatAnchor}
                    onComposeQuestion={composeRouteQuestion}
                    notes={notesInCode}
                    onOpenNoteInChat={openNoteInChat}
                    onDeleteNote={deleteNote}
                    selectionNavigationRequest={chatAnchorNavigationRequest}
                    agentStopped={routePhase === 'filling' && state.worker.kind === 'disconnected'}
                    navigation={routeNavigation}
                    onUnderExplained={setRouteUnderExplained}
                    {...(routePhase === 'ready' ? { onFillStop: fillStop } : {})}
                    onRouteSummary={reportRouteSummary}
                    onOpenThread={openThreadInDiff}
                    headerAside={snapshotPill}
                    generationCap={generationCap}
                />
            ) : view === 'route' && routeKind === 'reading' ? (
                <RouteReadingView
                    onOpenDiff={() => {
                        session.setView('diff');
                    }}
                />
            ) : view === 'route' && routeKind === 'failed' && route?.failure != null ? (
                <RouteFailedView
                    failure={route.failure}
                    retrying={generating}
                    actionError={routeActionError}
                    onRetry={startGeneration}
                    onOpenDiff={() => {
                        session.setView('diff');
                    }}
                />
            ) : (
                <ViewFrame
                    view={view}
                    token={token}
                    prKey={state.prKey}
                    session={session}
                    pr={state.pr}
                    diff={currentDiff}
                    lenses={currentReview.lenses}
                    threads={currentReview.threads}
                    reviewHostAvailable={reviewHost !== null}
                    diffLoading={currentReview.diffLoading}
                    lensesLoading={currentReview.lensesLoading}
                    threadsLoading={currentReview.threadsLoading}
                    diffError={currentReview.diffError}
                    lensesError={currentReview.lensesError}
                    threadsError={currentReview.threadsError}
                    {...(threadStore === null ? {} : { threadStore })}
                    picker={{ rows: pickerMenuRows, viewing: resolved.viewing, now, localHost, onSelect: selectViewing }}
                    {...(snapshotPill === null ? {} : { headerAside: snapshotPill })}
                    {...(showReviewActionBar && reviewActionBarDataReady
                        ? { onWritePrComment: prComments.openModal }
                        : {})}
                    onJumpToStop={jumpToStop}
                    onOpenFile={(fileId) => {
                        navigateFromPalette({ kind: 'file', fileId });
                    }}
                    generation={{
                        route,
                        other: routeOtherFacts,
                        longRunning,
                        cancelling,
                        retrying: generating,
                        actionError: routeActionError,
                        onRetry: startGeneration,
                        onCancel: cancelGeneration,
                    }}
                />
            )}

            {/* Каркас тура: заглушка целей шагов на вкладке маршрута, пока маршрута нет. */}
            {tourScaffoldVisible ? <TourScaffold /> : null}
                </div>
                {chatOpen ? (
                    <>
                        <button
                            type="button"
                            className="chat-panel-scrim"
                            aria-label={t('app.closeChat')}
                            onClick={closeChat}
                        />
                        <ChatPanel
                            worker={state.worker}
                            tasks={state.tasks}
                            exchanges={chatData.exchanges}
                            notes={chatData.notes}
                            loading={currentChat.loading}
                            error={currentChat.error}
                            reconnectCommand={reconnectCommand(state.prKey)}
                            anchor={currentChatComposer.anchor}
                            focusRequest={chatFocusRequest}
                            prefillRequest={chatPrefillRequest}
                            scrollRequest={chatScrollRequest}
                            onScrollRequestHandled={handleChatScrollRequest}
                            onClose={closeChat}
                            onRemoveAnchor={() => {
                                setChatComposerContext({ key: chatKey, anchor: null, latched: false });
                            }}
                            onAsk={askChat}
                            onCancel={cancelChat}
                            onRetry={retryChat}
                            onNavigate={navigateChatAnchor}
                            onNavigateToNote={navigateToNote}
                            viewDiffId={notesDiffId}
                        />
                    </>
                ) : null}
            </div>

            {routeViewSnapshot === null ? null : (
                <>
                    <RouteCommands snapshot={routeViewSnapshot} other={routeOtherFacts} onJump={jumpToStop} />
                    <RoutePresetCommand
                        preset={preset}
                        setPreset={session.setPreset}
                        setView={session.setView}
                    />
                </>
            )}
            <RouteGenerateCommand
                phase={routePhase}
                smallPr={route?.smallPr === true}
                generating={generating}
                onGenerate={startGeneration}
            />

            {cheatsheetOpen ? (
                <ShortcutCheatsheet
                    onClose={() => {
                        setCheatsheetOpen(false);
                    }}
                />
            ) : null}

            <CommandPalette
                open={paletteOpen}
                source={paletteSource}
                iterations={{ rows: pickerMenuRows, viewing: resolved.viewing, now, localHost, onSelect: selectViewing }}
                chat={paletteChat}
                sourceError={currentReview.diffError}
                status={paletteStatus}
                onStatusHandled={() => {
                    setPaletteStatus(null);
                }}
                onOpen={() => {
                    session.setPaletteOpen(true);
                }}
                onClose={() => {
                    session.setPaletteOpen(false);
                }}
            />

            {tourActive ? (
                <TourHost
                    key={tourReplays}
                    epoch={tourEpoch}
                    agentConnected={agentConnected}
                    onOpenChat={openChatPanel}
                    onCloseChat={closeChat}
                />
            ) : null}

            {updateToast.visible && state.update !== null ? (
                <UpdateToast
                    update={state.update}
                    onLater={updateToast.later}
                    onDismissVersion={updateToast.dismissVersion}
                />
            ) : null}

            {showReviewActionBar ? (
                reviewActionBarDataReady && reviewHost !== null && state.pr !== null ? (
                    <ReviewActionBar
                        pr={state.pr}
                        diff={currentDiff}
                        diffStore={diffStore}
                        threadStore={threadStore}
                        connection={snapshot.connection}
                        hostName={hostDisplayName(reviewHost, t)}
                        reviewHost={reviewHost}
                        route={routeSummary === null ? null : { ...routeSummary, viewed: stopViewed }}
                        composerTransport={composerTransport}
                        {...(prThreadActions === null ? {} : { threadActions: prThreadActions })}
                        draftBuffer={draftBuffer}
                        onPublish={publishHere}
                        onComplete={completeReview}
                        prComments={prComments}
                        chatOpen={chatOpen}
                    />
                ) : null
            ) : null}
            </ThreadPinProvider>
        </ReadOnlyIterationProvider>
        </BlobLoaderProvider>
        </ReviewHostProvider>
    );
}

export { MessageScreen } from './components/message-screen.tsx';

const EMPTY_DRAFT_BUFFER: readonly DraftBufferEntry[] = [];
/** Сколько ждать заметку после перехода: виртуализатор и маршрут дорисовывают карточки не сразу. */
const NOTE_FOCUS_SEARCH_MS = 3000;

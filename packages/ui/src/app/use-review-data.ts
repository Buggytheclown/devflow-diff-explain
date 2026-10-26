import type { PrDiff, UiReviewProgressResponse, UiRouteState, UiSnapshotSummary } from '@sherpa/protocol';
import type { Dispatch, RefObject, SetStateAction } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';

import {
    fetchReviewDiff,
    fetchReviewLenses,
    fetchReviewProgress,
    fetchReviewRoute,
    fetchReviewSnapshots,
    fetchReviewThreads,
    mirrorViewedFiles,
} from '../api.js';
import type { DiffViewStore } from '../diff-view/store.js';
import type { PaletteNavigation } from '../palette/diff-source.tsx';
import type { ProgressWriter } from '../progress/progress-writer.js';
import type { StopProgressStore } from '../progress/stop-progress-store.js';
import { viewedMirrorUpdate } from '../progress/viewed-mirror.js';
import type { ActiveFacts, ReviewState, SnapshotsState } from './review-state.js';
import {
    emptyActiveFacts,
    emptyReviewState,
    emptySnapshots,
    errorMessage,
    reviewStateForKeys,
    sharedReviewState,
} from './review-state.js';

/** Состояния вкладки, которые заполняют ручки ревью, и разбор ответа маршрута без параметров. */
export interface ReviewStateSlots {
    readonly snapshotsState: SnapshotsState;
    readonly setSnapshotsState: Dispatch<SetStateAction<SnapshotsState>>;
    /** Факты активной итерации, приведённые к текущему `reviewKey`. */
    readonly facts: ActiveFacts;
    readonly setActiveFacts: Dispatch<SetStateAction<ActiveFacts>>;
    readonly applyActiveRoute: (route: UiRouteState | null) => void;
    readonly reviewState: ReviewState;
    readonly setReviewState: Dispatch<SetStateAction<ReviewState>>;
}

/**
 * Слоты состояния читаются раньше, чем известен ключ вкладки: по ним и разрешается выбор
 * итерации, а ручки (`useReviewData`) заполняют их уже с готовым `viewKey`.
 */
export function useReviewState(reviewKey: string, reviewHost: string | null): ReviewStateSlots {
    const [snapshotsState, setSnapshotsState] = useState<SnapshotsState>(() => emptySnapshots(reviewKey));
    const [activeFacts, setActiveFacts] = useState<ActiveFacts>(() => emptyActiveFacts(reviewKey));
    const facts = activeFacts.key === reviewKey ? activeFacts : emptyActiveFacts(reviewKey);
    /** Маршрут без параметров: он знает `diffId` и коммит активной итерации и текущий снапшот. */
    const applyActiveRoute = useCallback(
        (route: UiRouteState | null) => {
            setActiveFacts((current) => {
                const base = current.key === reviewKey ? current : emptyActiveFacts(reviewKey);
                if (route === null) {
                    return base.routeSettled ? base : { ...base, routeSettled: true };
                }
                const next: ActiveFacts = {
                    key: reviewKey,
                    diffId: route.stale?.prDiffId ?? route.snapshot?.diffId ?? base.diffId,
                    commit: route.stale?.prCommit ?? route.snapshot?.commit ?? base.commit,
                    snapshot: route.snapshot,
                    routeSettled: true,
                };
                return base.routeSettled &&
                    base.diffId === next.diffId &&
                    base.commit === next.commit &&
                    base.snapshot?.snapshotId === next.snapshot?.snapshotId
                    ? base
                    : next;
            });
        },
        [reviewKey],
    );
    const [reviewState, setReviewState] = useState<ReviewState>(() =>
        emptyReviewState(reviewKey, reviewKey, reviewHost !== null),
    );
    return {
        snapshotsState,
        setSnapshotsState,
        facts,
        setActiveFacts,
        applyActiveRoute,
        reviewState,
        setReviewState,
    };
}

export interface ReviewDataOptions {
    readonly token: string;
    readonly reviewKey: string;
    readonly viewKey: string;
    readonly reviewReady: boolean;
    readonly reviewHost: string | null;
    readonly routeRevision: number | null;
    readonly progressRevision: number | null;
    readonly threadsRevision: number | null;
    readonly viewDiffId: string | null;
    readonly viewSnapshotId: string | null;
    readonly viewPending: boolean;
    readonly sliceBase: string | null;
    readonly sliceHead: string | null;
    readonly activeIterationKey: string | null;
    readonly readOnly: boolean;
    readonly currentDiff: PrDiff | null;
    readonly progress: UiReviewProgressResponse | null;
    readonly viewedMirrorAvailable: boolean;
    readonly diffStore: DiffViewStore | null;
    readonly progressWriter: ProgressWriter | null;
    readonly stopProgress: StopProgressStore;
    readonly mirroredFileWrites: RefObject<Set<string>>;
    readonly progressWritesSettled: number;
    readonly setSnapshotsState: Dispatch<SetStateAction<SnapshotsState>>;
    readonly setActiveFacts: Dispatch<SetStateAction<ActiveFacts>>;
    readonly setReviewState: Dispatch<SetStateAction<ReviewState>>;
    readonly applyActiveRoute: (route: UiRouteState | null) => void;
    /** Пришедший дифф сбрасывает то, что адресовало файлы прошлого. */
    readonly setActiveFileId: (fileId: string | null) => void;
    readonly setPaletteNavigation: (navigation: PaletteNavigation | null) => void;
}

export interface ReviewDataResult {
    /** Перечитать маршрут вне SSE-ревизии: ручка ответила «снапшот устарел». */
    readonly refreshRoute: () => void;
}

/**
 * Ручки ревью: снапшоты, дифф, линзы, прогресс, зеркало просмотренных файлов, треды и маршрут.
 * Порядок эффектов внутри — часть контракта: по нему тесты сверяют список и очерёдность запросов.
 */
export function useReviewData({
    token,
    reviewKey,
    viewKey,
    reviewReady,
    reviewHost,
    routeRevision,
    progressRevision,
    threadsRevision,
    viewDiffId,
    viewSnapshotId,
    viewPending,
    sliceBase,
    sliceHead,
    activeIterationKey,
    readOnly,
    currentDiff,
    progress,
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
}: ReviewDataOptions): ReviewDataResult {
    const progressLoaded = progress !== null;
    const viewedMirrorBaseline = useRef<{
        readonly reviewKey: string;
        readonly diffId: string;
        readonly state: ReadonlyMap<string, boolean>;
    } | null>(null);

    /**
     * Список снапшотов для пикера: перечитывается по той же ревизии маршрута, что и сам маршрут.
     * Отказ ручки — не ошибка интерфейса: сервер её может ещё не уметь, и список деградирует
     * до одного текущего снапшота.
     */
    const seenSnapshots = useRef<{ key: string; revision: number | null; loaded: boolean }>({
        key: reviewKey,
        revision: null,
        loaded: false,
    });
    useEffect(() => {
        if (!reviewReady || reviewHost === null) {
            return;
        }
        if (seenSnapshots.current.key !== reviewKey) {
            seenSnapshots.current = { key: reviewKey, revision: null, loaded: false };
        }
        const revision = routeRevision;
        if (seenSnapshots.current.loaded && seenSnapshots.current.revision === revision) {
            return;
        }

        let alive = true;
        const settle = (list: readonly UiSnapshotSummary[] | null): void => {
            if (!alive) {
                return;
            }
            seenSnapshots.current = { key: reviewKey, revision, loaded: true };
            setSnapshotsState({ key: reviewKey, list, loaded: true });
        };
        void fetchReviewSnapshots(token).then(settle, () => {
            settle(null);
        });
        return () => {
            alive = false;
        };
    }, [reviewHost, reviewKey, reviewReady, routeRevision, setSnapshotsState, token]);

    // Дифф публикуется сразу по готовности: линзы и треды не держат читалку на своём запросе.
    useEffect(() => {
        if (!reviewReady || reviewHost === null || viewPending) {
            return;
        }
        let alive = true;
        const selection =
            sliceBase === null || sliceHead === null ? { diffId: viewDiffId } : { base: sliceBase, head: sliceHead };
        void fetchReviewDiff(token, selection).then(
            (diff) => {
                if (!alive) {
                    return;
                }
                setActiveFileId(null);
                setPaletteNavigation(null);
                // Дифф без параметров — и есть активная итерация: её id нужен режиму чтения.
                if (viewDiffId === null) {
                    setActiveFacts((current) => {
                        if (current.key === reviewKey && current.diffId === diff.diffId) {
                            return current;
                        }
                        const base = current.key === reviewKey ? current : emptyActiveFacts(reviewKey);
                        return { ...base, diffId: diff.diffId };
                    });
                }
                setReviewState((current) => ({
                    ...reviewStateForKeys(current, reviewKey, viewKey),
                    diff,
                    diffError: null,
                    diffLoading: false,
                }));
            },
            (error: unknown) => {
                if (alive) {
                    setReviewState((current) => ({
                        ...reviewStateForKeys(current, reviewKey, viewKey),
                        diff: null,
                        diffError: errorMessage(error),
                        diffLoading: false,
                    }));
                }
            },
        );
        return () => {
            alive = false;
        };
    }, [
        activeIterationKey,
        reviewHost,
        reviewKey,
        reviewReady,
        setActiveFacts,
        setActiveFileId,
        setPaletteNavigation,
        setReviewState,
        sliceBase,
        sliceHead,
        token,
        viewDiffId,
        viewKey,
        viewPending,
    ]);

    // Линзы нужны Overview и фильтрам Full diff, но загружаются независимо от сырого диффа.
    // В срезе линз нет: ownership и PCI считаны по файлам итерации, а у среза `fileId` свои.
    // Пока выбор из адреса не разрешён, линзы ждут вместе с диффом — иначе открытый по ссылке
    // срез успел бы сходить за ними впустую.
    useEffect(() => {
        if (!reviewReady || reviewHost === null || sliceBase !== null || viewPending) {
            return;
        }
        let alive = true;
        void fetchReviewLenses(token).then(
            (lenses) => {
                if (alive) {
                    setReviewState((current) => ({
                        ...sharedReviewState(current, reviewKey, viewKey),
                        lenses,
                        lensesError: null,
                        lensesLoading: false,
                    }));
                }
            },
            (error: unknown) => {
                if (alive) {
                    setReviewState((current) => ({
                        ...sharedReviewState(current, reviewKey, viewKey),
                        lenses: null,
                        lensesError: errorMessage(error),
                        lensesLoading: false,
                    }));
                }
            },
        );
        return () => {
            alive = false;
        };
        // `viewKey` в зависимостях — ради свежего замыкания: ответ, отставший от смены выбора,
        // не должен переписать ключ уже загруженного диффа.
    }, [activeIterationKey, reviewHost, reviewKey, reviewReady, setReviewState, sliceBase, token, viewKey, viewPending]);

    // `ProgressWriter` на вкладке один (`use-progress-writer.ts`): серверные снимки проходят через его merge,
    // а событие своей записи не порождает лишнее перечитывание без разрыва ревизий.
    const [progressRetry, setProgressRetry] = useState<{ key: string; attempt: number }>({
        key: reviewKey,
        attempt: 0,
    });
    const progressRetryAttempt = progressRetry.key === reviewKey ? progressRetry.attempt : 0;
    useEffect(() => {
        if (
            !reviewReady ||
            reviewHost === null ||
            diffStore === null ||
            currentDiff === null ||
            progressWriter === null ||
            viewPending ||
            // Прогресс живёт по `fileId` итерации: у среза они свои, и отметок для них нет.
            sliceBase !== null
        ) {
            return;
        }
        // Прогресс спрашивается про ту итерацию, которая нарисована: пока маршрут не перестроен,
        // вкладка живёт на диффе итерации снапшота, и отметки активной к её `fileId` не подходят.
        const drawnDiffId = viewDiffId ?? currentDiff.diffId;
        // Держим прогресс не той итерации, что на экране, — перечитываем, не спрашивая ревизию:
        // своя ревизия при смене итерации не рвётся, а отметки на экране уже чужие.
        const otherIteration = progress?.diffId !== drawnDiffId;
        if (!otherIteration && !progressWriter.shouldReload(progressRevision)) {
            return;
        }

        let alive = true;
        let retry: ReturnType<typeof setTimeout> | null = null;
        const mark = progressWriter.beginReload();
        void fetchReviewProgress(token, drawnDiffId).then(
            (response) => {
                if (!alive) {
                    return;
                }
                if (response.diffId !== drawnDiffId) {
                    // Ответ про чужую итерацию (гонка со сменой выбора): применить его — значит
                    // погасить отметки на диффе, который остался на экране. Ждать перечитки —
                    // следующему событию прогресса: писатель её уже просит.
                    setReviewState((current) => ({
                        ...reviewStateForKeys(current, reviewKey, viewKey),
                        progressLoading: false,
                    }));
                    return;
                }
                const merged = progressWriter.finishReload(response, mark);
                diffStore.setProgress(merged.files);
                // setProgress синхронно будит зеркало: признак снимается после записи очищенных диапазонов.
                mirroredFileWrites.current.clear();
                stopProgress.setAll(merged.stops);
                setReviewState((current) => ({
                    ...reviewStateForKeys(current, reviewKey, viewKey),
                    progress: { ...response, files: [...merged.files], stops: [...merged.stops] },
                    progressError: null,
                    progressLoading: false,
                }));
                if (progressRetryAttempt !== 0) {
                    setProgressRetry({ key: reviewKey, attempt: 0 });
                }
            },
            (error: unknown) => {
                if (!alive) {
                    return;
                }
                setReviewState((current) => {
                    const next = reviewStateForKeys(current, reviewKey, viewKey);
                    return {
                        ...next,
                        // Фоновый провал не заменяет уже показанный прогресс полноэкранной ошибкой.
                        progressError: next.progress === null ? errorMessage(error) : null,
                        progressLoading: false,
                    };
                });
                retry = setTimeout(() => {
                    setProgressRetry({ key: reviewKey, attempt: progressRetryAttempt + 1 });
                }, Math.min(1000 * 2 ** progressRetryAttempt, 15_000));
            },
        );
        return () => {
            alive = false;
            if (retry !== null) {
                clearTimeout(retry);
            }
        };
    }, [
        progress,
        currentDiff,
        diffStore,
        progressRetryAttempt,
        progressWriter,
        progressWritesSettled,
        reviewHost,
        reviewKey,
        reviewReady,
        setReviewState,
        sliceBase,
        progressRevision,
        mirroredFileWrites,
        stopProgress,
        token,
        viewDiffId,
        viewKey,
        viewPending,
    ]);

    // Один app-level подписчик зеркалит только переходы read от покрытия. Первый полный снимок
    // диффа и прогресса становится baseline: история при открытии вкладки в хост не переигрывается.
    useEffect(() => {
        if (readOnly || !viewedMirrorAvailable || currentDiff === null || diffStore === null || !progressLoaded) {
            return;
        }
        const sync = (): void => {
            const previous = viewedMirrorBaseline.current;
            const diffSnapshot = diffStore.getSnapshot();
            const update = viewedMirrorUpdate(
                previous?.reviewKey === reviewKey && previous.diffId === currentDiff.diffId ? previous.state : null,
                {
                    readStates: diffSnapshot.readState,
                    progress: diffSnapshot.progress,
                    fileWrites: mirroredFileWrites.current,
                },
            );
            viewedMirrorBaseline.current = { reviewKey, diffId: currentDiff.diffId, state: update.state };
            if (update.entries.length > 0) {
                void mirrorViewedFiles(token, update.entries).catch(() => undefined);
            }
        };

        const unsubscribe = diffStore.subscribe(sync);
        sync();
        return unsubscribe;
    }, [
        currentDiff,
        diffStore,
        mirroredFileWrites,
        progressLoaded,
        readOnly,
        reviewKey,
        token,
        viewedMirrorAvailable,
    ]);

    // Треды читаются только здесь. Ревизия помечается увиденной только после успеха.
    const seenThreads = useRef<{ key: string; revision: number | null; loaded: boolean }>({
        key: reviewKey,
        revision: null,
        loaded: false,
    });
    const [threadRetry, setThreadRetry] = useState<{ key: string; attempt: number }>({ key: reviewKey, attempt: 0 });
    const threadRetryAttempt = threadRetry.key === reviewKey ? threadRetry.attempt : 0;
    useEffect(() => {
        if (!reviewReady || reviewHost === null) {
            return;
        }
        if (seenThreads.current.key !== reviewKey) {
            seenThreads.current = { key: reviewKey, revision: null, loaded: false };
        }
        const revision = threadsRevision;
        if (seenThreads.current.loaded && seenThreads.current.revision === revision) {
            return;
        }

        let alive = true;
        let retry: ReturnType<typeof setTimeout> | null = null;
        setReviewState((current) => {
            const next = sharedReviewState(current, reviewKey, viewKey);
            return {
                ...next,
                threadsError: null,
                threadsLoading: next.threads === null,
            };
        });
        void fetchReviewThreads(token).then(
            (threads) => {
                if (!alive) {
                    return;
                }
                seenThreads.current = { key: reviewKey, revision, loaded: true };
                setReviewState((current) => ({
                    ...sharedReviewState(current, reviewKey, viewKey),
                    threads,
                    threadsError: null,
                    threadsLoading: false,
                }));
                if (threadRetryAttempt !== 0) {
                    setThreadRetry({ key: reviewKey, attempt: 0 });
                }
            },
            (error: unknown) => {
                if (!alive) {
                    return;
                }
                setReviewState((current) => ({
                    ...sharedReviewState(current, reviewKey, viewKey),
                    threadsError: errorMessage(error),
                    threadsLoading: false,
                }));
                retry = setTimeout(() => {
                    setThreadRetry({ key: reviewKey, attempt: threadRetryAttempt + 1 });
                }, Math.min(1000 * 2 ** threadRetryAttempt, 15_000));
            },
        );
        return () => {
            alive = false;
            if (retry !== null) {
                clearTimeout(retry);
            }
        };
        // `viewKey` — ради свежего замыкания, см. эффект линз; сами треды от выбора не зависят.
    }, [reviewHost, reviewKey, reviewReady, setReviewState, threadsRevision, threadRetryAttempt, token, viewKey]);

    // Маршрут читается той же петлёй, что и треды: событие несёт только ревизию, данные
    // перечитываются ручкой, и ревизия помечается увиденной лишь после успеха.
    const seenRoute = useRef<{ key: string; revision: number | null; loaded: boolean }>({
        key: viewKey,
        revision: null,
        loaded: false,
    });
    /** Ревизия, на которой факты об активной итерации уже собраны: общая на оба эффекта маршрута. */
    const seenActiveRoute = useRef<{ key: string; revision: number | null }>({ key: reviewKey, revision: null });
    const [routeRetry, setRouteRetry] = useState<{ key: string; attempt: number }>({ key: reviewKey, attempt: 0 });
    const routeRetryAttempt = routeRetry.key === reviewKey ? routeRetry.attempt : 0;
    const refreshRoute = useCallback(() => {
        seenRoute.current.loaded = false;
        setRouteRetry((current) => ({
            key: reviewKey,
            attempt: current.key === reviewKey ? current.attempt + 1 : 1,
        }));
    }, [reviewKey]);
    useEffect(() => {
        if (!reviewReady || reviewHost === null || viewPending) {
            return;
        }
        if (seenRoute.current.key !== viewKey) {
            seenRoute.current = { key: viewKey, revision: null, loaded: false };
        }
        const revision = routeRevision;
        if (seenRoute.current.loaded && seenRoute.current.revision === revision) {
            return;
        }

        let alive = true;
        let retry: ReturnType<typeof setTimeout> | null = null;
        void fetchReviewRoute(token, viewSnapshotId).then(
            (response) => {
                if (!alive) {
                    return;
                }
                seenRoute.current = { key: viewKey, revision, loaded: true };
                // Маршрут без параметров описывает активную итерацию: из него и берётся то,
                // с чем сравнивается выбор, и запасной список снапшотов.
                if (viewSnapshotId === null) {
                    seenActiveRoute.current = { key: reviewKey, revision };
                    applyActiveRoute(response.route);
                }
                setReviewState((current) => ({
                    ...reviewStateForKeys(current, reviewKey, viewKey),
                    route: response.route,
                    routeError: null,
                    routeLoading: false,
                }));
                if (routeRetryAttempt !== 0) {
                    setRouteRetry({ key: reviewKey, attempt: 0 });
                }
            },
            (error: unknown) => {
                if (!alive) {
                    return;
                }
                if (viewSnapshotId === null) {
                    applyActiveRoute(null);
                }
                setReviewState((current) => {
                    const next = reviewStateForKeys(current, reviewKey, viewKey);
                    return {
                        ...next,
                        // Фоновый провал не стирает уже показанный маршрут.
                        routeError: next.route === null ? errorMessage(error) : null,
                        routeLoading: false,
                    };
                });
                retry = setTimeout(
                    () => {
                        setRouteRetry({ key: reviewKey, attempt: routeRetryAttempt + 1 });
                    },
                    Math.min(1000 * 2 ** routeRetryAttempt, 15_000),
                );
            },
        );
        return () => {
            alive = false;
            if (retry !== null) {
                clearTimeout(retry);
            }
        };
    }, [
        applyActiveRoute,
        reviewHost,
        reviewKey,
        reviewReady,
        routeRetryAttempt,
        routeRevision,
        setReviewState,
        token,
        viewKey,
        viewPending,
        viewSnapshotId,
    ]);

    /**
     * Пока вкладка смотрит прошлый снапшот (или ещё не решила, что смотрит), маршрут без
     * параметров не читает никто — а без него неизвестна активная итерация: и режим чтения,
     * и подписи выбора, и сам разбор адреса опёрлись бы на пустоту и сбросили бы выбор.
     */
    useEffect(() => {
        if (!reviewReady || reviewHost === null) {
            return;
        }
        if (!viewPending && viewSnapshotId === null) {
            return;
        }
        const revision = routeRevision;
        if (seenActiveRoute.current.key === reviewKey && seenActiveRoute.current.revision === revision) {
            return;
        }

        let alive = true;
        const settle = (route: UiRouteState | null): void => {
            if (!alive) {
                return;
            }
            seenActiveRoute.current = { key: reviewKey, revision };
            applyActiveRoute(route);
        };
        void fetchReviewRoute(token, null).then(
            (response) => {
                settle(response.route);
            },
            () => {
                settle(null);
            },
        );
        return () => {
            alive = false;
        };
    }, [applyActiveRoute, reviewHost, reviewKey, reviewReady, routeRevision, token, viewPending, viewSnapshotId]);

    return { refreshRoute };
}

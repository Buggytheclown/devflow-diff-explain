import type { Locale, UiRouteState, UiTask } from '@sherpa/protocol';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { cancelTask, fillRouteStop, generateReviewRoute } from '../api.js';
import type { Translate } from '../i18n/index.js';
import {
    generationIsLong,
    openRouteTasks,
    routeActionErrorInPlace,
    routeGenerationAvailable,
    routeViewKind,
} from '../route/generation.js';
import type { SessionStore } from '../session/session-store.js';
import type { ViewId } from '../session/views.js';
import type { RouteActionFailure } from './review-state.js';
import { EMPTY_TASKS, errorMessage } from './review-state.js';

export interface UseRouteGenerationOptions {
    readonly route: UiRouteState | null;
    readonly token: string;
    readonly uiLocale: Locale;
    readonly t: Translate;
    readonly session: SessionStore;
    readonly view: ViewId;
    readonly tasks: readonly UiTask[] | undefined;
    readonly tourActive: boolean;
    /** Обратное ребро к ручкам ревью: ответ «снапшот устарел» перечитывает маршрут. */
    readonly refreshRoute: () => void;
}

/** Генерация маршрута: ручки, долгая задача, дефолтная вью малого PR. */
export function useRouteGeneration({
    route,
    token,
    uiLocale,
    t,
    session,
    view,
    tasks,
    tourActive,
    refreshRoute,
}: UseRouteGenerationOptions) {
    const routePhase = route?.phase ?? null;
    const routeKind = routeViewKind(route);
    const routeTasks = useMemo(() => openRouteTasks(tasks ?? EMPTY_TASKS), [tasks]);
    const [generating, setGenerating] = useState(false);
    const [cancelling, setCancelling] = useState(false);
    /**
     * Причина вместе с фазой, в которой её получили: сервер сказал новое — старая жалоба на
     * ручку устарела и уходит с экрана сама, без отдельного сброса.
     */
    const [routeActionFailure, setRouteActionFailure] = useState<RouteActionFailure | null>(null);
    const routeActionError = routeActionFailure?.phase === routePhase ? routeActionFailure.message : null;
    /** Фаза, из которой запросили генерацию: кнопка остаётся в загрузке, пока фаза не сдвинется. */
    const generationFrom = useRef<string | null>(null);
    /**
     * Зеркало `generating` для гарда повторного запуска: состояние React обновляется к следующему
     * рендеру, а два вызова подряд (палитра, кнопка) случаются в одном.
     */
    const generationInFlight = useRef(false);
    const stopGenerating = useCallback(() => {
        generationInFlight.current = false;
        setGenerating(false);
    }, []);
    useEffect(() => {
        if (generating && generationFrom.current !== routePhase) {
            stopGenerating();
        }
    }, [generating, routePhase, stopGenerating]);
    const startGeneration = useCallback(() => {
        if (
            !routeGenerationAvailable({
                phase: routePhase,
                smallPr: route?.smallPr === true,
                generating: generationInFlight.current,
            })
        ) {
            return;
        }
        generationInFlight.current = true;
        generationFrom.current = routePhase;
        setGenerating(true);
        setRouteActionFailure(null);
        void generateReviewRoute(token, uiLocale).then(
            (outcome) => {
                // Генерация пошла — кнопку отпускает смена фазы по SSE, а не ответ ручки.
                if (outcome !== 'started') {
                    stopGenerating();
                }
                if (outcome === 'small_pr') {
                    setRouteActionFailure({ phase: routePhase, message: t('route.smallPr.notGenerated') });
                }
            },
            (error: unknown) => {
                stopGenerating();
                setRouteActionFailure({ phase: routePhase, message: errorMessage(error) });
            },
        );
    }, [route?.smallPr, routePhase, stopGenerating, t, token, uiLocale]);
    const fillStop = useCallback(
        (planIndex: number) => {
            const snapshotId = route?.snapshot?.snapshotId;
            if (routePhase !== 'ready' || snapshotId === undefined) {
                return;
            }

            setRouteActionFailure(null);
            void fillRouteStop(token, { snapshotId, planIndex }).then(
                (outcome) => {
                    if (outcome === 'stale_snapshot' || outcome === 'not_unfilled') {
                        refreshRoute();
                    }
                },
                (error: unknown) => {
                    setRouteActionFailure({ phase: routePhase, message: errorMessage(error) });
                },
            );
        },
        [refreshRoute, route?.snapshot?.snapshotId, routePhase, token],
    );
    const cancelGeneration = useCallback(() => {
        const ids = routeTasks.map((task) => task.id);
        if (ids.length === 0) {
            return;
        }
        setCancelling(true);
        setRouteActionFailure(null);
        void Promise.all(ids.map((id) => cancelTask(token, id))).then(
            () => {
                setCancelling(false);
            },
            (error: unknown) => {
                setCancelling(false);
                setRouteActionFailure({ phase: routePhase, message: errorMessage(error) });
            },
        );
    }, [routePhase, routeTasks, token]);

    // Часы тикают только пока агенту есть что делать: «всё ещё работаю» — функция времени.
    const [now, setNow] = useState(() => Date.now());
    const hasRouteTasks = routeTasks.length > 0;
    useEffect(() => {
        if (!hasRouteTasks) {
            return;
        }
        const timer = setInterval(() => {
            setNow(Date.now());
        }, LONG_GENERATION_TICK);
        return () => {
            clearInterval(timer);
        };
    }, [hasRouteTasks]);
    const longRunning = generationIsLong(routeTasks, now);

    /**
     * Малый PR открывается на полном диффе (docs/design/SPEC-elements.md §4.1). Выбор ревьюера — вью из адреса или руками —
     * не переопределяется никогда, поэтому решение принимается один раз и только по умолчанию.
     *
     * Идущий тур ждём: он начинается на Маршруте, и переключить вкладку под ним значило бы увести
     * первые его шаги в запасное размещение. Решение не отменяется, а откладывается до конца тура.
     */
    const smallPrRedirected = useRef(false);
    useEffect(() => {
        if (smallPrRedirected.current || tourActive || routePhase !== 'none' || route?.smallPr !== true) {
            return;
        }
        smallPrRedirected.current = true;
        if (!session.viewPinned()) {
            session.setView('diff');
        }
    }, [route?.smallPr, routePhase, session, tourActive]);

    const actionErrorInPlace = routeActionErrorInPlace(view, route);
    const generateAvailable = routeGenerationAvailable({
        phase: routePhase,
        smallPr: route?.smallPr === true,
        generating,
    });

    return {
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
    };
}

/** Как часто пересчитывается «всё ещё работаю»: порог грубый, секундная точность не нужна. */
const LONG_GENERATION_TICK = 5000;

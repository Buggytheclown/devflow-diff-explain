import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { DiffViewSnapshot } from '../../diff-view/store.js';
import { useT } from '../../i18n/index.js';
import type { ProgressWriter } from '../../progress/progress-writer.js';
import type { StopProgressStore } from '../../progress/stop-progress-store.js';
import type { RouteEntry, RouteModel } from '../../route/route-model.js';
import { entryParseFailed, entryPending, entryUnfilled, stopSeenRanges } from '../../route/route-model.js';
import { stopCoveredByProgress } from '../../route/stop-coverage.js';
import type { SessionStore } from '../../session/session-store.js';
import { entryId } from './stop-lookup.js';
import type { RequestJump } from './use-route-jump.js';

export interface StopViewedOptions {
    readonly model: RouteModel;
    /** Маршрут ещё достраивается: у «Прочего» отмечать нечего — оно считает незанятые слоты. */
    readonly filling: boolean;
    readonly stopViewed: ReadonlyMap<string, boolean>;
    /** Файлы линзы; `null` — линзы нет. Автоотметка сообщает о переходе только по видимому. */
    readonly fileIds: ReadonlySet<string> | null;
    readonly matches: (entry: RouteEntry, ids: ReadonlySet<string> | null) => boolean;
    readonly session: SessionStore;
    readonly stopProgress: StopProgressStore;
    readonly writer: ProgressWriter;
    /** Первый серверный снимок прогресса уже применён: до него сравнивать покрытие не с чем. */
    readonly progressLoaded: boolean;
    readonly diffSnapshot: DiffViewSnapshot;
    readonly requestJump: RequestJump;
}

export interface StopViewed {
    readonly markStop: (stopId: string, viewed: boolean, withFeedback?: boolean) => Promise<void>;
    /** Значение сорвавшейся записи по остановкам; отсутствие ключа — записи не срывались. */
    readonly stopFailures: ReadonlyMap<string, boolean>;
    readonly announcement: string;
    readonly unfilledEntry: (entry: RouteEntry) => boolean;
    readonly viewedStops: number;
}

/**
 * Отметка «просмотрено» на остановке (docs/design/SPEC-elements.md §2.10, docs/architecture.md §7.1): ручная запись с диапазонами,
 * автоотметка по покрытию файловых отметок и aria-объявление результата.
 */
export function useStopViewed({
    model,
    filling,
    stopViewed,
    fileIds,
    matches,
    session,
    stopProgress,
    writer,
    progressLoaded,
    diffSnapshot,
    requestJump,
}: StopViewedOptions): StopViewed {
    const t = useT();
    /**
     * Отмечать нечего: остановка не заполнена, а «Прочее» на недостроенном маршруте считает
     * не остаток модели, а всё, до чего агент ещё не дошёл.
     */
    const unfilledEntry = useCallback(
        (entry: RouteEntry): boolean => entryUnfilled(entry) || (filling && entry.kind === 'other'),
        [filling],
    );
    const [stopFailures, setStopFailures] = useState<ReadonlyMap<string, boolean>>(EMPTY_FAILURES);
    const [announcement, setAnnouncement] = useState('');
    const autoMarking = useRef(new Set<string>());
    /** Последнее вычисленное покрытие: первый готовый снимок задаёт baseline, а не действие ревьюера. */
    const autoCoverage = useRef(new Map<string, boolean>());
    /** Ручное снятие блокирует автоотметку, пока покрытие действительно не пропадёт. */
    const manuallyUnmarked = useRef(new Set<string>());
    const stopCoverageSnapshot = useMemo(
        () => ({ progress: diffSnapshot.progress, readState: diffSnapshot.readState }),
        [diffSnapshot.progress, diffSnapshot.readState],
    );
    const viewedStops = useMemo(
        () => model.entries.filter((entry) => stopViewed.get(entryId(entry)) === true).length,
        [model.entries, stopViewed],
    );
    const nextVisibleEntry = useCallback(
        (stopId: string): string | null => {
            const current = model.entries.findIndex((entry) => entryId(entry) === stopId);
            if (current < 0) {
                return null;
            }
            const next = model.entries.slice(current + 1).find((entry) => matches(entry, fileIds));
            return next === undefined ? null : entryId(next);
        },
        [fileIds, matches, model.entries],
    );

    const markStop = useCallback(
        async (stopId: string, viewed: boolean, withFeedback = true): Promise<void> => {
            const entry = model.entries.find((candidate) => entryId(candidate) === stopId) ?? null;
            const wasViewed = stopProgress.isViewed(stopId);
            if (entry === null || wasViewed === viewed) {
                return;
            }
            // Отметка пишет seen-диапазоны, а посчитать их можно только по разобранным моделям:
            // до разбора отметка легла бы на сервер с пустым набором и не переписалась бы потом.
            // У незаполненной остановки диапазонов нет вовсе, у файла со сорвавшимся разбором их
            // не будет до повтора. Снятие диапазонов не требует.
            if (
                viewed &&
                (entryPending(entry, model.totals) ||
                    entryParseFailed(entry, model.totals) ||
                    unfilledEntry(entry))
            ) {
                return;
            }
            if (!viewed) {
                // Ставим блок до оптимистичного обновления: его синхронный рендер уже увидит снятую отметку.
                manuallyUnmarked.current.add(stopId);
                // Временная развёртка просмотренной живёт только пока стоит отметка.
                session.forgetViewedExpansion(stopId);
            }
            setStopFailures((previous) => {
                if (!previous.has(stopId)) {
                    return previous;
                }
                const next = new Map(previous);
                next.delete(stopId);
                return next;
            });

            // Диапазоны считает UI: у сервера модели диффа нет.
            const written = writer.writeStop(stopId, viewed, viewed ? stopSeenRanges(entry) : []);
            if (viewed && withFeedback) {
                const next = nextVisibleEntry(stopId);
                if (next !== null) {
                    // Это продолжение сворачивания, а не шаг мастера: линза и состояние следующей записи не меняются.
                    requestJump(next, null);
                }
            }
            if (withFeedback) {
                // Отметка уже применена оптимистично — объявляем то, что ревьюер видит на экране.
                const snapshot = stopProgress.getSnapshot();
                const count = model.entries.filter((candidate) => snapshot.get(entryId(candidate)) === true).length;
                setAnnouncement(
                    t(
                        viewed ? 'route.stop.announce.viewed' : 'route.stop.announce.unviewed',
                        entry.view.planLabel,
                        count,
                        model.stopCount,
                    ),
                );
            }
            if (!(await written)) {
                if (!viewed) {
                    manuallyUnmarked.current.delete(stopId);
                }
                setStopFailures((previous) => new Map(previous).set(stopId, viewed));
            }
        },
        [
            model.entries,
            model.stopCount,
            model.totals,
            nextVisibleEntry,
            requestJump,
            session,
            stopProgress,
            t,
            unfilledEntry,
            writer,
        ],
    );

    useEffect(() => {
        // До первого ответа ручки стор содержит только умолчания. Такой снимок не baseline:
        // иначе приехавший серверный прогресс выглядел бы новым чтением и запустил прокрутку.
        if (!progressLoaded) {
            return;
        }

        const candidates: RouteEntry[] = [];
        const currentIds = new Set<string>();
        let feedbackStopId: string | null = null;

        for (const entry of model.entries) {
            const stopId = entryId(entry);
            currentIds.add(stopId);
            // Пока диапазоны нельзя честно посчитать, это не `false`: первый готовый результат
            // должен стать baseline и не превратить загрузку данных в действие ревьюера.
            if (
                entryPending(entry, model.totals) ||
                entryParseFailed(entry, model.totals) ||
                unfilledEntry(entry)
            ) {
                continue;
            }

            const covered = stopCoveredByProgress(entry, stopCoverageSnapshot);
            const previous = autoCoverage.current.get(stopId);
            autoCoverage.current.set(stopId, covered);
            if (!covered) {
                manuallyUnmarked.current.delete(stopId);
                continue;
            }
            if (
                previous !== false ||
                stopViewed.get(stopId) === true ||
                manuallyUnmarked.current.has(stopId) ||
                autoMarking.current.has(stopId)
            ) {
                continue;
            }

            candidates.push(entry);
            if (matches(entry, fileIds)) {
                // Несколько отметок одним снимком дают один переход и одно итоговое aria-объявление.
                feedbackStopId = stopId;
            }
        }

        for (const stopId of autoCoverage.current.keys()) {
            if (!currentIds.has(stopId)) {
                autoCoverage.current.delete(stopId);
                manuallyUnmarked.current.delete(stopId);
            }
        }

        const start = (entry: RouteEntry): void => {
            const stopId = entryId(entry);
            autoMarking.current.add(stopId);
            void markStop(stopId, true, stopId === feedbackStopId).finally(() => {
                autoMarking.current.delete(stopId);
            });
        };
        for (const entry of candidates) {
            if (entryId(entry) !== feedbackStopId) {
                start(entry);
            }
        }
        const feedbackEntry = candidates.find((entry) => entryId(entry) === feedbackStopId);
        if (feedbackEntry !== undefined) {
            start(feedbackEntry);
        }
    }, [
        fileIds,
        markStop,
        matches,
        model.entries,
        model.totals,
        progressLoaded,
        stopCoverageSnapshot,
        stopViewed,
        unfilledEntry,
    ]);

    return { markStop, stopFailures, announcement, unfilledEntry, viewedStops };
}

const EMPTY_FAILURES: ReadonlyMap<string, boolean> = new Map();

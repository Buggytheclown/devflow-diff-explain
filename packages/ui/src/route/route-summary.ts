import type { RouteSnapshot } from '@sherpa/protocol';

import type { OtherStopFacts } from './other-stop.js';
import { otherStopVisible, visibleStops } from './other-stop.js';

/** Числа готового маршрута, посчитанные после разбора диффа. */
export interface RouteSummary {
    /** Остановки в порядке рендера, включая «Прочее», если оно вообще есть. */
    readonly stopIds: readonly string[];
    readonly otherStopId: string | null;
    readonly uncoveredLines: number;
}

/** Данные маршрута для панели действий; `null` означает, что точных чисел ещё нет. */
export interface RouteFacts {
    readonly stopIds: readonly string[];
    readonly otherStopId: string | null;
    readonly uncoveredLines: number | null;
}

export interface ReportedRouteSummary {
    readonly snapshotId: string;
    readonly value: RouteSummary;
}

/**
 * До отчёта вью маршрута набор остановок — видимые остановки снапшота; старый отчёт к новому
 * снапшоту не применяется.
 */
export function routeFactsForSnapshot(
    snapshot: RouteSnapshot,
    reported: ReportedRouteSummary | null,
    other: OtherStopFacts,
): RouteFacts {
    if (reported?.snapshotId === snapshot.snapshotId) {
        return reported.value;
    }

    return {
        stopIds: visibleStops(snapshot, other).map((stop) => stop.id),
        otherStopId: otherStopVisible(snapshot, other)
            ? (snapshot.stops.find((stop) => stop.tier === 'other')?.id ?? null)
            : null,
        uncoveredLines: null,
    };
}

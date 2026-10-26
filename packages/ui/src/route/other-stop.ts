import type { RouteSnapshot, RouteStop } from '@sherpa/protocol';

/**
 * Видимость синтетической остановки «Прочее» (docs/design/SPEC-elements.md §4.3) — одно правило
 * на весь UI. Сервер кладёт её в снапшот всегда и сразу готовой, но для ревьюера она существует,
 * только когда маршрут достроен и ей есть что показать. Всё, что считает или перечисляет
 * остановки, берёт их через `visibleStops` или `otherStopVisible`.
 */

/** Что известно о содержимом «Прочего». */
export interface OtherStopFacts {
    /** Непокрытых изменённых строк; `null` — ещё не посчитано (патчи не разобраны). */
    readonly uncovered: number | null;
    /** Конфликтных файлов: сказать о них может только строка «Прочего» (docs/design/SPEC-elements.md §4.1). */
    readonly conflictFiles: number;
}

/** Ничего не известно: «Прочего» нет, пока непокрытое не посчитано. */
export const UNKNOWN_OTHER: OtherStopFacts = { uncovered: null, conflictFiles: 0 };

/** Снапшот ещё достраивается: хоть один слот не готов и не провален. */
export function snapshotFilling(snapshot: RouteSnapshot): boolean {
    return snapshot.stops.some((stop) => stop.status === 'queued' || stop.status === 'filling');
}

/**
 * «Прочее» видно, когда все остальные остановки достроены (провал — тоже итог: строки такой
 * остановки честно уходят в «Прочее») и в нём есть непокрытые строки или конфликтные файлы.
 * Пока маршрут строится, непокрытое — это незанятые слоты плана, а не остаток модели.
 */
export function otherStopVisible(snapshot: RouteSnapshot, facts: OtherStopFacts): boolean {
    if (snapshotFilling(snapshot)) {
        return false;
    }
    return (facts.uncovered ?? 0) > 0 || facts.conflictFiles > 0;
}

/**
 * Маршрут достроен, а видно ли «Прочее», ещё не известно: дифф разбирается. Число остановок
 * в этот момент называть нельзя — оно может вырасти на «Прочее».
 */
export function otherStopPending(snapshot: RouteSnapshot, facts: OtherStopFacts): boolean {
    return !snapshotFilling(snapshot) && facts.uncovered === null && facts.conflictFiles === 0;
}

/** Остановки снапшота, которые видит ревьюер, в порядке массива `stops`. */
export function visibleStops(snapshot: RouteSnapshot, facts: OtherStopFacts): readonly RouteStop[] {
    const other = otherStopVisible(snapshot, facts);
    return other ? snapshot.stops : snapshot.stops.filter((stop) => stop.tier !== 'other');
}

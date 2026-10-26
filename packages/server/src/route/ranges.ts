/**
 * Арифметика строчных диапазонов для дедупликации якорей (`docs/design/SPEC-elements.md §4.3`:
 * два стопа, заявившие
 * один диапазон). Считается интервалами, а не построчно: длина якоря приходит от модели.
 */

/** Включительный диапазон строк одной стороны файла. */
export interface LineRange {
    readonly start: number;
    readonly end: number;
}

export function rangesOverlap(left: LineRange, right: LineRange): boolean {
    return left.start <= right.end && right.start <= left.end;
}

/** Пересечение диапазона с набором кусков: куски результата отсортированы и не пересекаются. */
export function intersectRanges(range: LineRange, others: readonly LineRange[]): LineRange[] {
    return others
        .filter((other) => rangesOverlap(range, other))
        .sort((left, right) => left.start - right.start)
        .map((other) => ({
            start: Math.max(range.start, other.start),
            end: Math.min(range.end, other.end),
        }));
}

/**
 * Остаток диапазона после вычитания занятых кусков. Пустой результат — диапазон занят целиком;
 * два и больше — вычитание разрезало его пополам (так и остаётся, склеивать нечего).
 */
export function subtractRanges(range: LineRange, occupied: readonly LineRange[]): LineRange[] {
    const sorted = occupied
        .filter((busy) => rangesOverlap(range, busy))
        .sort((left, right) => left.start - right.start);

    const rest: LineRange[] = [];
    let cursor = range.start;
    for (const busy of sorted) {
        if (busy.start > cursor) {
            rest.push({ start: cursor, end: Math.min(busy.start - 1, range.end) });
        }
        cursor = Math.max(cursor, busy.end + 1);
        if (cursor > range.end) {
            break;
        }
    }
    if (cursor <= range.end) {
        rest.push({ start: cursor, end: range.end });
    }
    return rest;
}

/**
 * Отображение строк между итерациями PR. Вход — интердифф A→B:
 * обычный `PrDiff`, у которого старая сторона патчей это голова итерации A, а новая — головы B.
 * Строка вне ханков интердиффа переносится в B со сдвигом, строка внутри — «затронута».
 *
 * Один примитив обслуживает перенос прогресса, классификацию стопов нового снапшота,
 * текст stale-баннера и миграцию якорей заметок. Здесь только чистые функции: ни БД, ни хоста.
 *
 * Разметку ханков читает `walkPatch` — тот же разборщик, чьи номера печатаются модели
 * в payload; своего парсера здесь нет.
 */
import type { PrDiff, RouteSnapshot, RouteStop } from '@sherpa/protocol';

import type { PatchLine } from '../route/diff-index.js';
import { walkPatch } from '../route/diff-index.js';
import type { LineRange } from '../route/ranges.js';
import { intersectRanges, subtractRanges } from '../route/ranges.js';

export interface IterationMapInput {
    /**
     * Интердифф A→B; null или интердифф без файлов — головы итераций совпадают
     * (перегенерация на той же итерации). База при этом всё равно проверяется отдельно:
     * `null` не означает «ничего не менялось», если ушла база.
     */
    interdiff: PrDiff | null;
    /**
     * База итерации A: совпадает с базой B — сторона `old` переносится тождественно.
     * `null` — база неизвестна (итерация записана сервером 0.3.x, ни строки, ни снапшота);
     * тогда сторона `old` считается затронутой целиком, как при смене базы: подставить базу
     * итерации B значило бы перенести старую сторону по заведомо неверной карте.
     */
    fromBaseCommit: string | null;
    /** База итерации B. */
    toBaseCommit: string;
}

export type FileStatus = 'unchanged' | 'modified' | 'added' | 'removed';

/** Результат отображения диапазона A→B: `carried` в координатах B, `touched` — в координатах A. */
export interface MappedRange {
    readonly carried: readonly LineRange[];
    readonly touched: readonly LineRange[];
}

export interface IterationMap {
    fileStatus(path: string): FileStatus;
    /**
     * Диапазон A → B. Куски не пересекаются, отсортированы;
     * сумма длин `touched` и `carried` равна длине входа.
     */
    mapRange(path: string, side: 'old' | 'new', range: LineRange): MappedRange;
    /** Затронутые строки A внутри диапазона — для баннера «затронуты остановки 02, 03 и 07». */
    touchedInA(path: string, side: 'old' | 'new', range: LineRange): readonly LineRange[];
    /** Затронутые строки B внутри диапазона B — для классификации стопов нового снапшота. */
    touchedInB(path: string, side: 'old' | 'new', range: LineRange): readonly LineRange[];
}

/** Классификация стопа нового снапшота. */
export type StopChangeKind = 'new' | 'changed';

/** Кусок сдвига: строки A начиная с `from` уезжают в B на `delta`. */
interface ShiftPoint {
    readonly from: number;
    readonly delta: number;
}

/** Отображение одного текстового файла; `null` вместо него — файл затронут целиком. */
interface FileLineMap {
    /** Затронутые строки в координатах A, отсортированы и не пересекаются. */
    readonly touchedOld: readonly LineRange[];
    /** Затронутые строки в координатах B. */
    readonly touchedNew: readonly LineRange[];
    /** Накопленный сдвиг после каждого ханка, по возрастанию `from`. */
    readonly shifts: readonly ShiftPoint[];
}

/** Строки одного ханка с номерами обеих сторон — всё, что нужно от разметки патча. */
type Hunk = PatchLine[];

/** Путь глазами отображения: переносить нечего, переносить тождественно или считать по патчу. */
type MappedPath = { kind: 'opaque' } | { kind: 'identity' } | { kind: 'mapped'; file: FileLineMap };

/** Отображение «ничего не изменилось»: любой диапазон переносится в себя. */
export function identityMap(): IterationMap {
    return {
        fileStatus: () => 'unchanged',
        mapRange: (_path, _side, range) =>
            isEmpty(range) ? { carried: [], touched: [] } : { carried: [range], touched: [] },
        touchedInA: () => [],
        touchedInB: () => [],
    };
}

/**
 * Отображение «переносить нечем»: интердиффа нет и не будет (хост без `capabilities.iterations`,
 * итерация, которой хост уже не знает). Любой диапазон считается затронутым — честнее сказать
 * «не перенесли», чем притвориться, что строки на месте.
 */
export function opaqueMap(): IterationMap {
    const touched = (_path: string, _side: 'old' | 'new', range: LineRange): readonly LineRange[] =>
        isEmpty(range) ? [] : [range];
    return {
        fileStatus: () => 'modified',
        mapRange: (_path, _side, range) => (isEmpty(range) ? { carried: [], touched: [] } : { carried: [], touched: [range] }),
        touchedInA: touched,
        touchedInB: touched,
    };
}

/** Отображение строк A→B по интердиффу: статусы файлов, перенос со сдвигом, затронутое. */
export function buildIterationMap(input: IterationMapInput): IterationMap {
    const statuses = new Map<string, FileStatus>();
    const files = new Map<string, FileLineMap | null>();
    const claim = (path: string, status: FileStatus): boolean => {
        // Первый файл с таким путём выигрывает — как в `indexDiff`.
        if (statuses.has(path)) {
            return false;
        }
        statuses.set(path, status);
        return true;
    };

    for (const file of input.interdiff?.files ?? []) {
        switch (file.changeType) {
            case 'add':
                claim(file.path, 'added');
                break;
            case 'delete':
                claim(file.path, 'removed');
                break;
            case 'move':
                // Переименование в v1 — «ушёл и появился»: строки через него не переносятся.
                if (file.oldPath !== null) {
                    claim(file.oldPath, 'removed');
                }
                claim(file.path, 'added');
                break;
            case 'copy':
                claim(file.path, 'added');
                break;
            case 'modify':
            case 'conflict':
                if (claim(file.path, 'modified')) {
                    // Нет текстового диффа (binary и прочее) — файл затронут целиком.
                    files.set(file.path, file.patch === null ? null : buildFileLineMap(file.patch));
                }
                break;
        }
    }

    const baseChanged = input.fromBaseCommit === null || input.fromBaseCommit !== input.toBaseCommit;
    const fileStatus = (path: string): FileStatus => statuses.get(path) ?? 'unchanged';

    const classifyPath = (path: string): MappedPath => {
        const status = fileStatus(path);
        // В A файла не было (added) либо в B его не стало (removed) — переносить нечего.
        if (status === 'added' || status === 'removed') {
            return { kind: 'opaque' };
        }
        if (status === 'unchanged') {
            return { kind: 'identity' };
        }
        const file = files.get(path) ?? null;
        // Файл изменён, а разбираемого патча нет — затронут целиком на обеих сторонах.
        return file === null ? { kind: 'opaque' } : { kind: 'mapped', file };
    };

    const mapRange = (path: string, side: 'old' | 'new', range: LineRange): MappedRange => {
        if (isEmpty(range)) {
            return { carried: [], touched: [] };
        }
        const target = classifyPath(path);
        if (target.kind === 'opaque') {
            return { carried: [], touched: [range] };
        }
        if (side === 'old') {
            return baseChanged ? { carried: [], touched: [range] } : { carried: [range], touched: [] };
        }
        if (target.kind === 'identity') {
            return { carried: [range], touched: [] };
        }
        const { file } = target;
        return {
            carried: subtractRanges(range, file.touchedOld).flatMap((gap) => shiftGap(gap, file.shifts)),
            touched: intersectRanges(range, file.touchedOld),
        };
    };

    const touchedInB = (path: string, side: 'old' | 'new', range: LineRange): readonly LineRange[] => {
        if (isEmpty(range)) {
            return [];
        }
        const target = classifyPath(path);
        if (target.kind === 'opaque') {
            return [range];
        }
        if (side === 'old') {
            return baseChanged ? [range] : [];
        }
        if (target.kind === 'identity') {
            return [];
        }
        return intersectRanges(range, target.file.touchedNew);
    };

    return {
        fileStatus,
        mapRange,
        touchedInA: (path, side, range) => mapRange(path, side, range).touched,
        touchedInB,
    };
}

/**
 * Классификация стопа нового снапшота (якоря в координатах B): `new` — интердифф задел все
 * строки якорей (или файл появился), `changed` — часть, null — ни одной и у стопа без якорей.
 */
export function classifyStop(stop: Pick<RouteStop, 'anchors'>, map: IterationMap): StopChangeKind | null {
    let total = 0;
    let touched = 0;
    for (const anchor of stop.anchors) {
        const range = { start: anchor.start, end: anchor.end };
        total += rangeLength(range);
        touched += totalLength(map.touchedInB(anchor.path, anchor.side, range));
    }
    if (total === 0 || touched === 0) {
        return null;
    }
    return touched === total ? 'new' : 'changed';
}

/**
 * Стопы старого снапшота (якоря в координатах A), которых коснулся интердифф, —
 * материал баннера «затронуты остановки 02, 03 и 07». Порядок — как в снапшоте.
 */
export function affectedStops(snapshot: Pick<RouteSnapshot, 'stops'>, map: IterationMap): string[] {
    return snapshot.stops
        .filter((stop) =>
            stop.anchors.some(
                (anchor) =>
                    map.touchedInA(anchor.path, anchor.side, { start: anchor.start, end: anchor.end }).length > 0,
            ),
        )
        .map((stop) => stop.id);
}

/** Перенос куска, не задетого интердиффом, в координаты B: сдвиг постоянен внутри куска. */
function shiftGap(gap: LineRange, shifts: readonly ShiftPoint[]): LineRange[] {
    const pieces: LineRange[] = [];
    let cursor = gap.start;
    let delta = 0;
    for (const shift of shifts) {
        if (shift.from > gap.end) {
            break;
        }
        if (shift.from <= cursor) {
            delta = shift.delta;
            continue;
        }
        pieces.push({ start: cursor + delta, end: shift.from - 1 + delta });
        cursor = shift.from;
        delta = shift.delta;
    }
    pieces.push({ start: cursor + delta, end: gap.end + delta });
    return pieces;
}

/** Разбор патча в затронутые области и сдвиги; `null` — патч, по которому переносить нельзя. */
function buildFileLineMap(patch: string): FileLineMap | null {
    const touchedOld: LineRange[] = [];
    const touchedNew: LineRange[] = [];
    const shifts: ShiftPoint[] = [];
    let delta = 0;

    for (const hunk of splitHunks(patch)) {
        const first = hunk.findIndex((line) => line.changed);
        if (first < 0) {
            continue;
        }
        const last = hunk.findLastIndex((line) => line.changed);
        const old = regionSpan(hunk, first, last, 'old');
        const fresh = regionSpan(hunk, first, last, 'new');
        if (old === null || fresh === null) {
            // Ханк без единой строки нужной стороны (дифф без контекста): точку вставки
            // в её координатах из разметки не достать — честнее считать файл затронутым целиком.
            return null;
        }

        touchedOld.push(old);
        touchedNew.push(fresh);
        delta += countSide(hunk, 'new') - countSide(hunk, 'old');
        shifts.push({ from: old.end + 1, delta });
    }

    return { touchedOld: mergeRanges(touchedOld), touchedNew: mergeRanges(touchedNew), shifts };
}

/**
 * Ханки патча. Границу даёт `walkPatch`: заголовок `@@` — единственная строка без номеров,
 * с которой начинается нумерованное тело.
 */
function splitHunks(patch: string): Hunk[] {
    const hunks: Hunk[] = [];
    let current: Hunk | null = null;
    for (const line of walkPatch(patch)) {
        if (line.old === null && line.new === null) {
            if (line.raw.startsWith('@@')) {
                current = [];
                hunks.push(current);
            }
            continue;
        }
        current?.push(line);
    }
    return hunks;
}

/**
 * Затронутая область ханка на одной стороне: от первой до последней изменённой строки, то есть
 * номера строк этой стороны внутри области плюс контекст между изменениями (правило 1).
 *
 * У вставки своих строк на этой стороне нет — её место читается по соседним строкам (правило 2):
 * стоп с якорем 10–20, внутрь которого вставили код, обязан стать `changed`. Соседи берутся
 * у каждого прогона вставки отдельно, а не у области целиком, иначе одна и та же вставка метила
 * бы соседей только когда git не склеил её с соседней правкой в общий ханк. Вставка вплотную
 * к удалению — замена, а не вставка: её место уже накрыто удалёнными строками, наружу область
 * не растёт (иначе каждая правка строки затрагивала бы ещё и следующую).
 */
function regionSpan(hunk: Hunk, first: number, last: number, side: 'old' | 'new'): LineRange | null {
    const numberAt = (index: number): number | null => {
        const line = hunk[index];
        if (line === undefined) {
            return null;
        }
        return side === 'old' ? line.old : line.new;
    };
    // Изменённая строка, у которой есть номер этой стороны: удалённая для `old`, добавленная
    // для `new` — вторая половина замены.
    const isCounterpart = (index: number): boolean => (hunk[index]?.changed ?? false) && numberAt(index) !== null;

    const bounds: number[] = [];
    let index = first;
    while (index <= last) {
        const number = numberAt(index);
        if (number !== null) {
            bounds.push(number);
            index += 1;
            continue;
        }
        const runStart = index;
        while (index <= last && numberAt(index) === null) {
            index += 1;
        }
        if (isCounterpart(runStart - 1) || isCounterpart(index)) {
            continue;
        }
        const before = nearestNumber(hunk, runStart - 1, -1, side);
        const after = nearestNumber(hunk, index, 1, side);
        if (before !== null) {
            bounds.push(before);
        }
        if (after !== null) {
            bounds.push(after);
        }
    }

    return bounds.length === 0 ? null : { start: Math.min(...bounds), end: Math.max(...bounds) };
}

/** Ближайшая строка с номером нужной стороны от индекса `from` в направлении `step`. */
function nearestNumber(hunk: Hunk, from: number, step: -1 | 1, side: 'old' | 'new'): number | null {
    for (let index = from; index >= 0 && index < hunk.length; index += step) {
        const number = side === 'old' ? hunk[index]?.old : hunk[index]?.new;
        if (number !== null && number !== undefined) {
            return number;
        }
    }
    return null;
}

function countSide(hunk: Hunk, side: 'old' | 'new'): number {
    return hunk.filter((line) => line.changed && (side === 'old' ? line.old : line.new) !== null).length;
}

/** Склейка соседних и пересекающихся кусков; вход — по возрастанию. */
function mergeRanges(ranges: readonly LineRange[]): LineRange[] {
    const merged: LineRange[] = [];
    for (const range of ranges) {
        const last = merged.at(-1);
        if (last !== undefined && range.start <= last.end + 1) {
            merged[merged.length - 1] = { start: last.start, end: Math.max(last.end, range.end) };
            continue;
        }
        merged.push(range);
    }
    return merged;
}

function isEmpty(range: LineRange): boolean {
    return range.end < range.start;
}

function rangeLength(range: LineRange): number {
    return range.end - range.start + 1;
}

function totalLength(ranges: readonly LineRange[]): number {
    return ranges.reduce((sum, range) => sum + rangeLength(range), 0);
}

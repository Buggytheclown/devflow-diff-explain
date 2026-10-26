import type { FileDiff, UiFileProgress, UiSeenRange } from '@sherpa/protocol';

import type { DiffFileModel } from '../diff/model.js';
import type { Translate } from '../i18n/index.js';

/**
 * Прогресс чтения файла (docs/design/SPEC-elements.md §2.12, docs/architecture.md §7.1): три значения read-state и числа для тултипа.
 * Чистый модуль — на входе запись прогресса, файл диффа и (когда есть) изменённые строки модели,
 * на выходе состояние и числа; ни React, ни сети. Текст тултипа собирает компонент
 * (`readStateTooltip`) — результат кешируется в сторе диффа и не должен нести язык.
 *
 * Отметки только ручные — слежения за вьюпортом нет; `partial` даёт частичное покрытие
 * изменённых строк seen-диапазонами.
 */

export type ReadState = 'unread' | 'partial' | 'read';

/** Изменённые строки файла по сторонам: added живут в `new`, removed — в `old`. */
export interface ChangedLines {
    readonly old: ReadonlySet<number>;
    readonly new: ReadonlySet<number>;
}

/** Что нужно от файла диффа: остальные поля read-state не касаются. */
export type ReadStateFile = Pick<FileDiff, 'generated' | 'viewed' | 'additions' | 'deletions'>;

export interface ReadStateInput {
    readonly file: ReadStateFile;
    /** Явная запись прогресса; null — записи нет, работают умолчания. */
    readonly record: UiFileProgress | null;
    /**
     * Изменённые строки разобранной модели: ими диапазоны считаются точно. Без них покрытие
     * оценивается длиной самих диапазонов — это верхняя граница, обрезанная числом изменённых строк.
     */
    readonly changed?: ChangedLines;
}

export interface FileReadState {
    readonly state: ReadState;
    /** Просмотрено изменённых строк — число тултипа; оно обязано совпадать с визуалом (docs/design/SPEC-elements.md §2.12). */
    readonly seen: number;
    readonly total: number;
    /** `read` держится пином (ручная отметка, отметка хоста, generated-дефолт), а не покрытием. */
    readonly pinned: boolean;
    /** Отметка стоит по умолчанию, потому что файл машинный: её можно снять (docs/architecture.md §7.7). */
    readonly generatedDefault: boolean;
}

/** Тултип прогресса (docs/design/SPEC-elements.md §2.12): числа обязаны совпадать с визуалом коробки. */
export function readStateTooltip(t: Translate, read: Pick<FileReadState, 'seen' | 'total' | 'generatedDefault'>): string {
    const numbers = read.total === 0 ? t('progress.noChangedLines') : t('progress.seen', read.seen, read.total);
    return read.generatedDefault ? t('progress.generatedSeen', t('progress.generatedNote'), numbers) : numbers;
}


/**
 * Слияние источников. `true` пинит `read` навсегда, `false` явно снимает пин и оставляет
 * состояние диапазонам. При `null` или без записи работают умолчания: отметка хоста, затем
 * машинный файл; иначе состояние считается покрытием диапазонов записи.
 */
export function readStateOf(input: ReadStateInput): FileReadState {
    const { file, record } = input;
    const total = file.additions + file.deletions;

    if (record?.viewed === true) {
        return pinned(total, false);
    }
    if (record?.viewed === false) {
        return fromCoverage(record.seenRanges, input.changed, total, false);
    }
    if (file.viewed === true) {
        return pinned(total, false);
    }
    if (file.generated) {
        return pinned(total, true);
    }
    return fromCoverage(record?.seenRanges ?? [], input.changed, total, false);
}

/** Изменённые строки модели — вход `changed` для точного счёта покрытия. */
export function changedLinesOf(model: DiffFileModel | null): ChangedLines | undefined {
    if (model?.content.kind !== 'text') {
        return undefined;
    }

    const oldLines = new Set<number>();
    const newLines = new Set<number>();
    for (const block of model.content.blocks) {
        if (block.kind !== 'hunk') {
            continue;
        }
        for (const line of block.lines) {
            if (line.kind === 'del' && line.oldLine !== null) {
                oldLines.add(line.oldLine);
            }
            if (line.kind === 'add' && line.newLine !== null) {
                newLines.add(line.newLine);
            }
        }
    }
    return { old: oldLines, new: newLines };
}

/** Отметка держит `read` целиком: число тултипа обязано сойтись с залитой коробкой. */
function pinned(total: number, generatedDefault: boolean): FileReadState {
    return {
        state: 'read',
        seen: total,
        total,
        pinned: true,
        generatedDefault,
    };
}

function fromCoverage(
    ranges: readonly UiSeenRange[],
    changed: ChangedLines | undefined,
    total: number,
    generatedDefault: boolean,
): FileReadState {
    return coverageState(countSeen(ranges, changed), total, generatedDefault);
}

function coverageState(counted: number, total: number, generatedDefault: boolean): FileReadState {
    const seen = Math.min(counted, total);
    const state: ReadState = seen === 0 ? 'unread' : seen >= total ? 'read' : 'partial';
    return {
        state,
        seen,
        total,
        pinned: false,
        generatedDefault,
    };
}

/**
 * Сколько изменённых строк покрыто диапазонами. Известны строки модели — считаем их пересечение
 * с диапазонами; неизвестны — берём длину самих диапазонов (склеив пересекающиеся), а вызывающий
 * обрезает её числом изменённых строк.
 */
function countSeen(ranges: readonly UiSeenRange[], changed: ChangedLines | undefined): number {
    if (ranges.length === 0) {
        return 0;
    }

    const merged = { old: mergeSide(ranges, 'old'), new: mergeSide(ranges, 'new') };
    if (changed === undefined) {
        return length(merged.old) + length(merged.new);
    }
    return countCovered(changed.old, merged.old) + countCovered(changed.new, merged.new);
}

type Span = readonly [start: number, end: number];

/**
 * Покрытие требуемых диапазонов просмотренными — read-state без пина: `total` — строк
 * в требуемых, `seen` — сколько из них накрыто.
 */
export function rangesCoverage(required: readonly UiSeenRange[], covered: readonly UiSeenRange[]): FileReadState {
    let total = 0;
    let seen = 0;
    for (const side of ['old', 'new'] as const) {
        const need = mergeSide(required, side);
        const have = mergeSide(covered, side);
        total += length(need);
        for (const [start, end] of need) {
            for (const [from, to] of have) {
                seen += Math.max(0, Math.min(end, to) - Math.max(start, from) + 1);
            }
        }
    }
    return coverageState(seen, total, false);
}

/** Диапазоны после добавления или вычитания других: результат склеен по сторонам. */
export function changeSeenRanges(
    ranges: readonly UiSeenRange[],
    change: 'add' | 'remove',
    delta: readonly UiSeenRange[],
): UiSeenRange[] {
    return (['old', 'new'] as const).flatMap((side) => {
        const spans =
            change === 'add'
                ? mergeSide([...ranges, ...delta], side)
                : subtractSpans(mergeSide(ranges, side), mergeSide(delta, side));
        return spans.map(([start, end]): UiSeenRange => ({ side, start, end }));
    });
}

function subtractSpans(spans: readonly Span[], removed: readonly Span[]): Span[] {
    let rest: Span[] = [...spans];
    for (const [from, to] of removed) {
        rest = rest.flatMap(([start, end]): Span[] => {
            if (to < start || from > end) {
                return [[start, end]];
            }
            const pieces: Span[] = [];
            if (start < from) {
                pieces.push([start, from - 1]);
            }
            if (end > to) {
                pieces.push([to + 1, end]);
            }
            return pieces;
        });
    }
    return rest;
}

function mergeSide(ranges: readonly UiSeenRange[], side: UiSeenRange['side']): Span[] {
    const spans = ranges
        .filter((range) => range.side === side)
        .map((range): Span => [range.start, range.end])
        .sort((a, b) => a[0] - b[0]);

    const merged: Span[] = [];
    for (const span of spans) {
        const last = merged.at(-1);
        if (last === undefined || span[0] > last[1] + 1) {
            merged.push(span);
            continue;
        }
        merged[merged.length - 1] = [last[0], Math.max(last[1], span[1])];
    }
    return merged;
}

function length(spans: readonly Span[]): number {
    return spans.reduce((total, [start, end]) => total + (end - start + 1), 0);
}

function countCovered(lines: ReadonlySet<number>, spans: readonly Span[]): number {
    let covered = 0;
    for (const line of lines) {
        if (spans.some(([start, end]) => line >= start && line <= end)) {
            covered += 1;
        }
    }
    return covered;
}

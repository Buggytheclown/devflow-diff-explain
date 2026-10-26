import type { DiffFileModel, DiffLine } from '../diff/model.js';

/**
 * Выделение диапазона строк (docs/design/SPEC-elements.md §2.14): click-drag и shift-click,
 * одинаково в unified и split.
 *
 * Строка адресуется своими номерами в файле, а не местом в модели: раскрытие контекста
 * переиндексирует блоки (пропуски исчезают, соседние ханки сливаются), и выделение, привязанное
 * к индексам, после клика по перемычке подсвечивало бы другие строки. Номера не меняются.
 *
 * Порядок строк из ключей не выводится (у добавленной есть только новый номер, у удалённой —
 * только старый), поэтому диапазон раскрывается в набор строк по порядку самой модели:
 * `selectedLines` находит границы в ней и отдаёт всё, что лежит между.
 */

/** `c<старый>:<новый>` для контекста, `a<новый>` для добавленной, `d<старый>` для удалённой. */
export type LineKey = string;

export interface LineRange {
    readonly side: 'old' | 'new';
    readonly line: number;
    readonly size: number;
}

export interface LineSelection {
    readonly selectedText?: string;
    readonly fileId: string;
    /** Сторона нумерации; старые сохранённые фикстуры без поля выводят её из ключа строки. */
    readonly side?: 'old' | 'new';
    /** Строка, с которой начали (может быть ниже фокуса — тянуть можно в обе стороны). */
    readonly anchor: LineKey;
    readonly focus: LineKey;
}

const EMPTY: ReadonlySet<LineKey> = new Set();

/** `null` — номеров у строки нет вовсе (кривой патч), выделять её нечем. */
export function lineKey(line: DiffLine): LineKey | null {
    if (line.kind === 'add') {
        return line.newLine === null ? null : `a${String(line.newLine)}`;
    }
    if (line.kind === 'del') {
        return line.oldLine === null ? null : `d${String(line.oldLine)}`;
    }
    return line.oldLine === null || line.newLine === null
        ? null
        : `c${String(line.oldLine)}:${String(line.newLine)}`;
}

/** `null` — в атрибуте не ключ строки (чужой элемент под курсором). */
export function parseLineKey(value: string | null | undefined): LineKey | null {
    return value === null || value === undefined || value === '' ? null : value;
}

/** Unified-строка без `data-side` адресуется по той стороне, на которой у неё есть номер. */
export function lineSide(key: LineKey): 'old' | 'new' {
    return key.startsWith('d') ? 'old' : 'new';
}

/** Номера строки по её ключу; `null` — строка не в формате `lineKey`. */
export function lineKeyNumbers(key: LineKey): { readonly old: number | null; readonly new: number | null } | null {
    if (key.startsWith('a')) {
        const line = lineNumber(key.slice(1));
        return line === null ? null : { old: null, new: line };
    }
    if (key.startsWith('d')) {
        const line = lineNumber(key.slice(1));
        return line === null ? null : { old: line, new: null };
    }
    if (!key.startsWith('c')) {
        return null;
    }
    const [oldPart, newPart, ...rest] = key.slice(1).split(':');
    const oldLine = lineNumber(oldPart);
    const newLine = lineNumber(newPart);
    return rest.length > 0 || oldLine === null || newLine === null ? null : { old: oldLine, new: newLine };
}

function lineNumber(value: string | undefined): number | null {
    return value === undefined || !/^\d+$/.test(value) ? null : Number(value);
}

/** Сторона нумерации выделения с совместимостью для значений без явного поля. */
export function selectionSide(selection: LineSelection): 'old' | 'new' {
    return selection.side ?? lineSide(selection.anchor);
}

interface OrderedLine {
    readonly key: LineKey;
    readonly line: DiffLine;
}

function orderedLines(model: DiffFileModel): OrderedLine[] {
    if (model.content.kind !== 'text') {
        return [];
    }

    const order: OrderedLine[] = [];
    for (const block of model.content.blocks) {
        if (block.kind !== 'hunk') {
            continue;
        }
        for (const line of block.lines) {
            const key = lineKey(line);
            if (key !== null) {
                order.push({ key, line });
            }
        }
    }
    return order;
}

function selectionBounds(order: readonly OrderedLine[], selection: LineSelection): { from: number; to: number } | null {
    const anchor = order.findIndex((entry) => entry.key === selection.anchor);
    const focus = order.findIndex((entry) => entry.key === selection.focus);
    if (anchor < 0 && focus < 0) {
        return null;
    }

    return {
        from: anchor < 0 ? focus : focus < 0 ? anchor : Math.min(anchor, focus),
        to: anchor < 0 ? focus : focus < 0 ? anchor : Math.max(anchor, focus),
    };
}

/**
 * Строки модели, попавшие в диапазон: обе границы ищутся в порядке самой модели, всё между
 * ними — выделено. Граница, которой в модели нет, игнорируется — выделение сжимается до
 * второй, а не расползается на весь файл.
 */
export function selectedLines(model: DiffFileModel, selection: LineSelection | null): ReadonlySet<LineKey> {
    if (selection === null) {
        return EMPTY;
    }

    const order = orderedLines(model);
    const bounds = selectionBounds(order, selection);
    return bounds === null ? EMPTY : new Set(order.slice(bounds.from, bounds.to + 1).map((entry) => entry.key));
}

/** Для смешанного d/a-диапазона берёт только существующие номера выбранной стороны. */
export function selectedLineRange(
    model: DiffFileModel,
    selection: LineSelection | null,
    side: 'old' | 'new',
): { line: number; size: number } | null {
    if (selection === null) {
        return null;
    }

    const order = orderedLines(model);
    const bounds = selectionBounds(order, selection);
    if (bounds === null) {
        return null;
    }

    let first: number | null = null;
    let last: number | null = null;
    for (const entry of order.slice(bounds.from, bounds.to + 1)) {
        const line = side === 'old' ? entry.line.oldLine : entry.line.newLine;
        if (line !== null) {
            first = first === null ? line : Math.min(first, line);
            last = last === null ? line : Math.max(last, line);
        }
    }
    return first === null || last === null ? null : { line: first, size: last - first + 1 };
}

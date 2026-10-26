import type { FileContent } from '@sherpa/protocol';

import type { DiffBlock, DiffFileModel, DiffGap, DiffHunk, DiffLine, LanguageId } from '../diff/model.js';
import { highlightable, highlightText } from '../diff/syntax.js';

/** Шаг раскрытия перемычки контекста. */
export const EXPAND_STEP = 20;

export type GapKey = string;
export type ExpandDirection = 'up' | 'down' | 'all';

/** Служебный ключ действия «Раскрыть файл»: transform раскрывает весь допустимый контекст. */
export const FILE_EXPANSION_KEY: GapKey = 'file:all';

export interface GapExpansion {
    readonly up: number;
    readonly down: number;
    readonly all: boolean;
}

/** Раскрытие одного файла: независимое состояние для каждой исходной перемычки. */
export type FileExpansion = ReadonlyMap<GapKey, GapExpansion>;

interface Sides {
    /** Строки новой версии (1-based индексация через `at`). */
    readonly lines: readonly string[];
    /** Строки старой версии; нужны только когда новой стороны нет вовсе. */
    readonly oldLines: readonly string[] | null;
}

function split(text: string | null): readonly string[] | null {
    if (text === null) {
        return null;
    }
    const lines = text.split('\n');
    // Файл почти всегда кончается переводом строки, и последний кусок разбиения — пустой хвост.
    if (lines.at(-1) === '') {
        lines.pop();
    }
    return lines;
}

/** Сколько строк в новой версии файла; 0 — содержимого новой стороны нет. */
export function newFileLength(content: FileContent): number {
    return split(content.newText)?.length ?? 0;
}

/** Стабильный ключ пропуска считается по его границам в исходной модели файла. */
export function gapKeyOf(gap: DiffGap): GapKey {
    const hidden = gap.hiddenLines === null ? 'end' : String(gap.hiddenLines);
    return gap.sourceKey ?? `${gap.edge}:${String(gap.oldStart)}:${String(gap.newStart)}:${hidden}`;
}

/** Новое неизменяемое состояние после действия одной мишени. */
export function expandGap(
    expansion: FileExpansion,
    key: GapKey,
    direction: ExpandDirection,
    amount = EXPAND_STEP,
): FileExpansion {
    const current = expansion.get(key) ?? { up: 0, down: 0, all: false };
    const next: GapExpansion =
        direction === 'all'
            ? { ...current, all: true }
            : direction === 'up'
              ? { ...current, up: current.up + amount }
              : { ...current, down: current.down + amount };
    return new Map(expansion).set(key, next);
}

/** Полное раскрытие добавляет `all` исходным и видимым после transform пропускам файла. */
export function expandAllGaps(
    model: DiffFileModel,
    expansion: FileExpansion,
    visibleGapKeys: readonly GapKey[] = [],
): FileExpansion {
    const next = new Map(expansion);
    const keys = new Set<GapKey>([FILE_EXPANSION_KEY, ...visibleGapKeys]);
    if (model.content.kind === 'text') {
        for (const block of model.content.blocks) {
            if (block.kind === 'gap') {
                keys.add(gapKeyOf(block));
            }
        }
    }
    for (const key of keys) {
        const current = next.get(key) ?? { up: 0, down: 0, all: false };
        next.set(key, { ...current, all: true });
    }
    return next;
}

/**
 * Сколько неизменённых строк прячет пропуск. У хвостового пропуска парсер ставит `null`:
 * точная длина появляется только после загрузки содержимого файла.
 */
export function hiddenLinesOf(gap: DiffGap, content: FileContent | null): number | null {
    if (gap.hiddenLines !== null) {
        return gap.hiddenLines;
    }
    if (content === null) {
        return null;
    }
    const total = newFileLength(content);
    return total === 0 ? null : Math.max(total - gap.newStart + 1, 0);
}

/**
 * Сколько строк осталось за этим ключом; исчезнувший пропуск полностью раскрыт. Ключ бывает
 * общим у нескольких пропусков: срез остановки делит промежуток чужими изменёнными строками,
 * а раскрытие у получившихся кусков одно на всех.
 */
export function hiddenLinesForGap(model: DiffFileModel, content: FileContent | null, key: GapKey): number | null {
    if (model.content.kind !== 'text') {
        return 0;
    }
    let total = 0;
    for (const block of model.content.blocks) {
        if (block.kind !== 'gap' || gapKeyOf(block) !== key) {
            continue;
        }
        const hidden = hiddenLinesOf(block, content);
        if (hidden === null) {
            return null;
        }
        total += hidden;
    }
    return total;
}

/** Сколько изменённых строк чужих остановок осталось за этим ключом — по всем его кускам. */
export function hiddenChangedForGap(model: DiffFileModel, key: GapKey): number {
    if (model.content.kind !== 'text') {
        return 0;
    }
    let total = 0;
    for (const block of model.content.blocks) {
        if (block.kind === 'gap' && gapKeyOf(block) === key) {
            total += block.hiddenChanged ?? 0;
        }
    }
    return total;
}

/** Точные числа одного действия, измеренные на моделях до и после раскрытия. */
export function gapExpansionDelta(
    before: DiffFileModel,
    after: DiffFileModel,
    content: FileContent | null,
    key: GapKey,
): { readonly loaded: number; readonly hidden: number; readonly hiddenChanged: number } {
    const beforeHidden = hiddenLinesForGap(before, content, key) ?? 0;
    const afterHidden = hiddenLinesForGap(after, content, key) ?? 0;
    return {
        loaded: Math.max(0, beforeHidden - afterHidden),
        hidden: afterHidden,
        hiddenChanged: hiddenChangedForGap(after, key),
    };
}

/**
 * Модель с направленно раскрытым контекстом. Функция всегда считает от исходной модели:
 * одинаковое состояние даёт одинаковый результат во всех потребителях карточки.
 */
export function expandFileContext(
    model: DiffFileModel,
    content: FileContent | null,
    expansion: FileExpansion,
): DiffFileModel {
    if (content === null || model.content.kind !== 'text' || expansion.size === 0) {
        return model;
    }

    const sides: Sides = { lines: split(content.newText) ?? [], oldLines: split(content.oldText) };
    if (sides.lines.length === 0 && sides.oldLines === null) {
        return model;
    }

    const blocks: DiffBlock[] = [];
    const source = model.content.blocks;
    /** Строки, раскрытые у нижнего края пропуска: следующий ханк заберёт их в начало. */
    let prefix: DiffLine[] = [];
    let merge = false;

    for (const [index, block] of source.entries()) {
        if (block.kind === 'hunk') {
            const grown = prefix.length === 0 ? block : growUp(block, prefix);
            const last = blocks.at(-1);
            if (merge && last?.kind === 'hunk') {
                blocks[blocks.length - 1] = join(last, grown);
            } else {
                blocks.push(grown);
            }
            prefix = [];
            merge = false;
            continue;
        }

        const hidden = hiddenLinesOf(block, content);
        if (hidden === null || hidden <= 0) {
            blocks.push(block);
            continue;
        }

        const state = expansion.get(gapKeyOf(block));
        if (state === undefined) {
            blocks.push(block);
            continue;
        }

        const hasPrevious = source[index - 1]?.kind === 'hunk';
        const hasNext = source[index + 1]?.kind === 'hunk';
        const towardPrevious = state.all
            ? hasPrevious
                ? hidden
                : 0
            : Math.min(block.edge === 'inner' ? state.up : block.edge === 'trailing' ? state.down : 0, hidden);
        const towardNext = state.all
            ? hasNext
                ? hidden
                : 0
            : Math.min(block.edge === 'inner' ? state.down : block.edge === 'leading' ? state.up : 0, hidden);

        if (towardPrevious + towardNext >= hidden) {
            const revealed = reveal(model, sides, block, 0, hidden);
            if (hasPrevious) {
                growDown(blocks, revealed);
            } else {
                prefix = revealed;
            }
            merge = hasPrevious && hasNext;
            continue;
        }

        growDown(blocks, reveal(model, sides, block, 0, towardPrevious));
        blocks.push({
            ...block,
            sourceKey: gapKeyOf(block),
            hiddenLines: block.hiddenLines === null ? null : hidden - towardPrevious - towardNext,
            oldStart: block.oldStart + towardPrevious,
            newStart: block.newStart + towardPrevious,
        });
        prefix = reveal(model, sides, block, hidden - towardNext, towardNext);
    }

    return { ...model, content: { kind: 'text', blocks } };
}

/** `count` строк пропуска начиная со смещения `offset`. */
function reveal(
    model: DiffFileModel,
    sides: Sides,
    gap: DiffGap,
    offset: number,
    count: number,
): DiffLine[] {
    const lines: DiffLine[] = [];
    const sourceGapKey = gapKeyOf(gap);
    for (let i = 0; i < count; i += 1) {
        const newLine = gap.newStart + offset + i;
        const oldLine = gap.oldStart + offset + i;
        const text = sides.lines[newLine - 1] ?? sides.oldLines?.[oldLine - 1];
        if (text === undefined) {
            break;
        }

        lines.push({ kind: 'context', oldLine, newLine, text, sourceGapKey });
    }

    highlightRevealed(lines, model.language);
    return lines;
}

/**
 * Раскрытые строки подсвечиваются одним куском: это непрерывный фрагмент файла, и построчно
 * его многострочные конструкции подсветить нельзя (см. `highlightHunk` в `diff/parse.ts`).
 * Предохранитель по длине — тот же, что в парсере.
 */
function highlightRevealed(lines: readonly DiffLine[], language: LanguageId | null): void {
    if (language === null || lines.length === 0) {
        return;
    }
    const texts = lines.map((line) => line.text);
    if (!highlightable(texts)) {
        return;
    }

    const tokens = highlightText(texts.join('\n'), language);
    for (const [index, line] of lines.entries()) {
        const lineTokens = tokens[index];
        if (lineTokens !== undefined && lineTokens.length > 0) {
            line.tokens = lineTokens;
        }
    }
}

/** Раскрытые строки в конец уже выложенного ханка. */
function growDown(blocks: DiffBlock[], lines: DiffLine[]): void {
    const last = blocks.at(-1);
    if (last?.kind !== 'hunk' || lines.length === 0) {
        return;
    }
    blocks[blocks.length - 1] = {
        ...last,
        lines: [...last.lines, ...lines],
        oldCount: last.oldCount + lines.length,
        newCount: last.newCount + lines.length,
    };
}

/** Два ханка становятся одним, когда перемычка между ними исчезла. */
function join(first: DiffHunk, second: DiffHunk): DiffHunk {
    return {
        ...first,
        lines: [...first.lines, ...second.lines],
        oldCount: first.oldCount + second.oldCount,
        newCount: first.newCount + second.newCount,
        whitespaceOnly: first.whitespaceOnly && second.whitespaceOnly,
    };
}

function growUp(hunk: DiffHunk, lines: DiffLine[]): DiffHunk {
    const first = lines[0];
    return {
        ...hunk,
        lines: [...lines, ...hunk.lines],
        oldStart: first?.oldLine ?? hunk.oldStart,
        newStart: first?.newLine ?? hunk.newStart,
        oldCount: hunk.oldCount + lines.length,
        newCount: hunk.newCount + lines.length,
    };
}

/** Ноль — раскрывать больше нечего; `null` — длина хвоста пока неизвестна. */
export function remainingHiddenLines(model: DiffFileModel, content: FileContent | null): number | null {
    if (model.content.kind !== 'text') {
        return 0;
    }

    let total = 0;
    for (const block of model.content.blocks) {
        if (block.kind !== 'gap') {
            continue;
        }
        const hidden = hiddenLinesOf(block, content);
        if (hidden === null) {
            return null;
        }
        total += hidden;
    }
    return total;
}

/**
 * Сколько изменённых строк чужих остановок прячут пропуски. Раскрыть их карточка среза не может:
 * они объяснены в других остановках. В Полном диффе всегда 0 — `hiddenChanged` ставит только обрезка.
 */
export function remainingHiddenChanged(model: DiffFileModel): number {
    if (model.content.kind !== 'text') {
        return 0;
    }

    let total = 0;
    for (const block of model.content.blocks) {
        if (block.kind === 'gap') {
            total += block.hiddenChanged ?? 0;
        }
    }
    return total;
}

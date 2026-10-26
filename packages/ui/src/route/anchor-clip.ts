import type { RouteAnchor } from '@sherpa/protocol';

import type { DiffBlock, DiffFileModel, DiffGap, DiffHunk, DiffLine } from '../diff/model.js';
import type { FileExpansion } from '../diff-view/expand.js';
import { FILE_EXPANSION_KEY, gapKeyOf } from '../diff-view/expand.js';

/**
 * Обрезка модели файла по якорям остановки (docs/design/README.md §1: правая колонка остановки показывает
 * реальный дифф, но только те диапазоны, за которые остановка отвечает).
 *
 * Функция чистая и считает от исходной модели: состояние UI — набор якорей, пересчёт идёт
 * с нуля. Внутри ханка вокруг диапазона остаётся `ANCHOR_CONTEXT` неизменённых строк, всё
 * пропущенное называется пропуском с честными числами — сколько неизменённых строк и сколько
 * изменённых, объяснённых другими остановками (docs/product.md §3, принцип 3: ничего не прячется молча).
 * Края файла — такие же пропуски: без них срез молча съедал бы начало и хвост файла, а карточка
 * считала бы, что раскрывать нечего.
 */

/** Неизменённых строк вокруг диапазона якоря внутри ханка. */
export const ANCHOR_CONTEXT = 3;

/** Диапазон строк одной стороны; `RouteAnchor` ему удовлетворяет. */
export interface AnchorSpan {
    readonly side: 'old' | 'new';
    readonly start: number;
    readonly end: number;
}

export interface ClippedModel {
    /** Модель только из ханков, попавших в якоря; блоки — новые объекты, исходная не тронута. */
    readonly model: DiffFileModel;
    /** Изменённых строк файла строго внутри якорей (правило `changedLinesOf`: add→new, del→old). */
    readonly changedLines: number;
    /** Ханков в срезе; ноль — якоря не резолвятся в этот дифф (дрейф якорей, docs/design/SPEC-elements.md §2.9). */
    readonly hunks: number;
}

/** Строка попадает в якорь: номер её стороны внутри диапазона. */
export function lineInAnchors(line: DiffLine, anchors: readonly AnchorSpan[]): boolean {
    return anchors.some((anchor) => {
        const number = anchor.side === 'old' ? line.oldLine : line.newLine;
        return number !== null && number >= anchor.start && number <= anchor.end;
    });
}

/**
 * Изменённые строки модели, покрытые якорями. Счёт — строго правилом `changedLinesOf`
 * (add живёт в `new`, del — в `old`), поэтому числа сходятся с полосой покрытия и read-state.
 */
export function coveredChangedLines(
    model: DiffFileModel | null,
    anchors: readonly AnchorSpan[],
): { readonly additions: number; readonly deletions: number } {
    if (model?.content.kind !== 'text' || anchors.length === 0) {
        return { additions: 0, deletions: 0 };
    }

    let additions = 0;
    let deletions = 0;
    for (const block of model.content.blocks) {
        if (block.kind !== 'hunk') {
            continue;
        }
        for (const line of block.lines) {
            if (line.kind === 'add' && line.newLine !== null && covers(anchors, 'new', line.newLine)) {
                additions += 1;
            }
            if (line.kind === 'del' && line.oldLine !== null && covers(anchors, 'old', line.oldLine)) {
                deletions += 1;
            }
        }
    }
    return { additions, deletions };
}

function covers(anchors: readonly AnchorSpan[], side: 'old' | 'new', line: number): boolean {
    return anchors.some((anchor) => anchor.side === side && line >= anchor.start && line <= anchor.end);
}

/**
 * Изменённые строки файла, которых не касается ни один якорь, — материал синтетического
 * «Прочего». Диапазоны склеены по соседним номерам, стороны раздельные.
 *
 * Пустые и пробельные строки сюда не попадают: читать в них
 * нечего, а «Прочее» и штриховка полного диффа регулярно набивались такими разделителями
 * между блоками, разнесёнными по разным остановкам. Правило действует только вне якорей —
 * покрытая пробельная строка считается в своём тире как раньше.
 */
export function uncoveredRanges(
    model: DiffFileModel | null,
    anchors: readonly AnchorSpan[],
): readonly AnchorSpan[] {
    return changedRanges(model, (line, side, number) => !covers(anchors, side, number) && hasText(line));
}

/**
 * Изменённые строки, которые правило пробельных выводит из статистики покрытия: без текста и
 * без якоря. Их вычитает знаменатель процента — иначе покрытое плюс непокрытое не сойдётся
 * с числом изменённых строк.
 */
export function droppedWhitespaceLines(model: DiffFileModel | null, anchors: readonly AnchorSpan[]): number {
    return spanLines(changedRanges(model, (line, side, number) => !covers(anchors, side, number) && !hasText(line)));
}

/**
 * То же непокрытое, но со всеми пробельными строками, — материал отметки «просмотрено».
 * Прогресс чтения считает изменённые строки патча целиком, и отметка «Прочего» обязана
 * накрывать их все: правило пробельных убирает строки из статистики покрытия, а не из
 * просмотренного (docs/architecture.md §7.1).
 */
export function uncoveredReadRanges(
    model: DiffFileModel | null,
    anchors: readonly AnchorSpan[],
): readonly AnchorSpan[] {
    return changedRanges(model, (line, side, number) => !covers(anchors, side, number));
}

/** Строка несёт текст: пустая или из одних пробелов — нет. */
function hasText(line: DiffLine): boolean {
    return line.text.trim() !== '';
}

/**
 * Изменённые строки файла, покрытые якорями, — диапазонами. Те же строки, что считает
 * `coveredChangedLines`, поэтому seen-диапазоны отметки остановки сходятся с её счётчиками
 * и с полосой покрытия.
 */
export function coveredChangedRanges(
    model: DiffFileModel | null,
    anchors: readonly AnchorSpan[],
): readonly AnchorSpan[] {
    if (anchors.length === 0) {
        return [];
    }
    return changedRanges(model, (line, side, number) => covers(anchors, side, number));
}

/** Изменённые строки, прошедшие отбор, склеенные по соседним номерам в пределах стороны. */
function changedRanges(
    model: DiffFileModel | null,
    keep: (line: DiffLine, side: 'old' | 'new', number: number) => boolean,
): readonly AnchorSpan[] {
    if (model?.content.kind !== 'text') {
        return [];
    }

    const kept: { old: number[]; new: number[] } = { old: [], new: [] };
    for (const block of model.content.blocks) {
        if (block.kind !== 'hunk') {
            continue;
        }
        for (const line of block.lines) {
            if (line.kind === 'add' && line.newLine !== null && keep(line, 'new', line.newLine)) {
                kept.new.push(line.newLine);
            }
            if (line.kind === 'del' && line.oldLine !== null && keep(line, 'old', line.oldLine)) {
                kept.old.push(line.oldLine);
            }
        }
    }

    return [...toSpans('old', kept.old), ...toSpans('new', kept.new)];
}

function toSpans(side: 'old' | 'new', lines: readonly number[]): AnchorSpan[] {
    const sorted = [...new Set(lines)].sort((left, right) => left - right);
    const spans: AnchorSpan[] = [];
    for (const line of sorted) {
        const last = spans.at(-1);
        if (last !== undefined && line === last.end + 1) {
            spans[spans.length - 1] = { side, start: last.start, end: line };
            continue;
        }
        spans.push({ side, start: line, end: line });
    }
    return spans;
}

/** Сколько строк в диапазонах (по правилу счёта одной строки на сторону). */
export function spanLines(spans: readonly AnchorSpan[]): number {
    return spans.reduce((total, span) => total + (span.end - span.start + 1), 0);
}

/** Якоря стопа для одного файла: `RouteAnchor` уже несёт нужные поля. */
export function anchorSpans(anchors: readonly RouteAnchor[]): readonly AnchorSpan[] {
    return anchors.map(({ side, start, end }) => ({ side, start, end }));
}

/**
 * Модель, обрезанная по якорям. Нетекстовое содержимое (binary, пустой патч) возвращается как
 * есть — резать нечего, карточка покажет свой однострочный нотис.
 *
 * `context` — сколько неизменённых строк оставить вокруг диапазона. «Expand context» карточки
 * поднимает это число: раскрытие вокруг остановки — те же неизменённые строки, только шире.
 */
export function clipModelToAnchors(
    model: DiffFileModel,
    anchors: readonly AnchorSpan[],
    context = ANCHOR_CONTEXT,
    expansion: FileExpansion = new Map(),
): ClippedModel {
    if (model.content.kind !== 'text') {
        return { model, changedLines: 0, hunks: 0 };
    }
    if (anchors.length === 0) {
        return { model: { ...model, content: { kind: 'text', blocks: [] } }, changedLines: 0, hunks: 0 };
    }

    const blocks: DiffBlock[] = [];
    /** Пропущенное между уже выложенным куском и следующим: пропуск рождается только между ними. */
    let skipped: SkippedLines = { context: 0, changed: 0 };
    let changedLines = 0;
    let hunks = 0;

    const flush = (lines: DiffLine[], source: DiffHunk): void => {
        if (lines.length === 0) {
            return;
        }
        if (anythingSkipped(skipped)) {
            blocks.push(gapOf(blocks.length === 0 ? 'leading' : 'inner', startOfGap(lines[0]), skipped));
        }
        skipped = { context: 0, changed: 0 };
        blocks.push(hunkOf(source, lines));
        hunks += 1;
    };

    for (const block of model.content.blocks) {
        if (block.kind === 'gap') {
            // Пропуск исходной модели сохраняет свой ключ и раскрывается до обрезки якорями.
            // Ключ среза уступает ему, когда сам срез спрятал одни чужие изменённые строки:
            // раскрывать по такому ключу нечего, а мишень у слипшегося пропуска одна.
            skipped = {
                ...skipped,
                context: skipped.context + (block.hiddenLines ?? 0),
                ...(block.hiddenLines === null ? { toEndOfFile: true } : {}),
                key: skipped.context === 0 ? gapKeyOf(block) : (skipped.key ?? gapKeyOf(block)),
            };
            continue;
        }

        const keep = keepPlan(block.lines, anchors, context, expansion);
        let run: DiffLine[] = [];
        for (const [index, line] of block.lines.entries()) {
            if (keep.mask[index] === true) {
                run.push(line);
                if (line.kind !== 'context' && lineInAnchors(line, anchors)) {
                    changedLines += 1;
                }
                continue;
            }
            flush(run, block);
            run = [];
            // Пропуск считает всё, что срез спрятал, включая пробельные изменённые строки:
            // правило пробельных вычитает их из статистики покрытия,
            // а не из того, о чём карточка обязана сказать вслух.
            const key = skipped.key ?? keep.gapKeys[index];
            skipped =
                line.kind === 'context'
                    ? { ...skipped, context: skipped.context + 1, ...(key === undefined ? {} : { key }) }
                    : { ...skipped, changed: skipped.changed + 1, ...(key === undefined ? {} : { key }) };
        }
        flush(run, block);
    }

    const tail = blocks.at(-1);
    if (tail?.kind === 'hunk' && anythingSkipped(skipped)) {
        blocks.push(gapOf('trailing', startAfterHunk(tail), skipped));
    }

    return { model: { ...model, content: { kind: 'text', blocks } }, changedLines, hunks };
}

/** Пропуску есть что сказать: спрятанные строки или неизвестный хвост исходного пропуска. */
function anythingSkipped(skipped: SkippedLines): boolean {
    return skipped.context + skipped.changed > 0 || skipped.toEndOfFile === true;
}

interface KeepPlan {
    readonly mask: boolean[];
    readonly gapKeys: (string | undefined)[];
}

interface SkippedLines {
    readonly context: number;
    readonly changed: number;
    /** Пропуск дотягивается до конца файла: его длину, как и в исходной модели, знает содержимое. */
    readonly toEndOfFile?: true;
    readonly key?: string;
}

/** Номер строки в каждой из версий. */
interface Sides {
    readonly old: number;
    readonly new: number;
}

/**
 * Какие строки ханка остаются: якоря, базовый контекст и направленное раскрытие конкретных
 * промежутков. Чужие изменённые строки раскрытие перешагивает, оставляя их скрытыми.
 */
function keepPlan(
    lines: readonly DiffLine[],
    anchors: readonly AnchorSpan[],
    context: number,
    expansion: FileExpansion,
): KeepPlan {
    const mask = Array.from({ length: lines.length }, () => false);
    const gapKeys: (string | undefined)[] = Array.from({ length: lines.length }, () => undefined);
    const revealAllContext = expansion.get(FILE_EXPANSION_KEY)?.all === true;
    for (const [index, line] of lines.entries()) {
        // Раскрытие выполнено до transform: срез не имеет права снова прятать эти строки.
        if (line.sourceGapKey !== undefined || (revealAllContext && line.kind === 'context')) {
            mask[index] = true;
        }
        if (!lineInAnchors(line, anchors)) {
            continue;
        }
        mask[index] = true;
        for (const step of [-1, 1]) {
            for (let offset = 1; offset <= context; offset += 1) {
                const neighbour = lines[index + step * offset];
                if (neighbour?.kind !== 'context') {
                    break;
                }
                mask[index + step * offset] = true;
            }
        }
    }

    let index = 0;
    while (index < lines.length) {
        if (mask[index] === true) {
            index += 1;
            continue;
        }
        const start = index;
        while (index < lines.length && mask[index] !== true) {
            index += 1;
        }
        const end = index - 1;
        // Кусок, спрятанный целиком, соседей не имеет: расти его раскрытию не к чему.
        if (start === 0 && end === lines.length - 1) {
            continue;
        }

        const beforeSource = lines[start - 1]?.sourceGapKey;
        const afterSource = lines[end + 1]?.sourceGapKey;
        const sourceKey =
            beforeSource === undefined || afterSource === undefined || beforeSource === afterSource
                ? (beforeSource ?? afterSource)
                : undefined;
        const key = sourceKey ?? `clip:${lineBoundary(lines[start - 1])}>${lineBoundary(lines[end + 1])}`;
        for (let cursor = start; cursor <= end; cursor += 1) {
            gapKeys[cursor] = key;
        }
        const state = expansion.get(key);
        if (state === undefined) {
            continue;
        }
        const up = state.all ? Number.MAX_SAFE_INTEGER : state.up;
        const down = state.all ? Number.MAX_SAFE_INTEGER : state.down;
        // У края ханка сосед один, и мишень у пропуска тоже одна: раскрываем в его сторону,
        // какую бы из двух ни нажали.
        const above = start > 0;
        const below = end < lines.length - 1;
        revealContext(mask, lines, start, end, 1, above ? (below ? up : Math.max(up, down)) : 0);
        revealContext(mask, lines, start, end, -1, below ? (above ? down : Math.max(up, down)) : 0);
    }

    return { mask, gapKeys };
}

/**
 * До `amount` неизменённых строк промежутка `[start, end]`, считая от его края в сторону `step`.
 * Чужие изменённые строки раскрытие перешагивает: показывать их в этой остановке нельзя, они
 * остаются скрытыми и становятся своим пропуском — ровно как при раскрытии всего файла.
 */
function revealContext(
    mask: boolean[],
    lines: readonly DiffLine[],
    start: number,
    end: number,
    step: 1 | -1,
    amount: number,
): void {
    let revealed = 0;
    let index = step === 1 ? start : end;
    while (revealed < amount && index >= start && index <= end) {
        if (lines[index]?.kind === 'context') {
            mask[index] = true;
            revealed += 1;
        }
        index += step;
    }
}

function lineBoundary(line: DiffLine | undefined): string {
    return line === undefined ? 'none' : `${line.kind}:${String(line.oldLine ?? 0)}:${String(line.newLine ?? 0)}`;
}

function gapOf(edge: DiffGap['edge'], start: Sides, skipped: SkippedLines): DiffGap {
    return {
        kind: 'gap',
        edge,
        hiddenLines: skipped.toEndOfFile === true ? null : skipped.context,
        ...(skipped.changed === 0 ? {} : { hiddenChanged: skipped.changed }),
        ...(skipped.key === undefined ? {} : { sourceKey: skipped.key }),
        oldStart: start.old,
        newStart: start.new,
    };
}

/** Начало пропуска — то, что идёт после него: своих номеров у пропуска нет. */
function startOfGap(next: DiffLine | undefined): Sides {
    return { old: next?.oldLine ?? 0, new: next?.newLine ?? 0 };
}

/** Хвостовому пропуску следующей строки взять неоткуда: его начало — конец последнего ханка. */
function startAfterHunk(previous: DiffHunk): Sides {
    return { old: previous.oldStart + previous.oldCount, new: previous.newStart + previous.newCount };
}

/** Кусок исходного ханка как самостоятельный ханк: границы и счётчики — по факту строк. */
function hunkOf(source: DiffHunk, lines: readonly DiffLine[]): DiffHunk {
    const oldLines = lines.filter((line) => line.oldLine !== null);
    const newLines = lines.filter((line) => line.newLine !== null);
    return {
        ...source,
        oldStart: oldLines[0]?.oldLine ?? source.oldStart,
        oldCount: oldLines.length,
        newStart: newLines[0]?.newLine ?? source.newStart,
        newCount: newLines.length,
        lines: [...lines],
    };
}

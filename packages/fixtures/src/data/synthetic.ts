import type { FileChangeType, FileDiff, HostId } from '@sherpa/protocol';

import { tsLines } from '../content.js';
import type { HunkSpec } from '../patch.js';
import { makeFileDiff } from '../patch.js';

/**
 * Генератор синтетических PR из модулей одинаковой формы: им собраны `large` (64 файла) и
 * `huge` (100 файлов, 20k+ строк для перф-прогона).
 *
 * Содержимое не хранится, а считается из индекса файла: мегабайтов в репозитории нет, а
 * результат байт-в-байт одинаков между запусками. Семя — сам индекс, никакого `Math.random()`.
 */

/** Размер файла в строках патча и во сколько ханков они разложены. */
export interface SyntheticSize {
    additions: number;
    deletions: number;
    /** Ханков в файле; у add/delete всегда один — файл лежит в патче целиком. */
    hunks: number;
}

export interface SyntheticParams {
    diffId: HostId;
    /** Корень путей модулей: `<root>/mod-01/service.ts`. */
    root: string;
    modules: number;
    filesPerModule: number;
    /** Имена файлов внутри модуля; выбираются по `index % fileKinds.length`. */
    fileKinds: readonly string[];
    /** Машинный файл: путь получает сегмент `generated/`, карточка сворачивается по умолчанию. */
    generatedAt: (index: number) => boolean;
    changeTypeAt: (index: number) => Extract<FileChangeType, 'add' | 'modify' | 'delete'>;
    sizeAt: (index: number) => SyntheticSize;
    /** Строк неизменённого контекста в начале каждого ханка правки. */
    context: number;
    viewedAt: (index: number, changeType: FileChangeType) => boolean;
    /** Врезать в файл длинные строки — материал проверок переноса. */
    longLinesAt?: (index: number) => boolean;
    /** Текст после закрывающего `@@`, как его пишет git. */
    sectionAt?: (moduleIndex: number) => string;
}

/** Диапазон изменённых строк одной стороны — из них маршрутная фикстура строит якоря. */
export interface SyntheticRange {
    side: 'old' | 'new';
    start: number;
    end: number;
}

export interface SyntheticFile {
    file: FileDiff;
    moduleIndex: number;
    /** Только изменённые строки: контекст ханка внутрь диапазонов не попадает. */
    ranges: SyntheticRange[];
}

/** Уникальный фрагмент длинного URL, по которому тест находит строку после разбора патча. */
export const LONG_LINE_MARKER = 'wrap-fixture.invalid';

/** Первый ханк правки начинается здесь; дальше ханки идут через `HUNK_GAP` неизменённых строк. */
const FIRST_HUNK_START = 12;
const HUNK_GAP = 9;

export function modulePathOf(root: string, moduleIndex: number): string {
    return `${root}/mod-${String(moduleIndex + 1).padStart(2, '0')}`;
}

/**
 * Врезка длинных строк: сверхдлинный URL по обе стороны, минифицированный JSON, строка с
 * табуляциями и строка с хвостовыми пробелами. Числа строк не меняются — заменяются готовые.
 */
function injectLongLines(deletedLines: string[], addedLines: string[], deletions: number): void {
    deletedLines[0] = `-    const endpoint = "https://${LONG_LINE_MARKER}/payload/${'b'.repeat(600)}/orders";`;
    addedLines[0] = `+    const endpoint = "https://${LONG_LINE_MARKER}/payload/${'a'.repeat(600)}/orders";`;
    // Замена, а не вставка: число строк патча меняться не должно. У короткого файла хвостовых
    // позиций может не быть — тогда врезаются только длинные URL.
    if (deletions + 2 >= addedLines.length) {
        return;
    }
    addedLines[deletions] = `+    const minifiedPayload = "${'eyJrZXkiOiJ2YWx1ZSIsImZsYWciOnRydWV9'.repeat(35)}";`;
    addedLines[deletions + 1] = `+\t\tconst tabbedTail = "${'tabbed-tail-'.repeat(100)}";`;
    addedLines[deletions + 2] = `+    const trailingWhitespace = "${'tail-'.repeat(180)}";   `;
}

/** Как поделить `total` строк между `parts` ханками: остаток достаётся первым ханкам. */
function split(total: number, parts: number): number[] {
    const base = Math.floor(total / parts);
    const extra = total % parts;
    return Array.from({ length: parts }, (_, part) => base + (part < extra ? 1 : 0));
}

function pathAt(params: SyntheticParams, index: number, generated: boolean): string {
    const moduleIndex = Math.floor(index / params.filesPerModule);
    const kind = params.fileKinds[index % params.fileKinds.length] ?? 'service.ts';
    const base = modulePathOf(params.root, moduleIndex);
    return generated ? `${base}/generated/${kind}` : `${base}/${kind}`;
}

/**
 * Ханки правки: у каждого — контекст, затем удалённые строки, затем добавленные. Строки
 * нарезаются из тех же двух массивов, что и у однохункового файла, поэтому число ханков
 * меняет только раскладку, а не содержимое.
 */
function modifyHunks(
    params: SyntheticParams,
    index: number,
    size: SyntheticSize,
    section: string | undefined,
): { hunks: HunkSpec[]; ranges: SyntheticRange[] } {
    const deletedLines = tsLines('-', size.deletions, index + 5);
    const addedLines = tsLines('+', size.additions, index + 11);
    if (params.longLinesAt?.(index) === true) {
        injectLongLines(deletedLines, addedLines, size.deletions);
    }

    const parts = Math.max(1, size.hunks);
    const deletionParts = split(size.deletions, parts);
    const additionParts = split(size.additions, parts);
    const hunks: HunkSpec[] = [];
    const ranges: SyntheticRange[] = [];

    let oldCursor = FIRST_HUNK_START;
    let newCursor = FIRST_HUNK_START;
    let deletedTaken = 0;
    let addedTaken = 0;
    for (let part = 0; part < parts; part += 1) {
        const deletions = deletionParts[part] ?? 0;
        const additions = additionParts[part] ?? 0;
        const context = tsLines(' ', params.context, index + 1);
        hunks.push({
            oldStart: oldCursor,
            newStart: newCursor,
            ...(section === undefined ? {} : { section }),
            lines: [
                ...context,
                ...deletedLines.slice(deletedTaken, deletedTaken + deletions),
                ...addedLines.slice(addedTaken, addedTaken + additions),
            ],
        });
        if (deletions > 0) {
            ranges.push({ side: 'old', start: oldCursor + params.context, end: oldCursor + params.context + deletions - 1 });
        }
        if (additions > 0) {
            ranges.push({ side: 'new', start: newCursor + params.context, end: newCursor + params.context + additions - 1 });
        }
        deletedTaken += deletions;
        addedTaken += additions;
        oldCursor += params.context + deletions + HUNK_GAP;
        newCursor += params.context + additions + HUNK_GAP;
    }
    return { hunks, ranges };
}

function fileAt(params: SyntheticParams, index: number): SyntheticFile {
    const moduleIndex = Math.floor(index / params.filesPerModule);
    const generated = params.generatedAt(index);
    const path = pathAt(params, index, generated);
    const changeType = params.changeTypeAt(index);
    const size = params.sizeAt(index);
    const viewed = params.viewedAt(index, changeType);

    if (changeType === 'add') {
        const file = makeFileDiff(params.diffId, {
            path,
            changeType,
            generated,
            ...(viewed ? { viewed } : {}),
            hunks: [{ oldStart: 0, newStart: 1, lines: tsLines('+', size.additions, index) }],
        });
        return {
            file,
            moduleIndex,
            ranges: size.additions === 0 ? [] : [{ side: 'new', start: 1, end: size.additions }],
        };
    }

    if (changeType === 'delete') {
        const file = makeFileDiff(params.diffId, {
            path,
            changeType,
            generated,
            ...(viewed ? { viewed } : {}),
            hunks: [{ oldStart: 1, newStart: 0, lines: tsLines('-', size.deletions, index + 3) }],
        });
        return {
            file,
            moduleIndex,
            ranges: size.deletions === 0 ? [] : [{ side: 'old', start: 1, end: size.deletions }],
        };
    }

    const { hunks, ranges } = modifyHunks(params, index, size, params.sectionAt?.(moduleIndex));
    return {
        file: makeFileDiff(params.diffId, { path, changeType, generated, viewed, hunks }),
        moduleIndex,
        ranges,
    };
}

/** Файлы синтетического PR в порядке индексов — вместе с картой изменённых диапазонов. */
export function synthesizeFiles(params: SyntheticParams): SyntheticFile[] {
    const total = params.modules * params.filesPerModule;
    const files: SyntheticFile[] = [];
    for (let index = 0; index < total; index += 1) {
        files.push(fileAt(params, index));
    }
    return files;
}

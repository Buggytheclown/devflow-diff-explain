import type { FileContent } from '@sherpa/protocol';

import type { DiffBlock, DiffFileModel, DiffHunk, DiffLine, LanguageId } from '../diff/model.js';
import { highlightable, highlightText } from '../diff/syntax.js';

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

/** Все скрытые неизменённые строки из сохранённых сторон той же версии. */
export function expandFileContext(model: DiffFileModel, content: FileContent | null): DiffFileModel {
    if (content === null || model.content.kind !== 'text') return model;
    const newLines = split(content.newText);
    const oldLines = split(content.oldText);
    if (newLines === null && oldLines === null) return model;
    const blocks: DiffBlock[] = [];
    let prefix: DiffLine[] = [];
    let merge = false;
    for (const [index, block] of model.content.blocks.entries()) {
        if (block.kind === 'hunk') {
            const grown = prefix.length === 0 ? block : growUp(block, prefix);
            const last = blocks.at(-1);
            if (merge && last?.kind === 'hunk') blocks[blocks.length - 1] = join(last, grown);
            else blocks.push(grown);
            prefix = [];
            merge = false;
            continue;
        }
        const hidden = block.hiddenLines ?? Math.max(
            (newLines?.length ?? oldLines?.length ?? 0) - (newLines === null ? block.oldStart : block.newStart) + 1, 0,
        );
        const revealed: DiffLine[] = [];
        for (let offset = 0; offset < hidden; offset += 1) {
            const oldLine = block.oldStart + offset;
            const newLine = block.newStart + offset;
            const text = newLines?.[newLine - 1] ?? oldLines?.[oldLine - 1];
            if (text === undefined) break;
            revealed.push({ kind: 'context', oldLine, newLine, text });
        }
        highlightRevealed(revealed, model.language);
        const previous = blocks.at(-1)?.kind === 'hunk';
        const next = model.content.blocks[index + 1]?.kind === 'hunk';
        if (previous) growDown(blocks, revealed);
        else prefix = revealed;
        merge = previous && next;
    }
    return { ...model, content: { kind: 'text', blocks } };
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
        oldStart: last.oldCount === 0 ? lines[0]?.oldLine ?? last.oldStart : last.oldStart,
        newStart: last.newCount === 0 ? lines[0]?.newLine ?? last.newStart : last.newStart,
        oldCount: last.oldCount + lines.length,
        newCount: last.newCount + lines.length,
    };
}

/** Два ханка становятся одним, когда перемычка между ними исчезла. */
function join(first: DiffHunk, second: DiffHunk): DiffHunk {
    return {
        ...first,
        lines: [...first.lines, ...second.lines],
        oldStart: first.oldCount === 0 && second.oldCount > 0 ? second.oldStart : first.oldStart,
        newStart: first.newCount === 0 && second.newCount > 0 ? second.newStart : first.newStart,
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

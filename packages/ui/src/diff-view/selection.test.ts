import type { FileContent } from '@sherpa/protocol';
import { describe, expect, it } from 'vitest';

import type { DiffFileModel } from '../diff/model.js';
import { parseFileDiff } from '../diff/parse.js';
import { expandAllGaps, expandFileContext } from './expand.js';
import type { LineKey, LineSelection } from './selection.js';
import { lineKey, selectedLines } from './selection.js';

/**
 * Выделение диапазона: ключ строки — её номера в файле, поэтому раскрытие контекста
 * переиндексирует модель, а выделение остаётся на тех же строках.
 */

const LINES = Array.from({ length: 120 }, (_, index) => `line-${String(index + 1)}`);
const CONTENT: FileContent = { oldText: `${LINES.join('\n')}\n`, newText: `${LINES.join('\n')}\n` };

/** Два ханка: правится строка 21 и строка 41, между ними и вокруг — пропуски. */
function twoHunks(): DiffFileModel {
    return parseFileDiff({
        fileId: 'f1',
        path: 'app.ts',
        oldPath: null,
        changeType: 'modify',
        binary: false,
        patch: [
            '@@ -21,1 +21,1 @@',
            '-line-21',
            '+line-21 changed',
            '@@ -41,1 +41,1 @@',
            '-line-41',
            '+line-41 changed',
            '',
        ].join('\n'),
    });
}

/** Тексты выделенных строк — по ним видно, те ли это строки, а не те ли индексы. */
function selectedTexts(model: DiffFileModel, selection: LineSelection): string[] {
    const keys = selectedLines(model, selection);
    const texts: string[] = [];
    if (model.content.kind !== 'text') {
        return texts;
    }
    for (const block of model.content.blocks) {
        if (block.kind !== 'hunk') {
            continue;
        }
        for (const line of block.lines) {
            const key = lineKey(line);
            if (key !== null && keys.has(key)) {
                texts.push(line.text);
            }
        }
    }
    return texts;
}

function selection(anchor: LineKey, focus: LineKey): LineSelection {
    return { fileId: 'f1', anchor, focus };
}

describe('выделение строк', () => {
    it('ключ строки — её номера в файле, по одному на сторону', () => {
        expect(lineKey({ kind: 'context', oldLine: 21, newLine: 23, text: 'x' })).toBe('c21:23');
        expect(lineKey({ kind: 'add', oldLine: null, newLine: 23, text: 'x' })).toBe('a23');
        expect(lineKey({ kind: 'del', oldLine: 21, newLine: null, text: 'x' })).toBe('d21');
        // Кривая строка без номеров не адресуется — выделять её нечем.
        expect(lineKey({ kind: 'del', oldLine: null, newLine: null, text: 'x' })).toBeNull();
    });

    it('диапазон берётся по порядку модели и тянется в обе стороны одинаково', () => {
        const model = twoHunks();

        expect(selectedTexts(model, selection('d21', 'a21'))).toEqual(['line-21', 'line-21 changed']);
        expect(selectedTexts(model, selection('a21', 'd21'))).toEqual(['line-21', 'line-21 changed']);
    });

    it('раскрытие контекста не сдвигает выделение на соседние строки', () => {
        const model = twoHunks();
        const range = selection('d21', 'a21');
        const before = selectedTexts(model, range);

        const expanded = expandFileContext(model, CONTENT, expandAllGaps(model, new Map()));
        expect(selectedTexts(expanded, range)).toEqual(before);
    });

    it('пропавшая граница сжимает выделение до второй, а не расползается на файл', () => {
        const model = twoHunks();

        expect(selectedTexts(model, selection('a21', 'a999'))).toEqual(['line-21 changed']);
        expect(selectedLines(model, selection('a998', 'a999')).size).toBe(0);
    });

    it('без выделения и на двоичном файле выделенных строк нет', () => {
        const model = twoHunks();

        expect(selectedLines(model, null).size).toBe(0);
        expect(selectedLines({ ...model, content: { kind: 'binary' } }, selection('a21', 'a21')).size).toBe(0);
    });
});

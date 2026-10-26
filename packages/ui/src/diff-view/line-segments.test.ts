import { describe, expect, it } from 'vitest';

import type { DiffLine } from '../diff/model.js';
import { hasTabs, lineSegments } from './line-segments.js';

/** Разбор строки на куски: подсветка, word-level, табы, хвостовые пробелы. */

function line(partial: Partial<DiffLine> & { text: string }): DiffLine {
    return { kind: 'context', oldLine: 1, newLine: 1, ...partial };
}

describe('куски строки диффа', () => {
    it('строка без разметки — один кусок', () => {
        expect(lineSegments(line({ text: 'const x = 1;' }))).toEqual([
            { text: 'const x = 1;', kind: null, word: false, trailing: false },
        ]);
    });

    it('токены подсветки режут строку по своим границам', () => {
        const segments = lineSegments(
            line({ text: 'const x = 1;', tokens: [{ from: 0, to: 5, kind: 'keyword' }] }),
        );

        expect(segments).toEqual([
            { text: 'const', kind: 'keyword', word: false, trailing: false },
            { text: ' x = 1;', kind: null, word: false, trailing: false },
        ]);
    });

    it('word-level подсветка и токен пересекаются кусками', () => {
        const segments = lineSegments(
            line({
                kind: 'add',
                text: 'return b;',
                tokens: [{ from: 0, to: 6, kind: 'keyword' }],
                words: [{ from: 7, to: 8 }],
            }),
        );

        expect(segments.map((segment) => [segment.text, segment.kind, segment.word])).toEqual([
            ['return', 'keyword', false],
            [' ', null, false],
            ['b', null, true],
            [';', null, false],
        ]);
    });

    it('соседние токены одной категории объединяются внутри word-level подсветки', () => {
        const segments = lineSegments(line({
            text: 'leftRight',
            tokens: [
                { from: 0, to: 4, kind: 'variable' },
                { from: 4, to: 9, kind: 'variable' },
            ],
            words: [{ from: 2, to: 6 }],
        }));

        expect(segments).toEqual([
            { text: 'le', kind: 'variable', word: false, trailing: false },
            { text: 'ftRi', kind: 'variable', word: true, trailing: false },
            { text: 'ght', kind: 'variable', word: false, trailing: false },
        ]);
    });

    it('табы показываются четырьмя пробелами, смещения не разъезжаются', () => {
        const raw = '\tconst x = 1;';
        const segments = lineSegments(line({ text: raw, tokens: [{ from: 1, to: 6, kind: 'keyword' }] }));

        expect(hasTabs(line({ text: raw }))).toBe(true);
        expect(segments).toEqual([
            { text: '    ', kind: null, word: false, trailing: false },
            { text: 'const', kind: 'keyword', word: false, trailing: false },
            { text: ' x = 1;', kind: null, word: false, trailing: false },
        ]);
    });

    it('хвостовые пробелы добавленной строки уходят в отдельный кусок', () => {
        const segments = lineSegments(line({ kind: 'add', text: 'const x = 1;   ' }));

        expect(segments.at(-1)).toEqual({ text: '   ', kind: null, word: false, trailing: true });
    });

    it('хвостовые пробелы отмечаются только у добавленных строк', () => {
        expect(lineSegments(line({ kind: 'del', text: 'x   ' })).some((segment) => segment.trailing)).toBe(false);
        expect(lineSegments(line({ kind: 'context', text: 'x   ' })).some((segment) => segment.trailing)).toBe(false);
    });

    it('пустая и целиком пробельная строка не порождают блока хвоста', () => {
        expect(lineSegments(line({ kind: 'add', text: '' }))).toEqual([]);
        expect(lineSegments(line({ kind: 'add', text: '   ' })).some((segment) => segment.trailing)).toBe(false);
    });

    it('очень длинная строка не размечается, но и не режется', () => {
        const text = 'x'.repeat(5000);
        const segments = lineSegments(line({ text, tokens: [{ from: 0, to: 10, kind: 'string' }] }));

        expect(segments).toHaveLength(1);
        expect(segments[0]?.text).toHaveLength(5000);
        expect(segments[0]?.kind).toBeNull();
    });
});

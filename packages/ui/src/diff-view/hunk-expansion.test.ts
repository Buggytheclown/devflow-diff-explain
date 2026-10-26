import { describe, expect, it } from 'vitest';

import type { DiffBlock, DiffFileModel, DiffGap, DiffHunk, DiffLine } from '../diff/model.js';
import { hunkContextRequests } from './hunk-expansion.js';

function hunk(newStart: number, count: number): DiffHunk {
    const lines: DiffLine[] = Array.from({ length: count }, (_unused, index) => ({
        kind: 'context',
        oldLine: newStart + index,
        newLine: newStart + index,
        text: `строка ${String(newStart + index)}`,
    }));
    return {
        kind: 'hunk',
        oldStart: newStart,
        oldCount: count,
        newStart,
        newCount: count,
        whitespaceOnly: false,
        lines,
    };
}

function gap(edge: DiffGap['edge'], newStart: number, hidden: number | null): DiffGap {
    return { kind: 'gap', edge, hiddenLines: hidden, oldStart: newStart, newStart };
}

function model(blocks: readonly DiffBlock[]): DiffFileModel {
    return {
        fileId: 'f1',
        path: 'src/a.ts',
        changeType: 'modified',
        malformed: false,
        content: { kind: 'text', blocks: [...blocks] },
    } as unknown as DiffFileModel;
}

describe('hunkContextRequests', () => {
    it('внутренние перемычки растят ханк с обеих сторон', () => {
        const file = model([gap('inner', 1, 30), hunk(40, 3), gap('inner', 43, 30), hunk(90, 2)]);

        expect(hunkContextRequests(file, 'new', 41)).toEqual([
            { gapKey: 'inner:1:1:30', direction: 'down' },
            { gapKey: 'inner:43:43:30', direction: 'up' },
        ]);
    });

    it('ведущая перемычка раскрывается вверх, хвостовая — вниз', () => {
        const file = model([gap('leading', 1, 12), hunk(20, 2), gap('trailing', 22, null)]);

        expect(hunkContextRequests(file, 'new', 20)).toEqual([
            { gapKey: 'leading:1:1:12', direction: 'up' },
            { gapKey: 'trailing:22:22:end', direction: 'down' },
        ]);
    });

    it('пустая перемычка и отсутствующая строка не дают запросов', () => {
        const empty = model([gap('inner', 1, 0), hunk(20, 2)]);

        expect(hunkContextRequests(empty, 'new', 20)).toEqual([]);
        expect(hunkContextRequests(empty, 'new', 999)).toEqual([]);
    });
});

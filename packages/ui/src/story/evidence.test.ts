import { describe, expect, it } from 'vitest';

import type { DiffFileModel } from '../diff/model.js';
import { evidenceLines } from './evidence.tsx';
import { returnForSnapshot } from './reading-state.js';

const model: DiffFileModel = { fileId: 'f', path: 'new.ts', oldPath: 'old.ts', changeType: 'move', language: null,
    modeChange: null, additions: 1, deletions: 1, onlyAdditions: false, onlyDeletions: false, whitespaceOnly: false, malformed: false,
    content: { kind: 'text', blocks: [{ kind: 'hunk', oldStart: 4, oldCount: 2, newStart: 8, newCount: 2, whitespaceOnly: false, lines: [
        { kind: 'context', oldLine: 4, newLine: 8, text: 'context' },
        { kind: 'del', oldLine: 5, newLine: null, text: 'before' },
        { kind: 'add', oldLine: null, newLine: 9, text: 'after' },
    ] }] } };
const source = { kind: 'lines' as const, fileId: 'f', path: 'new.ts', side: 'new' as const, start: 8, end: 9 };

describe('источники рассказа', () => {
    it('показывает только указанную сторону с исходными номерами, не склеивая del/add', () => {
        expect(evidenceLines(model, source)?.map((line) => line.text)).toEqual(['context', 'after']);
        expect(evidenceLines(model, { ...source, path: 'old.ts', side: 'old', start: 4, end: 5 })?.map((line) => line.text)).toEqual(['context', 'before']);
    });
    it('не маскирует неполный диапазон и нетекстовый файл корректной пустотой', () => {
        expect(evidenceLines(model, { ...source, end: 10 })).toBeNull();
        expect(evidenceLines({ ...model, content: { kind: 'binary' } }, source)).toBeNull();
    });
    it('новое поколение сбрасывает старый раздел и фокус возврата только к новому введению', () => {
        const point = { storyKey: 'old', sectionId: 'stop-2', focus: 'source:2' };
        expect(returnForSnapshot(point, 'old')).toBe(point);
        expect(returnForSnapshot(point, 'new')).toEqual({ storyKey: 'new', sectionId: 'intro', focus: null });
    });
});

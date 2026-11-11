import type { FileContent } from '@sherpa/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { lowlight } from '../diff/languages.js';
import type { DiffFileModel, DiffLine } from '../diff/model.js';
import { parseFileDiff } from '../diff/parse.js';
import { expandFileContext } from './expand.js';

const OLD = ['first', 'before', 'middle-a', 'middle-b', 'last-before', 'tail'];
const NEW = ['first', 'after', 'inserted', 'middle-a', 'middle-b', 'last-after', 'tail'];
const CONTENT: FileContent = { oldText: `${OLD.join('\n')}\n`, newText: `${NEW.join('\n')}\n` };
function model(): DiffFileModel {
    return parseFileDiff({ fileId: 'f1', path: 'app.ts', oldPath: null, changeType: 'modify', binary: false,
        patch: '@@ -2,1 +2,2 @@\n-before\n+after\n+inserted\n@@ -5,1 +6,1 @@\n-last-before\n+last-after\n' });
}
function rows(value: DiffFileModel): DiffLine[] {
    return value.content.kind === 'text' ? value.content.blocks.flatMap((block) => block.kind === 'hunk' ? block.lines : []) : [];
}
function side(value: DiffFileModel, which: 'old' | 'new') {
    return rows(value).filter((line) => line[which === 'old' ? 'oldLine' : 'newLine'] !== null)
        .map((line) => [line[which === 'old' ? 'oldLine' : 'newLine'], line.text]);
}
afterEach(() => { vi.restoreAllMocks(); });

describe('полное раскрытие контекста', () => {
    it('восстанавливает обе стороны и сдвиги координат, объединяя начало, промежуток и хвост', () => {
        const base = model();
        const before = structuredClone(base);
        const expanded = expandFileContext(base, CONTENT);
        expect(side(expanded, 'old')).toEqual(OLD.map((text, i) => [i + 1, text]));
        expect(side(expanded, 'new')).toEqual(NEW.map((text, i) => [i + 1, text]));
        expect(expanded.content).toMatchObject({ kind: 'text', blocks: [{ kind: 'hunk', oldStart: 1, newStart: 1, oldCount: OLD.length, newCount: NEW.length }] });
        if (expanded.content.kind === 'text') expect(expanded.content.blocks).toHaveLength(1);
        expect(base).toEqual(before);
        expect(expanded.additions).toBe(base.additions);
        expect(expanded.deletions).toBe(base.deletions);
        expect(rows(expanded).filter((line) => line.kind !== 'context')).toEqual(rows(base));
        expect(expandFileContext(expanded, CONTENT)).toEqual(expanded);
    });

    it.each(['', '\n'])('не выдумывает строку после конца файла с окончанием %j', (ending) => {
        const expanded = expandFileContext(model(), { oldText: OLD.join('\n') + ending, newText: NEW.join('\n') + ending });
        expect(side(expanded, 'new').at(-1)).toEqual([7, 'tail']);
        expect(side(expanded, 'new')).toHaveLength(7);
    });

    it.each(['add', 'delete'] as const)('сохраняет полный односторонний файл %s и EOF-маркер', (changeType) => {
        const added = changeType === 'add';
        const base = parseFileDiff({ fileId: 'one', path: 'one.ts', oldPath: null, changeType, binary: false,
            patch: added ? '@@ -0,0 +1,1 @@\n+text\n\\ No newline at end of file' : '@@ -1,1 +0,0 @@\n-text\n\\ No newline at end of file' });
        const expanded = expandFileContext(base, { oldText: added ? null : 'text', newText: added ? 'text' : null });
        expect(expanded).toEqual(base);
        expect(rows(expanded)[0]?.noNewline).toBe(true);
    });

    it.each([
        { patch: '@@ -0,0 +1,1 @@\n+added\n', old: ['keep'], next: ['added', 'keep'] },
        { patch: '@@ -1,0 +2,1 @@\n+added\n', old: ['keep'], next: ['keep', 'added'] },
        { patch: '@@ -1,1 +0,0 @@\n-removed\n', old: ['removed', 'keep'], next: ['keep'] },
        { patch: '@@ -2,1 +1,0 @@\n-removed\n', old: ['keep', 'removed'], next: ['keep'] },
    ])('точно раскрывает modify с нулевым диапазоном $patch', ({ patch, old, next }) => {
        const base = parseFileDiff({ fileId: 'zero', path: 'zero.txt', oldPath: null, changeType: 'modify', binary: false, patch });
        const expanded = expandFileContext(base, { oldText: old.join('\n') + '\n', newText: next.join('\n') + '\n' });
        expect(side(expanded, 'old')).toEqual(old.map((text, i) => [i + 1, text]));
        expect(side(expanded, 'new')).toEqual(next.map((text, i) => [i + 1, text]));
        if (expanded.content.kind === 'text') expect(expanded.content.blocks[0]).toMatchObject({ oldStart: 1, newStart: 1 });
    });

    it('оставляет недоступные оригиналы, бинарные и metadata-only модели прежними', () => {
        const base = model();
        expect(expandFileContext(base, null)).toBe(base);
        for (const kind of ['binary', 'none'] as const) {
            const value = { ...base, content: { kind } };
            expect(expandFileContext(value, CONTENT)).toBe(value);
        }
    });

    it('рисует только реальные строки короткого legacy-оригинала', () => {
        const expanded = expandFileContext(model(), { oldText: 'first', newText: 'first' });
        expect(rows(expanded).filter((line) => line.kind === 'context').map((line) => line.text)).toEqual(['first']);
    });

    it('сбой лексера не теряет раскрытые строки и не меняет существующие изменения', () => {
        const base = model();
        vi.spyOn(lowlight, 'highlight').mockImplementation(() => { throw new Error('lexer failed'); });
        const expanded = expandFileContext(base, CONTENT);
        expect(side(expanded, 'new')).toEqual(NEW.map((text, i) => [i + 1, text]));
        expect(rows(expanded).filter((line) => line.kind !== 'context')).toEqual(rows(base));
        expect(rows(expanded).filter((line) => line.kind === 'context').every((line) => line.tokens === undefined)).toBe(true);
    });
});

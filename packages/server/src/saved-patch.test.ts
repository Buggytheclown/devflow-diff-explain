import { expect, it } from 'vitest';
import { mediumDiff } from './route/fixture-support.js';
import { savedPatchIndex } from './saved-patch.js';
import { storyEvidenceResolver } from './story-evidence.js';
import { diagramSourceErrors } from './flow-coordinator.js';
import { chatCodeLinkErrors } from './chat-code-links.js';
import { codeLink } from '@sherpa/protocol';

const base = mediumDiff();
const sample = base.files[0];
if (sample === undefined) throw new Error('Fixture needs a file');
const file = { ...sample, fileId: 'renamed', path: 'new.ts', oldPath: 'old.ts', patch: '@@ -10,2 +20,2 @@\n-before\n+after\n same\n@@ -30 +40 @@\n-later\n+latest\n' };
const diff = { ...base, files: [file] };
it('различает стороны переименования и отвергает промежуток между ханками', () => {
    const index = savedPatchIndex(diff);
    expect(index.file('old.ts', 'old')).toBe(file);
    expect(index.file('new.ts', 'old')).toBeNull();
    expect(index.file('new.ts', 'old', true)).toBe(file);
    expect(index.file('old.ts', 'new')).toBeNull();
    expect(index.range(file, { side: 'old', start: 10, end: 11 })?.map((line) => line.raw)).toEqual(['-before', ' same']);
    expect(index.range(file, { side: 'new', start: 20, end: 40 })).toBeNull();
    expect(index.range(file, { side: 'old', start: 20, end: 20 })).toBeNull();
    expect(savedPatchIndex({ ...diff, files: [{ ...file, patch: null }] }).range(file, { side: 'new', start: 20, end: 20 })).toBeNull();
});
it('рассказ, схема и чат одинаково отклоняют недоступный диапазон', () => {
    const source = { path: 'new.ts', side: 'new' as const, start: 20, end: 40 };
    const block = { claims: [{ quote: 'Обновлён вызов.', sources: [{ kind: 'lines' as const, ...source }], limitation: null }] };
    expect(storyEvidenceResolver(diff)(block, 'Обновлён вызов.').ok).toBe(false);
    expect(chatCodeLinkErrors(`[Код](${codeLink(source)})`, diff, null)).not.toEqual([]);
    const diagram = { title: 'Поток', nodes: [{ id: 'call', label: 'Вызов', change: 'modified' as const, sources: [{ kind: 'patch' as const, ...source }], limitation: null }], edges: [] };
    expect(diagramSourceErrors(diagram, diff, [])).not.toEqual([]);
    source.end = 21;
    expect(storyEvidenceResolver(diff)({ claims: [{ quote: 'Обновлён вызов.', limitation: null, sources: [{ kind: 'lines', ...source }] }] }, 'Обновлён вызов.').ok).toBe(true);
    expect(chatCodeLinkErrors(`[Код](${codeLink(source)})`, diff, null)).toEqual([]);
    expect(diagramSourceErrors({ ...diagram, nodes: [{ id: 'call', label: 'Вызов', change: 'modified', limitation: null, sources: [{ kind: 'patch', ...source }] }] }, diff, [])).toEqual([]);
});
it('не выбирает произвольный файл или повторяющиеся номера строк', () => {
    const duplicate = { ...file, fileId: 'other' };
    const index = savedPatchIndex({ ...diff, files: [file, duplicate] });
    expect(index.file('old.ts', 'old', true)).toBeNull();
    const repeated = { ...file, patch: file.patch + '@@ -10 +20 @@\n-before\n+after\n' };
    expect(savedPatchIndex({ ...diff, files: [repeated] }).range(repeated, { side: 'new', start: 20, end: 20 })).toBeNull();
});

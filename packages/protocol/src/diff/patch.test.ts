import { describe, expect, it } from 'vitest';
import { parseUnifiedPatch } from './patch.js';
import { PATCH_CASES } from './patch-cases.js';

describe('общая семантика строк и координат unified patch', () => {
    for (const item of PATCH_CASES) it(item.name, () => {
        const parsed = parseUnifiedPatch(item.patch);
        const hunks = parsed.parts.filter((part) => part.kind === 'hunk');
        const rows = hunks.flatMap((hunk) => hunk.lines.filter((line) => line.kind !== 'marker'));
        expect(rows.map((line) => [line.raw, line.old, line.new])).toEqual(item.rows);
        expect(parsed.malformed).toBe(item.malformed);
        for (const hunk of hunks) {
            expect(hunk.oldCount).toBe(hunk.lines.filter((line) => line.old !== null).length);
            expect(hunk.newCount).toBe(hunk.lines.filter((line) => line.new !== null).length);
        }
        // Все исходные строки остаются на месте; удалён только завершающий разделитель.
        const raw = parsed.parts.flatMap((part) => part.kind === 'hunk' ? [part.raw, ...part.lines.map((line) => line.raw)] : [part.raw]);
        expect(raw.join('\n') + (item.patch.endsWith('\n') ? '\n' : '')).toBe(item.patch);
    });

    it('EOF-маркеры отмечают предшествующую строку и сами не получают координат', () => {
        const parsed = parseUnifiedPatch('@@ -1 +1 @@\n-old\n\\ old EOF\n+new\n\\ new EOF\n');
        const hunk = parsed.parts[0];
        if (hunk?.kind !== 'hunk') throw new Error('Expected hunk');
        expect(hunk.lines).toMatchObject([
            { kind: 'del', noNewline: true }, { kind: 'marker', old: null, new: null },
            { kind: 'add', noNewline: true }, { kind: 'marker', old: null, new: null },
        ]);
    });

    it('неизвестный префикс не теряет первый символ, пустой patch не создаёт строк', () => {
        const hunk = parseUnifiedPatch('@@ -1 +1 @@\n?unknown\n').parts[0];
        if (hunk?.kind !== 'hunk') throw new Error('Expected hunk');
        expect(hunk.lines[0]).toMatchObject({ text: '?unknown', malformed: true });
        expect(parseUnifiedPatch('')).toEqual({ parts: [], malformed: false });
    });
});

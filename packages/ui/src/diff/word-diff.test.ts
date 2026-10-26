import type { FixtureName } from '@sherpa/fixtures';
import { fixtureIteration } from '@sherpa/fixtures';
import { describe, expect, it } from 'vitest';

import type { CharRange, DiffFileModel, DiffHunk, DiffLine } from './model.js';
import { toParseRequest } from './model.js';
import { parseFileDiff } from './parse.js';
import { diffWords } from './word-diff.js';

/** Подсвеченные куски строки текстом — так тест читается, а не пересчитывается руками. */
function pieces(text: string, ranges: readonly CharRange[] | undefined): string[] {
    return (ranges ?? []).map((range) => text.slice(range.from, range.to));
}

function lines(model: DiffFileModel): DiffLine[] {
    return model.content.kind === 'text'
        ? model.content.blocks.filter((block): block is DiffHunk => block.kind === 'hunk').flatMap((hunk) => hunk.lines)
        : [];
}

function parseFixtureFile(fixture: FixtureName, path: string): DiffFileModel {
    const file = fixtureIteration(fixture).diff.files.find((candidate) => candidate.path === path);
    if (file === undefined) {
        throw new Error(`нет файла ${path} в фикстуре ${fixture}`);
    }
    return parseFileDiff(toParseRequest(file));
}

describe('word-level дифф пары строк', () => {
    it('подсвечивает изменённое слово, а не всю строку', () => {
        const oldText = 'const timeout = 30;';
        const newText = 'const timeout = 60;';
        const diff = diffWords(oldText, newText);

        expect(pieces(oldText, diff?.old)).toEqual(['30']);
        expect(pieces(newText, diff?.new)).toEqual(['60']);
    });

    it('видит вставку без удаления', () => {
        const oldText = 'call(a, b)';
        const newText = 'call(a, extra, b)';
        const diff = diffWords(oldText, newText);

        expect(diff?.old).toEqual([]);
        expect(pieces(newText, diff?.new)).toEqual(['extra, ']);
    });

    it('совпавшие строки подсвечивать нечем', () => {
        expect(diffWords('same line', 'same line')).toBeNull();
    });

    it('пара без общих слов не подсвечивается: подсветка всей строки — шум', () => {
        expect(diffWords('alpha beta gamma', 'delta epsilon zeta')).toBeNull();
    });

    it('строки длиннее капа не подсвечиваются', () => {
        const long = `const x = "${'a'.repeat(1200)}";`;

        expect(long.length).toBeGreaterThan(1000);
        expect(diffWords(long, `${long} `)).toBeNull();
    });

    it('строка на пределе капа подсвечивается', () => {
        const oldText = `const x = "${'a'.repeat(900)}";`;
        const newText = `const y = "${'a'.repeat(900)}";`;

        expect(pieces(oldText, diffWords(oldText, newText)?.old)).toEqual(['x']);
    });
});

describe('спаривание строк внутри ханка', () => {
    it('пара del/add из фикстуры получает диапазоны с обеих сторон', () => {
        const model = parseFixtureFile('medium', 'services/orders/src/domain/order.ts');
        const del = lines(model).find((line) => line.kind === 'del' && line.text.includes('scheduled'));
        const add = lines(model).find((line) => line.kind === 'add' && line.text.includes('scheduled'));

        // `readonly scheduled?: boolean;` → `readonly scheduled: boolean;`: изменился один знак.
        expect(pieces(del?.text ?? '', del?.words)).toEqual(['?']);
        expect(add?.words).toBeUndefined();
    });

    it('пара с одинаковым текстом остаётся без подсветки', () => {
        // edge/clock.ts: строка `now(): Date;` удалена и добавлена без изменений, рядом добавлена вторая.
        const changed = lines(parseFixtureFile('edge', 'services/orders/src/infra/time/clock.ts')).filter(
            (line) => line.kind !== 'context',
        );

        expect(changed.every((line) => line.words === undefined)).toBe(true);
    });

    it('лишние добавленные строки без пары подсветки не получают', () => {
        const model = parseFileDiff({
            fileId: 'f1',
            path: 'a/b.ts',
            oldPath: null,
            changeType: 'modify',
            binary: false,
            patch: ['@@ -1,1 +1,2 @@', '-const a = 1;', '+const a = 2;', '+const b = 3;', ''].join('\n'),
        });
        const changed = lines(model);

        expect(pieces(changed[0]?.text ?? '', changed[0]?.words)).toEqual(['1']);
        expect(pieces(changed[1]?.text ?? '', changed[1]?.words)).toEqual(['2']);
        expect(changed[2]?.words).toBeUndefined();
    });
});

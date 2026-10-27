import { fixtureIteration } from '@sherpa/fixtures';
import { describe, expect, it } from 'vitest';

import { inTreeOrder, withTreeOrder } from './file-order.js';

/** Порядок файлов UI — порядок дерева: каталоги раньше файлов на каждом уровне, обе группы по алфавиту. */

function order(paths: readonly string[]): string[] {
    return inTreeOrder(paths.map((path) => ({ path }))).map((file) => file.path);
}

describe('порядок файлов', () => {
    it('на каждом уровне каталоги раньше файлов', () => {
        expect(order(['src/z.ts', 'src/lib/b.ts', 'a.ts', 'src/a.ts', 'docs/readme.md'])).toEqual([
            'docs/readme.md',
            'src/lib/b.ts',
            'src/a.ts',
            'src/z.ts',
            'a.ts',
        ]);
    });

    it('файл в корне идёт после всех каталогов корня', () => {
        expect(order(['pnpm-lock.yaml', 'b/x.ts', 'a/y.ts'])).toEqual(['a/y.ts', 'b/x.ts', 'pnpm-lock.yaml']);
    });

    it('файл и каталог с одним именем: сначала каталог', () => {
        expect(order(['src/a', 'src/a/b.ts'])).toEqual(['src/a/b.ts', 'src/a']);
        expect(order(['src/a/b.ts', 'src/a'])).toEqual(['src/a/b.ts', 'src/a']);
    });

    it('внутри группы — по алфавиту, как сравнивает дерево', () => {
        expect(order(['src/b.ts', 'src/B2.ts', 'src/a.ts'])).toEqual(['src/a.ts', 'src/b.ts', 'src/B2.ts']);
    });

    it('сортирует копию диффа, сохраняя исходный порядок и данные файлов', () => {
        const diff = fixtureIteration('medium').diff;
        const original = diff.files.map((file) => file.path);
        const sorted = withTreeOrder(diff);
        expect(sorted.files.map((file) => file.path)).toEqual(order(original));
        expect(diff.files.map((file) => file.path)).toEqual(original);
        expect(new Set(sorted.files)).toEqual(new Set(diff.files));
    });
});

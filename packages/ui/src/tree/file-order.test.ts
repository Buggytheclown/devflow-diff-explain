import { fixtureIteration } from '@sherpa/fixtures';
import { describe, expect, it } from 'vitest';

import { inTreeOrder, withTreeOrder } from './file-order.js';
import { buildFileTree } from './file-tree.js';

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

    it('совпадает с порядком файлов в дереве, хотя хост отдал их иначе', () => {
        const diff = fixtureIteration('medium').diff;
        const every = new Map<string, boolean>();
        for (const file of diff.files) {
            const segments = file.path.split('/');
            for (let index = 1; index < segments.length; index += 1) {
                every.set(segments.slice(0, index).join('/'), false);
            }
        }
        const tree = buildFileTree({
            files: diff.files,
            pciFileIds: new Set(),
            mineFileIds: null,
            readState: new Map(),
            routeFiles: null,
            collapsed: every,
        });
        const treePaths = tree.rows.flatMap((row) => (row.kind === 'file' ? [row.path] : []));

        expect(diff.files.map((file) => file.path)).not.toEqual(treePaths);
        expect(withTreeOrder(diff).files.map((file) => file.path)).toEqual(treePaths);
    });
});

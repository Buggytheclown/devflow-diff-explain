import { expect, it } from 'vitest';
import { buildFileTree, treeFiles } from './file-tree-model.js';
import type { TreeFile } from './file-tree-model.js';

const files = (paths: string[]): TreeFile[] => paths.map((path, index) => ({ fileId: String(index), path, additions: 1, deletions: 0, explanations: 1 }));

it('сжимает цепочку каталогов, сохраняя полный путь и несколько файлов', () => {
    const input = files(['billing/x/skills/extraction/deps.py', 'billing/x/skills/extraction/constants.py']);
    const tree = buildFileTree(input);
    expect(tree[0]).toMatchObject({ kind: 'directory', path: 'billing/x/skills/extraction', label: 'billing/x/skills/extraction' });
    expect(tree.flatMap(treeFiles)).toEqual(input);
});

it('возврат в каталог не переставляет файлы относительно рассказа', () => {
    const input = files(['src/a.py', 'tests/test_a.py', 'src/b.py', 'README.md', 'src/c.py']);
    const tree = buildFileTree(input);
    expect(tree.flatMap(treeFiles)).toEqual(input);
    expect(tree.filter((node) => node.kind === 'directory' && node.path === 'src')).toHaveLength(3);
});

it('различает одноимённые файлы, файл и каталог с совпадающим именем', () => {
    const input = files(['src/config', 'src/config/settings.py', 'tests/settings.py', 'src/settings.py']);
    expect(buildFileTree(input).flatMap(treeFiles)).toEqual(input);
    expect(buildFileTree([])).toEqual([]);
});

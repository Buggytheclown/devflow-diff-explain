import type { FileDiff } from '@sherpa/protocol';
import { describe, expect, it } from 'vitest';

import type { FileReadState, ReadState } from '../progress/read-state.js';
import {
    buildFileTree,
    filterByQuery,
    isCollapsed,
    matchesQuery,
    readBox,
    rowIndent,
    rowKey,
    splitLabel,
    toggleDirectory,
    TREE_INDENT_STEP,
} from './file-tree.js';
import type { FileTreeInput, TreeDirRow, TreeFileRow } from './file-tree.js';

/** Готовое состояние прогресса для строк дерева: числа тултипа здесь не проверяются. */
function read(state: ReadState): FileReadState {
    return { state, seen: state === 'read' ? 12 : state === 'partial' ? 5 : 0, total: 12, pinned: false, generatedDefault: false };
}

function file(path: string, patch: Partial<FileDiff> = {}): FileDiff {
    return {
        fileId: `f-${path}`,
        path,
        oldPath: null,
        changeType: 'modify',
        binary: false,
        generated: false,
        additions: 10,
        deletions: 2,
        patch: null,
        viewed: null,
        blameUrl: null,
        hostFileUrl: null,
        image: null,
        ...patch,
    };
}

function input(files: readonly FileDiff[], patch: Partial<FileTreeInput> = {}): FileTreeInput {
    return {
        files,
        pciFileIds: new Set(),
        mineFileIds: null,
        readState: new Map(),
        routeFiles: null,
        collapsed: new Map(),
        ...patch,
    };
}

const FILES = [
    file('services/orders/api/v3/handlers.ts'),
    file('services/orders/api/v3/schemas.ts'),
    file('services/orders/domain/order.ts'),
    file('gen/go/market/order.pb.go', { generated: true }),
    file('pnpm-lock.yaml'),
];

describe('buildFileTree', () => {
    it('схлопывает цепочки каталогов с единственным каталогом внутри', () => {
        const tree = buildFileTree(input(FILES));

        // Схлопнутая цепочка занимает место своего корневого каталога в алфавитном порядке
        // (`gen` перед `market`), а не уезжает в хвост к файлам верхнего уровня.
        expect(tree.rows.map((row) => [row.kind, row.label, row.depth])).toEqual([
            ['dir', 'gen/go/market', 0],
            ['file', 'order.pb.go', 1],
            ['dir', 'services/orders', 0],
            ['dir', 'api/v3', 1],
            ['file', 'handlers.ts', 2],
            ['file', 'schemas.ts', 2],
            ['dir', 'domain', 1],
            ['file', 'order.ts', 2],
            ['file', 'pnpm-lock.yaml', 0],
        ]);
    });

    it('каталог с единственным файлом со своим файлом не склеивается', () => {
        // В строке файла стоит только имя (SPEC-theming-2026-09-12 §6a): склеенный путь
        // отбирал у имени всю строку — каталог ужимался до нуля, а слэш оставался сиротой.
        const tree = buildFileTree(input([file('src/generated/index.test.ts', { generated: true })]));

        expect(tree.rows.map((row) => [row.kind, row.label, row.depth])).toEqual([
            ['dir', 'src/generated', 0],
            ['file', 'index.test.ts', 1],
        ]);
    });

    it('глубина потомков схлопнутой цепочки уменьшается на число схлопнутых уровней', () => {
        const tree = buildFileTree(input([file('a/b/c/one.ts'), file('a/b/c/two.ts')]));

        // Три каталога в одной строке глубины 0 — дети идут глубиной 1, а не 3.
        expect(tree.rows.map((row) => [row.label, row.depth])).toEqual([
            ['a/b/c', 0],
            ['one.ts', 1],
            ['two.ts', 1],
        ]);
    });

    it('при активном фильтре цепочка считается по видимым детям', () => {
        const files = [file('a/b/one.ts'), file('a/c/two.ts')];

        // Без фильтра у `a` два ребёнка — цепочки нет.
        expect(buildFileTree(input(files)).rows.map((row) => row.label)).toEqual([
            'a',
            'b',
            'one.ts',
            'c',
            'two.ts',
        ]);
        // Фильтр оставил одного ребёнка — цепочка схлопнулась.
        expect(buildFileTree(input(filterByQuery(files, 'one'))).rows.map((row) => row.label)).toEqual([
            'a/b',
            'one.ts',
        ]);
    });

    it('у каталога полный путь, а не схлопнутая подпись', () => {
        const tree = buildFileTree(input(FILES));
        const dirs = tree.rows.filter((row): row is TreeDirRow => row.kind === 'dir');

        expect(dirs.map((row) => row.path)).toEqual([
            'gen/go/market',
            'services/orders',
            'services/orders/api/v3',
            'services/orders/domain',
        ]);
    });

    it('агрегаты каталога — сумма по всему поддереву', () => {
        const tree = buildFileTree(
            input([
                file('a/b/one.ts', { additions: 3, deletions: 1 }),
                file('a/c/two.ts', { additions: 4, deletions: 2 }),
            ]),
        );
        const root = tree.rows.find((row): row is TreeDirRow => row.kind === 'dir');

        expect(root).toMatchObject({ label: 'a', additions: 7, deletions: 3, files: 2 });
    });

    it('строка файла несёт три состояния read-state', () => {
        const files = [file('a/one.ts'), file('a/two.ts'), file('a/three.ts')];
        const tree = buildFileTree(
            input(files, {
                readState: new Map([
                    ['f-a/one.ts', read('read')],
                    ['f-a/two.ts', read('partial')],
                ]),
            }),
        );

        expect(
            tree.rows.filter((row): row is TreeFileRow => row.kind === 'file').map((row) => [row.path, row.read.state]),
        ).toEqual([
            ['a/one.ts', 'read'],
            ['a/three.ts', 'unread'],
            ['a/two.ts', 'partial'],
        ]);
        expect([readBox('read'), readBox('partial'), readBox('unread')]).toEqual(['full', 'partial', 'none']);
    });

    it('машинным считается каталог, у которого машинное всё поддерево', () => {
        const tree = buildFileTree(
            input([
                file('gen/a/one.ts', { generated: true }),
                file('gen/b/two.ts', { generated: true }),
                file('src/a/one.ts', { generated: true }),
                file('src/b/two.ts'),
            ]),
        );
        const roots = tree.rows.filter((row): row is TreeDirRow => row.kind === 'dir' && row.depth === 0);

        expect(roots.map((row) => [row.label, row.generated])).toEqual([
            ['gen', true],
            ['src', false],
        ]);
    });

    it('чужой корень — только верхний уровень и только при известной линзе «мои»', () => {
        const files = [file('mine/a/one.ts'), file('mine/b/two.ts'), file('foreign/a/one.ts'), file('foreign/b/two.ts')];

        const withLens = buildFileTree(
            input(files, { mineFileIds: new Set(['f-mine/a/one.ts', 'f-mine/b/two.ts']) }),
        );
        expect(
            withLens.rows
                .filter((row): row is TreeDirRow => row.kind === 'dir' && row.depth === 0)
                .map((row) => [row.label, row.foreign]),
        ).toEqual([
            ['foreign', true],
            ['mine', false],
        ]);

        const withoutLens = buildFileTree(input(files));
        expect(
            withoutLens.rows.every((row) => row.kind !== 'dir' || !row.foreign),
        ).toBe(true);
    });

    it('каталог с больше чем 20 детьми свёрнут по умолчанию', () => {
        const many = Array.from({ length: 21 }, (_, index) => file(`big/file-${String(index)}.ts`));
        const tree = buildFileTree(input([...many, file('small/one.ts'), file('small/two.ts')]));

        expect([...tree.bulkDirectories]).toEqual(['big']);
        expect(tree.rows.filter((row) => row.kind === 'file').map((row) => row.label)).toEqual([
            'one.ts',
            'two.ts',
        ]);
    });

    it('ровно 20 детей — порог не сработал', () => {
        const many = Array.from({ length: 20 }, (_, index) => file(`big/file-${String(index)}.ts`));
        const tree = buildFileTree(input(many));

        expect([...tree.bulkDirectories]).toEqual([]);
        expect(tree.rows.filter((row) => row.kind === 'file')).toHaveLength(20);
    });

    it('явный выбор ревьюера старше умолчания по размеру', () => {
        const many = Array.from({ length: 21 }, (_, index) => file(`big/file-${String(index)}.ts`));
        const tree = buildFileTree(input(many, { collapsed: new Map([['big', false]]) }));

        expect(tree.rows.filter((row) => row.kind === 'file')).toHaveLength(21);
    });

    it('каталоги под свёрткой всё равно попадают в directories', () => {
        const tree = buildFileTree(
            input(
                [
                    file('a/b/one.ts'),
                    file('a/b/two.ts'),
                    file('a/c/three.ts'),
                    file('a/c/four.ts'),
                    file('a/five.ts'),
                ],
                { collapsed: new Map([['a', true]]) },
            ),
        );

        expect(tree.rows.map((row) => row.label)).toEqual(['a']);
        expect([...tree.directories].sort()).toEqual(['a', 'a/b', 'a/c']);
    });

    it('conflict-флаг строки берётся из changeType файла (SPEC-elements §4.1)', () => {
        const tree = buildFileTree(
            input([...FILES, file('services/orders/domain/slot.ts', { changeType: 'conflict' })]),
        );
        const tagged = tree.rows.filter((row) => row.kind === 'file' && row.conflict).map((row) => row.path);

        expect(tagged).toEqual(['services/orders/domain/slot.ts']);
    });

    it('pci-тег ставится по членству в линзе', () => {
        const tree = buildFileTree(input(FILES, { pciFileIds: new Set(['f-services/orders/domain/order.ts']) }));
        const tagged = tree.rows.filter((row) => row.kind === 'file' && row.pci).map((row) => row.path);

        expect(tagged).toEqual(['services/orders/domain/order.ts']);
    });
});

describe('toggleDirectory', () => {
    const tree = buildFileTree(input([file('a/b/one.ts'), file('a/b/two.ts'), file('a/c/three.ts'), file('a/c/four.ts')]));

    it('обычный клик трогает только сам каталог', () => {
        const next = toggleDirectory(tree, new Map(), 'a', false);

        expect(next.get('a')).toBe(true);
        expect(next.has('a/b')).toBe(false);
    });

    it('⌥-клик распространяет состояние на поддерево', () => {
        const next = toggleDirectory(tree, new Map(), 'a', true);

        expect([...next.entries()].sort()).toEqual([
            ['a', true],
            ['a/b', true],
            ['a/c', true],
        ]);
    });

    it('⌥-клик по свёрнутому каталогу разворачивает и его потомков', () => {
        const collapsed = new Map([['a', true], ['a/b', true], ['a/c', true]]);
        const next = toggleDirectory(tree, collapsed, 'a', true);

        expect([...next.values()]).toEqual([false, false, false]);
    });

    it('isCollapsed учитывает умолчание по размеру', () => {
        const many = Array.from({ length: 21 }, (_, index) => file(`big/file-${String(index)}.ts`));
        const big = buildFileTree(input(many));

        expect(isCollapsed(big, new Map(), 'big')).toBe(true);
        expect(isCollapsed(big, new Map([['big', false]]), 'big')).toBe(false);
    });
});

describe('matchesQuery', () => {
    it('пустой запрос пропускает всё', () => {
        expect(matchesQuery('src/a.ts', '')).toBe(true);
        expect(matchesQuery('src/a.ts', '   ')).toBe(true);
    });

    it('подстрока ищется по всему пути, регистр не важен', () => {
        expect(matchesQuery('services/orders/api/handlers.ts', 'orders/api')).toBe(true);
        expect(matchesQuery('services/orders/api/handlers.ts', 'ORDERS')).toBe(true);
        expect(matchesQuery('services/orders/api/handlers.ts', 'billing')).toBe(false);
    });

    it('нечёткое совпадение — только по имени файла', () => {
        expect(matchesQuery('services/orders/api/handlers.ts', 'hdl')).toBe(true);
        expect(matchesQuery('services/orders/api/handlers.ts', 'hlred')).toBe(false);
        // Буквы разбросаны по каталогам, но не по имени: путь не должен ловиться нечётко.
        expect(matchesQuery('services/orders/api/order.ts', 'svoa')).toBe(false);
    });
});

describe('filterByQuery', () => {
    it('пустой запрос отдаёт исходный список тем же объектом', () => {
        const files = [file('a.ts')];
        expect(filterByQuery(files, ' ')).toBe(files);
    });

    it('ничего не нашлось — пустой список', () => {
        expect(filterByQuery([file('a.ts')], 'zzz')).toEqual([]);
    });
});

describe('rowKey', () => {
    it('различает каталог и файл с одинаковым путём', () => {
        // Файл без расширения рядом со своей папкой: `src/a` и `src/a/b.ts` в одном диффе.
        const tree = buildFileTree(input([file('src/a'), file('src/a/b.ts'), file('src/a/c.ts')]));
        const keys = tree.rows.map(rowKey);

        expect(tree.rows.filter((row) => row.path === 'src/a')).toHaveLength(2);
        expect(new Set(keys).size).toBe(keys.length);
    });
});

describe('rowIndent', () => {
    it('файл рядом со схлопнутой цепочкой стоит в её колонке, дети цепочки — на шаг глубже', () => {
        const tree = buildFileTree(
            input([
                file('checkout/ui/assets/countdown-icon.svg'),
                file('checkout/ui/assets/legacy-window-badge.png'),
                file('checkout/src/order.ts'),
                file('checkout/config.yaml'),
            ]),
        );
        const indent = (label: string): number => {
            const row = tree.rows.find((candidate) => candidate.label === label);
            if (row === undefined) {
                throw new Error(`нет строки ${label}`);
            }
            return rowIndent(row);
        };

        expect(indent('config.yaml')).toBe(indent('ui/assets'));
        expect(indent('src')).toBe(indent('ui/assets'));
        // Цепочка из двух сегментов — один уровень: её дети на шаг глубже, а не на два.
        expect(indent('countdown-icon.svg')).toBe(indent('ui/assets') + TREE_INDENT_STEP);
        expect(indent('order.ts')).toBe(indent('countdown-icon.svg'));
    });
});

describe('splitLabel', () => {
    it('отделяет цепочку каталогов от последнего сегмента, разделитель — при имени', () => {
        expect(splitLabel('services/orders/order.ts')).toEqual({ dir: 'services/orders', name: '/order.ts' });
    });

    it('подпись без каталогов отдаётся целиком именем', () => {
        expect(splitLabel('pnpm-lock.yaml')).toEqual({ dir: '', name: 'pnpm-lock.yaml' });
    });
});

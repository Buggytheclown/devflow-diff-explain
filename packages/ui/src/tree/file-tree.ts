import type { FileDiff } from '@sherpa/protocol';

import { fuzzyMatch } from '../palette/fuzzy.js';
import type { FileReadState, ReadState } from '../progress/read-state.js';
import { readStateOf } from '../progress/read-state.js';
import type { RouteMarginFile } from '../route/margin-model.js';
import { inTreeOrder } from './file-order.js';

/**
 * Дерево файлов левой панели полного диффа (docs/design/SPEC-elements.md §2.20,
 * docs/design/README.md §10). Чистый модуль: построение, агрегаты, свёртка и поиск считаются
 * без React и без DOM — рендер только рисует готовые строки.
 *
 * Цепочки каталогов с единственным каталогом внутри склеиваются в одну строку (`services/orders`,
 * `api/v3`) — так дерево из двух десятков файлов помещается в панель, а не растекается по одному
 * сегменту пути на строку. Каталог с единственным файлом со своим файлом не склеивается:
 * в строке файла стоит только имя (docs/design/SPEC-theming-2026-09-12.md §6a).
 */

/** Свыше этого числа детей каталог по умолчанию свёрнут (docs/design/SPEC-elements.md §2.20). */
export const BULK_DIRECTORY_CHILDREN = 20;

/** Отступ верхнего уровня: левые 26px держат метку остановки (docs/design/SPEC-theming-2026-09-12.md §6a). */
export const TREE_INDENT_BASE = 26;
export const TREE_INDENT_STEP = 10;

/**
 * Строки одного уровня начинаются в одной колонке: шеврон каталога и коробка файла.
 * Схлопнутая цепочка — один уровень.
 */
export function rowIndent(row: Pick<TreeRow, 'depth'>, indentStep = TREE_INDENT_STEP): number {
    return TREE_INDENT_BASE + row.depth * indentStep;
}

export interface TreeFileRow {
    readonly kind: 'file';
    /** Путь файла; он же ключ строки. */
    readonly path: string;
    /** Имя файла: каталоги стоят своими строками (docs/design/SPEC-theming-2026-09-12.md §6a). */
    readonly label: string;
    readonly depth: number;
    readonly fileId: string;
    readonly additions: number;
    readonly deletions: number;
    readonly generated: boolean;
    /** Ссылки хоста для меню файла (docs/design/SPEC-elements.md §2.11); null — хосту нечего предложить. */
    readonly hostFileUrl: string | null;
    readonly blameUrl: string | null;
    /** Файл не смёржен: тег `conflict` в строке и исключение из покрытия (docs/design/SPEC-elements.md §4.1). */
    readonly conflict: boolean;
    /** Файл входит в extra-линзу `pci` — тег в строке (docs/design/README.md §10). */
    readonly pci: boolean;
    /** Прогресс чтения файла (docs/design/SPEC-elements.md §2.12): три состояния и числа для тултипа. */
    readonly read: FileReadState;
    /** Маршрут на полях (docs/design/README.md §10): бейдж остановки или штриховка. null — маршрута нет. */
    readonly route: RouteMarginFile | null;
}

export interface TreeDirRow {
    readonly kind: 'dir';
    readonly path: string;
    readonly label: string;
    readonly depth: number;
    readonly additions: number;
    readonly deletions: number;
    readonly files: number;
    /** Полностью прочитанных файлов в поддереве; `partial` в это число не входит. */
    readonly readFiles: number;
    /** Всё поддерево машинное — приглушение как у файлов (docs/design/README.md §10). */
    readonly generated: boolean;
    /**
     * Корневой каталог без единого моего файла (docs/design/README.md §10, «foreign roots»).
     * Всегда `false`, если ownership-линзы нет: приглушать нечем.
     */
    readonly foreign: boolean;
    readonly collapsed: boolean;
}

export type TreeRow = TreeFileRow | TreeDirRow;

export interface FileTree {
    /** Видимые строки в порядке обхода: содержимое свёрнутых каталогов сюда не попадает. */
    readonly rows: readonly TreeRow[];
    /** Все каталоги дерева, включая спрятанные под свёрткой, — цели ⌥-клика. */
    readonly directories: ReadonlySet<string>;
    /** Каталоги, свёрнутые по умолчанию из-за размера; явный выбор ревьюера старше. */
    readonly bulkDirectories: ReadonlySet<string>;
}

export interface FileTreeInput {
    readonly files: readonly FileDiff[];
    /** Файлы, входящие в линзу `pci`; пустое множество — тегов нет. */
    readonly pciFileIds: ReadonlySet<string>;
    /** Файлы ownership-линзы; null — линзы нет, «чужие корни» не вычисляются. */
    readonly mineFileIds: ReadonlySet<string> | null;
    /** Read-state файлов; файла нет в карте — считается от умолчаний самого файла. */
    readonly readState: ReadonlyMap<string, FileReadState>;
    /** Маршрут на полях (docs/design/README.md §10); null — маршрута нет и бейджей в строках тоже. */
    readonly routeFiles: ReadonlyMap<string, RouteMarginFile> | null;
    /** Явный выбор ревьюера: путь → свёрнут. Отсутствие ключа отдаёт решение умолчанию. */
    readonly collapsed: ReadonlyMap<string, boolean>;
}

interface Node {
    readonly segment: string;
    readonly path: string;
    readonly dirs: Map<string, Node>;
    readonly files: TreeFileRow[];
    additions: number;
    deletions: number;
    fileCount: number;
    readCount: number;
    generatedCount: number;
    mineCount: number;
}

function makeNode(segment: string, path: string): Node {
    return {
        segment,
        path,
        dirs: new Map(),
        files: [],
        additions: 0,
        deletions: 0,
        fileCount: 0,
        readCount: 0,
        generatedCount: 0,
        mineCount: 0,
    };
}

interface EmitContext {
    readonly rows: TreeRow[];
    readonly directories: Set<string>;
    readonly bulkDirectories: Set<string>;
    readonly collapsed: ReadonlyMap<string, boolean>;
    readonly mineKnown: boolean;
}

/**
 * Строки дерева в порядке обхода. Порядок задаёт `inTreeOrder`: файлы раскладываются по узлам
 * уже в нём, поэтому каталоги и файлы каждого узла лежат в порядке вставки — сортировать
 * при обходе нечего.
 */
export function buildFileTree(input: FileTreeInput): FileTree {
    const root = makeNode('', '');

    for (const file of inTreeOrder(input.files)) {
        const segments = file.path.split('/');
        const name = segments.pop() ?? file.path;
        const read = input.readState.get(file.fileId) ?? readStateOf({ file, record: null });
        const mine = input.mineFileIds?.has(file.fileId) ?? false;

        let node = root;
        const chain: Node[] = [root];
        for (const segment of segments) {
            let next = node.dirs.get(segment);
            if (next === undefined) {
                next = makeNode(segment, node.path === '' ? segment : `${node.path}/${segment}`);
                node.dirs.set(segment, next);
            }
            node = next;
            chain.push(node);
        }

        node.files.push({
            kind: 'file',
            path: file.path,
            label: name,
            depth: 0,
            fileId: file.fileId,
            additions: file.additions,
            deletions: file.deletions,
            generated: file.generated,
            hostFileUrl: file.hostFileUrl,
            blameUrl: file.blameUrl,
            conflict: file.changeType === 'conflict',
            pci: input.pciFileIds.has(file.fileId),
            read,
            route: input.routeFiles?.get(file.fileId) ?? null,
        });

        for (const ancestor of chain) {
            ancestor.additions += file.additions;
            ancestor.deletions += file.deletions;
            ancestor.fileCount += 1;
            ancestor.readCount += read.state === 'read' ? 1 : 0;
            ancestor.generatedCount += file.generated ? 1 : 0;
            ancestor.mineCount += mine ? 1 : 0;
        }
    }

    const context: EmitContext = {
        rows: [],
        directories: new Set(),
        bulkDirectories: new Set(),
        collapsed: input.collapsed,
        mineKnown: input.mineFileIds !== null,
    };
    emit(root, 0, '', true, context);
    return { rows: context.rows, directories: context.directories, bulkDirectories: context.bulkDirectories };
}

/**
 * Обход с раскруткой цепочек. `prefix` — сегменты схлопнутых предков; `visible: false` —
 * строки не выводятся (мы внутри свёрнутого каталога), но обойти поддерево всё равно надо:
 * его каталоги должны попасть в `directories` и в умолчания по размеру.
 */
function emit(node: Node, depth: number, prefix: string, visible: boolean, context: EmitContext): void {
    for (const dir of node.dirs.values()) {
        const chain = prefix === '' ? dir.segment : `${prefix}/${dir.segment}`;
        const onlyDir = dir.dirs.size === 1 && dir.files.length === 0;

        // Цепочка «каталог → единственный каталог» рисуется одной строкой: собственного ряда
        // у промежуточного узла нет, его сегмент уезжает в подпись потомка. Каталог
        // с единственным файлом в эту цепочку не входит: в строке файла стоит только имя,
        // иначе путь отнимает у имени всю строку (docs/design/SPEC-theming-2026-09-12.md §6a).
        if (onlyDir) {
            emit(dir, depth, chain, visible, context);
            continue;
        }

        context.directories.add(dir.path);
        const children = dir.dirs.size + dir.files.length;
        if (children > BULK_DIRECTORY_CHILDREN) {
            context.bulkDirectories.add(dir.path);
        }
        const collapsed = context.collapsed.get(dir.path) ?? children > BULK_DIRECTORY_CHILDREN;

        if (visible) {
            context.rows.push({
                kind: 'dir',
                path: dir.path,
                label: chain,
                depth,
                additions: dir.additions,
                deletions: dir.deletions,
                files: dir.fileCount,
                readFiles: dir.readCount,
                generated: dir.generatedCount === dir.fileCount,
                // «Чужой корень» — понятие про верхний уровень (docs/design/README.md §10): глубже приглушать
                // нечего, там уже видно по самим файлам.
                foreign: depth === 0 && context.mineKnown && dir.mineCount === 0,
                collapsed,
            });
        }
        emit(dir, depth + 1, '', visible && !collapsed, context);
    }

    // Схлопнутая цепочка каталогов своих файлов не имеет (иначе она не цепочка), поэтому
    // подпись файла — это всегда его имя, без приставки от `prefix`.
    if (visible) {
        for (const file of node.files) {
            context.rows.push({ ...file, depth });
        }
    }
}

/**
 * Ключ строки для React и виртуализатора. Один путь может принадлежать сразу каталогу и файлу
 * (файл без расширения рядом со своей папкой: `src/a` и `src/a/b.ts`), поэтому одного пути мало.
 */
export function rowKey(row: TreeRow): string {
    return `${row.kind}:${row.path}`;
}

/**
 * Подпись строки, разложенная на цепочку каталогов и последний сегмент (docs/design/SPEC-elements.md §1.2): путь
 * обрезается слева, а имя файла с расширением не режется. Разделитель уезжает в имя — так на
 * краю левой обрезки не остаётся нейтрального символа, который сбил бы порядок.
 */
export function splitLabel(label: string): { readonly dir: string; readonly name: string } {
    const cut = label.lastIndexOf('/');
    return cut < 0 ? { dir: '', name: label } : { dir: label.slice(0, cut), name: label.slice(cut) };
}

/** Свёрнутость каталога с учётом умолчаний: явный выбор ревьюера старше. */
export function isCollapsed(tree: FileTree, collapsed: ReadonlyMap<string, boolean>, path: string): boolean {
    return collapsed.get(path) ?? tree.bulkDirectories.has(path);
}

/**
 * Переключение каталога. ⌥-клик (`subtree`) распространяет новое состояние на всё поддерево,
 * включая каталоги, спрятанные под свёрткой (docs/design/SPEC-elements.md §2.20).
 */
export function toggleDirectory(
    tree: FileTree,
    collapsed: ReadonlyMap<string, boolean>,
    path: string,
    subtree: boolean,
): Map<string, boolean> {
    const value = !isCollapsed(tree, collapsed, path);
    const next = new Map(collapsed).set(path, value);
    if (subtree) {
        for (const candidate of tree.directories) {
            if (candidate.startsWith(`${path}/`)) {
                next.set(candidate, value);
            }
        }
    }
    return next;
}

/**
 * Отбор по строке фильтра (docs/design/SPEC-elements.md §2.20): подстрока в пути или нечёткое совпадение по имени
 * файла. Пустой запрос пропускает всё.
 */
export function matchesQuery(path: string, query: string): boolean {
    const needle = query.trim().toLowerCase();
    if (needle === '') {
        return true;
    }

    const haystack = path.toLowerCase();
    if (haystack.includes(needle)) {
        return true;
    }
    return fuzzyMatch(haystack.slice(haystack.lastIndexOf('/') + 1), needle);
}

export function filterByQuery(files: readonly FileDiff[], query: string): readonly FileDiff[] {
    return query.trim() === '' ? files : files.filter((file) => matchesQuery(file.path, query));
}

/** Три вида коробки read-state (docs/design/SPEC-elements.md §2.12, §2.20): полная, полубокс, пустая. */
export type ReadSummary = 'none' | 'partial' | 'full';

/** Коробка read-state в разметке строки. */
export function readBox(state: ReadState): ReadSummary {
    if (state === 'read') {
        return 'full';
    }
    return state === 'partial' ? 'partial' : 'none';
}

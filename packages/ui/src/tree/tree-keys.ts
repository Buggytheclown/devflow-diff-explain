import type { TreeRow } from './file-tree.js';

/**
 * Клавиатура дерева (docs/design/SPEC-elements.md §2.20): ↑/↓ ходят, →/← разворачивают и сворачивают, ⏎ открывает файл.
 * Чистый редьюсер: на вход клавиша и плоский список видимых строк, на выход — намерение.
 * Так поведение проверяется тестом без DOM, а компонент только исполняет команду.
 */

export type TreeCommand =
    | { readonly kind: 'focus'; readonly index: number }
    | { readonly kind: 'setCollapsed'; readonly path: string; readonly collapsed: boolean }
    | { readonly kind: 'open'; readonly fileId: string };

/** `null` — клавиша дереву не принадлежит, событие уходит дальше. */
export function treeKeyCommand(key: string, rows: readonly TreeRow[], index: number): TreeCommand | null {
    if (rows.length === 0) {
        return null;
    }
    const current = rows[index];

    switch (key) {
        case 'ArrowDown':
            return { kind: 'focus', index: Math.min(index + 1, rows.length - 1) };
        case 'ArrowUp':
            // Из «ничего не выбрано» (-1) ↑ ведёт на первую строку, а не в отрицательный индекс.
            return { kind: 'focus', index: index <= 0 ? 0 : index - 1 };
        case 'ArrowRight':
            if (current === undefined) {
                return { kind: 'focus', index: 0 };
            }
            if (current.kind !== 'dir') {
                return null;
            }
            return current.collapsed
                ? { kind: 'setCollapsed', path: current.path, collapsed: false }
                : { kind: 'focus', index: Math.min(index + 1, rows.length - 1) };
        case 'ArrowLeft': {
            if (current === undefined) {
                return { kind: 'focus', index: 0 };
            }
            if (current.kind === 'dir' && !current.collapsed) {
                return { kind: 'setCollapsed', path: current.path, collapsed: true };
            }
            const parent = parentIndex(rows, index);
            return parent === null ? null : { kind: 'focus', index: parent };
        }
        case 'Enter':
            if (current === undefined) {
                return null;
            }
            return current.kind === 'file'
                ? { kind: 'open', fileId: current.fileId }
                : { kind: 'setCollapsed', path: current.path, collapsed: !current.collapsed };
        default:
            return null;
    }
}

/** Ближайшая строка выше с меньшей глубиной; null — строка уже верхнего уровня. */
function parentIndex(rows: readonly TreeRow[], index: number): number | null {
    const depth = rows[index]?.depth;
    if (depth === undefined || depth === 0) {
        return null;
    }
    for (let i = index - 1; i >= 0; i -= 1) {
        const row = rows[i];
        if (row !== undefined && row.depth < depth) {
            return i;
        }
    }
    return null;
}

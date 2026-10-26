import type { PrDiff } from '@sherpa/protocol';

/**
 * Порядок файлов в UI — один на всех: порядок дерева файлов. Обход в глубину, на каждом уровне
 * сначала каталоги, потом файлы, обе группы по алфавиту. Порядок хоста не используется нигде:
 * дифф приводится к этому порядку в точке, где приходит в UI (`fetchReviewDiff`), и дерево,
 * карточки, клавиши перехода и палитра идут по нему одинаково.
 */

const collator = new Intl.Collator();

/** Сравнение путей по сегментам. Файл и каталог с одним именем (`src/a` и `src/a/b.ts`) — каталог раньше. */
function compareSegments(left: readonly string[], right: readonly string[]): number {
    const length = Math.min(left.length, right.length);
    for (let index = 0; index < length; index += 1) {
        const leftDir = index < left.length - 1;
        const rightDir = index < right.length - 1;
        if (leftDir !== rightDir) {
            return leftDir ? -1 : 1;
        }
        const order = collator.compare(left[index] ?? '', right[index] ?? '');
        if (order !== 0) {
            return order;
        }
    }
    return left.length - right.length;
}

/** Файлы в порядке дерева. */
export function inTreeOrder<T extends { readonly path: string }>(files: readonly T[]): T[] {
    return files
        .map((file) => ({ file, segments: file.path.split('/') }))
        .sort((left, right) => compareSegments(left.segments, right.segments))
        .map(({ file }) => file);
}

/** Дифф с файлами в порядке дерева. */
export function withTreeOrder(diff: PrDiff): PrDiff {
    return { ...diff, files: inTreeOrder(diff.files) };
}

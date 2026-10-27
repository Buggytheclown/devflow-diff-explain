import type { FileDiff, PrDiff } from '@sherpa/protocol';
import { walkPatch } from './route/diff-index.js';
import type { PatchLine } from './route/diff-index.js';

type Side = 'old' | 'new';
interface Range { side: Side; start: number; end: number }

/** Единый индекс именно переданной сохранённой ревизии. Текущий checkout не читается. */
export function savedPatchIndex(diff: PrDiff | null) {
    const files = diff?.files ?? [];
    const ids = uniqueIndex(files, (file) => file.fileId);
    const paths = { old: uniqueIndex(files, (file) => file.oldPath ?? file.path), new: uniqueIndex(files, (file) => file.path) };
    const numbered = new Map<FileDiff, Record<Side, Map<number, PatchLine | null>>>();
    return {
        file: (path: string, side: Side = 'new', canonicalOldPath = false): FileDiff | null => {
            if (paths[side].has(path)) return paths[side].get(path) ?? null;
            return side === 'old' && canonicalOldPath ? paths.new.get(path) ?? null : null;
        },
        byId: (id: string): FileDiff | null => ids.get(id) ?? null,
        range: (file: FileDiff | null | undefined, range: Range): readonly PatchLine[] | null => {
            if (file?.patch == null || !files.includes(file) ||
                !Number.isSafeInteger(range.start) || !Number.isSafeInteger(range.end) || range.start < 1 || range.end < range.start) return null;
            let index = numbered.get(file);
            if (index === undefined) {
                index = { old: new Map(), new: new Map() };
                for (const line of walkPatch(file.patch)) for (const side of ['old', 'new'] as const) {
                    const n = line[side];
                    if (n !== null) index[side].set(n, index[side].has(n) ? null : line);
                }
                numbered.set(file, index);
            }
            const side = index[range.side];
            if (range.end - range.start + 1 > side.size) return null;
            const result: PatchLine[] = [];
            for (let n = range.start; n <= range.end; n += 1) {
                const line = side.get(n);
                if (line == null) return null;
                result.push(line);
            }
            return result;
        },
    };
}

/** Не выбираем произвольный файл, если путь или идентификатор неоднозначен. */
function uniqueIndex(files: readonly FileDiff[], key: (file: FileDiff) => string): Map<string, FileDiff | null> {
    const result = new Map<string, FileDiff | null>();
    for (const file of files) { const value = key(file); result.set(value, result.has(value) ? null : file); }
    return result;
}

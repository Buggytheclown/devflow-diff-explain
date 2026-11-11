import type { PrDiff } from '@sherpa/protocol';
import { parseUnifiedPatch } from '@sherpa/protocol/diff';

/** Файл диффа глазами валидатора: id для резолва якоря и номера изменённых строк по сторонам. */
export interface ChangedFile {
    readonly fileId: string;
    readonly path: string;
    readonly old: ReadonlySet<number>;
    readonly new: ReadonlySet<number>;
}

/** Индекс диффа по пути файла. Путь — то, чем оперирует модель; `fileId` резолвится отсюда. */
export type DiffIndex = ReadonlyMap<string, ChangedFile>;

/**
 * Строка патча с номерами обеих сторон. `null` — на этой стороне строки нет: у добавленной нет
 * старого номера, у удалённой — нового, у заголовков и служебных маркеров нет никакого.
 */
export interface PatchLine {
    readonly raw: string;
    readonly old: number | null;
    readonly new: number | null;
    /** Добавленная или удалённая строка — та самая, по которой валидатор принимает якорь. */
    readonly changed: boolean;
}

/** Номера во всех серверных потребителях и UI определяет общий разбор патча. */
export function* walkPatch(patch: string): Generator<PatchLine> {
    for (const part of parseUnifiedPatch(patch).parts) {
        yield { raw: part.raw, old: null, new: null, changed: false };
        if (part.kind !== 'hunk') continue;
        for (const line of part.lines) {
            yield { raw: line.raw, old: line.old, new: line.new,
                changed: line.kind === 'add' || line.kind === 'del' };
        }
    }
    // Сохраняем серверное форматирование payload, не приписывая разделителю координаты.
    if (patch === '' || patch.endsWith('\n')) yield { raw: '', old: null, new: null, changed: false };
}

export function indexDiff(diff: PrDiff): DiffIndex {
    const files = new Map<string, ChangedFile>();
    for (const file of diff.files) {
        // Первый файл с таким путём выигрывает: дублей путей в одной итерации быть не должно.
        if (files.has(file.path)) {
            continue;
        }
        files.set(file.path, {
            fileId: file.fileId,
            path: file.path,
            ...changedLines(file.patch),
        });
    }
    return files;
}

/** Номера изменённых строк патча. У binary и файлов без текстового диффа менять нечего. */
function changedLines(patch: string | null): { old: Set<number>; new: Set<number> } {
    const oldLines = new Set<number>();
    const newLines = new Set<number>();
    if (patch === null) {
        return { old: oldLines, new: newLines };
    }

    for (const line of walkPatch(patch)) {
        if (!line.changed) {
            continue;
        }
        if (line.old !== null) {
            oldLines.add(line.old);
        }
        if (line.new !== null) {
            newLines.add(line.new);
        }
    }

    return { old: oldLines, new: newLines };
}

/** Изменённые строки нужной стороны файла. */
export function sideLines(file: ChangedFile, side: 'old' | 'new'): ReadonlySet<number> {
    return side === 'old' ? file.old : file.new;
}

/**
 * Задевает ли диапазон хоть одну изменённую строку своей стороны. Перебор идёт по изменённым
 * строкам, а не по диапазону: длина диапазона приходит от модели и ничем не ограничена.
 */
export function touchesChangedLines(
    file: ChangedFile,
    side: 'old' | 'new',
    start: number,
    end: number,
): boolean {
    for (const line of sideLines(file, side)) {
        if (line >= start && line <= end) {
            return true;
        }
    }
    return false;
}

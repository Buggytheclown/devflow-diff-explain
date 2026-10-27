import type { PrDiff } from '@sherpa/protocol';

/**
 * Изменённые строки диффа — единственная опора валидатора маршрута при резолве якорей.
 * Считаются сканом `@@`-ханков `FileDiff.patch`: added попадают в сторону `new`, removed — в `old`
 * (то же определение, что у математики покрытия в `docs/spec.md`:
 * `changed = added + removed`).
 *
 * Парсер UI сюда не тащится: он живёт в воркере браузера и строит полную модель строк,
 * а здесь нужны только номера изменённых строк. Но разметку ханка обе стороны обязаны читать
 * одинаково: модель якорится по номерам, которые ревьюер увидит в UI, — расхождение в один
 * сдвиг превращает корректный якорь в мёртвый. Поэтому правила ниже дословно повторяют
 * `packages/ui/src/diff/parse.ts`: заявленные в заголовке счётчики строк, маркер `\ `,
 * пустая строка и неопознанный префикс — контекст.
 */

/** Файл диффа глазами валидатора: id для резолва якоря и номера изменённых строк по сторонам. */
export interface ChangedFile {
    readonly fileId: string;
    readonly path: string;
    readonly old: ReadonlySet<number>;
    readonly new: ReadonlySet<number>;
}

/** Индекс диффа по пути файла. Путь — то, чем оперирует модель; `fileId` резолвится отсюда. */
export type DiffIndex = ReadonlyMap<string, ChangedFile>;

/** `@@ -a,b +c,d @@` и укороченная форма `@@ -a +c @@` (одна строка). Та же форма, что в UI. */
const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/;

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

/**
 * Разбор патча в пронумерованные строки — единственное место, где живёт разметка ханка.
 * Отсюда же payload печатает номера модели, поэтому напечатанное и принимаемое не разъезжаются.
 */
export function* walkPatch(patch: string): Generator<PatchLine> {
    const lines = patch.split('\n');
    let index = 0;
    while (index < lines.length) {
        const raw = lines[index] ?? '';
        const header = HUNK_HEADER.exec(raw);
        index += 1;
        // Всё вне ханка (`diff --git`, `--- a/…`, `+++ b/…`) номеров не имеет и их не двигает.
        yield { raw, old: null, new: null, changed: false };
        if (header === null) {
            continue;
        }

        let oldLine = Number(header[1]);
        let newLine = Number(header[3]);
        // Счётчики строк заголовка ограничивают тело ханка: хвост за ними номера уже не двигает.
        let restOld = header[2] === undefined ? 1 : Number(header[2]);
        let restNew = header[4] === undefined ? 1 : Number(header[4]);

        while (index < lines.length && (restOld > 0 || restNew > 0)) {
            const body = lines[index] ?? '';
            // Ханк обрублен: следующий заголовок пришёл раньше, чем кончились заявленные строки.
            if (HUNK_HEADER.test(body) || body.startsWith('diff --git ')) {
                break;
            }
            index += 1;

            // `\ No newline at end of file` — служебный маркер, в счётчики он не входит.
            if (body.startsWith('\\ ')) {
                yield { raw: body, old: null, new: null, changed: false };
                continue;
            }
            const prefix = body.slice(0, 1);
            if (prefix === '+') {
                yield { raw: body, old: null, new: newLine, changed: true };
                newLine += 1;
                restNew -= 1;
            } else if (prefix === '-') {
                yield { raw: body, old: oldLine, new: null, changed: true };
                oldLine += 1;
                restOld -= 1;
            } else {
                // Контекст: пробел, пустая строка (хосты режут хвостовой пробел) и неопознанный
                // префикс — всё, что не `+`/`-`, двигает обе стороны. Так же считает UI.
                yield { raw: body, old: oldLine, new: newLine, changed: false };
                oldLine += 1;
                newLine += 1;
                restOld -= 1;
                restNew -= 1;
            }
        }
    }
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

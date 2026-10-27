import type { FileContent, FileDiff } from '@sherpa/protocol';

import { contextLineAt } from './content.js';

/**
 * Полный текст файла по обе стороны диффа — топливо «Expand context» (`docs/spec.md`).
 *
 * Хранить полные файлы в репозитории незачем: строки ханков берутся из патча, а всё, что
 * патч не показал, достраивается генератором из номера строки (`contextLineAt`). Отсюда два
 * инварианта, на которых стоит UI: нумерация сходится с патчем (контекстная строка ханка
 * лежит в тексте ровно на своём номере), а неизменённые куски совпадают в обеих версиях —
 * старая сторона генерируется по номеру строки новой (см. `deltaAt`).
 */

const HUNK_HEADER_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** Сколько неизменённых строк фикстура дописывает за последним ханком: файл не кончается на нём. */
function tailLength(path: string): number {
    let hash = 0x811c9dc5;
    for (let i = 0; i < path.length; i += 1) {
        hash ^= path.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return 8 + (hash % 25);
}

interface HunkBounds {
    oldStart: number;
    oldEnd: number;
    newStart: number;
    newEnd: number;
}

interface ParsedPatch {
    /** Номер строки → текст, отдельно для каждой стороны. */
    old: Map<number, string>;
    new: Map<number, string>;
    hunks: HunkBounds[];
}

function parsePatch(patch: string): ParsedPatch {
    const parsed: ParsedPatch = { old: new Map(), new: new Map(), hunks: [] };
    const lines = patch.split('\n');
    let hunk: HunkBounds | null = null;
    let oldLine = 0;
    let newLine = 0;

    for (const raw of lines) {
        const header = HUNK_HEADER_RE.exec(raw);
        if (header !== null) {
            oldLine = Number(header[1]);
            newLine = Number(header[3]);
            hunk = { oldStart: oldLine, oldEnd: oldLine, newStart: newLine, newEnd: newLine };
            parsed.hunks.push(hunk);
            continue;
        }
        if (hunk === null) {
            continue;
        }

        const prefix = raw.slice(0, 1);
        const text = raw.slice(1);
        if (prefix === '+') {
            parsed.new.set(newLine, text);
            newLine += 1;
        } else if (prefix === '-') {
            parsed.old.set(oldLine, text);
            oldLine += 1;
        } else if (prefix === ' ') {
            parsed.old.set(oldLine, text);
            parsed.new.set(newLine, text);
            oldLine += 1;
            newLine += 1;
        } else {
            // Хвост шапки следующего файла в патче фикстуры невозможен (патч пер-файловый),
            // а пустая строка в конце — не строка ханка.
            continue;
        }
        hunk.oldEnd = oldLine;
        hunk.newEnd = newLine;
    }
    return parsed;
}

/**
 * Сдвиг нумерации новой стороны относительно старой на строке `oldLine`: до первого ханка — его
 * собственный сдвиг, дальше — накопленный ханками слева. По нему старая сторона берёт текст
 * неизменённой строки там же, где его берёт новая.
 */
function deltaAt(hunks: readonly HunkBounds[], oldLine: number): number {
    const first = hunks[0];
    if (first === undefined) {
        return 0;
    }
    let delta = first.newStart - first.oldStart;
    for (const hunk of hunks) {
        if (hunk.oldEnd <= oldLine) {
            delta = hunk.newEnd - hunk.oldEnd;
        }
    }
    return delta;
}

function build(known: ReadonlyMap<number, string>, total: number, path: string, delta: (line: number) => number): string {
    const lines: string[] = [];
    for (let line = 1; line <= total; line += 1) {
        lines.push(known.get(line) ?? contextLineAt(path, line + delta(line)));
    }
    return lines.join('\n');
}

function lastKey(map: ReadonlyMap<number, string>): number {
    let max = 0;
    for (const key of map.keys()) {
        max = Math.max(max, key);
    }
    return max;
}

/**
 * Текст файла по обе стороны; `null` — содержимого нет (binary). Добавленный и удалённый файл
 * лежат в патче целиком, поэтому у них ничего не достраивается: отсутствующая сторона — `null`,
 * присутствующая — ровно строки патча.
 */
export function fileContentOf(file: FileDiff): FileContent | null {
    if (file.binary) {
        return null;
    }

    const patch = file.patch === null ? null : parsePatch(file.patch);
    if (file.changeType === 'add') {
        const newText = patch === null ? '' : build(patch.new, lastKey(patch.new), file.path, () => 0);
        return { oldText: null, newText };
    }
    if (file.changeType === 'delete') {
        const oldText = patch === null ? '' : build(patch.old, lastKey(patch.old), file.path, () => 0);
        return { oldText, newText: null };
    }

    // Правка (в том числе одна лишь смена режима): файл длиннее патча — за последним ханком
    // идёт неизменённый хвост, а до первого — неизменённое начало.
    const newTotal = (patch === null ? 0 : lastKey(patch.new)) + tailLength(file.path);
    const finalDelta = patch === null ? 0 : deltaAt(patch.hunks, Number.MAX_SAFE_INTEGER);
    const oldTotal = newTotal - finalDelta;

    return {
        oldText: build(patch?.old ?? new Map(), oldTotal, file.path, (line) =>
            patch === null ? 0 : deltaAt(patch.hunks, line),
        ),
        newText: build(patch?.new ?? new Map(), newTotal, file.path, () => 0),
    };
}

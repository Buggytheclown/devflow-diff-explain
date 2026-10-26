import type { DiffLine, SyntaxKind } from '../diff/model.js';

/**
 * Разбор строки диффа на куски для рендера: подсветка синтаксиса, word-level подсветка пары
 * (docs/design/SPEC-elements.md §2.14), табы четырьмя пробелами и блок хвостовых пробелов у добавленных строк.
 *
 * Табы разворачиваются внутри куска, а не в исходном тексте: иначе смещения, посчитанные
 * парсером по сырой строке, разъехались бы с тем, что видно на экране.
 */

/** Выше этого длина строки перестаёт стоить разметки: подсветка пропускается, текст не режется. */
const MARKUP_LIMIT = 4000;

const TAB = '    ';

export interface LineSegment {
    readonly text: string;
    /** null — категории у куска нет: обычный код. */
    readonly kind: SyntaxKind | null;
    /** Кусок попал в word-level подсветку изменённой пары. */
    readonly word: boolean;
    /** Хвостовые пробелы добавленной строки — их видно блоком (docs/design/SPEC-elements.md §2.14). */
    readonly trailing: boolean;
}

function expandTabs(text: string): string {
    return text.includes('\t') ? text.replaceAll('\t', TAB) : text;
}

/** В строке есть таб: карточка вешает `title`, потому что на экране он выглядит пробелами. */
export function hasTabs(line: DiffLine): boolean {
    return line.text.includes('\t');
}

/** Длина хвостовых пробелов, которые надо показать блоком; 0 — показывать нечего. */
function trailingLength(line: DiffLine): number {
    if (line.kind !== 'add' || line.text.trim() === '') {
        return 0;
    }
    return line.text.length - line.text.trimEnd().length;
}

export function lineSegments(line: DiffLine): LineSegment[] {
    const text = line.text;
    if (text.length === 0) {
        return [];
    }

    const trailing = trailingLength(line);
    const body = text.length - trailing;

    if (text.length > MARKUP_LIMIT) {
        return segmentsOf([
            { text: text.slice(0, body), kind: null, word: false, trailing: false },
            ...(trailing > 0 ? [{ text: text.slice(body), kind: null, word: false, trailing: true }] : []),
        ]);
    }

    const kinds = new Array<SyntaxKind | null>(body).fill(null);
    for (const token of line.tokens ?? []) {
        for (let i = Math.max(token.from, 0); i < Math.min(token.to, body); i += 1) {
            kinds[i] = token.kind;
        }
    }

    const words = new Array<boolean>(body).fill(false);
    for (const range of line.words ?? []) {
        for (let i = Math.max(range.from, 0); i < Math.min(range.to, body); i += 1) {
            words[i] = true;
        }
    }

    const segments: LineSegment[] = [];
    let start = 0;
    for (let i = 1; i <= body; i += 1) {
        if (i < body && kinds[i] === kinds[start] && words[i] === words[start]) {
            continue;
        }
        segments.push({
            text: text.slice(start, i),
            kind: kinds[start] ?? null,
            word: words[start] ?? false,
            trailing: false,
        });
        start = i;
    }
    if (trailing > 0) {
        segments.push({ text: text.slice(body), kind: null, word: false, trailing: true });
    }
    return segmentsOf(segments);
}

function segmentsOf(segments: readonly LineSegment[]): LineSegment[] {
    return segments
        .filter((segment) => segment.text.length > 0)
        .map((segment) => ({ ...segment, text: expandTabs(segment.text) }));
}

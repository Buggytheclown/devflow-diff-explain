import type { CharRange } from './model.js';

/**
 * Word-level подсветка изменённых пар (docs/design/SPEC-elements.md §2.14). Пары спариваются снаружи (парсер ханка),
 * здесь — только дифф двух строк по токенам: слова, пробельные пачки, одиночная пунктуация.
 *
 * Своя LCS вместо библиотеки: алгоритм на две строки — это тридцать строк кода,
 * а зависимость в UI мы не заводим.
 */

/** Длиннее — не подсвечиваем: O(n·m) на минифицированной строке съест воркер. */
const MAX_LINE_LENGTH = 1000;

/** Страховка от квадрата на строке из одной пунктуации (символ = токен). */
const MAX_MATRIX_CELLS = 250_000;

/** Ниже этого сходства пара «изменена целиком»: подсветка каждого второго слова — шум. */
const MIN_SIMILARITY = 0.3;

export interface WordDiff {
    old: CharRange[];
    new: CharRange[];
}

interface Token extends CharRange {
    text: string;
}

/** Слово, пачка пробелов или одиночный символ пунктуации. */
const TOKEN_RE = /[\p{L}\p{N}_$]+|\s+|[^\s]/gu;

/**
 * Диапазоны изменённых кусков в паре строк. `null` — подсвечивать нечего или не стоит:
 * строки совпали, слишком длинные или разошлись слишком сильно.
 */
export function diffWords(oldText: string, newText: string): WordDiff | null {
    if (oldText === newText) {
        return null;
    }
    if (oldText.length > MAX_LINE_LENGTH || newText.length > MAX_LINE_LENGTH) {
        return null;
    }

    const oldTokens = tokenize(oldText);
    const newTokens = tokenize(newText);
    if (oldTokens.length * newTokens.length > MAX_MATRIX_CELLS) {
        return null;
    }

    const matched = longestCommonSubsequence(oldTokens, newTokens);
    if (similarity(oldTokens, newTokens, matched) < MIN_SIMILARITY) {
        return null;
    }

    const oldRanges = unmatchedRanges(oldTokens, matched.old);
    const newRanges = unmatchedRanges(newTokens, matched.new);
    if (oldRanges.length === 0 && newRanges.length === 0) {
        return null;
    }
    return { old: oldRanges, new: newRanges };
}

function tokenize(text: string): Token[] {
    const tokens: Token[] = [];
    for (const match of text.matchAll(TOKEN_RE)) {
        const from = match.index;
        tokens.push({ from, to: from + match[0].length, text: match[0] });
    }
    return tokens;
}

interface Matched {
    /** Индексы совпавших токенов в каждой строке. */
    old: Set<number>;
    new: Set<number>;
}

/**
 * Доля общего в паре строк. Пробелы из счёта выкинуты: отступ совпадает почти всегда,
 * и без этого две строки без единого общего слова выглядят похожими на 40%.
 */
function similarity(oldTokens: readonly Token[], newTokens: readonly Token[], matched: Matched): number {
    const meaningful = (tokens: readonly Token[]): number => tokens.filter((token) => !isBlank(token)).length;
    const common = [...matched.old].filter((index) => {
        const token = oldTokens[index];
        return token !== undefined && !isBlank(token);
    }).length;

    const total = meaningful(oldTokens) + meaningful(newTokens);
    return total === 0 ? 0 : (2 * common) / total;
}

function isBlank(token: Token): boolean {
    return token.text.trim().length === 0;
}

/** Классическая LCS по таблице длин с обратным проходом: нужны сами индексы совпавших токенов. */
function longestCommonSubsequence(a: readonly Token[], b: readonly Token[]): Matched {
    const width = b.length + 1;
    const table = new Int32Array((a.length + 1) * width);

    for (let i = a.length - 1; i >= 0; i -= 1) {
        for (let j = b.length - 1; j >= 0; j -= 1) {
            const cell = i * width + j;
            table[cell] =
                a[i]?.text === b[j]?.text
                    ? (table[cell + width + 1] ?? 0) + 1
                    : Math.max(table[cell + width] ?? 0, table[cell + 1] ?? 0);
        }
    }

    const oldMatched = new Set<number>();
    const newMatched = new Set<number>();
    let i = 0;
    let j = 0;
    while (i < a.length && j < b.length) {
        if (a[i]?.text === b[j]?.text) {
            oldMatched.add(i);
            newMatched.add(j);
            i += 1;
            j += 1;
        } else if ((table[(i + 1) * width + j] ?? 0) >= (table[i * width + j + 1] ?? 0)) {
            i += 1;
        } else {
            j += 1;
        }
    }

    return { old: oldMatched, new: newMatched };
}

/** Несовпавшие токены, слитые в непрерывные диапазоны. */
function unmatchedRanges(tokens: readonly Token[], matched: ReadonlySet<number>): CharRange[] {
    const ranges: CharRange[] = [];
    let open: CharRange | null = null;

    for (const [index, token] of tokens.entries()) {
        if (matched.has(index)) {
            open = null;
            continue;
        }
        if (open !== null && open.to === token.from) {
            open.to = token.to;
            continue;
        }
        open = { from: token.from, to: token.to };
        ranges.push(open);
    }
    return ranges;
}

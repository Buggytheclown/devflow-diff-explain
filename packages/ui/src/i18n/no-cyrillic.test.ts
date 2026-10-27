import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * Весь UI говорит словарём: кириллицы в коде `packages/ui/src` быть не должно — ни в подписях,
 * ни в `title`, ни в сообщениях. Этот тест и есть проверка полноты перевода.
 *
 * Вне проверки: комментарии (документация для нас, а не интерфейс для ревьюера), сам русский
 * словарь `i18n/ru.ts`, тесты и `dev/**` — галерея живёт на фикстурах и подписях состояний,
 * ревьюер её не видит.
 */
function skipped(file: string): boolean {
    return file.startsWith('dev/') || file.includes('.test.') || file === 'i18n/ru.ts';
}

const CYRILLIC = /[Ѐ-ӿ]/u;
const SRC = fileURLToPath(new URL('..', import.meta.url));

describe('перевод UI', () => {
    it('не содержит кириллицы вне комментариев', () => {
        const files = sources(SRC).filter((file) => !skipped(file));
        // Страховка от молчаливого «ничего не нашли»: сломанный обход дал бы зелёный тест впустую.
        expect(files).toEqual(expect.arrayContaining(['main.tsx', 'story/app.tsx', 'diff/parse.ts']));

        const found: string[] = [];
        for (const file of files) {
            const source = stripComments(readFileSync(SRC + file, 'utf8'));
            source.split('\n').forEach((line, index) => {
                if (CYRILLIC.test(line)) {
                    found.push(`${file}:${String(index + 1)}: ${line.trim()}`);
                }
            });
        }
        expect(found, 'кириллица в коде — текст должен быть в словаре').toEqual([]);
    });

    it('вырезает комментарии, но не строки и не URL в них', () => {
        const source = [
            '// комментарий',
            "/* блок */ const a = 'текст';",
            "const url = 'http://host/#t=1'; // хвост",
            '{/* JSX-комментарий */}',
        ].join('\n');

        const stripped = stripComments(source).split('\n');
        expect(stripped[0]?.trim()).toBe('');
        expect(stripped[1]).toContain("'текст'");
        expect(stripped[2]).toContain("'http://host/#t=1'");
        expect(stripped[3]?.trim()).toMatch(/^\{ +\}$/u);
    });

    it('не принимает кавычку внутри регулярного литерала за начало строки', () => {
        // Без разбора регэкспа кавычка из класса символов открыла бы «строку» до конца файла,
        // и следующий комментарий с кириллицей проехал бы в проверку.
        const source = ['const re = /["\'`]+/u;', '// комментарий', "const b = 'текст';"].join('\n');

        const stripped = stripComments(source).split('\n');
        expect(stripped[1]?.trim()).toBe('');
        expect(stripped[2]).toContain("'текст'");
    });
});

/** Все `.ts`/`.tsx` каталога, путями относительно `src`. */
function sources(root: string, rel = ''): string[] {
    const found: string[] = [];
    for (const entry of readdirSync(`${root}${rel}`)) {
        const next = `${rel}${entry}`;
        if (statSync(`${root}${next}`).isDirectory()) {
            found.push(...sources(root, `${next}/`));
        } else if (/\.tsx?$/u.test(entry)) {
            found.push(next);
        }
    }
    return found;
}

/**
 * Заменяет содержимое комментариев пробелами, сохраняя переводы строк: номера строк в отчёте
 * остаются настоящими. Строковые литералы (в том числе шаблонные) проверку проходят как есть —
 * `//` внутри URL комментарием не считается. Регулярные литералы пропускаются целиком: кавычка
 * в классе символов иначе открыла бы строку и сбила разбор всего файла.
 */
function stripComments(source: string): string {
    const out: string[] = [];
    let index = 0;
    let quote: string | null = null;
    // Последний значимый символ перед `/`: по нему регулярный литерал отличается от деления.
    let significant = '';

    const blank = (text: string): string => text.replaceAll(/[^\n]/gu, ' ');

    while (index < source.length) {
        const char = source[index] ?? '';
        if (quote !== null) {
            out.push(char);
            if (char === '\\') {
                out.push(source[index + 1] ?? '');
                index += 2;
                continue;
            }
            if (char === quote) {
                quote = null;
                significant = char;
            }
            index += 1;
            continue;
        }
        if (char === "'" || char === '"' || char === '`') {
            quote = char;
            out.push(char);
            index += 1;
            continue;
        }
        if (char === '/' && source[index + 1] === '/') {
            const end = source.indexOf('\n', index);
            const stop = end === -1 ? source.length : end;
            out.push(blank(source.slice(index, stop)));
            index = stop;
            continue;
        }
        if (char === '/' && source[index + 1] === '*') {
            const end = source.indexOf('*/', index + 2);
            const stop = end === -1 ? source.length : end + 2;
            out.push(blank(source.slice(index, stop)));
            index = stop;
            continue;
        }
        if (char === '/') {
            const end = regexEnd(source, index, significant);
            if (end !== -1) {
                out.push(source.slice(index, end));
                index = end;
                significant = '/';
                continue;
            }
        }
        out.push(char);
        if (!/\s/u.test(char)) {
            significant = char;
        }
        index += 1;
    }
    return out.join('');
}

/**
 * Из «разрешающих» символов намеренно выкинуты `<`, `>` и `}`: с них начинаются `</div>` и
 * `{...} />`, а регулярное выражение после них не встречается.
 */
const REGEX_ALLOWED_BEFORE = new Set([
    '(',
    ',',
    '=',
    ':',
    '[',
    '!',
    '&',
    '|',
    '?',
    '+',
    '-',
    '*',
    '%',
    '^',
    '~',
    ';',
    '{',
]);

/** Конец регулярного литерала, начинающегося в `start`, или `-1`, если это деление или JSX. */
function regexEnd(source: string, start: number, significant: string): number {
    if (significant !== '' && !REGEX_ALLOWED_BEFORE.has(significant)) {
        return -1;
    }
    let index = start + 1;
    let inClass = false;
    while (index < source.length) {
        const char = source[index];
        // Регулярный литерал не переносится: незакрытый `/` — это деление.
        if (char === '\n') {
            return -1;
        }
        if (char === '\\') {
            index += 2;
            continue;
        }
        if (char === '[') {
            inClass = true;
        } else if (char === ']') {
            inClass = false;
        } else if (char === '/' && !inClass) {
            index += 1;
            while (/[a-z]/u.test(source[index] ?? '')) {
                index += 1;
            }
            return index;
        }
        index += 1;
    }
    return -1;
}

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * Правило системы: значения живут только в `tokens.css`, компонентные стили ходят через
 * переменные. Проверяется механически — иначе второй набор цветов заводится незаметно
 * и расходится с хендоффом.
 */

const SRC = fileURLToPath(new URL('..', import.meta.url));
const TOKENS = path.join(SRC, 'styles', 'tokens.css');

function cssFiles(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            return cssFiles(full);
        }
        return entry.isFile() && entry.name.endsWith('.css') && full !== TOKENS ? [full] : [];
    });
}

const FILES = cssFiles(SRC);
const DECLARED = new Set(
    [...readFileSync(TOKENS, 'utf8').matchAll(/^\s*(--[a-z0-9-]+)\s*:/gm)].map((match) => match[1]),
);

describe('компонентные стили', () => {
    it('файлы стилей вообще нашлись', () => {
        expect(FILES.length).toBeGreaterThan(0);
    });

    for (const file of FILES) {
        const name = path.relative(SRC, file);
        const css = readFileSync(file, 'utf8');

        it(`${name}: выбор палитры остаётся в tokens.css`, () => {
            const selectors = css.replace(/\/\*[\s\S]*?\*\//g, '').match(/\[data-theme\s*(?:=|[~|^$*]=)[^\]]*\]/g);
            expect(selectors ?? []).toEqual([]);
        });

        it(`${name}: цвета только через токены`, () => {
            const literals = [
                ...css.matchAll(/#[0-9a-fA-F]{3,8}\b/g),
                ...css.matchAll(/\brgba?\(/g),
                ...css.matchAll(/\bhsla?\(/g),
            ].map((match) => match[0]);

            expect(literals).toEqual([]);
        });

        // Размер текста — целиком в rem через токены (docs/design/theme.md, «Типографика»):
        // px здесь снова отвязал бы интерфейс от системного размера шрифта и от режима L.
        it(`${name}: размеры текста только через токены`, () => {
            const sizes = [...css.matchAll(/font-size:\s*([^;]+);/g)].map((match) => match[1]?.trim());

            expect(
                sizes.filter((size) => size === undefined || !(size.startsWith('var(') || size === 'inherit')),
            ).toEqual([]);
        });

        it(`${name}: используются только объявленные токены`, () => {
            const used = [...css.matchAll(/var\(\s*(--[a-z0-9-]+)/g)].map((match) => match[1]);
            // Своя переменная файла — не второй набор значений, а одно место для константы
            // раскладки этой вью (её цвет всё равно не спрятать: литералы запрещены выше).
            const local = new Set(
                [...css.matchAll(/^\s*(--[a-z0-9-]+)\s*:/gm)].map((match) => match[1]),
            );

            expect(
                used.filter((token) => token !== undefined && !DECLARED.has(token) && !local.has(token)),
            ).toEqual([]);
        });
    }
});

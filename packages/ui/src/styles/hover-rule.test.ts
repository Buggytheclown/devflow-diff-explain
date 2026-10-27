import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * Одно правило ховера (docs/design/theme.md): наведение меняет только
 * поверхность. Проверяется механически — компонентный стиль, который красит на ховере текст
 * или рамку, заводит второй набор состояний мимо `controls.css` и расходится с таблицей §5.
 *
 * Исключений из правила два, оба из спеки: ссылки (поверхности нет, цвет идёт по лестнице
 * акцента) и корзина (иконка краснеет вместе с фоном). Оба живут в `controls.css`, поэтому
 * сам файл состояний и базовый слой тест не читает.
 */

const SRC = fileURLToPath(new URL('..', import.meta.url));
const EXEMPT = new Set([path.join(SRC, 'styles', 'controls.css'), path.join(SRC, 'styles', 'base.css')]);

function cssFiles(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            return cssFiles(full);
        }
        return entry.isFile() && entry.name.endsWith('.css') && !EXEMPT.has(full) ? [full] : [];
    });
}

/** Селектор и свойства каждого блока правил файла; вложенных блоков в стилях нет. */
function rules(css: string): { selector: string; body: string }[] {
    return [...css.matchAll(/([^{}]*)\{([^{}]*)\}/g)].map((match) => ({
        selector: (match[1] ?? '').replace(/\/\*[\s\S]*?\*\//g, '').trim().replace(/\s+/g, ' '),
        body: match[2] ?? '',
    }));
}

describe('правило ховера §5', () => {
    for (const file of cssFiles(SRC)) {
        const name = path.relative(SRC, file);

        it(`${name}: ховер меняет только поверхность`, () => {
            const offenders = rules(readFileSync(file, 'utf8'))
                .filter((rule) => rule.selector.includes(':hover'))
                .filter((rule) => /(?:^|;|\s)(?:color|border-color)\s*:/.test(rule.body))
                .map((rule) => rule.selector);

            expect(
                offenders,
                'ховер красит текст или рамку: цвет состояния живёт в styles/controls.css, ' +
                    'компонентный стиль держит только раскладку (SPEC-changes-2026-09-20.md §5)',
            ).toEqual([]);
        });
    }
});

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { Icon } from './icon.tsx';
import type { IconName } from './icon.tsx';

const SPRITE = readFileSync(fileURLToPath(new URL('./sprite.svg', import.meta.url)), 'utf8');
const ICONS_CSS = readFileSync(fileURLToPath(new URL('./icons.css', import.meta.url)), 'utf8');

const ICON_IDS = [
    'ic-search',
    'ic-chev-down',
    'ic-chev-right',
    'ic-thumb',
    'ic-pencil',
    'ic-check',
    'ic-cross',
    'ic-swap',
    'ic-arrow-up',
    'ic-arrow-down',
    'ic-updown',
    'ic-reply',
    'ic-bold',
    'ic-italic',
    'ic-link',
    'ic-code',
    'ic-codeblock',
    'ic-list',
    'ic-trash',
] as const;

describe('SVG-иконки', () => {
    it('спрайт содержит полный набор уникальных непустых символов с общей геометрией', () => {
        const entries = symbols(SPRITE);
        expect(entries.map(([id]) => id)).toEqual([...ICON_IDS, 'ic-sliders', 'ic-dot']);
        for (const [, markup] of entries) {
            expect(markup).toContain('viewBox="0 0 16 16"');
            expect(markup).toMatch(/<(?:path|circle|rect|line|polyline)\b/u);
            expect(markup).toContain('currentColor');
        }
    });

    it('каждая иконка ссылается на существующий символ встроенного спрайта', () => {
        for (const [id] of symbols(SPRITE)) {
            const html = renderToStaticMarkup(<Icon name={id.slice(3) as IconName} size={14} />);
            expect(html).toContain(`<use href="#${id}"></use>`);
        }
    });

    it('svg несёт собственный viewBox, точный размер и скрыт от дерева доступности', () => {
        const html = renderToStaticMarkup(<Icon name="swap" size={14} />);

        expect(html).toContain('width="14" height="14" viewBox="0 0 16 16"');
        expect(html).toContain('aria-hidden="true"');
        expect(html).toContain('focusable="false"');
        expect(html).toContain('<use href="#ic-swap"></use>');
    });

    it('flex-контейнер не может сжать svg', () => {
        expect(ICONS_CSS).toMatch(/\.icon\s*\{[^}]*display:\s*block;[^}]*flex:\s*none;/su);
    });
});

/** Пары «id → разметка symbol» в порядке файла. */
function symbols(sprite: string): [string, string][] {
    return [...sprite.matchAll(/<symbol id="([^"]+)"[\s\S]*?<\/symbol>/gu)].map((match) => [match[1] ?? '', match[0]]);
}

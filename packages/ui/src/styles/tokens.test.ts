import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * Механическая сверка общих дизайн-токенов и действующих таблиц оформления.
 *
 * `EXPECTED` фиксирует контракт геометрии, шрифтов, disabled и движения общих компонентов.
 * Цвета четырёх палитр и две шрифтовые шкалы сверяются с docs/design/theme.md.
 * Раскладка экранов задаётся CSS компонентов; наличие общего токена не добавляет экран.
 */

/** Нецветовой токен → значение контракта общих компонентов. */
const EXPECTED: Record<string, string> = {
    // docs/design/theme.md: disabled opacity .45.
    '--disabled-opacity': '.45',

    // Type — IBM Plex Sans 400/450/500/600 for UI, IBM Plex Mono 400/500 for code, paths, numbers,
    // commits, keys and all machine data. Сама шкала живёт в docs/design/theme.md, раздел
    // «Типографика»: размеры в rem, пол 11px. Значения ниже сверяются с той таблицей отдельным
    // тестом, поэтому пересказывать её словами здесь незачем.
    '--font-sans': "'IBM Plex Sans',system-ui,sans-serif",
    '--font-mono': "'IBM Plex Mono',ui-monospace,monospace",
    '--font-size-pr-title-overview': '1.5rem',
    '--font-size-pr-title': '1.375rem',
    '--font-size-screen-title': '1.1875rem',
    '--font-size-stop-title-high': '1.0625rem',
    '--font-size-stop-title': '0.9688rem',
    '--font-size-section-title': '0.9688rem',
    '--font-size-input': '0.875rem',
    '--font-size-body': '0.8438rem',
    '--font-size-ui': '0.8125rem',
    '--font-size-secondary': '0.7813rem',
    '--font-size-control': '0.75rem',
    '--font-size-meta': '0.7188rem',
    '--font-size-gutter': '0.6875rem',
    '--font-size-badge': '0.6875rem',
    '--font-size-scope': '0.6875rem',
    '--font-size-tag': '0.6875rem',
    '--font-size-stop-mark': '0.625rem',
    '--font-size-avatar-glyph': '0.5625rem',
    '--font-size-close-glyph': '1.125rem',
    '--font-size-code': '0.75rem',
    '--line-height-body': '1.62',
    // Плотность строк кода в px не зависит от размера текста.
    '--line-height-code': '20px',

    // Radius — 2–3px (rules, tier marks) · 4–5px (badges, small chips) · 6px (buttons, rows) ·
    // 7px (inputs, chips, primary buttons) · 8–9px (cards, popovers) · 10–12px (panels, dialogs).
    // Диапазоны разложены на конкретные роли по размерам из docs/design/theme.md§5 и §14.
    '--radius-rule': '2px',
    '--radius-mark': '3px',
    '--radius-key': '4px',
    '--radius-badge': '5px',
    '--radius-button': '6px',
    '--radius-input': '7px',
    '--radius-popover': '8px',
    '--radius-card': '9px',
    // docs/design/theme.md: плавающая панель использует отдельный радиус 11px.
    '--radius-floating': '11px',
    '--radius-panel': '12px',

    // Spacing — page gutter `clamp(30px, 2.4vw, 60px)` · column gap `clamp(40px, 3vw, 72px)` ·
    // 22px card gap · 14px control gap · 8–10px inner gap.
    '--space-page': 'clamp(30px, 2.4vw, 60px)',
    '--space-column': 'clamp(40px, 3vw, 72px)',
    '--space-card': '22px',
    '--space-control': '14px',
    '--space-inner': '10px',
    '--space-inner-tight': '8px',
    // Резерв под закреплённую панель общих компонентов.
    '--space-bar-reserve': '180px',

    // Общие ширины панелей и предельные ширины диффа; раскладка приложения задаётся отдельно.
    '--width-agent-panel': 'clamp(392px, 26vw, 560px)',
    '--width-file-tree': 'clamp(320px, 22vw, 560px)',
    '--diff-max': '1280px',

    // Motion — spinner `spin .8s linear infinite` · skeleton/streaming `shimmer 1.6s ease-in-out
    // infinite` · caret `caret 1s step-end infinite` · jump scroll ~320ms ease-in-out cubic ·
    // jump flash ~900ms. Плюс docs/design/theme.md: hover 90ms ease-out.
    // «ease-in-out cubic» записан кривой easeInOutCubic — в CSS такого ключевого слова нет.
    '--motion-hover': '90ms',
    '--motion-hover-ease': 'ease-out',
    '--motion-spin': '.8s',
    '--motion-shimmer': '1.6s',
    '--motion-caret': '1s',
    '--motion-jump': '320ms',
    '--motion-jump-ease': 'cubic-bezier(.65,0,.35,1)',
    '--motion-flash': '900ms',
};

/** Отличия геометрии и шрифтов самостоятельной темы Arcanum (docs/design/theme.md). */
const ARCANUM_EXPECTED: Record<string, string> = {
    ...EXPECTED,
    '--font-sans': "'YS Text', 'Helvetica Neue', Arial, Helvetica, sans-serif",
    '--font-mono': "Menlo, Monaco, Consolas, 'Liberation Mono', 'Ubuntu Mono', 'DejaVu Sans Mono', 'Courier New', Courier, monospace",
    '--font-size-body': '0.875rem',
    '--font-size-ui': '0.875rem',
    '--font-size-secondary': '0.8125rem',
    '--font-size-control': '0.8125rem',
    '--font-size-meta': '0.8125rem',
    '--font-size-gutter': '0.75rem',
    '--line-height-body': '1.5',
    '--line-height-code': '17px',
    '--radius-badge': '3px',
    '--radius-button': '5px',
    '--radius-input': '5px',
    '--radius-card': '5px',
    '--radius-floating': '8px',
    '--radius-panel': '8px',
    '--space-page': '20px',
    '--space-column': '32px',
    '--space-card': '12px',
    '--space-control': '12px',
    '--width-file-tree': 'clamp(280px, 22vw, 420px)',
};

const THEMES = ['dark', 'light', 'arcanum-dark', 'arcanum-light'] as const;
const ARCANUM_THEMES = ['arcanum-dark', 'arcanum-light'] as const;
type Theme = typeof THEMES[number];

const TOKENS_CSS = readFileSync(fileURLToPath(new URL('./tokens.css', import.meta.url)), 'utf8');
const THEME_MD = readFileSync(fileURLToPath(new URL('../../../../docs/design/theme.md', import.meta.url)), 'utf8');

/**
 * Различия записи, которые CSS считает одним значением: пробелы после запятых, ведущий ноль
 * в дробях и регистр. Хендофф пишет `rgba(127,140,255,.13)`, форматтер — `rgba(127, 140, 255, 0.13)`;
 * сверять надо цвет, а не пробелы.
 */
function normalize(value: string): string {
    return value
        .toLowerCase()
        .replace(/\s*,\s*/g, ',')
        .replace(/\s+/g, ' ')
        .replace(/(^|[\s,(])0\.(\d)/g, '$1.$2')
        .trim();
}

/** Объявления `--name: value;` из базового блока. */
function parseRootTokens(css: string): Map<string, string> {
    const root = /:root(?:,\s*\[data-theme\])?\s*\{([\s\S]*?)\n\}/.exec(css)?.[1];
    if (root === undefined) {
        throw new Error('в tokens.css не найден блок :root');
    }

    const withoutComments = root.replace(/\/\*[\s\S]*?\*\//g, '');
    const tokens = new Map<string, string>();
    for (const [, name, value] of withoutComments.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) {
        if (name !== undefined && value !== undefined) {
            tokens.set(name, normalize(value));
        }
    }
    return tokens;
}

/** Таблица четырёх цветовых палитр из docs/design/theme.md. */
function parseThemeDoc(markdown: string): Record<Theme, Map<string, string>> {
    const result: Record<Theme, Map<string, string>> = {
        dark: new Map(), light: new Map(), 'arcanum-dark': new Map(), 'arcanum-light': new Map(),
    };
    for (const [, name, darkValue, lightValue, arcanumDarkValue, arcanumLightValue] of markdown.matchAll(
        /^\| `(--[a-z0-9-]+)` \| `([^`]+)` \| `([^`]+)` \| `([^`]+)` \| `([^`]+)` \|$/gm,
    )) {
        if (name === undefined || darkValue === undefined || lightValue === undefined
            || arcanumDarkValue === undefined || arcanumLightValue === undefined) {
            continue;
        }
        result.dark.set(name, normalize(darkValue));
        result.light.set(name, normalize(lightValue));
        result['arcanum-dark'].set(name, normalize(arcanumDarkValue));
        result['arcanum-light'].set(name, normalize(arcanumLightValue));
    }
    if (result.dark.size === 0) {
        throw new Error('в theme.md не найдена таблица цветовых токенов');
    }
    return result;
}

/** Только собственный блок выбранной темы, без соседних селекторов и наследуемых значений. */
function themeCss(theme: 'light' | 'arcanum-dark' | 'arcanum-light'): string {
    const marker = `:root[data-theme='${theme}']`;
    const start = TOKENS_CSS.indexOf(marker);
    if (start < 0) {
        throw new Error(`в tokens.css не найден блок ${theme}`);
    }
    const after = TOKENS_CSS.slice(start + marker.length);
    const body = after.slice(after.indexOf('{') + 1, after.indexOf('}'));
    return `:root {${body}\n}`;
}

/**
 * Таблица «токен | rem | px при M | px при L | где» из раздела «Типографика» docs/design/theme.md.
 * Колонки с px — производные от rem, тест их пересчитывает.
 */
function parseTypographyDoc(markdown: string): Map<string, { rem: string; m: string; l: string }> {
    const scale = new Map<string, { rem: string; m: string; l: string }>();
    for (const [, name, rem, m, l] of markdown.matchAll(
        /^\| `(--font-size-[a-z0-9-]+)` \| `([\d.]+rem)` \| ([\d.]+) \| ([\d.]+) \| [^|]+\|$/gm,
    )) {
        if (name !== undefined && rem !== undefined && m !== undefined && l !== undefined) {
            scale.set(name, { rem, m, l });
        }
    }
    if (scale.size === 0) {
        throw new Error('в theme.md не найдена таблица шрифтовой шкалы');
    }
    return scale;
}

/** rem → px на базе `base`, округление до десятых и без хвостового нуля — как в таблице. */
function remToPx(rem: string, base: number): string {
    return String(Math.round(Number.parseFloat(rem) * base * 10) / 10);
}

const darkPalette = parseRootTokens(TOKENS_CSS);
const lightCss = themeCss('light');
const lightPalette = parseRootTokens(lightCss);
const arcanumCss = themeCss('arcanum-dark');
const arcanumPalette = parseRootTokens(arcanumCss);
const arcanumLightCss = themeCss('arcanum-light');
const arcanumLightPalette = parseRootTokens(arcanumLightCss);
const palettes: Record<Theme, Map<string, string>> = {
    dark: darkPalette, light: lightPalette, 'arcanum-dark': arcanumPalette, 'arcanum-light': arcanumLightPalette,
};
const documented = parseThemeDoc(THEME_MD);
const documentedScale = parseTypographyDoc(THEME_MD.split('## Типографика Arcanum')[0] ?? '');
const documentedArcanumScale = parseTypographyDoc(THEME_MD.split('## Типографика Arcanum')[1] ?? '');

describe('дизайн-токены', () => {
    it('в :root объявлены все общие и документированные токены', () => {
        expect([...darkPalette.keys()]).toEqual(
            expect.arrayContaining([...Object.keys(EXPECTED), ...documented.dark.keys()]),
        );
    });

    it('в нецветовом контракте нет цветов', () => {
        expect(Object.entries(EXPECTED).filter(([, value]) => /#|rgba?\(/.test(value))).toEqual([]);
    });

    for (const [name, expected] of Object.entries(EXPECTED)) {
        it(`${name} = ${expected}`, () => {
            expect(darkPalette.get(name)).toBe(normalize(expected));
        });
    }

    it('каждый токен объявлен один раз в каждой палитре', () => {
        for (const block of TOKENS_CSS.matchAll(/\{([^{}]*)\}/g)) {
            const declarations = [...(block[1] ?? '').matchAll(/^\s*(--[a-z0-9-]+)\s*:/gm)].map((match) => match[1]);
            expect(declarations).toHaveLength(new Set(declarations).size);
        }
    });
});

/**
 * Шрифтовая шкала: docs/design/theme.md Всё в rem от базы `html`, пол
 * 11px (0.6875rem), ниже пола — только декоративные глифы, у которых нет своего текста.
 */
describe('шрифтовая шкала', () => {
    const GLYPHS = new Set(['--font-size-avatar-glyph']);
    /**
     * Единственный текст ниже пола — метка остановки в строке дерева (§5, §6a): 10px в метке
     * 17×13 у левого края. Список закрытый: второе исключение обязано пройти через спеку.
     */
    const FLOOR_EXCEPTIONS = new Set(['--font-size-stop-mark']);
    const FLOOR_REM = 0.6875;

    it('в таблице theme.md перечислены ровно шрифтовые токены tokens.css', () => {
        const inCss = [...darkPalette.keys()].filter((name) => name.startsWith('--font-size-'));
        expect(inCss.sort()).toEqual([...documentedScale.keys()].sort());
    });

    for (const [name, row] of documentedScale) {
        it(`${name} = ${row.rem}`, () => {
            expect(darkPalette.get(name)).toBe(normalize(row.rem));
            expect(row.m).toBe(remToPx(row.rem, 16));
            expect(row.l).toBe(remToPx(row.rem, 18));
        });
    }

    it('ниже пола 11px только декоративные глифы и метка остановки', () => {
        const below = [...documentedScale]
            .filter(
                ([name, row]) =>
                    !GLYPHS.has(name) && !FLOOR_EXCEPTIONS.has(name) && Number.parseFloat(row.rem) < FLOOR_REM,
            )
            .map(([name]) => name);
        expect(below).toEqual([]);
    });

    it('исключение из пола ровно одно и это метка остановки', () => {
        expect([...FLOOR_EXCEPTIONS]).toEqual(['--font-size-stop-mark']);
        expect(documentedScale.get('--font-size-stop-mark')?.rem).toBe('0.625rem');
    });

    it('база шкалы и размер текста L заданы на html', () => {
        expect(TOKENS_CSS).toMatch(/html\s*\{\s*font-size:\s*100%;\s*\}/);
        expect(TOKENS_CSS).toMatch(/html\[data-textsize='l']\s*\{\s*font-size:\s*112\.5%;\s*\}/);
    });
});

describe('палитры тем', () => {
    it('светлая Arcanum использует белую основу, отдельный гаттер и общую типографику Arcanum', () => {
        const css = themeCss('arcanum-light');
        const values = parseRootTokens(css);
        expect(css).toContain('color-scheme: light;');
        expect([...values.keys()].sort()).toEqual([...darkPalette.keys()].sort());
        expect(values.get('--surface-app')).toBe('#ffffff');
        expect(values.get('--surface-card-header')).toBe('#f2f2f2');
        expect(values.get('--surface-diff-gap')).toBe('#f1f8ff');
        expect(values.get('--diff-add-gutter-bg')).toBe('#cbf5cb');
        expect(values.get('--diff-del-gutter-bg')).toBe('#fdd7d7');
        for (const [name, expected] of Object.entries(ARCANUM_EXPECTED)) {
            expect(values.get(name), name).toBe(normalize(expected));
        }
    });

    it('светлая палитра переключает color-scheme', () => {
        expect(lightCss).toContain('color-scheme: light;');
    });

    it('каждое поддерево темы начинает с исходных токенов, включая шрифты и геометрию', () => {
        expect(TOKENS_CSS).toMatch(/:root,\s*\[data-theme\]\s*\{/);
    });

    it('тёмная Arcanum сохраняет dark color-scheme', () => {
        expect(arcanumCss).toContain('color-scheme: dark;');
    });

    for (const theme of THEMES) {
        it(`${theme}: полный набор токенов сбрасывается на границе темы`, () => {
            expect([...palettes[theme].keys()].sort()).toEqual([...darkPalette.keys()].sort());
        });

        // В тёмной Шерпе серая лестница плоская: роль текста, равная обычной подписи, приглушения не даст.
        it(`${theme}: подпись прочитанного в дереве отличается от обычной подписи файла и каталога`, () => {
            const readColor = tokenValue(palettes[theme], '--tree-read-color');
            expect(readColor).not.toBe(tokenValue(palettes[theme], '--tree-label-color'));
            expect(readColor).not.toBe(tokenValue(palettes[theme], '--tree-dir-color'));
        });

        // Прочитанность перебивает оттенки foreign и generated, поэтому прочитанная строка не должна быть ярче их.
        it(`${theme}: подпись прочитанного в дереве не контрастнее оттенков foreign и generated`, () => {
            const tokens = palettes[theme];
            const panel = blend(
                parseColor(tokenValue(tokens, '--surface-panel')),
                parseColor(tokenValue(tokens, '--surface-app')).rgb,
            );
            const onPanel = (name: string): number => contrast(parseColor(tokenValue(tokens, name)).rgb, panel);
            const read = onPanel('--tree-read-color');
            expect(read).toBeLessThanOrEqual(onPanel('--text-muted-dim'));
            expect(read).toBeLessThanOrEqual(onPanel('--text-dim-strong'));
        });

        it(`${theme}: все цветовые значения совпадают с theme.md`, () => {
            const colors = new Map([...palettes[theme]].filter(([name]) => documented[theme].has(name)));
            expect(Object.fromEntries(colors)).toEqual(Object.fromEntries(documented[theme]));
        });
    }

    for (const theme of ARCANUM_THEMES) {
        for (const [name, expected] of Object.entries(ARCANUM_EXPECTED)) {
            it(`${theme}: ${name} = ${expected}`, () => {
                expect(palettes[theme].get(name)).toBe(normalize(expected));
            });
        }
    }

    it('в таблице типографики Arcanum перечислены ровно шрифтовые токены', () => {
        expect([...documentedArcanumScale.keys()].sort()).toEqual([...documentedScale.keys()].sort());
    });

    for (const theme of ARCANUM_THEMES) {
        for (const [name, row] of documentedArcanumScale) {
            it(`${theme}: шкала ${name} = ${row.rem}`, () => {
                expect(palettes[theme].get(name)).toBe(normalize(row.rem));
                expect(row.m).toBe(remToPx(row.rem, 16));
                expect(row.l).toBe(remToPx(row.rem, 18));
            });
        }
    }
});

/**
 * Пары «текст → подложка» для проверки контраста. `on` — слои подложки сверху вниз: под
 * полупрозрачной заливкой строки диффа контраст считается по результату наложения.
 *
 * `low` перечисляет темы, в которых дизайнерская пара не дотягивает до 4.5:1. Значения не
 * подгоняются под норму — они из `docs/design/theme.md` §2, решение о подъёме
 * за дизайном. Замеры (:1): тёмная — номера строк на карточке 4.03 и на схлопнутой строке 3.93,
 * гаттер удаления 4.12; светлая — номера строк 2.91 (на схлопнутой строке 2.62), знаки и гаттеры строк диффа 3.63 / 4.14 /
 * 4.06 / 4.46, счётчики в шапке карточки 3.69 / 4.22, галочка на зелёном hover 3.88, пункт плана
 * в очереди 4.17, янтарный текст на янтарной подложке 4.45, декоратор 4.18, чернила янтарной
 * кнопки 4.31, чип правки комментария 4.26, текст в подтверждении удаления 4.50, бейдж «новая»
 * 4.46, пункт плана в очереди на альтернативной подложке 4.17, отметка «сохранено» 3.69 на
 * карточке треда (4.37 в тёмной) и 3.82 в композере модалки, метка остановки в дереве 3.56.
 * Тёмная Arcanum имеет отдельный список исключений: только маркер удаления на строке (3.96)
 * и в шапке (3.55). Для светлой Arcanum исключений нет; прежние на неё не переносятся.
 */
interface TextPair {
    readonly text: string;
    readonly on: readonly string[];
    readonly low?: readonly Theme[];
    readonly inherited?: string;
}

const TEXT_PAIRS: readonly TextPair[] = [
    // Основная лестница текста — на каждой поверхности, на которой она встречается.
    ...[
        '--surface-app',
        '--surface-panel',
        '--surface-panel-deep',
        '--surface-diff-card',
        '--surface-card-header',
        '--surface-input',
        '--surface-chip',
        '--surface-control',
        '--surface-raised',
        '--surface-popover',
        '--surface-command',
        '--surface-offline-banner',
        '--surface-tour-card',
    ].flatMap(
        (surface) =>
            [
                '--text-primary',
                '--text-primary-soft',
                '--text-secondary',
                '--text-secondary-dim',
                '--text-body',
                '--text-muted',
                '--text-muted-dim',
                '--text-dim',
                '--text-dim-strong',
            ].map((text) => ({ text, on: [surface] })),
    ),
    // Дифф-рендер: номера строк, знаки и код на своих строках. Пустой половине split номера не
    // достаются — `--surface-diff-empty` держит только код в блоках композера.
    { text: '--text-gutter', on: ['--surface-diff-card'], low: ['dark', 'light'] },
    { text: '--text-gutter', on: ['--surface-diff-gap'], low: ['dark', 'light'] },
    { text: '--code-text', on: ['--surface-diff-card'] },
    { text: '--code-text', on: ['--surface-diff-empty'] },
    { text: '--code-text', on: ['--surface-code-inset'] },
    { text: '--code-text', on: ['--surface-command'] },
    { text: '--code-text', on: ['--diff-add-bg', '--surface-diff-card'] },
    { text: '--code-text-del', on: ['--diff-del-bg', '--surface-diff-card'] },
    { text: '--diff-add-text', on: ['--diff-add-bg', '--surface-diff-card'], low: ['light'] },
    // Arcanum: референсный красный маркер, 3.96:1 (docs/design/theme.md).
    { text: '--diff-del-text', on: ['--diff-del-bg', '--surface-diff-card'], low: ['light', 'arcanum-dark'] },
    { text: '--diff-add-gutter', on: ['--diff-add-gutter-bg', '--diff-add-bg', '--surface-diff-card'], low: ['light'] },
    { text: '--diff-del-gutter', on: ['--diff-del-gutter-bg', '--diff-del-bg', '--surface-diff-card'], low: ['dark', 'light'] },
    { text: '--diff-add-text', on: ['--surface-card-header'], low: ['light'] },
    // Тот же маркер в шапке: 3.55:1 (docs/design/theme.md).
    { text: '--diff-del-text', on: ['--surface-card-header'], low: ['light', 'arcanum-dark'] },
    { text: '--syntax-keyword', on: ['--surface-diff-card'] },
    { text: '--syntax-string', on: ['--surface-diff-card'] },
    { text: '--syntax-comment', on: ['--surface-diff-card'] },
    { text: '--syntax-decorator', on: ['--surface-diff-card'], low: ['light'] },
    ...['--syntax-property', '--syntax-number', '--syntax-type'].map(
        (text) => ({ text, on: ['--surface-diff-card'] }),
    ),
    ...['--syntax-variable', '--syntax-function'].flatMap((text) => [
        { text, on: ['--surface-diff-card'], inherited: '--code-text' },
        { text, on: ['--diff-del-bg', '--surface-diff-card'], inherited: '--code-text-del' },
    ]),
    // Акцентная и янтарная группы — на своих поверхностях.
    { text: '--accent-text', on: ['--accent-surface'] },
    { text: '--accent-text-soft', on: ['--accent-surface'] },
    { text: '--accent-text-bright', on: ['--accent-surface'] },
    { text: '--accent-text-queued', on: ['--accent-surface'], low: ['light'] },
    { text: '--accent-ink', on: ['--accent'] },
    { text: '--attention-text', on: ['--attention-surface'], low: ['light'] },
    { text: '--attention-text-dim', on: ['--attention-surface'] },
    { text: '--attention-text-soft', on: ['--attention-surface'] },
    { text: '--attention-body', on: ['--attention-surface'] },
    { text: '--attention-label', on: ['--attention-surface'] },
    { text: '--accent-text', on: ['--accent-surface-alt'] },
    { text: '--accent-text-soft', on: ['--accent-surface-alt'] },
    { text: '--accent-text-bright', on: ['--accent-surface-alt'] },
    { text: '--accent-text-queued', on: ['--accent-surface-alt'], low: ['light'] },
    { text: '--attention-text', on: ['--attention-surface-alt'] },
    { text: '--attention-text-dim', on: ['--attention-surface-alt'] },
    { text: '--attention-text-soft', on: ['--attention-surface-alt'] },
    { text: '--attention-body', on: ['--attention-surface-alt'] },
    { text: '--attention-label', on: ['--attention-surface-alt'] },
    // Та же прежняя пара зелёного бейджа: в light её зафиксированный контраст 4.46.
    { text: '--success-text', on: ['--ownership-mine-surface', '--surface-panel-deep'], low: ['light'] },
    { text: '--success-text', on: ['--ownership-mine-surface', '--surface-app'], low: ['light'] },
    { text: '--error-text', on: ['--error-surface'] },
    { text: '--error-text', on: ['--surface-digest-footer'] },
    { text: '--text-dim-strong', on: ['--surface-digest-footer'] },
    // «Не покрыто»: чип лежит поверх красного футера, сам футер — на карточке дайджеста.
    // У исходной light прежняя пара даёт 3.89:1; обе Arcanum обязаны проходить 4.5:1.
    { text: '--error-text', on: ['--error-border', '--surface-digest-footer', '--surface-panel-deep'], low: ['light'] },
    { text: '--text-secondary', on: ['--surface-digest-footer', '--surface-panel-deep'] },
    // Метка остановки в строке дерева (§6a): второстепенный маркер, пара из спеки.
    { text: '--stop-mark-text', on: ['--surface-panel'], low: ['light'] },
    // Подпись прочитанного в дереве: на панели и под ховером строки.
    { text: '--tree-read-color', on: ['--surface-panel'] },
    { text: '--tree-read-color', on: ['--surface-raised'] },
    { text: '--chat-body-text', on: ['--surface-panel'] },
    { text: '--pr-comments-body-text', on: ['--surface-raised'] },
    { text: '--text-on-selected', on: ['--surface-selected'] },
    // Комментарии к PR: чипы статуса, подтверждение удаления и сноска о публикации.
    { text: '--pr-comments-published-chip-text', on: ['--pr-comments-published-chip-surface'] },
    { text: '--comment-edit-chip-text', on: ['--comment-edit-chip-surface'], low: ['light'] },
    { text: '--diff-del-text-strong', on: ['--pr-comments-delete-surface'], low: ['light'] },
    // Лестница сплошных кнопок §5: текст обязан читаться на всех трёх тонах своего цвета.
    { text: '--text-danger-button', on: ['--surface-danger-button'] },
    { text: '--text-danger-button', on: ['--surface-danger-button-hover'] },
    { text: '--text-danger-button', on: ['--surface-danger-button-pressed'] },
    { text: '--text-button', on: ['--surface-button'] },
    { text: '--text-button', on: ['--surface-button-hover'] },
    { text: '--text-button', on: ['--surface-button-pressed'] },
    { text: '--accent-ink', on: ['--accent-hover'] },
    { text: '--accent-ink', on: ['--accent-pressed'] },
    { text: '--attention-button-ink', on: ['--attention-button-hover'], low: ['light'] },
    { text: '--attention-button-ink', on: ['--attention-button-pressed'] },
    { text: '--text-chip-active', on: ['--surface-chip-active-hover'] },
    { text: '--text-chip-active', on: ['--surface-chip-active-pressed'] },
    { text: '--pr-comments-note-icon', on: ['--surface-app'] },
    // Черновик: поле с несохранённым текстом и отметка «сохранено» — она живёт и на карточке
    // треда, и в композере модалки.
    { text: '--attention-text-soft', on: ['--draft-field-surface'] },
    { text: '--draft-saved', on: ['--surface-card-header'], low: ['dark', 'light'] },
    { text: '--draft-saved', on: ['--surface-app'], low: ['light'] },
    // Бейдж «новая» у остановки — зелёная группа «моего» владения.
    { text: '--diff-add-text-strong', on: ['--ownership-mine-surface'], low: ['light'] },
    // Отметка «просмотрено»: галочка на своей подложке и на зелёном hover (§4).
    { text: '--diff-add-text-strong', on: ['--viewed-surface'] },
    { text: '--diff-add-text-strong', on: ['--viewed-hover-surface'], low: ['light'] },
    // Выбранные состояния §1: сегмент, включённый чип, янтарная primary.
    { text: '--text-on-segment-active', on: ['--surface-segment-active'] },
    { text: '--text-chip-active', on: ['--surface-chip-active'] },
    { text: '--attention-button-ink', on: ['--attention-button'], low: ['light'] },
];

describe('контраст текста на подложках', () => {
    for (const palette of THEMES) {
        const tokens = palettes[palette];
        for (const pair of TEXT_PAIRS) {
            const known = pair.low?.includes(palette) === true;
            it(`${palette}: ${pair.text} на ${pair.on.join(' → ')}${known ? ' — ниже нормы' : ''}`, () => {
                const background = pair.on.reduceRight<number[]>(
                    (below, layer) => blend(parseColor(tokenValue(tokens, layer)), below),
                    parseColor(tokenValue(tokens, '--surface-app')).rgb,
                );
                const textColor = tokenValue(tokens, pair.text);
                const inherited = textColor === 'currentcolor' && pair.inherited !== undefined
                    ? tokenValue(tokens, pair.inherited)
                    : textColor;
                const ratio = contrast(parseColor(inherited).rgb, background);
                if (known) {
                    // Нижняя граница — худшая из зафиксированных пар (номера строк на схлопнутой строке в светлой, 2.62).
                    expect(ratio).toBeGreaterThanOrEqual(2.6);
                    // Пара дотянулась до нормы — её пора убрать из `low`.
                    expect(ratio).toBeLessThan(4.5);
                } else {
                    expect(ratio).toBeGreaterThanOrEqual(4.5);
                }
            });
        }
    }
});

function tokenValue(tokens: Map<string, string>, name: string): string {
    const seen = new Set<string>();
    let current = name;
    while (!seen.has(current)) {
        seen.add(current);
        const found = tokens.get(current);
        if (found === undefined) {
            throw new Error(`в палитре нет токена ${current}`);
        }
        const reference = /^var\((--[a-z0-9-]+)\)$/.exec(found)?.[1];
        if (reference === undefined) {
            return found;
        }
        current = reference;
    }
    throw new Error(`циклическая ссылка цветового токена ${name}`);
}

/** `#rrggbb` или `rgba(r,g,b,a)` → канальные значения и альфа. */
function parseColor(raw: string): { rgb: number[]; alpha: number } {
    const rgba = /rgba?\(([^)]+)\)/.exec(raw);
    if (rgba !== null) {
        const parts = (rgba[1] ?? '').split(',').map(Number);
        return { rgb: parts.slice(0, 3), alpha: parts[3] ?? 1 };
    }
    return { rgb: [1, 3, 5].map((offset) => Number.parseInt(raw.slice(offset, offset + 2), 16)), alpha: 1 };
}

/** Наложение слоя на то, что под ним; самый нижний слой обязан быть непрозрачным. */
function blend(layer: { rgb: number[]; alpha: number }, below: number[] | null): number[] {
    if (below === null) {
        return layer.rgb;
    }
    return layer.rgb.map((channel, index) => channel * layer.alpha + (below[index] ?? 0) * (1 - layer.alpha));
}

/** Контраст непрозрачных цветов по относительной яркости sRGB. */
function contrast(first: number[], second: number[]): number {
    const luminance = (rgb: number[]): number => {
        const channels = rgb.map((raw) => {
            const value = raw / 255;
            return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
        });
        return (channels[0] ?? 0) * 0.2126 + (channels[1] ?? 0) * 0.7152 + (channels[2] ?? 0) * 0.0722;
    };
    const a = luminance(first);
    const b = luminance(second);
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

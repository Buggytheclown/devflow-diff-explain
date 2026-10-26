import { useEffect, useRef, useState } from 'react';

import { type ResolvedTheme, useResolvedTheme } from '../../settings/document-settings.tsx';
import tokensCss from '../../styles/tokens.css?raw';

/**
 * Витрина токенов: свотчи и шкала типографики строятся из самого `tokens.css`, а не из
 * второго списка — иначе витрина рано или поздно разошлась бы с системой.
 */

interface TokenGroup {
    readonly title: string;
    readonly tokens: readonly { readonly name: string; readonly value: string }[];
}

/** Группы берутся из заголовков-комментариев вида «--- Название ---» внутри `:root`. */
function parseGroups(css: string): readonly TokenGroup[] {
    const groups: { title: string; tokens: { name: string; value: string }[] }[] = [];
    let current: { title: string; tokens: { name: string; value: string }[] } | null = null;

    for (const line of css.split('\n')) {
        const heading = /^\s*\/\*\s*---\s*(.+?)\s*---/.exec(line)?.[1];
        if (heading !== undefined) {
            current = { title: heading, tokens: [] };
            groups.push(current);
            continue;
        }

        const [, name, value] = /^\s*(--[a-z0-9-]+)\s*:\s*([^;]+);/.exec(line) ?? [];
        if (name !== undefined && value !== undefined && current !== null) {
            current.tokens.push({ name, value: value.trim() });
        }
    }

    return groups;
}

const BASE_RULE = /:root(?:\s*,\s*\[data-theme\])?\s*\{([^}]*)\}/.exec(tokensCss)?.[1] ?? '';
const GROUPS = parseGroups(BASE_RULE);
const BASE_VALUES = new Map(GROUPS.flatMap((group) => group.tokens.map((token) => [token.name, token.value])));
const THEME_VALUES: Readonly<Record<ResolvedTheme, ReadonlyMap<string, string>>> = {
    dark: themeValues('dark'),
    light: themeValues('light'),
    'arcanum-dark': themeValues('arcanum-dark'),
    'arcanum-light': themeValues('arcanum-light'),
};

/** Учитываем все правила выбранной темы по порядку, включая общие блоки двух палитр. */
function themeValues(theme: ResolvedTheme): ReadonlyMap<string, string> {
    const values = new Map<string, string>();
    const selector = new RegExp(`^(?::root)?\\[data-theme=['"]${theme}['"]\\]$`);
    const css = tokensCss.replace(/\/\*[\s\S]*?\*\//g, '');
    for (const [, selectors, body] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
        if (!selectors?.split(',').some((candidate) => selector.test(candidate.trim()))) {
            continue;
        }
        for (const match of (body ?? '').matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) {
            if (match[1] !== undefined && match[2] !== undefined) {
                values.set(match[1], match[2].trim());
            }
        }
    }
    return values;
}

function tokenValue(theme: ResolvedTheme, name: string): string {
    return THEME_VALUES[theme].get(name) ?? BASE_VALUES.get(name) ?? '';
}

function isPaint(value: string): boolean {
    return value.startsWith('#') || value.startsWith('rgba(') || value.includes('gradient(');
}

export function TokenSwatches() {
    const theme = useResolvedTheme();
    return (
        <div className="showcase">
            {GROUPS.map((group) => (
                <section key={group.title} className="showcase__group">
                    <h3 className="showcase__group-title">{group.title}</h3>
                    <div className="showcase__grid">
                        {group.tokens.map((token) => {
                            const value = tokenValue(theme, token.name);
                            return (
                                <div key={token.name} className="swatch">
                                    {isPaint(value) ? (
                                        <span className="swatch__paint" style={{ background: `var(${token.name})` }} />
                                    ) : (
                                        <span className="swatch__paint swatch__paint--empty" />
                                    )}
                                    <span className="swatch__name">{token.name}</span>
                                    <span className="swatch__value">{value}</span>
                                </div>
                            );
                        })}
                    </div>
                </section>
            ))}
        </div>
    );
}

/**
 * Адаптивные ширины (docs/design/SPEC-theming-2026-09-12.md §6): значения зависят от окна,
 * поэтому витрина показывает не запись, а то, во что её разрешил браузер прямо сейчас —
 * приёмку «на 2560 дерево 560, панель агента 560, потолок 1280/1920» видно числами. Колонки
 * нарратива здесь нет: её `26%` считаются от контента вью, и вне маршрута число соврало бы.
 */
const WIDTH_SAMPLES: readonly { readonly label: string; readonly value: string }[] = [
    { label: 'боковое поле вью', value: 'var(--space-page)' },
    { label: 'зазор нарратив ↔ дифф', value: 'var(--space-column)' },
    { label: 'дерево файлов Полного диффа', value: 'var(--width-file-tree)' },
    { label: 'панель агента', value: 'var(--width-agent-panel)' },
];

function WidthBar({ label, value }: { label: string; value: string }) {
    const [measured, setMeasured] = useState<number | null>(null);
    const ref = useRef<HTMLDivElement | null>(null);
    useEffect(() => {
        const element = ref.current;
        if (element === null) {
            return;
        }
        const report = (): void => {
            setMeasured(Math.round(element.getBoundingClientRect().width));
        };
        report();
        const observer = new ResizeObserver(report);
        observer.observe(element);
        return () => {
            observer.disconnect();
        };
    }, []);

    return (
        <div className="width-sample">
            <span className="width-sample__label">{label}</span>
            <div className="width-sample__track">
                <div className="width-sample__bar" ref={ref} style={{ width: value }} />
            </div>
            <span className="width-sample__value">
                {value} → {measured === null ? '—' : `${String(measured)}px`}
            </span>
        </div>
    );
}

/** Ширины раскладки и потолок код-панелей по режиму диффа. */
export function LayoutWidths() {
    return (
        <div className="showcase">
            <section className="showcase__group">
                <h3 className="showcase__group-title">Ширины раскладки</h3>
                {WIDTH_SAMPLES.map((sample) => (
                    <WidthBar key={sample.label} label={sample.label} value={sample.value} />
                ))}
            </section>

            <section className="showcase__group">
                <h3 className="showcase__group-title">Потолок код-панелей</h3>
                {/* Атрибут тот же, что вью ставит на свой корень: переключение режима меняет потолок. */}
                <div data-diff-mode="unified">
                    <WidthBar label="unified" value="var(--diff-max)" />
                </div>
                <div data-diff-mode="split">
                    <WidthBar label="side by side" value="var(--diff-max)" />
                </div>
            </section>
        </div>
    );
}

/** Строка для глазной сверки шрифта: кириллица, латиница, цифры и знаки машинных данных. */
const SAMPLE = 'Шерпа · маршрут по диффу — Sherpa route 0123456789 {} => #!';

const SIZE_TOKENS = GROUPS.flatMap((group) => group.tokens).filter((token) =>
    token.name.startsWith('--font-size-'),
);

export function TypographyScale() {
    const theme = useResolvedTheme();
    return (
        <div className="showcase">
            <section className="showcase__group">
                <h3 className="showcase__group-title">{tokenValue(theme, '--font-sans')}</h3>
                {SIZE_TOKENS.map((token) => (
                    <p
                        key={token.name}
                        className="sample sample--sans"
                        style={{ fontSize: `var(${token.name})` }}
                    >
                        <span className="sample__label">
                            {token.name} · {tokenValue(theme, token.name)}
                        </span>
                        {SAMPLE}
                    </p>
                ))}
            </section>

            <section className="showcase__group">
                <h3 className="showcase__group-title">{tokenValue(theme, '--font-mono')}</h3>
                {SIZE_TOKENS.map((token) => (
                    <p
                        key={token.name}
                        className="sample sample--mono"
                        style={{ fontSize: `var(${token.name})` }}
                    >
                        <span className="sample__label">
                            {token.name} · {tokenValue(theme, token.name)}
                        </span>
                        {SAMPLE}
                    </p>
                ))}
            </section>

            <section className="showcase__group">
                <h3 className="showcase__group-title">Начертания</h3>
                <p className="sample sample--sans" style={{ fontWeight: 400 }}>
                    Sans 400 · {SAMPLE}
                </p>
                <p className="sample sample--sans" style={{ fontWeight: 450 }}>
                    Sans 450 (Text) · {SAMPLE}
                </p>
                <p className="sample sample--sans" style={{ fontWeight: 500 }}>
                    Sans 500 · {SAMPLE}
                </p>
                <p className="sample sample--sans" style={{ fontWeight: 600 }}>
                    Sans 600 · {SAMPLE}
                </p>
                <p className="sample sample--sans" style={{ fontStyle: 'italic' }}>
                    Sans 400 курсив · {SAMPLE}
                </p>
                <p className="sample sample--sans" style={{ fontStyle: 'italic', fontWeight: 450 }}>
                    Sans 450 курсив · {SAMPLE}
                </p>
                <p className="sample sample--mono" style={{ fontWeight: 400 }}>
                    Mono 400 · {SAMPLE}
                </p>
                <p className="sample sample--mono" style={{ fontWeight: 500 }}>
                    Mono 500 · {SAMPLE}
                </p>
                <p className="sample sample--mono" style={{ fontStyle: 'italic' }}>
                    Mono 400 курсив · {SAMPLE}
                </p>
            </section>
        </div>
    );
}

// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it } from 'vitest';

import { LocaleProvider } from '../../i18n/index.js';
import { GALLERY_STATES } from './states.tsx';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// В jsdom нет раскладки; тестовые изображения и компоненты могут наблюдать размер.
(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class {
    observe(): void {
        // Раскладки нет.
    }
    unobserve(): void {
        // Раскладки нет.
    }
    disconnect(): void {
        // Раскладки нет.
    }
};

// В jsdom прокрутки нет; состояния, доводящие карточку до вида, зовут её при монтировании.
HTMLElement.prototype.scrollIntoView = function noopScrollIntoView(): void {
    // Прокрутки нет.
};

describe('реестр галереи', () => {
    it('не содержит повторяющихся id', () => {
        const seen = new Set<string>();
        const duplicates = new Set<string>();

        for (const state of GALLERY_STATES) {
            if (seen.has(state.id)) {
                duplicates.add(state.id);
            }
            seen.add(state.id);
        }

        expect([...duplicates], 'повторяющиеся id состояний галереи').toEqual([]);
    });

    // Непереведённое рисуется по-русски и падать не должно: смоук ловит не полноту перевода,
    // а обращения к несуществующим ключам и прочие поломки под другим языком.
    // Реестр идёт группами, а не одним тестом: рендер всех состояний в jsdom занимает десятки
    // секунд, и на загруженной машине (`pnpm -r test` держит все пакеты разом) общий бюджет
    // упирался в таймаут. У группы бюджета хватает с запасом, а упавшая группа сразу видна.
    for (const group of groups()) {
        it(`рендерит состояния группы «${group}» на обеих локалях`, { timeout: 60_000 }, () => {
            for (const locale of ['ru', 'en'] as const) {
                for (const state of GALLERY_STATES.filter((candidate) => candidate.group === group)) {
                    expect(() => {
                        render(<LocaleProvider locale={locale}>{state.render()}</LocaleProvider>);
                    }, `${state.id} · ${locale}`).not.toThrow();
                }
            }
        });
    }
});

/** Группы реестра в порядке появления: тест на группу заводится по этому списку. */
function groups(): readonly string[] {
    return [...new Set(GALLERY_STATES.map((state) => state.group))];
}

/** Монтирует состояние в свой контейнер и сразу снимает: галерее хватает факта отрисовки. */
function render(node: React.ReactNode): void {
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    try {
        act(() => {
            root.render(node);
        });
    } finally {
        act(() => {
            root.unmount();
        });
        host.remove();
    }
}

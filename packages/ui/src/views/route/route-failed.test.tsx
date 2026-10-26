// @vitest-environment jsdom
import { routeFixtures } from '@sherpa/fixtures';
import type { UiRouteFailure } from '@sherpa/protocol';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';

import { RouteFailedCard } from './generation-card.tsx';

/**
 * Живые клики по карточке провала (docs/design/README.md §12): «Повторить» действительно зовёт генерацию,
 * а «Показать сырой вывод» раскрывает вывод модели, а не рассказывает о нём.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const FAILURE: UiRouteFailure = (() => {
    const failure = routeFixtures('medium')?.states.failed?.failure ?? null;
    if (failure === null) {
        throw new Error('фикстуре medium нужно состояние провала генерации');
    }
    return failure;
})();

const mounted: (() => void)[] = [];

afterEach(() => {
    for (const unmount of mounted.splice(0)) {
        unmount();
    }
});

interface Mounted {
    readonly host: HTMLElement;
    readonly retries: number[];
    readonly opens: number[];
}

function mount(
    options: { failure?: UiRouteFailure; retrying?: boolean; initialRawShown?: boolean } = {},
): Mounted {
    const host = document.createElement('div');
    document.body.append(host);
    const retries: number[] = [];
    const opens: number[] = [];
    const root = createRoot(host);

    act(() => {
        root.render(
            <RouteFailedCard
                failure={options.failure ?? FAILURE}
                retrying={options.retrying ?? false}
                initialRawShown={options.initialRawShown ?? false}
                onRetry={() => {
                    retries.push(retries.length + 1);
                }}
                onOpenDiff={() => {
                    opens.push(opens.length + 1);
                }}
            />,
        );
    });
    mounted.push(() => {
        act(() => {
            root.unmount();
        });
        host.remove();
    });

    return { host, retries, opens };
}

function button(scope: HTMLElement, text: string): HTMLButtonElement {
    const found = [...scope.querySelectorAll('button')].find((element) => element.textContent.trim() === text);
    if (found === undefined) {
        throw new Error(`кнопки «${text}» в разметке нет`);
    }
    return found;
}

function click(element: HTMLElement): void {
    act(() => {
        element.click();
    });
}

describe('карточка провала генерации', () => {
    it('«Повторить» зовёт генерацию каждым кликом', () => {
        const { host, retries } = mount();

        click(button(host, 'Повторить'));
        click(button(host, 'Повторить'));

        expect(retries).toHaveLength(2);
    });

    it('в состоянии загрузки кнопка не пускает второй запрос, а глиф крутится', () => {
        const { host, retries } = mount({ retrying: true });
        const retry = button(host, 'Повторить');

        expect(retry.disabled).toBe(true);
        expect(host.querySelector('.gen-retry__glyph.is-spinning')).not.toBeNull();

        click(retry);

        expect(retries).toHaveLength(0);
    });

    it('«Показать сырой вывод» раскрывает вывод модели и сворачивается обратно', () => {
        const { host } = mount();
        const toggle = button(host, 'Показать сырой вывод');

        expect(host.querySelector('.gen-failed__raw')).toBeNull();
        expect(toggle.getAttribute('aria-expanded')).toBe('false');

        click(toggle);

        const raw = host.querySelector('.gen-failed__raw');
        expect(raw?.textContent).toBe(FAILURE.rawOutput);
        expect(button(host, 'Скрыть сырой вывод').getAttribute('aria-expanded')).toBe('true');

        click(button(host, 'Скрыть сырой вывод'));

        expect(host.querySelector('.gen-failed__raw')).toBeNull();
    });

    it('раскрытый с самого начала вывод — кадр галереи состояний', () => {
        const { host } = mount({ initialRawShown: true });

        expect(host.querySelector('.gen-failed__raw')?.textContent).toBe(FAILURE.rawOutput);
        expect(button(host, 'Скрыть сырой вывод').getAttribute('aria-expanded')).toBe('true');
    });

    it('модель ничего не вернула — кнопки сырого вывода нет вовсе', () => {
        const { host } = mount({ failure: { message: FAILURE.message, rawOutput: null } });

        expect([...host.querySelectorAll('button')].map((element) => element.textContent.trim())).toEqual([
            'Повторить',
            'Читать полный дифф',
        ]);
    });

    it('футер уводит в читалку: провал генерации её не задел', () => {
        const { host, opens } = mount();

        expect(host.textContent).toContain('Ридер ниже не пострадал — полный дифф доступен.');
        click(button(host, 'Читать полный дифф'));

        expect(opens).toHaveLength(1);
    });
});

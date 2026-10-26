// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { FILE_MENU_STATES } from './file-menu-states.tsx';

/**
 * Кадры меню файла рисуются без сервера и без кликов. Рендер — в jsdom, а не статической
 * разметкой: меню живёт порталом в `body`, которого у серверного рендера нет.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@tanstack/react-virtual', () => ({
    defaultRangeExtractor: () => [],
    useVirtualizer: ({ count }: { count: number }) => ({
        getTotalSize: () => count * 26,
        getVirtualItems: () =>
            Array.from({ length: count }, (_, index) => ({
                index,
                key: index,
                start: index * 26,
                size: 26,
                end: (index + 1) * 26,
                lane: 0,
            })),
        scrollToIndex: () => undefined,
    }),
}));

const mounted: (() => void)[] = [];

afterEach(() => {
    for (const unmount of mounted.splice(0)) {
        unmount();
    }
});

function render(id: string): HTMLElement {
    const state = FILE_MENU_STATES.find((candidate) => candidate.id === id);
    if (state === undefined) {
        throw new Error(`нет состояния ${id}`);
    }
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    act(() => {
        root.render(state.render());
    });
    mounted.push(() => {
        act(() => {
            root.unmount();
        });
        host.remove();
    });
    return host;
}

function items(): HTMLButtonElement[] {
    return [...document.body.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
}

describe('галерея меню файла', () => {
    it('регистрирует три кадра меню', () => {
        expect(FILE_MENU_STATES.map((state) => state.id)).toEqual([
            'file-menu-card',
            'file-menu-tree',
            'file-menu-read-only',
        ]);
    });

    it('кадр карточки: меню открыто, все пункты доступны, файл просмотрен', () => {
        const host = render('file-menu-card');

        expect(host.querySelector('.file-card')).not.toBeNull();
        expect(items().map((item) => item.textContent)).toEqual([
            'Скопировать путь',
            'Скопировать ссылку на файл',
            'Открыть в Аркануме',
            'Снять отметку',
        ]);
        expect(items().filter((item) => item.getAttribute('aria-disabled') === 'true')).toEqual([]);
    });

    it('кадр дерева: обе ссылки хоста выключены, отметка доступна', () => {
        render('file-menu-tree');

        expect(items().map((item) => item.getAttribute('aria-disabled'))).toEqual([null, 'true', 'true', null]);
    });

    it('кадр прошлой итерации: выключена только отметка', () => {
        render('file-menu-read-only');

        expect(items().map((item) => item.getAttribute('aria-disabled'))).toEqual([null, null, null, 'true']);
        expect(items()[3]?.title).toBe('только в активной итерации');
    });
});

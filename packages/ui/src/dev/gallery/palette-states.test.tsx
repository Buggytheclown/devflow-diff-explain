// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';

import { PALETTE_STATES } from './palette-states.tsx';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// jsdom не умеет прокрутку, а палитра ведёт к курсору сам список.
HTMLElement.prototype.scrollIntoView = function noopScrollIntoView(): void {
    return undefined;
};

const mounted: (() => void)[] = [];

afterEach(() => {
    for (const unmount of mounted.splice(0)) {
        unmount();
    }
});

function render(id: string): HTMLElement {
    const state = PALETTE_STATES.find((candidate) => candidate.id === id);
    if (state === undefined) {
        throw new Error(`нет состояния ${id}`);
    }
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    act(() => {
        root.render(<>{state.render()}</>);
    });
    mounted.push(() => {
        act(() => {
            root.unmount();
        });
        host.remove();
    });
    return host;
}

function rows(host: HTMLElement): string[] {
    return [...host.querySelectorAll('.command-palette__item')].map((item) => item.textContent);
}

describe('галерея командной палитры', () => {
    it('регистрирует ровно те id, которые заводит нарезка', () => {
        expect(PALETTE_STATES.map((state) => state.id)).toEqual([
            'palette-fuzzy',
            'palette-empty',
            'palette-no-results',
            'palette-diff-search',
            'palette-chat-recent',
            'palette-chat-query',
            'palette-chat-anchors',
        ]);
    });

    it('пустой @ показывает последние восемь обменов, новые сверху', () => {
        const host = render('palette-chat-recent');
        const items = rows(host);

        expect(items).toHaveLength(8);
        expect(host.querySelector('.command-palette__group-label')?.textContent).toBe('История чата');
        expect(items[0]).toContain('Зачем политике отдельный');
        expect(items.join('\n')).toContain('ещё отвечает');
        expect(items.join('\n')).toContain('без ответа');
        expect(items.join('\n')).toContain('отменён');
        // Девятый и десятый по свежести обмены в выдачу не попадают.
        expect(host.textContent).not.toContain('Почему закрытое окно отвечает 409');
        expect(host.textContent).not.toContain('Разложи изменение этого PR');
    });

    it('@ с текстом ищет и по вопросу, и по ответу', () => {
        const items = rows(render('palette-chat-query'));

        expect(items).toEqual([
            // Попадание в вопросе.
            expect.stringContaining('Как считается окно для смешанной корзины?'),
            // Попадание только в ответе.
            expect.stringContaining('Как выбирается причина закрытия между отправкой и дедлайном?'),
            expect.stringContaining('Почему закрытое окно отвечает 409, а не 400?'),
        ]);
    });

    it('пометки якоря: весь PR, чужая итерация, потерянная заметка', () => {
        const items = rows(render('palette-chat-anchors'));

        expect(items).toEqual([
            expect.stringContaining('edit-window.ts:24–32'),
            expect.stringContaining('вопрос ко всему PR'),
            expect.stringContaining('handlers.ts:48–54'),
        ]);
        expect(items[0]).not.toContain('якорь не в этой итерации');
        expect(items[2]).toContain('якорь не в этой итерации');
        expect(items[2]).toContain('заметка потеряла якорь');
    });
});

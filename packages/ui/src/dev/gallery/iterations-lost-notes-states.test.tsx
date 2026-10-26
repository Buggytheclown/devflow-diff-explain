// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';

import { GALLERY_STATES } from './states.tsx';
import { ITERATION_LOST_NOTE_STATES } from './iterations-lost-notes-states.tsx';

/**
 * Реестр состояний потерянных заметок. Кадр — живая вью полного диффа рядом с панелью чата, поэтому здесь
 * проверяется регистрация, монтирование и текст баннера с чипом; раскладку заметок по итерации
 * проверяет `notes/model.test.ts`, а поведение баннера — `iteration-banners.test.tsx`.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class {
    observe(): void {
        // В jsdom нет раскладки.
    }
    unobserve(): void {
        // В jsdom нет раскладки.
    }
    disconnect(): void {
        // В jsdom нет раскладки.
    }
};
HTMLElement.prototype.scrollIntoView = function noopScrollIntoView(): void {
    // В jsdom нет прокрутки.
};

const cleanups: (() => void)[] = [];

afterEach(() => {
    for (const cleanup of cleanups.splice(0)) {
        cleanup();
    }
});

function mount(id: string): HTMLElement {
    const state = ITERATION_LOST_NOTE_STATES.find((candidate) => candidate.id === id);
    if (state === undefined) {
        throw new Error(`нет состояния ${id}`);
    }
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    act(() => {
        root.render(<>{state.render()}</>);
    });
    cleanups.push(() => {
        act(() => {
            root.unmount();
        });
        host.remove();
    });
    return host;
}

describe('галерея потерянных заметок', () => {
    it('регистрирует ровно те id, что объявлены в файле', () => {
        expect(ITERATION_LOST_NOTE_STATES.map((state) => state.id)).toEqual(['iterations-notes-lost']);
    });

    it('попадает в общий реестр ровно один раз, в группу «Итерации»', () => {
        const ids = GALLERY_STATES.filter((state) => state.id === 'iterations-notes-lost');

        expect(ids).toHaveLength(1);
        expect(ids[0]?.group).toBe('Итерации');
    });

    it('кадр показывает баннер, чип потерянного якоря и счётчик всех заметок', () => {
        const host = mount('iterations-notes-lost');

        expect(host.textContent).toContain('1 заметка потеряла якорь после нового пуша');
        expect(host.textContent).toContain('якорь потерян после пуша · handlers.ts:48–54');
        // Счётчик шапки чата считает все заметки, включая потерявшую якорь.
        expect(host.textContent).toContain('Заметки 5');
    });
});

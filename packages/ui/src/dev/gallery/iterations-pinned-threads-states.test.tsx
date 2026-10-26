// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';

import { GALLERY_STATES } from './states.tsx';
import { ITERATION_PINNED_THREAD_STATES } from './iterations-pinned-threads-states.tsx';

/**
 * Реестр состояний приколотых тредов. Полный дифф в галерее — живая вью с виртуализацией и сторами,
 * поэтому здесь проверяется только регистрация и то, что кадр монтируется; чип пина, действие
 * и группа ушедших файлов проверены в `threads/thread-list.test.tsx`.
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

const cleanups: (() => void)[] = [];

afterEach(() => {
    for (const cleanup of cleanups.splice(0)) {
        cleanup();
    }
});

function mount(id: string): HTMLElement {
    const state = ITERATION_PINNED_THREAD_STATES.find((candidate) => candidate.id === id);
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

describe('галерея приколотых тредов', () => {
    it('регистрирует ровно те id, что объявлены в файле', () => {
        expect(ITERATION_PINNED_THREAD_STATES.map((state) => state.id)).toEqual([
            'iterations-thread-pinned',
            'iterations-thread-pinned-old',
        ]);
    });

    it('попадает в общий реестр ровно один раз, в группу «Итерации»', () => {
        const ids = GALLERY_STATES.filter((state) => state.id === 'iterations-thread-pinned');

        expect(ids).toHaveLength(1);
        expect(ids[0]?.group).toBe('Итерации');
    });

    it('оба состояния монтируются: активная итерация и прошлая в режиме чтения', () => {
        expect(mount('iterations-thread-pinned').textContent).toContain('Полный дифф');
        expect(mount('iterations-thread-pinned-old').textContent).toContain('Полный дифф');
    });
});

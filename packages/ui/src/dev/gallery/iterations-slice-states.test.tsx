// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';

import { GALLERY_STATES } from './states.tsx';
import { ITERATION_SLICE_STATES } from './iterations-slice-states.tsx';

/**
 * Реестр состояний среза между итерациями. Full diff в галерее — живая вью со сторами и виртуализацией,
 * поэтому здесь проверяется регистрация и то, что каждый кадр монтируется и говорит про срез.
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
    const state = ITERATION_SLICE_STATES.find((candidate) => candidate.id === id);
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

function sliceClass(row: Element): string {
    if (row.classList.contains('is-slice-edge')) {
        return 'edge';
    }
    return row.classList.contains('is-slice-inside') ? 'inside' : '-';
}

describe('галерея среза между итерациями', () => {
    it('регистрирует ровно те id, которые заводит нарезка задачи', () => {
        expect(ITERATION_SLICE_STATES.map((state) => state.id)).toEqual([
            'iterations-slice',
            'iterations-slice-picker',
            'iterations-slice-picker-edge',
            'iterations-slice-picker-preview',
            'iterations-slice-route',
            'iterations-slice-overview',
            'iterations-slice-empty',
            'iterations-slice-loading',
        ]);
    });

    it('состояния попадают в общий реестр в группу «Итерации» по одному разу', () => {
        for (const state of ITERATION_SLICE_STATES) {
            const found = GALLERY_STATES.filter((candidate) => candidate.id === state.id);

            expect(found).toHaveLength(1);
            expect(found[0]?.group).toBe('Итерации');
        }
    });

    it('срез показывает индикатор с обеими сторонами и баннер режима чтения', () => {
        const host = mount('iterations-slice');

        expect(host.querySelector('.snapshot-pill')?.textContent).toContain('срез');
        expect(host.textContent).toContain('Вы смотрите срез между итерациями');
        expect(host.textContent).toContain('К активной итерации');
    });

    it('меню в срезе: «Сейчас: срез …», галки и подписи на краях, промежуточная — внутри диапазона', () => {
        const host = mount('iterations-slice-picker');

        expect(host.querySelector('.snapshot-picker__now')?.textContent).toMatch(/^Сейчас: срез \w{7} → \w{7}$/);
        expect([...host.querySelectorAll('.snapshot-picker__section')].map((node) => node.textContent)).toEqual([
            'Снапшоты и итерации',
        ]);
        const rows = [...host.querySelectorAll('.snapshot-picker__row')];
        expect(rows.map((row) => row.getAttribute('aria-checked'))).toEqual(['true', 'false', 'true']);
        expect(rows.map((row) => sliceClass(row))).toEqual(['edge', 'inside', 'edge']);
        expect([...host.querySelectorAll('.snapshot-picker__role')].map((node) => node.textContent)).toEqual([
            'голова',
            'база',
        ]);
        expect(host.querySelector('.snapshot-picker__hint')?.textContent).toBe(
            'Shift+клик по двум итерациям — срез между ними',
        );
    });

    it('выбран первый край: отмечен только он, подсказка про вторую итерацию', () => {
        const host = mount('iterations-slice-picker-edge');

        const rows = [...host.querySelectorAll('.snapshot-picker__row')];
        expect(rows.map((row) => sliceClass(row))).toEqual(['-', '-', 'edge']);
        expect(host.querySelector('.snapshot-picker__hint')?.textContent).toBe(
            'Выберите вторую итерацию · Esc или клик по первой ещё раз — отмена',
        );
    });

    it('курсор на другой итерации — превью диапазона', () => {
        const host = mount('iterations-slice-picker-preview');

        const rows = [...host.querySelectorAll('.snapshot-picker__row')];
        expect(rows.map((row) => sliceClass(row))).toEqual(['edge', 'inside', 'edge']);
        expect(rows[0]?.classList.contains('is-cursor')).toBe(true);
    });

    it('вкладка маршрута объясняет, что маршрута для среза не бывает', () => {
        const host = mount('iterations-slice-route');

        expect(host.textContent).toContain('это «что нового» без ИИ');
        expect(host.textContent).toContain('К полному диффу');
    });

    it('вкладка обзора объясняет, что карточки считаются по активной итерации', () => {
        const host = mount('iterations-slice-overview');

        expect(host.textContent).toContain('Для среза обзор не собирается');
        expect(host.textContent).toContain('К полному диффу');
    });

    it('пустой срез говорит, что изменений между итерациями нет, не теряя шапки', () => {
        const host = mount('iterations-slice-empty');

        expect(host.textContent).toContain('изменений нет');
        expect(host.querySelector('.snapshot-pill')?.textContent).toContain('срез');
    });

    it('загрузка среза рисует три карточки-скелетона и пометку про хост', () => {
        const host = mount('iterations-slice-loading');

        // Шапка PR с индикатором и место панели файлов стоят уже в кадре ожидания: приезд данных
        // не двигает раскладку, а ревьюер всё это время видит, какой срез считается.
        expect(host.querySelector('.pr-header')).not.toBeNull();
        expect(host.querySelector('.snapshot-pill')?.textContent).toContain('срез');
        expect(host.querySelector('.full-diff__panel-placeholder')).not.toBeNull();
        expect(host.querySelectorAll('.diff-skeleton-card')).toHaveLength(3);
        expect(host.textContent).toContain('это дольше обычного');
    });
});

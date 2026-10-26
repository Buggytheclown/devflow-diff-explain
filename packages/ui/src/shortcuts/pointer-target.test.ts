// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';

import { createPointerTarget } from './pointer-target.js';

/**
 * Правило «последний сигнал»: движение мыши делает целью элемент под курсором, любая смена
 * фокуса возвращает цель фокусу. `elementFromPoint` в jsdom нет — документ подставляется свой.
 */

interface Harness {
    readonly pointer: ReturnType<typeof createPointerTarget>;
    /** Что вернёт `elementFromPoint` в следующий раз. */
    under: Element | null;
    readonly move: (x: number, y: number) => void;
    readonly focus: () => void;
    readonly leave: () => void;
    readonly blurWindow: () => void;
    readonly points: { x: number; y: number }[];
    readonly listenerCount: () => number;
}

function harness(activeElement: Element | null = null): Harness {
    const listeners = new Map<string, Set<EventListener>>();
    const bind = (target: 'doc' | 'win') => ({
        addEventListener: (type: string, listener: EventListener) => {
            const key = `${target}:${type}`;
            const set = listeners.get(key) ?? new Set<EventListener>();
            set.add(listener);
            listeners.set(key, set);
        },
        removeEventListener: (type: string, listener: EventListener) => {
            listeners.get(`${target}:${type}`)?.delete(listener);
        },
    });
    const fire = (key: string, event: Event): void => {
        for (const listener of listeners.get(key) ?? []) {
            listener(event);
        }
    };
    const points: { x: number; y: number }[] = [];
    const state: { under: Element | null } = { under: null };
    const pointer = createPointerTarget(
        { ...bind('win') },
        {
            ...bind('doc'),
            activeElement,
            elementFromPoint: (x, y) => {
                points.push({ x, y });
                return state.under;
            },
        },
    );

    return {
        pointer,
        get under() {
            return state.under;
        },
        set under(element: Element | null) {
            state.under = element;
        },
        move: (x, y) => {
            fire('doc:pointermove', Object.assign(new Event('pointermove'), { clientX: x, clientY: y }));
        },
        focus: () => {
            fire('doc:focusin', new Event('focusin'));
        },
        leave: () => {
            fire('doc:pointerleave', new Event('pointerleave'));
        },
        blurWindow: () => {
            fire('win:blur', new Event('blur'));
        },
        points,
        listenerCount: () => [...listeners.values()].reduce((total, set) => total + set.size, 0),
    };
}

function row(): HTMLElement {
    const card = document.createElement('article');
    card.dataset.file = 'f1';
    const line = document.createElement('div');
    line.dataset.key = 'a7';
    card.append(line);
    return line;
}

describe('трекер курсора', () => {
    it('до первого движения мыши цели под курсором нет', () => {
        const h = harness();
        h.under = row();

        expect(h.pointer.hovered()).toBeNull();
        expect(h.points).toHaveLength(0);
    });

    it('движение мыши даёт элемент из elementFromPoint по последней позиции', () => {
        const h = harness();
        const line = row();
        h.under = line;

        h.focus();
        h.move(40, 120);

        expect(h.pointer.hovered()).toBe(line);
        expect(h.points).toEqual([{ x: 40, y: 120 }]);
    });

    it('перевод фокуса после движения мыши возвращает цель фокусу', () => {
        const h = harness();
        h.under = row();

        h.move(40, 120);
        h.focus();

        expect(h.pointer.hovered()).toBeNull();
    });

    it('позиция читается в момент вызова: под неподвижной мышью контент мог уехать', () => {
        const h = harness();
        const first = row();
        const second = row();
        h.under = first;
        h.move(10, 10);
        expect(h.pointer.hovered()).toBe(first);

        h.under = second;
        expect(h.pointer.hovered()).toBe(second);
        expect(h.points).toEqual([
            { x: 10, y: 10 },
            { x: 10, y: 10 },
        ]);
    });

    it('курсор ушёл из окна — позиция забыта', () => {
        const h = harness();
        h.under = row();

        h.move(40, 120);
        h.leave();
        expect(h.pointer.hovered()).toBeNull();

        h.move(40, 120);
        h.blurWindow();
        expect(h.pointer.hovered()).toBeNull();
    });

    it('цель по селектору падает на активный элемент, когда мышь не последний сигнал', () => {
        const active = document.createElement('div');
        active.dataset.stop = 's03';
        const inside = document.createElement('button');
        active.append(inside);
        const h = harness(inside);

        expect(h.pointer.target('[data-stop]')).toBe(active);

        const hoveredStop = document.createElement('div');
        hoveredStop.dataset.stop = 's07';
        h.under = hoveredStop;
        h.move(1, 2);
        expect(h.pointer.target('[data-stop]')).toBe(hoveredStop);

        // Под мышью не остановка: цель остаётся за фокусом, а не теряется вовсе.
        h.under = document.createElement('div');
        expect(h.pointer.target('[data-stop]')).toBe(active);
    });

    it('уход курсора с вложенного элемента позицию не трогает', () => {
        const line = row();
        const card = line.parentElement;
        if (card === null) {
            throw new Error('строке нужна карточка');
        }
        document.body.append(card);
        const pointer = createPointerTarget(window, {
            addEventListener: (type, listener, options) => {
                document.addEventListener(type, listener, options);
            },
            removeEventListener: (type, listener, options) => {
                document.removeEventListener(type, listener, options);
            },
            get activeElement() {
                return document.activeElement;
            },
            elementFromPoint: () => line,
        });
        document.dispatchEvent(Object.assign(new Event('pointermove'), { clientX: 8, clientY: 9 }));
        expect(pointer.hovered()).toBe(line);

        // Прокрутка колесом: браузер шлёт уход с узла под неподвижной мышью, а не из окна.
        line.dispatchEvent(new Event('pointerleave'));
        line.dispatchEvent(new Event('mouseleave'));
        expect(pointer.hovered()).toBe(line);

        document.dispatchEvent(new Event('pointerleave'));
        expect(pointer.hovered()).toBeNull();

        pointer.dispose();
        card.remove();
    });

    it('снятие трекера отписывает все слушатели', () => {
        const h = harness();
        expect(h.listenerCount()).toBe(5);

        h.pointer.dispose();
        expect(h.listenerCount()).toBe(0);
    });
});

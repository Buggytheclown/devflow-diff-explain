// @vitest-environment jsdom
import { fixtureIteration } from '@sherpa/fixtures';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createDiffViewStore } from '../../diff-view/store.js';
import { buildFileFilters, selectFilter } from '../../filters/lens-filters.js';
import { RouteToolbar } from './route-toolbar.tsx';
import { createT } from '../../i18n/index.js';

const t = createT('ru');

/**
 * Тулбар меряет свою высоту сам (№38): вью держит от неё липкий офсет колонки остановок.
 * Проверяется то, ради чего замер и заводился, — что перенос строк в тулбаре доезжает
 * до офсета, а не расходится с захардкоженной константой.
 */

const DATA = fixtureIteration('medium');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** Наблюдатели, заведённые за время теста: их дёргает сам тест — раскладки в jsdom нет. */
let observers: (() => void)[] = [];
let height = 0;

class FakeResizeObserver {
    constructor(private readonly callback: () => void) {}
    observe(): void {
        observers.push(this.callback);
    }
    unobserve(): void {
        // Наблюдение снимается только вместе с наблюдателем.
    }
    disconnect(): void {
        observers = observers.filter((callback) => callback !== this.callback);
    }
}

const mounted: (() => void)[] = [];

afterEach(() => {
    for (const unmount of mounted.splice(0)) {
        unmount();
    }
    observers = [];
    vi.restoreAllMocks();
});

function mount(onHeight: (value: number) => void): void {
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver = FakeResizeObserver;
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(() => ({
        height,
        width: 0,
        top: 0,
        bottom: height,
        left: 0,
        right: 0,
        x: 0,
        y: 0,
        toJSON: () => ({}),
    }));

    const filters = buildFileFilters({
        files: DATA.diff.files,
        ownership: DATA.ownership,
        extra: DATA.extraLenses, t,});
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    act(() => {
        root.render(
            <RouteToolbar
                store={createDiffViewStore({ files: DATA.diff.files })}
                preset="triage"
                onPreset={() => undefined}
                filters={filters}
                filter={selectFilter(filters, 'all')}
                onFilter={() => undefined}
                strip={null}
                onHeight={onHeight}
            />,
        );
    });
    mounted.push(() => {
        act(() => {
            root.unmount();
        });
        host.remove();
    });
}

describe('высота тулбара маршрута', () => {
    it('снимается сразу при маунте: ждать первого события наблюдателя нечего', () => {
        const heights: number[] = [];
        height = 99;
        mount((value) => heights.push(value));

        expect(heights).toEqual([99]);
    });

    it('перенос строк в тулбаре доезжает до вью', () => {
        const heights: number[] = [];
        height = 99;
        mount((value) => heights.push(value));

        height = 141;
        act(() => {
            for (const report of observers) {
                report();
            }
        });

        expect(heights.at(-1)).toBe(141);
    });
});

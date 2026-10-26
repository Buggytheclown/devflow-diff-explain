// @vitest-environment jsdom
import { fixtureIteration } from '@sherpa/fixtures';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createDiffViewStore } from '../diff-view/store.js';
import { buildFileFilters, selectFilter } from '../filters/lens-filters.js';
import { FullDiffToolbar } from './full-diff.tsx';
import { createT } from '../i18n/index.js';

const t = createT('ru');

/** Тулбар сам сообщает вью высоту, от которой считаются все липкие офсеты полного диффа. */

const DATA = fixtureIteration('medium');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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
            <FullDiffToolbar
                store={createDiffViewStore({ files: DATA.diff.files })}
                filters={filters}
                filter={selectFilter(filters, 'all')}
                onFilter={() => undefined}
                smallPr={false}
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

describe('высота тулбара полного диффа', () => {
    it('снимается сразу при маунте', () => {
        const heights: number[] = [];
        height = 50;
        mount((value) => heights.push(value));

        expect(heights).toEqual([50]);
    });

    it('изменение раскладки доезжает до вью', () => {
        const heights: number[] = [];
        height = 50;
        mount((value) => heights.push(value));

        height = 74;
        act(() => {
            for (const report of observers) {
                report();
            }
        });

        expect(heights.at(-1)).toBe(74);
    });
});

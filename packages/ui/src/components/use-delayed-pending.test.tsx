// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PENDING_DELAY_MS, useDelayedPending } from './use-delayed-pending.js';

/** Политика docs/design/SPEC-elements.md §3: индикатор ожидания не мигает на быстром ответе и гаснет без задержки. */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mounted: (() => void)[] = [];

beforeEach(() => {
    vi.useFakeTimers();
});

afterEach(() => {
    for (const unmount of mounted.splice(0)) {
        unmount();
    }
    vi.useRealTimers();
});

function mount(pending: boolean, delayMs?: number) {
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    const render = (next: boolean, nextDelay = delayMs): void => {
        act(() => {
            root.render(<Probe pending={next} delayMs={nextDelay} />);
        });
    };
    render(pending);
    mounted.push(() => {
        act(() => {
            root.unmount();
        });
        host.remove();
    });
    return { shown: (): boolean => host.textContent === 'да', render };
}

function Probe({ pending, delayMs }: { pending: boolean; delayMs?: number | undefined }) {
    return <>{useDelayedPending(pending, delayMs) ? 'да' : 'нет'}</>;
}

describe('useDelayedPending', () => {
    it('до порога молчит, после — зажигается', () => {
        const probe = mount(true);

        expect(probe.shown()).toBe(false);
        act(() => {
            vi.advanceTimersByTime(PENDING_DELAY_MS - 1);
        });
        expect(probe.shown()).toBe(false);
        act(() => {
            vi.advanceTimersByTime(1);
        });
        expect(probe.shown()).toBe(true);
    });

    it('быстрое ожидание не мигает вовсе', () => {
        const probe = mount(true);

        act(() => {
            vi.advanceTimersByTime(120);
        });
        probe.render(false);

        expect(probe.shown()).toBe(false);
        act(() => {
            vi.advanceTimersByTime(1000);
        });
        expect(probe.shown()).toBe(false);
    });

    it('гаснет сразу, а новое ожидание отсчитывает порог заново', () => {
        const probe = mount(true);
        act(() => {
            vi.advanceTimersByTime(PENDING_DELAY_MS);
        });
        expect(probe.shown()).toBe(true);

        probe.render(false);
        expect(probe.shown()).toBe(false);

        probe.render(true);
        expect(probe.shown()).toBe(false);
        act(() => {
            vi.advanceTimersByTime(PENDING_DELAY_MS);
        });
        expect(probe.shown()).toBe(true);
    });

    it('нулевая задержка показывает индикатор первым же кадром', () => {
        expect(mount(true, 0).shown()).toBe(true);
        expect(mount(false, 0).shown()).toBe(false);
    });
});

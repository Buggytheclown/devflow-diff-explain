// @vitest-environment jsdom
import { comment, human, thread } from '@sherpa/fixtures';
import type { Thread } from '@sherpa/protocol';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';

import { createThreadStore } from './store.js';
import { ThreadMarker } from './thread-marker.tsx';

/**
 * Маркер — один контрол на всю строку: на ней может стоять и обычный тред, и resolved,
 * у которых дефолт раскрытости разный. Клик обязан доставать скрытое, а не прятать видимое.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const FILE_ID = 'file-1';

function lineThread(id: string, resolved: boolean): Thread {
    return thread({
        id,
        resolved,
        anchor: { fileId: FILE_ID, path: 'src/order_service.py', position: { side: 'new', line: 48, size: 1 } },
        root: comment({
            id: `${id}-root`,
            author: human('kai', 'Kai Kennedy'),
            body: 'вопрос по строке',
            createdAt: '2026-08-24T10:00:00.000Z',
        }),
    });
}

function render(threads: readonly Thread[]) {
    const store = createThreadStore(threads, new Set([FILE_ID]));
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    // Мишень строки диффа: там на mousedown начинается выделение (`file-card` → `onSelectStart`).
    const rowMouseDown = vi.fn();
    const draw = (): void => {
        act(() => {
            root.render(
                <div onMouseDown={rowMouseDown}>
                    <ThreadMarker threads={threads} store={store} openThreads={store.getSnapshot().openThreads} />
                </div>,
            );
        });
    };
    draw();
    const click = (): void => {
        const button = container.querySelector('button');
        if (button === null) {
            throw new Error('маркер не нарисовался');
        }
        act(() => {
            button.click();
        });
        draw();
    };
    const expanded = (): string | null => container.querySelector('button')?.getAttribute('aria-expanded') ?? null;
    const mouseDown = (): void => {
        act(() => {
            container
                .querySelector('button')
                ?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
        });
    };
    return { store, click, expanded, mouseDown, rowMouseDown };
}

describe('маркер треда', () => {
    it('на строке с раскрытым и свёрнутым тредом первый клик раскрывает оба', () => {
        const open = lineThread('m-open', false);
        const closed = lineThread('m-resolved', true);
        const { store, click, expanded } = render([open, closed]);

        // Дефолт: обычный тред раскрыт, resolved свёрнут (docs/decisions.md, «Треды, issue и композер»).
        expect(store.isThreadOpen(open.id)).toBe(true);
        expect(store.isThreadOpen(closed.id)).toBe(false);
        expect(expanded()).toBe('false');

        click();
        expect(store.isThreadOpen(open.id)).toBe(true);
        expect(store.isThreadOpen(closed.id)).toBe(true);
        expect(expanded()).toBe('true');
    });

    it('mousedown по маркеру не доходит до строки и не начинает выделение', () => {
        const { mouseDown, rowMouseDown } = render([lineThread('m-only', false)]);

        mouseDown();

        expect(rowMouseDown).not.toHaveBeenCalled();
    });

    it('когда раскрыты все треды строки, клик сворачивает их вместе', () => {
        const first = lineThread('m1', false);
        const second = lineThread('m2', false);
        const { store, click, expanded } = render([first, second]);

        expect(expanded()).toBe('true');

        click();
        expect(store.isThreadOpen(first.id)).toBe(false);
        expect(store.isThreadOpen(second.id)).toBe(false);
        expect(expanded()).toBe('false');
    });
});

import { useEffect, useSyncExternalStore } from 'react';

import { useEscapeLayer } from '../shortcuts/context.tsx';
import type { DiffViewStore } from './store.js';

export function shouldClearSelectionOnPointerDown(target: EventTarget | null): boolean {
    return !(target instanceof Element) || target.closest('.diff-rows, .markdown-review, .selection-popover') === null;
}

/**
 * Жизненный цикл выделения строк (docs/design/SPEC-elements.md §2.14): протяжку начинает карточка, а заканчивают
 * события окна — отпущенная мышь, Esc и клик вне строк диффа.
 *
 * Хук нужен обоим вью: пока он жил внутри списка полного диффа, начатое на маршруте выделение
 * некому было закрыть, и панель действий пропадала навсегда.
 */
export function useSelectionLifecycle(store: DiffViewStore): void {
    // Выделение — младший слой лестницы Esc: палитра и поповеры поверх него закрываются первыми.
    const hasSelection =
        useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot).selection !== null;
    useEscapeLayer('selection', store.clearSelection, hasSelection);

    useEffect(() => {
        const onPointerDown = (event: MouseEvent): void => {
            if (shouldClearSelectionOnPointerDown(event.target)) {
                store.clearSelection();
            }
        };
        const onPointerUp = (): void => {
            store.finishSelection();
        };
        window.addEventListener('mousedown', onPointerDown);
        window.addEventListener('mouseup', onPointerUp);
        return () => {
            window.removeEventListener('mousedown', onPointerDown);
            window.removeEventListener('mouseup', onPointerUp);
            store.finishSelection();
        };
    }, [store]);
}

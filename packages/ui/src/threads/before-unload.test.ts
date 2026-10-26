import type { DraftBufferEntry } from '@sherpa/protocol';
import { describe, expect, it, vi } from 'vitest';

import { attachComposerBeforeUnload } from './before-unload.js';
import { createThreadStore } from './store.js';

function openComposer(store: ReturnType<typeof createThreadStore>): void {
    store.openComposer({
        key: 'new:pr',
        threadId: null,
        parentId: null,
        anchor: null,
        text: '',
        commentId: null,
        status: 'idle',
        slow: false,
        confirmDiscard: false,
        resolvedAtOpen: false,
    });
}

/** Запись буфера с этим текстом: ровно то, что уже лежит на сервере. */
function bufferEntry(body: string): DraftBufferEntry {
    return {
        id: 'ck-1',
        draft: { body, parentId: null, anchor: null },
        commentId: null,
        state: 'failed',
        error: 'хост прилёг',
        attempts: 1,
        createdAt: '2026-09-03T10:00:00.000Z',
        updatedAt: '2026-09-03T10:00:00.000Z',
    };
}

describe('предупреждение перед уходом', () => {
    it('ставит слушатель только на время несохранённых изменений', () => {
        const store = createThreadStore([], new Set());
        const addEventListener = vi.fn();
        const removeEventListener = vi.fn();
        const detach = attachComposerBeforeUnload(store, { addEventListener, removeEventListener });
        openComposer(store);

        store.updateComposer('new:pr', { text: 'черновик' });
        expect(addEventListener).toHaveBeenCalledOnce();

        store.updateComposer('new:pr', { commentId: 'draft-1', status: 'saved' });
        expect(removeEventListener).toHaveBeenCalledOnce();

        store.updateComposer('new:pr', { text: 'черновик с правкой', status: 'idle' });
        expect(addEventListener).toHaveBeenCalledTimes(2);

        store.closeComposer('new:pr');
        expect(removeEventListener).toHaveBeenCalledTimes(2);
        detach();
    });

    // Буферный текст уже на сервере: уходить с ним не страшно, диалог не нужен.
    it('не держит уход из-за черновика, который лежит в буфере сервера', () => {
        const store = createThreadStore([], new Set());
        const addEventListener = vi.fn();
        const removeEventListener = vi.fn();
        const detach = attachComposerBeforeUnload(store, { addEventListener, removeEventListener });
        openComposer(store);

        store.updateComposer('new:pr', { text: 'сохранится позже' });
        expect(addEventListener).toHaveBeenCalledOnce();

        store.updateComposer('new:pr', { status: 'buffered', bufferEntry: bufferEntry('сохранится позже') });
        expect(removeEventListener).toHaveBeenCalledOnce();

        // Дописанного после провала на сервере ещё нет: уход с ним теряет работу, и диалог нужен.
        store.updateComposer('new:pr', { text: 'сохранится позже и ещё абзац' });
        expect(addEventListener).toHaveBeenCalledTimes(2);
        detach();
    });

    it('отменяет beforeunload стандартным браузерным диалогом', () => {
        const store = createThreadStore([], new Set());
        const listeners: ((event: BeforeUnloadEvent) => void)[] = [];
        attachComposerBeforeUnload(store, {
            addEventListener: (_type, next) => {
                listeners.push(next);
            },
            removeEventListener: () => undefined,
        });
        openComposer(store);
        store.updateComposer('new:pr', { text: 'не потерять' });
        const preventDefault = vi.fn();
        const event = { preventDefault, returnValue: undefined as string | undefined };

        listeners[0]?.(event as unknown as BeforeUnloadEvent);

        expect(preventDefault).toHaveBeenCalledOnce();
        expect(event.returnValue).toBe('');
    });
});

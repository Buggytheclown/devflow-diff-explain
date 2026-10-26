import type { Thread } from '@sherpa/protocol';

import type { IterationLayout } from './model.js';
import { createThreadStore } from './store.js';
import type { ThreadStore } from './store.js';

/** Сторы живут дольше FullDiffView, чтобы смена таба не уничтожала текст и ошибки композеров. */
const stores = new Map<string, ThreadStore>();

export function persistentThreadStore(
    prKey: string,
    diffId: string,
    initial: readonly Thread[],
    fileIds: ReadonlySet<string>,
    iterationLayout: IterationLayout | null = null,
): ThreadStore {
    // Итерация исчерпывает стор: после пуша та же итерация становится прошлой, но стор остаётся
    // тот же — раскладку ему меняют через `setIterationLayout`, чтобы не терять открытые композеры.
    const key = `${prKey}\u0000${diffId}`;
    const existing = stores.get(key);
    if (existing !== undefined) {
        return existing;
    }
    const created = createThreadStore(initial, fileIds, iterationLayout);
    stores.set(key, created);
    return created;
}

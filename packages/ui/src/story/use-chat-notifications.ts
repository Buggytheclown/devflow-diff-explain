import type { ChatExchange } from '@sherpa/protocol';
import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { z } from 'zod';
import { readCache, writeCache } from './reading-cache.js';

const receiptsSchema = z.record(z.string(), z.string());
type Receipts = z.infer<typeof receiptsSchema>;
const completed = (exchange: ChatExchange) => exchange.status === 'done' && exchange.answer !== null;
const receipt = (exchange: ChatExchange) => `${String(exchange.taskId)}:${exchange.updatedAt}`;
const subscribeVisibility = (listener: () => void) => {
    document.addEventListener('visibilitychange', listener);
    return () => { document.removeEventListener('visibilitychange', listener); };
};
const pageVisible = () => document.visibilityState === 'visible';

/** Квитанции относятся к ответу, а не к максимальному id: ответы могут завершаться не по порядку. */
function createReceipts(prKey: string | null) {
    const key = `chat-read:${prKey ?? ''}`;
    let value: Receipts | undefined = prKey === null ? undefined : readCache(key, receiptsSchema);
    const listeners = new Set<() => void>();
    return {
        getSnapshot: () => value,
        subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
        acknowledge: (exchanges: readonly ChatExchange[]) => {
            if (prKey === null) return;
            const next = { ...value };
            let changed = value === undefined;
            for (const exchange of exchanges) {
                if (completed(exchange) && next[String(exchange.id)] !== receipt(exchange)) {
                    next[String(exchange.id)] = receipt(exchange); changed = true;
                }
            }
            if (!changed) return;
            value = next; writeCache(key, value);
            for (const listener of listeners) listener();
        },
    };
}

export function useChatNotifications({ prKey, exchanges, shown, loaded, open }: {
    prKey: string | null; exchanges: readonly ChatExchange[]; shown: readonly ChatExchange[]; loaded: boolean; open: boolean;
}): number {
    const store = useMemo(() => createReceipts(prKey), [prKey]);
    const receipts = useSyncExternalStore(store.subscribe, store.getSnapshot);
    const visible = useSyncExternalStore(subscribeVisibility, pageVisible);
    useEffect(() => {
        if (!loaded) return;
        // При первом запуске прежняя история не становится новой; пустая квитанция тоже сохраняется.
        if (receipts === undefined) store.acknowledge(exchanges);
        else if (open && visible) store.acknowledge(shown);
    }, [store, receipts, exchanges, shown, loaded, open, visible]);
    return receipts === undefined ? 0 : shown.filter((exchange) => completed(exchange) && receipts[String(exchange.id)] !== receipt(exchange)).length;
}

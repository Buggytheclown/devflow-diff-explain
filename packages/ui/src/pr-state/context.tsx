import type { UiPrState } from '@sherpa/protocol';
import type { ReactNode } from 'react';
import { createContext, useContext, useSyncExternalStore } from 'react';

import type { UiPrStateStore } from './pr-state-store.js';
import { createUiPrStateStore } from './pr-state-store.js';

/**
 * Запаска для дерева без провайдера (галерея, тесты компонентов): свёрнутость не должна требовать
 * сети, чтобы отрисовать компонент. Стор один на модуль — по стору на вызов хука нельзя:
 * компонент, который берёт и стор, и снапшот, писал бы в один экземпляр, а читал из другого.
 * Тесту, которому нужна своя изоляция, достаточно обернуть дерево в `PrStateProvider`.
 */
const fallbackStore = createUiPrStateStore();

/** Один стор состояния PR на страницу; провайдер ставится у корня (`main.tsx`). */
const PrStateContext = createContext<UiPrStateStore>(fallbackStore);

export function PrStateProvider({ store, children }: { store: UiPrStateStore; children: ReactNode }) {
    return <PrStateContext.Provider value={store}>{children}</PrStateContext.Provider>;
}

export function usePrStateStore(): UiPrStateStore {
    return useContext(PrStateContext);
}

export function usePrState(): UiPrState {
    const store = usePrStateStore();
    return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}

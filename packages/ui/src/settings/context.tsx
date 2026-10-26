import type { UiSettings } from '@sherpa/protocol';
import type { ReactNode } from 'react';
import { createContext, useContext, useSyncExternalStore } from 'react';

import type { UiSettingsStore } from './settings-store.js';
import { createUiSettingsStore } from './settings-store.js';

/**
 * Запаска для дерева без провайдера (галерея, тесты компонентов): настройки не должны требовать
 * сети, чтобы отрисовать компонент. Стор один на модуль — по стору на вызов хука нельзя:
 * компонент, который берёт и стор, и снапшот, писал бы в один экземпляр, а читал из другого.
 * Тесту, которому нужна своя изоляция, достаточно обернуть дерево в `SettingsProvider`.
 */
const fallbackStore = createUiSettingsStore({ loaded: true });

/** Один стор глобальных настроек на страницу; провайдер ставится у корня (`main.tsx`). */
const SettingsContext = createContext<UiSettingsStore>(fallbackStore);

export function SettingsProvider({ store, children }: { store: UiSettingsStore; children: ReactNode }) {
    return <SettingsContext.Provider value={store}>{children}</SettingsContext.Provider>;
}

export function useUiSettingsStore(): UiSettingsStore {
    return useContext(SettingsContext);
}

export function useUiSettings(): UiSettings {
    const store = useUiSettingsStore();
    return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}

/** Пришёл ли ответ сервера: до него в снапшоте умолчания, а не выбор ревьюера. */
export function useUiSettingsLoaded(): boolean {
    const store = useUiSettingsStore();
    return useSyncExternalStore(store.subscribe, store.isLoaded, store.isLoaded);
}

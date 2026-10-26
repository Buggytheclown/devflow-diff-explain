import type { UiSettings, UiSettingsPatch } from '@sherpa/protocol';
import { uiSettingsSchema } from '@sherpa/protocol';
import { describe, expect, it, vi } from 'vitest';

import { createUiSettingsStore, DEFAULT_UI_SETTINGS, loadUiSettings } from './settings-store.js';

/** Клиентская сторона глобальных настроек: оптимистичное применение и запись на сервер. */

function recording(): {
    readonly patches: UiSettingsPatch[];
    readonly send: (patch: UiSettingsPatch) => Promise<UiSettings>;
} {
    const patches: UiSettingsPatch[] = [];
    return {
        patches,
        send: (patch) => {
            patches.push(patch);
            return Promise.resolve(merged(patch));
        },
    };
}

/** Ответ ручки: сервер всегда отдаёт весь набор после слияния. */
function merged(patch: UiSettingsPatch): UiSettings {
    return uiSettingsSchema.parse({ ...DEFAULT_UI_SETTINGS, ...patch });
}

/** Записи уходят на сервер через цепочку промисов — им нужен прокрут микрозадач. */
async function flush(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('глобальные настройки UI', () => {
    it('без загрузки отдаёт умолчания контракта', () => {
        expect(createUiSettingsStore().getSnapshot()).toEqual({
            diffMode: 'unified',
            shipMode: 'ship',
            composerLayout: 'visual',
            locale: 'auto',
            theme: 'auto',
            arcanum: false,
            textSize: 'm',
            onboarding: { completedAt: null, step: 0 },
            updates: { dismissedVersion: null },
        });
    });

    it('применяет смену сразу и шлёт только названное поле', async () => {
        const { patches, send } = recording();
        const store = createUiSettingsStore({ send });
        const seen: string[] = [];
        store.subscribe(() => seen.push(store.getSnapshot().diffMode));

        store.update({ diffMode: 'split' });

        // Применение синхронное: ревьюер видит новый режим до всякой сети.
        expect(store.getSnapshot()).toMatchObject({ diffMode: 'split', shipMode: 'ship' });
        expect(seen).toEqual(['split']);

        await flush();
        expect(patches).toEqual([{ diffMode: 'split' }]);
    });

    it('поздняя загрузка не перебивает выбранную тему, запись сохраняет порядок переключений', async () => {
        const { patches, send } = recording();
        const store = createUiSettingsStore({ send });
        store.update({ theme: 'light' });
        store.applyLoaded(merged({ theme: 'dark', diffMode: 'split' }));
        expect(store.getSnapshot()).toMatchObject({ theme: 'light', diffMode: 'split' });
        store.update({ theme: 'dark' });
        await flush();
        expect(patches).toEqual([{ theme: 'light' }, { theme: 'dark' }]);
    });

    it('явный выбор до загрузки сохраняется даже при совпадении с первым HTML', async () => {
        const { patches, send } = recording();
        // HTML разрешил сохранённый Auto в light; это ещё не выбор явной Светлой темы.
        const store = createUiSettingsStore({ initial: { theme: 'light' }, send });
        store.update({ theme: 'light' });
        store.update({ theme: 'light' });
        store.applyLoaded(merged({ theme: 'auto', textSize: 'l' }));

        expect(store.getSnapshot()).toMatchObject({ theme: 'light', textSize: 'l' });
        await flush();
        expect(patches).toEqual([{ theme: 'light' }]);
    });

    it('переключатель Arcanum сохраняется отдельно и не теряется при позднем GET', async () => {
        const { patches, send } = recording();
        const store = createUiSettingsStore({ initial: { theme: 'light', arcanum: true }, send });
        store.update({ arcanum: false });
        store.applyLoaded(merged({ theme: 'auto', arcanum: true, textSize: 'l' }));
        expect(store.getSnapshot()).toMatchObject({ theme: 'auto', arcanum: false, textSize: 'l' });
        await flush();
        expect(patches).toEqual([{ arcanum: false }]);
    });

    it('повтор уже загруженного значения никуда не едет', async () => {
        const { patches, send } = recording();
        const store = createUiSettingsStore({ loaded: true, send });

        store.update({ diffMode: 'unified' });
        store.update({ shipMode: 'sticky_ship' });
        store.update({ shipMode: 'sticky_ship' });

        await flush();
        expect(patches).toEqual([{ shipMode: 'sticky_ship' }]);
    });

    it('провал записи не откатывает выбор', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const store = createUiSettingsStore({ send: () => Promise.reject(new Error('сервер молчит')) });

        store.update({ diffMode: 'split' });
        await vi.waitFor(() => {
            expect(warn).toHaveBeenCalled();
        });

        expect(store.getSnapshot().diffMode).toBe('split');
        warn.mockRestore();
    });

    it('записи не обгоняют друг друга', async () => {
        const order: string[] = [];
        let releaseFirst!: () => void;
        const first = new Promise<void>((resolve) => {
            releaseFirst = resolve;
        });
        const store = createUiSettingsStore({
            send: async (patch) => {
                const mode = patch.diffMode ?? 'unified';
                if (mode === 'split') {
                    await first;
                }
                order.push(mode);
                return merged(patch);
            },
        });

        store.update({ diffMode: 'split' });
        store.update({ diffMode: 'unified' });
        releaseFirst();
        await vi.waitFor(() => {
            expect(order).toHaveLength(2);
        });

        expect(order).toEqual(['split', 'unified']);
    });

    it('серверные настройки не перебивают то, что ревьюер уже поменял', () => {
        const store = createUiSettingsStore();
        store.update({ diffMode: 'split' });

        store.applyLoaded({
            diffMode: 'unified',
            shipMode: 'sticky_ship',
            composerLayout: 'markdown',
            locale: 'auto',
            theme: 'auto',
            arcanum: false,
            textSize: 'm',
            onboarding: { completedAt: null, step: 0 },
            updates: { dismissedVersion: null },
        });

        expect(store.getSnapshot()).toEqual({
            diffMode: 'split',
            shipMode: 'sticky_ship',
            composerLayout: 'markdown',
            locale: 'auto',
            theme: 'auto',
            arcanum: false,
            textSize: 'm',
            onboarding: { completedAt: null, step: 0 },
            updates: { dismissedVersion: null },
        });
    });

    it('загруженные настройки не считаются локальной сменой и никуда не едут', async () => {
        const { patches, send } = recording();
        const store = createUiSettingsStore({ send });

        await loadUiSettings(store, () =>
            Promise.resolve({
                diffMode: 'split',
                shipMode: 'ship',
                composerLayout: 'visual',
                locale: 'auto',
                theme: 'auto',
            arcanum: false,
                textSize: 'm',
                onboarding: { completedAt: null, step: 0 },
                updates: { dismissedVersion: null },
            }),
        );

        await flush();
        expect(store.getSnapshot().diffMode).toBe('split');
        expect(patches).toEqual([]);
    });

    it('недоступная ручка оставляет умолчания и не роняет UI', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const store = createUiSettingsStore();

        await loadUiSettings(store, () => Promise.reject(new Error('сервер не отвечает')));

        expect(store.getSnapshot()).toEqual(DEFAULT_UI_SETTINGS);
        // Ответа не было — умолчания остаются умолчаниями, и решать по ним нельзя.
        expect(store.isLoaded()).toBe(false);
        expect(warn).toHaveBeenCalled();
        warn.mockRestore();
    });

    it('ответ сервера поднимает флаг загрузки и будит подписчиков, даже совпав с умолчаниями', async () => {
        const store = createUiSettingsStore();
        let notified = 0;
        store.subscribe(() => {
            notified += 1;
        });

        expect(store.isLoaded()).toBe(false);
        await loadUiSettings(store, () => Promise.resolve({ ...DEFAULT_UI_SETTINGS }));

        expect(store.isLoaded()).toBe(true);
        expect(notified).toBe(1);
    });
});

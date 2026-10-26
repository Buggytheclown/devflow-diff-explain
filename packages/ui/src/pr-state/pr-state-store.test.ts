import type { UiPrState, UiPrStatePatch } from '@sherpa/protocol';
import { uiPrStateSchema } from '@sherpa/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    addRecentCommand,
    createUiPrStateStore,
    DEFAULT_UI_PR_STATE,
    PALETTE_RECENT_LIMIT,
    PR_STATE_SEND_DEBOUNCE_MS,
} from './pr-state-store.js';

/** Клиентская сторона состояния PR: оптимистичное применение, запись с задержкой до затишья, поздний boot-GET. */

function recording(): {
    readonly patches: UiPrStatePatch[];
    readonly keepalives: boolean[];
    readonly send: (patch: UiPrStatePatch, options?: { readonly keepalive?: boolean }) => Promise<UiPrState>;
} {
    const patches: UiPrStatePatch[] = [];
    const keepalives: boolean[] = [];
    return {
        patches,
        keepalives,
        send: (patch, options) => {
            patches.push(patch);
            keepalives.push(options?.keepalive === true);
            return Promise.resolve(merged(patch));
        },
    };
}

/** Ответ ручки: сервер всегда отдаёт состояние целиком после замены названных полей. */
function merged(patch: UiPrStatePatch): UiPrState {
    return uiPrStateSchema.parse({ ...DEFAULT_UI_PR_STATE, ...patch });
}

/** Отправка уходит цепочкой промисов — ей нужен прокрут микрозадач (с фейковыми таймерами тоже). */
async function settle(): Promise<void> {
    await Promise.resolve();
    await Promise.resolve();
}

afterEach(() => {
    vi.useRealTimers();
});

describe('состояние UI этого PR', () => {
    it('без загрузки отдаёт умолчания контракта', () => {
        expect(createUiPrStateStore().getSnapshot()).toEqual({
            treeCollapsed: {},
            diffCollapsed: {},
            paletteRecent: [],
        });
    });

    it('применяет смену сразу, шлёт после паузы и только названное поле', async () => {
        vi.useFakeTimers();
        const { patches, send } = recording();
        const store = createUiPrStateStore({ send });
        const seen: number[] = [];
        store.subscribe(() => seen.push(Object.keys(store.getSnapshot().treeCollapsed).length));

        store.update({ treeCollapsed: { 'src/api': true } });

        // Применение синхронное: дерево сворачивается до всякой сети.
        expect(store.getSnapshot().treeCollapsed).toEqual({ 'src/api': true });
        expect(seen).toEqual([1]);
        expect(patches).toEqual([]);

        vi.advanceTimersByTime(PR_STATE_SEND_DEBOUNCE_MS);
        await settle();
        expect(patches).toEqual([{ treeCollapsed: { 'src/api': true } }]);
    });

    it('два клика подряд уезжают одним запросом с последним значением', async () => {
        vi.useFakeTimers();
        const { patches, send } = recording();
        const store = createUiPrStateStore({ send });

        store.update({ treeCollapsed: { 'src/api': true } });
        store.update({ treeCollapsed: { 'src/api': true, 'src/ui': true } });
        vi.advanceTimersByTime(PR_STATE_SEND_DEBOUNCE_MS);
        await settle();

        expect(patches).toEqual([{ treeCollapsed: { 'src/api': true, 'src/ui': true } }]);
    });

    it('flush шлёт отложенное сразу и помечает запрос переживающим уход вкладки', async () => {
        vi.useFakeTimers();
        const { patches, keepalives, send } = recording();
        const store = createUiPrStateStore({ send });

        store.update({ paletteRecent: ['diff.toggleMode'] });
        store.flush();
        await settle();

        expect(patches).toEqual([{ paletteRecent: ['diff.toggleMode'] }]);
        expect(keepalives).toEqual([true]);

        // Отправленное не уедет второй раз по таймеру.
        vi.advanceTimersByTime(PR_STATE_SEND_DEBOUNCE_MS * 2);
        await settle();
        expect(patches).toHaveLength(1);
    });

    it('flush без отложенного ничего не шлёт', async () => {
        const { patches, send } = recording();
        const store = createUiPrStateStore({ send });

        store.flush();
        await settle();

        expect(patches).toEqual([]);
    });

    it('повтор того же значения никуда не едет', async () => {
        vi.useFakeTimers();
        const { patches, send } = recording();
        const store = createUiPrStateStore({ send, initial: { diffCollapsed: { f1: true } } });

        store.update({ diffCollapsed: { f1: true } });
        vi.advanceTimersByTime(PR_STATE_SEND_DEBOUNCE_MS);
        await settle();

        expect(patches).toEqual([]);
    });

    it('удаление ключа карты — это смена: поле уезжает целиком', async () => {
        vi.useFakeTimers();
        const { patches, send } = recording();
        const store = createUiPrStateStore({ send, initial: { treeCollapsed: { 'src/api': true } } });

        store.update({ treeCollapsed: {} });
        vi.advanceTimersByTime(PR_STATE_SEND_DEBOUNCE_MS);
        await settle();

        expect(store.getSnapshot().treeCollapsed).toEqual({});
        expect(patches).toEqual([{ treeCollapsed: {} }]);
    });

    it('провал записи не откатывает свёртку', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const store = createUiPrStateStore({ send: () => Promise.reject(new Error('сервер молчит')) });

        store.update({ diffCollapsed: { f1: true } });
        store.flush();
        await vi.waitFor(() => {
            expect(warn).toHaveBeenCalled();
        });

        expect(store.getSnapshot().diffCollapsed).toEqual({ f1: true });
        warn.mockRestore();
    });

    it('записи не обгоняют друг друга', async () => {
        vi.useFakeTimers();
        const order: string[] = [];
        let releaseFirst!: () => void;
        const first = new Promise<void>((resolve) => {
            releaseFirst = resolve;
        });
        const store = createUiPrStateStore({
            send: async (patch) => {
                const id = patch.paletteRecent?.[0] ?? '';
                if (id === 'a') {
                    await first;
                }
                order.push(id);
                return merged(patch);
            },
        });

        store.update({ paletteRecent: ['a'] });
        vi.advanceTimersByTime(PR_STATE_SEND_DEBOUNCE_MS);
        await settle();
        store.update({ paletteRecent: ['b'] });
        vi.advanceTimersByTime(PR_STATE_SEND_DEBOUNCE_MS);
        await settle();
        vi.useRealTimers();
        releaseFirst();
        await vi.waitFor(() => {
            expect(order).toHaveLength(2);
        });

        expect(order).toEqual(['a', 'b']);
    });

    it('flush переотправляет запись, которую сервер ещё не подтвердил', async () => {
        vi.useFakeTimers();
        const patches: UiPrStatePatch[] = [];
        const keepalives: boolean[] = [];
        const store = createUiPrStateStore({
            send: (patch, sendOptions) => {
                patches.push(patch);
                keepalives.push(sendOptions?.keepalive === true);
                // Запрос, который так и не долетел: ровно то, что делает с обычным fetch уход вкладки.
                return new Promise<UiPrState>(() => undefined);
            },
        });

        store.update({ treeCollapsed: { 'src/api': true } });
        vi.advanceTimersByTime(PR_STATE_SEND_DEBOUNCE_MS);
        await settle();
        expect(patches).toHaveLength(1);

        store.flush();
        await settle();

        expect(patches).toEqual([{ treeCollapsed: { 'src/api': true } }, { treeCollapsed: { 'src/api': true } }]);
        expect(keepalives).toEqual([false, true]);
    });

    it('flush не ждёт висящий запрос: keepalive уходит прямо в обработчике', () => {
        const patches: UiPrStatePatch[] = [];
        const store = createUiPrStateStore({
            send: (patch) => {
                patches.push(patch);
                return new Promise<UiPrState>(() => undefined);
            },
        });

        store.update({ paletteRecent: ['a'] });
        store.flush();
        store.update({ paletteRecent: ['b'] });
        store.flush();

        // Без единого прокрута микрозадач: очередь висит на первом запросе, а вкладка уже уходит.
        expect(patches).toEqual([{ paletteRecent: ['a'] }, { paletteRecent: ['b'] }]);
    });

    it('подтверждённое сервером не досылается', async () => {
        const { patches, send } = recording();
        const store = createUiPrStateStore({ send });

        store.update({ paletteRecent: ['a'] });
        store.flush();
        await settle();
        store.flush();
        await settle();

        expect(patches).toHaveLength(1);
    });

    it('пока boot-GET в пути, запись держится и уезжает поверх серверного состояния', async () => {
        vi.useFakeTimers();
        const { patches, send } = recording();
        const store = createUiPrStateStore({ send });
        let release!: (state: UiPrState) => void;
        const loaded = store.load(
            () =>
                new Promise<UiPrState>((resolve) => {
                    release = resolve;
                }),
        );

        store.update({ diffCollapsed: { f1: true } });
        vi.advanceTimersByTime(PR_STATE_SEND_DEBOUNCE_MS);
        await settle();
        // Карта, выросшая из умолчаний, стёрла бы серверные ключи: до ответа не пишем.
        expect(patches).toEqual([]);

        release(uiPrStateSchema.parse({ diffCollapsed: { f2: true } }));
        await loaded;
        await settle();

        expect(store.getSnapshot().diffCollapsed).toEqual({ f2: true, f1: true });
        expect(patches).toEqual([{ diffCollapsed: { f2: true, f1: true } }]);
    });

    it('провал boot-GET выключает запись: сохранённое состояние PR не затирается', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const { patches, send } = recording();
        const store = createUiPrStateStore({ send });

        await store.load(() => Promise.reject(new Error('сервер не отвечает')));
        store.update({ diffCollapsed: { f1: true } });
        store.flush();
        await settle();

        // Свёрнутость ревьюер видит, но на сервер она не поедет: там всё ещё чужие ключи.
        expect(store.getSnapshot().diffCollapsed).toEqual({ f1: true });
        expect(patches).toEqual([]);
        warn.mockRestore();
    });

    it('серверное состояние не перебивает выбор ревьюера, но и не теряет своих ключей', async () => {
        const store = createUiPrStateStore();
        store.update({ diffCollapsed: { f1: true }, paletteRecent: ['ui.toggleTree'] });

        await store.load(() =>
            Promise.resolve({
                treeCollapsed: { 'src/api': true },
                diffCollapsed: { f1: false, f2: true },
                paletteRecent: ['diff.toggleMode'],
            }),
        );

        expect(store.getSnapshot()).toEqual({
            // Нетронутое поле берётся с сервера целиком.
            treeCollapsed: { 'src/api': true },
            // Карта сливается по ключам: выбор ревьюера сверху, остальное серверное на месте.
            diffCollapsed: { f2: true, f1: true },
            // MRU-список сливать нечем: побеждает то, что ревьюер сделал только что.
            paletteRecent: ['ui.toggleTree'],
        });
    });

    it('загруженное состояние не считается локальной сменой и никуда не едет', async () => {
        const { patches, send } = recording();
        const store = createUiPrStateStore({ send });

        await store.load(() =>
            Promise.resolve({ treeCollapsed: { 'src/api': true }, diffCollapsed: {}, paletteRecent: [] }),
        );
        store.flush();
        await settle();

        expect(store.getSnapshot().treeCollapsed).toEqual({ 'src/api': true });
        expect(patches).toEqual([]);
    });

    it('недоступная ручка оставляет умолчания и не роняет UI', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const store = createUiPrStateStore();

        await store.load(() => Promise.reject(new Error('сервер не отвечает')));

        expect(store.getSnapshot()).toEqual(DEFAULT_UI_PR_STATE);
        expect(warn).toHaveBeenCalled();
        warn.mockRestore();
    });
});

describe('недавние команды палитры', () => {
    it('последняя впереди, повтор не двоится', () => {
        expect(addRecentCommand(['a', 'b'], 'c')).toEqual(['c', 'a', 'b']);
        expect(addRecentCommand(['a', 'b', 'c'], 'b')).toEqual(['b', 'a', 'c']);
    });

    it('длина держится под лимитом показа', () => {
        const ids = Array.from({ length: PALETTE_RECENT_LIMIT + 2 }, (_, index) => `command-${String(index)}`);
        const recent = ids.reduce<string[]>((list, id) => addRecentCommand(list, id), []);

        expect(recent).toHaveLength(PALETTE_RECENT_LIMIT);
        expect(recent[0]).toBe(ids[ids.length - 1]);
    });
});

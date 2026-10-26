import { describe, expect, it, vi } from 'vitest';

import { VIEWING_CURRENT } from '../iterations/viewing.js';

import {
    createSessionStore,
    EMPTY_NOTE_STACKS_EXPANDED,
    EMPTY_NOTES_EXPANDED,
    EMPTY_STOPS,
    isNoteExpanded,
    isNoteStackExpanded,
    parsePreset,
    parseRouteFilter,
} from './session-store.js';
import { DEFAULT_VIEW, parseViewId } from './views.js';

describe('сессионный стор', () => {
    it('стартовая вью — Обзор: маршрут при открытии ещё не готов', () => {
        expect(DEFAULT_VIEW).toBe('overview');

        // Так вью выбирается на старте в main.tsx: адрес сильнее дефолта, мусор в адресе — слабее.
        const fromUrl = (value: string | null) =>
            createSessionStore({ initial: { view: parseViewId(value) ?? DEFAULT_VIEW, filter: 'all' } })
                .getSnapshot().view;

        expect(fromUrl(null)).toBe('overview');
        expect(fromUrl('мусор')).toBe('overview');
        expect(fromUrl('route')).toBe('route');
    });

    it('отдаёт стабильный снапшот и меняет его на setView', () => {
        const store = createSessionStore({ initial: { view: 'route', filter: 'all' } });
        const first = store.getSnapshot();

        expect(store.getSnapshot()).toBe(first);

        store.setView('diff');
        expect(store.getSnapshot()).toEqual({
            view: 'diff',
            filter: 'all',
            preset: 'triage',
            routeFilter: 'all',
            viewing: VIEWING_CURRENT,
            threadAuthor: null,
            paletteOpen: false,
            chatOpen: false,
            notesExpanded: EMPTY_NOTES_EXPANDED,
            noteStacksExpanded: EMPTY_NOTE_STACKS_EXPANDED,
            stops: EMPTY_STOPS,
        });
    });

    it('пресет по умолчанию — триаж, меняется и переживает разбор фрагмента', () => {
        const persist = vi.fn();
        const store = createSessionStore({ initial: { view: 'route', filter: 'all' }, persist });

        expect(store.getSnapshot().preset).toBe('triage');

        store.setPreset('tour');
        store.setPreset('tour');

        expect(store.getSnapshot().preset).toBe('tour');
        expect(persist).toHaveBeenCalledTimes(1);
        expect(parsePreset('tour')).toBe('tour');
        expect(parsePreset('мусор')).toBeNull();
        expect(createSessionStore({ initial: { view: 'route', filter: 'all', preset: 'tour' } }).getSnapshot().preset).toBe(
            'tour',
        );
    });

    it('фильтр «что нового» по умолчанию выключен, меняется и переживает разбор фрагмента', () => {
        const persist = vi.fn();
        const store = createSessionStore({ initial: { view: 'route', filter: 'all' }, persist });

        expect(store.getSnapshot().routeFilter).toBe('all');

        store.setRouteFilter('new');
        store.setRouteFilter('new');

        expect(store.getSnapshot().routeFilter).toBe('new');
        expect(persist).toHaveBeenCalledTimes(1);
        expect(parseRouteFilter('new')).toBe('new');
        expect(parseRouteFilter('all')).toBe('all');
        expect(parseRouteFilter('мусор')).toBeNull();
        expect(
            createSessionStore({ initial: { view: 'route', filter: 'all', routeFilter: 'new' } }).getSnapshot()
                .routeFilter,
        ).toBe('new');
    });

    it('уведомляет подписчиков об изменении и молчит про повтор того же значения', () => {
        const store = createSessionStore({ initial: { view: 'overview', filter: 'all' } });
        const listener = vi.fn();
        store.subscribe(listener);

        store.setView('route');
        store.setView('route');

        expect(listener).toHaveBeenCalledTimes(1);
    });

    it('отдельно сообщает о каждом выборе вью, даже если выбрали текущую', () => {
        const store = createSessionStore({ initial: { view: 'diff', filter: 'all' } });
        const listener = vi.fn();
        store.subscribeViewSelection(listener);

        store.setView('diff');
        store.setView('route');

        expect(store.getViewSelectionSnapshot()).toBe(2);
        expect(listener).toHaveBeenCalledTimes(2);
    });

    it('отписка перестаёт получать уведомления', () => {
        const store = createSessionStore({ initial: { view: 'overview', filter: 'all' } });
        const listener = vi.fn();
        const unsubscribe = store.subscribe(listener);

        unsubscribe();
        store.setView('diff');

        expect(listener).not.toHaveBeenCalled();
    });

    it('persist вызывается на каждом изменении и получает новое состояние', () => {
        const persist = vi.fn();
        const store = createSessionStore({ initial: { view: 'overview', filter: 'all' }, persist });

        store.setView('diff');
        store.setView('diff');

        expect(persist.mock.calls).toEqual([
            [
                {
                    view: 'diff',
                    filter: 'all',
                    preset: 'triage',
                    routeFilter: 'all',
                    viewing: VIEWING_CURRENT,
                    threadAuthor: null,
                    paletteOpen: false,
                    chatOpen: false,
                    notesExpanded: EMPTY_NOTES_EXPANDED,
                    noteStacksExpanded: EMPTY_NOTE_STACKS_EXPANDED,
                    stops: EMPTY_STOPS,
                },
            ],
        ]);
    });

    it('снапшот не меняется, если менять нечего — useSyncExternalStore не перерисует зря', () => {
        const store = createSessionStore({ initial: { view: 'route', filter: 'all' } });
        const before = store.getSnapshot();

        store.setView('route');
        store.setFilter('all');

        expect(store.getSnapshot()).toBe(before);
    });

    it('фильтр меняется отдельно от вью и тоже уходит в persist', () => {
        const persist = vi.fn();
        const store = createSessionStore({ initial: { view: 'diff', filter: 'all' }, persist });

        store.setFilter('pci');

        const expected = {
            view: 'diff',
            filter: 'pci',
            preset: 'triage',
            routeFilter: 'all',
            viewing: VIEWING_CURRENT,
            threadAuthor: null,
            paletteOpen: false,
            chatOpen: false,
            notesExpanded: EMPTY_NOTES_EXPANDED,
            noteStacksExpanded: EMPTY_NOTE_STACKS_EXPANDED,
            stops: EMPTY_STOPS,
        };

        expect(store.getSnapshot()).toEqual(expected);
        expect(persist.mock.calls).toEqual([[expected]]);
    });

    it('открытость палитры живёт в сессии и не меняет остальные поля', () => {
        const store = createSessionStore({ initial: { view: 'diff', filter: 'all' } });

        store.setPaletteOpen(true);

        expect(store.getSnapshot()).toMatchObject({ view: 'diff', filter: 'all', paletteOpen: true });
    });

    it('открытость чата живёт в сессии и не уходит в отдельное хранилище', () => {
        const persist = vi.fn();
        const store = createSessionStore({ initial: { view: 'route', filter: 'all' }, persist });

        store.setChatOpen(true);
        store.setChatOpen(true);

        expect(store.getSnapshot().chatOpen).toBe(true);
        expect(persist).toHaveBeenCalledTimes(1);
    });

    it('развёрнутость заметки общая для обеих вью и живёт только в сессии', () => {
        const store = createSessionStore({ initial: { view: 'route', filter: 'all' } });

        expect(isNoteExpanded(store.getSnapshot(), 31)).toBe(false);
        store.toggleNoteExpanded(31);
        expect(isNoteExpanded(store.getSnapshot(), 31)).toBe(true);

        store.setView('diff');
        expect(isNoteExpanded(store.getSnapshot(), 31)).toBe(true);
        store.expandNote(31);
        expect(store.getSnapshot().notesExpanded).toEqual(new Set(['31']));

        store.toggleNoteExpanded(31);
        expect(isNoteExpanded(store.getSnapshot(), 31)).toBe(false);
    });

    it('раскрытие стопки переживает смену вью, а сворачивание закрывает её заметки', () => {
        const store = createSessionStore({ initial: { view: 'route', filter: 'all' } });
        const stackKey = 'file-1:new:41:43';

        store.setNoteStackExpanded(stackKey, true);
        store.expandNote(31);
        store.setView('diff');

        expect(isNoteStackExpanded(store.getSnapshot(), stackKey)).toBe(true);
        expect(isNoteExpanded(store.getSnapshot(), 31)).toBe(true);

        store.collapseNoteStack(stackKey, [31, 32]);

        expect(isNoteStackExpanded(store.getSnapshot(), stackKey)).toBe(false);
        expect(isNoteExpanded(store.getSnapshot(), 31)).toBe(false);
    });

    it('снятие отметки остановки не стирает прежнюю развёртку, а временную — стирает', () => {
        const store = createSessionStore({ initial: { view: 'route', filter: 'all' } });

        store.setStopExpanded('s05', true);
        store.setViewedStopExpanded('s05', true);

        expect(store.getSnapshot().stops).toEqual({
            expanded: new Set(['s05']),
            expandedViewed: new Set(['s05']),
            collapsed: new Set(),
            testCode: new Set(),
        });

        store.forgetViewedExpansion('s05');

        expect(store.getSnapshot().stops).toEqual({
            expanded: new Set(['s05']),
            expandedViewed: new Set(),
            collapsed: new Set(),
            testCode: new Set(),
        });
    });

    it('раскрытый тест-код дайджеста живёт отдельно от развёрток и свёрток', () => {
        const store = createSessionStore({ initial: { view: 'route', filter: 'all' } });

        store.setStopTestCode('s04', true);

        expect(store.getSnapshot().stops.testCode).toEqual(new Set(['s04']));
        expect(store.getSnapshot().stops.expanded).toEqual(new Set());
        expect(store.getSnapshot().stops.collapsed).toEqual(new Set());

        store.setStopTestCode('s04', false);
        expect(store.getSnapshot().stops.testCode).toEqual(new Set());
    });

    it('ручная свёртка остановки живёт отдельно от развёрток', () => {
        const store = createSessionStore({ initial: { view: 'route', filter: 'all' } });

        store.setStopCollapsed('s01', true);
        expect(store.getSnapshot().stops.collapsed).toEqual(new Set(['s01']));

        store.setStopCollapsed('s01', false);
        expect(store.getSnapshot().stops.collapsed).toEqual(new Set());
    });

    it('вью из адреса закреплена сразу, дефолтная — только после выбора ревьюера', () => {
        const fromUrl = createSessionStore({ initial: { view: 'route', filter: 'all' }, viewPinned: true });
        const byDefault = createSessionStore({ initial: { view: 'route', filter: 'all' } });

        expect(fromUrl.viewPinned()).toBe(true);
        expect(byDefault.viewPinned()).toBe(false);

        // Даже повторный выбор той же вью — выбор: приложение больше её не подменяет.
        byDefault.setView('route');
        expect(byDefault.viewPinned()).toBe(true);
    });
});

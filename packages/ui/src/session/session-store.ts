import type { Viewing } from '../iterations/viewing.js';
import { sameViewing, VIEWING_CURRENT } from '../iterations/viewing.js';
import type { ViewId } from './views.js';

/**
 * Сессионное состояние UI — то, что `docs/design/README.md` называет «Per session (UI)»: чем
 * смотрят на PR, а не что в PR лежит. Стор живёт вне React-дерева (docs/architecture.md §1,
 * паттерн pulldash): подписки плюс `useSyncExternalStore`, никаких эффектов на синхронизацию.
 *
 * В состоянии активная вью и выбранный фильтр файлов; механика обобщённая — новые поля
 * (панели, палитра) добавляются рядом.
 */

export const EMPTY_NOTES_EXPANDED: ReadonlySet<string> = new Set();
export const EMPTY_NOTE_STACKS_EXPANDED: ReadonlySet<string> = new Set();

export function isNoteExpanded(state: Pick<SessionState, 'notesExpanded'>, noteId: number | string): boolean {
    return state.notesExpanded.has(String(noteId));
}

export function isNoteStackExpanded(
    state: Pick<SessionState, 'noteStacksExpanded'>,
    stackKey: string,
): boolean {
    return state.noteStacksExpanded.has(stackKey);
}

/**
 * Развёртки остановок маршрута в текущей сессии. Наборы, а не один флаг: отметка
 * «просмотрено» сворачивает ханки, но не стирает прежнюю развёртку — снятие отметки обязано
 * вернуть карточку ровно в то состояние, в котором её оставили (docs/design/SPEC-elements.md §2.9).
 *
 * Сама отметка «просмотрено» здесь не живёт: она персистится per PR на сервере
 * (docs/design/README.md, «State model»), её держит `StopProgressStore`.
 *
 * `expanded` — остановка раскрыта вопреки свёртке по тиру (low свёрнут по умолчанию).
 * `expandedViewed` — просмотренная остановка временно раскрыта из строки-сводки.
 * `collapsed` — остановка свёрнута руками (шорткат `x`, §5), независимо от тира.
 * `testCode` — у дайджест-остановки раскрыт тест-код (docs/design/README.md §2). Набор, а не общий
 * флаг: дайджестов в маршруте бывает несколько, и раскрытый тест-код одного не должен
 * раскрывать чужой. Отметку «просмотрено» этот тогл не двигает — он чисто показывающий.
 */
export interface StopsState {
    readonly expanded: ReadonlySet<string>;
    readonly expandedViewed: ReadonlySet<string>;
    readonly collapsed: ReadonlySet<string>;
    readonly testCode: ReadonlySet<string>;
}

export const EMPTY_STOPS: StopsState = {
    expanded: new Set(),
    expandedViewed: new Set(),
    collapsed: new Set(),
    testCode: new Set(),
};

/**
 * Пресет маршрута (docs/design/README.md «State model», docs/design/SPEC-elements.md §2.5):
 * `triage` — план-порядок «сначала важное», `tour` — нарративный порядок чтения из `tourOrder`
 * снапшота. Номера остановок от пресета не зависят — они план-фиксированные (§8 п.4).
 */
export type RoutePreset = 'triage' | 'tour';

export const DEFAULT_PRESET: RoutePreset = 'triage';

/** `null` — строка не является пресетом (мусор во фрагменте URL). */
export function parsePreset(value: string | null): RoutePreset | null {
    return value === 'triage' || value === 'tour' ? value : null;
}

/**
 * Фильтр «что нового с прошлого захода» (docs/design/README.md §9): `new` оставляет
 * в маршруте только стопы с классификацией относительно предыдущего снапшота. Номера остановок
 * план-фиксированные, файловый фильтр применяется поверх.
 */
export type RouteFilter = 'all' | 'new';

export const DEFAULT_ROUTE_FILTER: RouteFilter = 'all';

/** `null` — строка не является фильтром маршрута (мусор во фрагменте URL). */
export function parseRouteFilter(value: string | null): RouteFilter | null {
    return value === 'all' || value === 'new' ? value : null;
}

export interface SessionState {
    readonly view: ViewId;
    /**
     * Что смотрит вкладка: текущее состояние PR, прошлый снапшот или итерация без маршрута.
     * Выбор клиентский и живёт во фрагменте адреса.
     */
    readonly viewing: Viewing;
    /** id фильтра файлов (docs/design/README.md §Filters). Одна модель на дерево, карточки и маршрут. */
    readonly filter: string;
    readonly preset: RoutePreset;
    readonly routeFilter: RouteFilter;
    /**
     * Линза «треды одного автора» на Полном диффе: логин участника, выбранного
     * в карточке обсуждения. Память вкладки — в адрес не пишется, смену PR и итерации
     * переживает, перезагрузку нет.
     */
    readonly threadAuthor: string | null;
    /** Командная палитра открыта поверх текущей вью. */
    readonly paletteOpen: boolean;
    /** Чат открыт в третьей колонке; живёт только в текущей сессии вкладки. */
    readonly chatOpen: boolean;
    /** Развёрнутые ИИ-заметки; общий набор для маршрута и полного диффа, без персиста. */
    readonly notesExpanded: ReadonlySet<string>;
    /** Раскрытые стопки заметок; ключ строится из файла, стороны и диапазона стопки. */
    readonly noteStacksExpanded: ReadonlySet<string>;
    readonly stops: StopsState;
}

export interface SessionStore {
    readonly subscribe: (listener: () => void) => () => void;
    readonly getSnapshot: () => SessionState;
    /** Каждая попытка выбрать вью, включая повторный выбор текущей. */
    readonly subscribeViewSelection: (listener: () => void) => () => void;
    readonly getViewSelectionSnapshot: () => number;
    /**
     * Вью выбрал ревьюер — ссылкой с параметром `view` или руками в этой сессии. Дефолтную вью
     * приложение вправе поменять под данные (малый PR открывается на полном диффе, docs/design/SPEC-elements.md §4.1),
     * выбранную — никогда.
     */
    readonly viewPinned: () => boolean;
    readonly setView: (view: ViewId) => void;
    readonly setFilter: (filter: string) => void;
    readonly setPreset: (preset: RoutePreset) => void;
    readonly setRouteFilter: (routeFilter: RouteFilter) => void;
    /**
     * `fragment` — ключи адреса, которые нужно задать тем же патчем, что и смену выбора:
     * иначе `viewingFragmentPatch` снимет их как якоря чужого диффа («показать на
     * старом коммите» задаёт `thread`).
     */
    readonly setViewing: (viewing: Viewing, fragment?: Readonly<Record<string, string | null>>) => void;
    /** `null` снимает линзу автора. */
    readonly setThreadAuthor: (login: string | null) => void;
    readonly setPaletteOpen: (open: boolean) => void;
    readonly setChatOpen: (open: boolean) => void;
    readonly toggleNoteExpanded: (noteId: number | string) => void;
    /** Принудительное раскрытие для перехода из чата к заметке. */
    readonly expandNote: (noteId: number | string) => void;
    readonly setNoteStackExpanded: (stackKey: string, expanded: boolean) => void;
    /** Закрывает стопку и все раскрытые заметки внутри неё одним обновлением. */
    readonly collapseNoteStack: (stackKey: string, noteIds: readonly (number | string)[]) => void;
    /** Развёртка остановки в покое (low-стопы свёрнуты по умолчанию). */
    readonly setStopExpanded: (stopId: string, expanded: boolean) => void;
    /** Развёртка просмотренной остановки из строки-сводки. */
    readonly setViewedStopExpanded: (stopId: string, expanded: boolean) => void;
    /** Ручная свёртка остановки любого тира. */
    readonly setStopCollapsed: (stopId: string, collapsed: boolean) => void;
    /** Show/Hide test code на дайджест-остановке (docs/design/README.md §2). */
    readonly setStopTestCode: (stopId: string, shown: boolean) => void;
    /**
     * Отметка снята: временная развёртка просмотренной остановки живёт только пока стоит
     * отметка, а прежняя развёртка (`expanded`) обязана вернуться нетронутой.
     */
    readonly forgetViewedExpansion: (stopId: string) => void;
}

export interface SessionStoreOptions {
    readonly initial: Omit<SessionState, 'threadAuthor' | 'paletteOpen' | 'chatOpen' | 'notesExpanded' | 'noteStacksExpanded' | 'stops' | 'preset' | 'routeFilter' | 'viewing'> & {
        readonly threadAuthor?: string | null;
        readonly routeFilter?: RouteFilter;
        readonly viewing?: Viewing;
        readonly paletteOpen?: boolean;
        readonly chatOpen?: boolean;
        readonly notesExpanded?: ReadonlySet<string>;
        readonly noteStacksExpanded?: ReadonlySet<string>;
        readonly stops?: StopsState;
        readonly preset?: RoutePreset;
    };
    /** Вью пришла из адреса, а не из умолчания: менять её под данные больше нельзя. */
    readonly viewPinned?: boolean;
    /**
     * Куда состояние утекает наружу сессии: на главной — во фрагмент URL, чтобы перезагрузка
     * вернула на тот же таб. Вызывается только при реальном изменении.
     */
    readonly persist?: (state: SessionState, fragment?: Readonly<Record<string, string | null>>) => void;
}

export function createSessionStore(options: SessionStoreOptions): SessionStore {
    const listeners = new Set<() => void>();
    const viewSelectionListeners = new Set<() => void>();
    let viewSelection = 0;
    let viewPinned = options.viewPinned ?? false;
    let state: SessionState = {
        ...options.initial,
        threadAuthor: options.initial.threadAuthor ?? null,
        paletteOpen: options.initial.paletteOpen ?? false,
        chatOpen: options.initial.chatOpen ?? false,
        notesExpanded: options.initial.notesExpanded ?? EMPTY_NOTES_EXPANDED,
        noteStacksExpanded: options.initial.noteStacksExpanded ?? EMPTY_NOTE_STACKS_EXPANDED,
        stops: options.initial.stops ?? EMPTY_STOPS,
        preset: options.initial.preset ?? DEFAULT_PRESET,
        routeFilter: options.initial.routeFilter ?? DEFAULT_ROUTE_FILTER,
        viewing: options.initial.viewing ?? VIEWING_CURRENT,
    };

    const toggleStop = (key: keyof StopsState, stopId: string, on: boolean): void => {
        const current = state.stops[key];
        if (current.has(stopId) === on) {
            return;
        }
        const next = new Set(current);
        if (on) {
            next.add(stopId);
        } else {
            next.delete(stopId);
        }
        update({ ...state, stops: { ...state.stops, [key]: next } });
    };

    // Патч фрагмента передаётся только когда он есть: persist без него видит один аргумент.
    const persist = (next: SessionState, fragment?: Readonly<Record<string, string | null>>): void => {
        if (fragment === undefined) {
            options.persist?.(next);
            return;
        }
        options.persist?.(next, fragment);
    };

    const update = (next: SessionState, fragment?: Readonly<Record<string, string | null>>): void => {
        state = next;
        persist(next, fragment);
        for (const listener of [...listeners]) {
            listener();
        }
    };

    const setNoteExpanded = (noteId: number | string, expanded: boolean): void => {
        const key = String(noteId);
        if (state.notesExpanded.has(key) === expanded) {
            return;
        }
        const notesExpanded = new Set(state.notesExpanded);
        if (expanded) {
            notesExpanded.add(key);
        } else {
            notesExpanded.delete(key);
        }
        update({ ...state, notesExpanded });
    };

    const setNoteStackExpanded = (stackKey: string, expanded: boolean): void => {
        if (state.noteStacksExpanded.has(stackKey) === expanded) {
            return;
        }
        const noteStacksExpanded = new Set(state.noteStacksExpanded);
        if (expanded) {
            noteStacksExpanded.add(stackKey);
        } else {
            noteStacksExpanded.delete(stackKey);
        }
        update({ ...state, noteStacksExpanded });
    };

    return {
        subscribe: (listener) => {
            listeners.add(listener);
            return () => {
                listeners.delete(listener);
            };
        },
        getSnapshot: () => state,
        subscribeViewSelection: (listener) => {
            viewSelectionListeners.add(listener);
            return () => {
                viewSelectionListeners.delete(listener);
            };
        },
        getViewSelectionSnapshot: () => viewSelection,
        viewPinned: () => viewPinned,
        setView: (view) => {
            viewPinned = true;
            viewSelection += 1;
            for (const listener of [...viewSelectionListeners]) {
                listener();
            }
            if (view !== state.view) {
                update({ ...state, view });
            }
        },
        setFilter: (filter) => {
            if (filter !== state.filter) {
                update({ ...state, filter });
            }
        },
        setPreset: (preset) => {
            if (preset !== state.preset) {
                update({ ...state, preset });
            }
        },
        setRouteFilter: (routeFilter) => {
            if (routeFilter !== state.routeFilter) {
                update({ ...state, routeFilter });
            }
        },
        setViewing: (viewing, fragment) => {
            if (!sameViewing(viewing, state.viewing)) {
                update({ ...state, viewing }, fragment);
            } else if (fragment !== undefined) {
                persist(state, fragment);
            }
        },
        setThreadAuthor: (threadAuthor) => {
            if (threadAuthor !== state.threadAuthor) {
                update({ ...state, threadAuthor });
            }
        },
        setPaletteOpen: (paletteOpen) => {
            if (paletteOpen !== state.paletteOpen) {
                update({ ...state, paletteOpen });
            }
        },
        setChatOpen: (chatOpen) => {
            if (chatOpen !== state.chatOpen) {
                update({ ...state, chatOpen });
            }
        },
        toggleNoteExpanded: (noteId) => {
            setNoteExpanded(noteId, !state.notesExpanded.has(String(noteId)));
        },
        expandNote: (noteId) => {
            setNoteExpanded(noteId, true);
        },
        setNoteStackExpanded,
        collapseNoteStack: (stackKey, noteIds) => {
            const noteKeys = new Set(noteIds.map(String));
            const stackChanged = state.noteStacksExpanded.has(stackKey);
            const notesChanged = [...noteKeys].some((noteId) => state.notesExpanded.has(noteId));
            if (!stackChanged && !notesChanged) {
                return;
            }
            const noteStacksExpanded = new Set(state.noteStacksExpanded);
            noteStacksExpanded.delete(stackKey);
            const notesExpanded = new Set(state.notesExpanded);
            for (const noteId of noteKeys) {
                notesExpanded.delete(noteId);
            }
            update({ ...state, noteStacksExpanded, notesExpanded });
        },

        setStopExpanded: (stopId, expanded) => {
            toggleStop('expanded', stopId, expanded);
        },
        setViewedStopExpanded: (stopId, expanded) => {
            toggleStop('expandedViewed', stopId, expanded);
        },
        setStopCollapsed: (stopId, collapsed) => {
            toggleStop('collapsed', stopId, collapsed);
        },
        setStopTestCode: (stopId, shown) => {
            toggleStop('testCode', stopId, shown);
        },
        forgetViewedExpansion: (stopId) => {
            toggleStop('expandedViewed', stopId, false);
        },
    };
}

import type { UiState } from '@sherpa/protocol';

import { activeT } from './i18n/index.js';
import {
    UI_CHAT_EVENT,
    UI_ENDPOINTS,
    UI_PROGRESS_EVENT,
    UI_REVIEW_EVENT,
    UI_ROUTE_EVENT,
    UI_STATE_EVENT,
    uiChatEventSchema,
    uiProgressEventSchema,
    uiReviewEventSchema,
    uiRouteEventSchema,
    uiStateSchema,
} from '@sherpa/protocol';

/**
 * Стор живёт вне React-дерева (docs/architecture.md §1): состояние приходит по SSE, React читает его
 * через `useSyncExternalStore`. Всё, что не прошло схему протокола, в стор не попадает.
 */

export type ConnectionState =
    /** Соединение ещё не дало первого снапшота. */
    | 'connecting'
    /** Снапшот получен, канал жив. */
    | 'online'
    /** Канал оборвался, браузер переподключается сам; последний снапшот остаётся на экране. */
    | 'reconnecting'
    /** Сервер прислал то, чего UI не понимает: дальше доверять каналу нельзя. */
    | 'fatal';

export interface StoreSnapshot {
    readonly connection: ConnectionState;
    readonly state: UiState | null;
    /** Текст фатальной ошибки; заполнен только при `fatal`. */
    readonly error: string | null;
    /**
     * Последняя ревизия прогресса чтения из канала; null — событие ещё не приходило.
     * Выросла против виденной вью — та перечитывает ручку прогресса.
     */
    readonly progressRevision: number | null;
    /** Последняя ревизия тредов; выросла — вью перечитывает снапшот тредов. */
    readonly threadsRevision: number | null;
    /** Последняя ревизия маршрута; выросла — вью перечитывает ручку `review/route`. */
    readonly routeRevision: number | null;
    /** Последняя ревизия чата и заметок; выросла — приложение перечитывает `review/chat`. */
    readonly chatRevision: number | null;
}

export interface Store {
    subscribe: (listener: () => void) => () => void;
    getSnapshot: () => StoreSnapshot;
    close: () => void;
}

export interface StreamHandlers {
    readonly onMessage: (data: string) => void;
    /** Событие `progress`: в нём едет только ревизия, данные вью перечитывает ручкой. */
    readonly onProgress: (data: string) => void;
    /** Событие `review`: в нём едет только ревизия тредов. */
    readonly onReview: (data: string) => void;
    /** Событие `route`: в нём едет только ревизия маршрута. */
    readonly onRoute: (data: string) => void;
    /** Событие `chat`: в нём едет только ревизия чата и заметок. */
    readonly onChat: (data: string) => void;
    /**
     * `recoverable: true` — канал переподключится сам (браузерный ретрай после обрыва потока);
     * `false` — соединение закрыто окончательно, повтор за стором.
     */
    readonly onError: (recoverable: boolean) => void;
}

export interface StreamConnection {
    readonly close: () => void;
}

export interface StoreOptions {
    readonly token: string;
    /** Подключение к SSE; в тестах подменяется, в браузере — `EventSource`. */
    readonly connect?: (url: string, handlers: StreamHandlers) => StreamConnection;
    /** Пауза перед своей попыткой переподключения; по умолчанию `RECONNECT_DELAY_MS`. */
    readonly reconnectDelayMs?: number;
}

/** Пауза перед своей попыткой переподключения: браузер повторяет не всегда (см. `onError`). */
const RECONNECT_DELAY_MS = 2000;

export function createStore(options: StoreOptions): Store {
    const listeners = new Set<() => void>();
    let snapshot: StoreSnapshot = {
        connection: 'connecting',
        state: null,
        error: null,
        progressRevision: null,
        threadsRevision: null,
        routeRevision: null,
        chatRevision: null,
    };
    let closed = false;

    const update = (next: StoreSnapshot): void => {
        snapshot = next;
        for (const listener of [...listeners]) {
            listener();
        }
    };

    const connect = options.connect ?? connectEventSource;
    const reconnectDelayMs = options.reconnectDelayMs ?? RECONNECT_DELAY_MS;
    const url = `${UI_ENDPOINTS.events}?token=${encodeURIComponent(options.token)}`;

    let connection: StreamConnection | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;

    const handlers: StreamHandlers = {
        onMessage: (data) => {
            if (closed || snapshot.connection === 'fatal') {
                return;
            }

            const state = parseState(data);
            if (state === null) {
                update({ ...snapshot, connection: 'fatal', error: activeT()('error.invalidState') });
                // Канал больше не источник правды — переподключаться к нему бессмысленно.
                connection?.close();
                return;
            }
            update({ ...snapshot, connection: 'online', state, error: null });
        },
        onProgress: (data) => {
            if (closed || snapshot.connection === 'fatal') {
                return;
            }
            // Fail-closed: не прошло схему — в стор не попадает. Ревизия прогресса не состояние
            // канала, поэтому одно кривое событие не повод объявлять его мёртвым.
            const revision = parseProgressRevision(data);
            if (revision !== null && revision !== snapshot.progressRevision) {
                update({ ...snapshot, progressRevision: revision });
            }
        },
        onReview: (data) => {
            if (closed || snapshot.connection === 'fatal') {
                return;
            }
            const revision = parseThreadsRevision(data);
            if (revision !== null && revision !== snapshot.threadsRevision) {
                update({ ...snapshot, threadsRevision: revision });
            }
        },
        onRoute: (data) => {
            if (closed || snapshot.connection === 'fatal') {
                return;
            }
            const revision = parseRouteRevision(data);
            if (revision !== null && revision !== snapshot.routeRevision) {
                update({ ...snapshot, routeRevision: revision });
            }
        },
        onChat: (data) => {
            if (closed || snapshot.connection === 'fatal') {
                return;
            }
            const revision = parseChatRevision(data);
            if (revision !== null && revision !== snapshot.chatRevision) {
                update({ ...snapshot, chatRevision: revision });
            }
        },
        onError: (recoverable) => {
            if (closed || snapshot.connection === 'fatal') {
                return;
            }
            if (snapshot.connection !== 'reconnecting') {
                update({ ...snapshot, connection: 'reconnecting', error: null });
            }
            if (recoverable) {
                return;
            }

            // Соединение закрыто окончательно (сервер не отвечает) — повторяем сами.
            connection?.close();
            retry = setTimeout(open, reconnectDelayMs);
        },
    };

    function open(): void {
        retry = null;
        if (closed) {
            return;
        }
        connection = connect(url, handlers);
    }

    open();

    return {
        subscribe: (listener) => {
            listeners.add(listener);
            return () => {
                listeners.delete(listener);
            };
        },
        getSnapshot: () => snapshot,
        close: () => {
            closed = true;
            listeners.clear();
            if (retry !== null) {
                clearTimeout(retry);
                retry = null;
            }
            connection?.close();
        },
    };
}

/** `null` — данные не прошли схему протокола (fail-closed). */
function parseState(data: string): UiState | null {
    let payload: unknown;
    try {
        payload = JSON.parse(data);
    } catch {
        return null;
    }

    const parsed = uiStateSchema.safeParse(payload);
    return parsed.success ? parsed.data : null;
}

/** `null` — событие не прошло схему протокола (fail-closed). */
function parseProgressRevision(data: string): number | null {
    let payload: unknown;
    try {
        payload = JSON.parse(data);
    } catch {
        return null;
    }

    const parsed = uiProgressEventSchema.safeParse(payload);
    return parsed.success ? parsed.data.progressRevision : null;
}

/** `null` — событие ревью не прошло схему протокола. */
function parseThreadsRevision(data: string): number | null {
    let payload: unknown;
    try {
        payload = JSON.parse(data);
    } catch {
        return null;
    }

    const parsed = uiReviewEventSchema.safeParse(payload);
    return parsed.success ? parsed.data.threadsRevision : null;
}

/** `null` — событие маршрута не прошло схему протокола. */
function parseRouteRevision(data: string): number | null {
    let payload: unknown;
    try {
        payload = JSON.parse(data);
    } catch {
        return null;
    }

    const parsed = uiRouteEventSchema.safeParse(payload);
    return parsed.success ? parsed.data.routeRevision : null;
}

/** `null` — событие чата не прошло схему протокола. */
function parseChatRevision(data: string): number | null {
    let payload: unknown;
    try {
        payload = JSON.parse(data);
    } catch {
        return null;
    }

    const parsed = uiChatEventSchema.safeParse(payload);
    return parsed.success ? parsed.data.chatRevision : null;
}

function connectEventSource(url: string, handlers: StreamHandlers): StreamConnection {
    const source = new EventSource(url);
    // Имя события не входит в `EventSourceEventMap`, поэтому слушатель получает базовый `Event`.
    source.addEventListener(UI_STATE_EVENT, (event) => {
        handlers.onMessage((event as MessageEvent<string>).data);
    });
    source.addEventListener(UI_PROGRESS_EVENT, (event) => {
        handlers.onProgress((event as MessageEvent<string>).data);
    });
    source.addEventListener(UI_REVIEW_EVENT, (event) => {
        handlers.onReview((event as MessageEvent<string>).data);
    });
    source.addEventListener(UI_ROUTE_EVENT, (event) => {
        handlers.onRoute((event as MessageEvent<string>).data);
    });
    source.addEventListener(UI_CHAT_EVENT, (event) => {
        handlers.onChat((event as MessageEvent<string>).data);
    });
    source.addEventListener('error', () => {
        // Обрыв уже установленного потока браузер повторяет сам, а вот неудачную попытку
        // подключения (сервер не поднят) — нет: там `readyState` сразу `CLOSED`.
        handlers.onError(source.readyState !== EventSource.CLOSED);
    });

    return {
        close: () => {
            source.close();
        },
    };
}

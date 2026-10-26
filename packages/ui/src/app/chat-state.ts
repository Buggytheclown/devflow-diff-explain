/** Состояние ленты чата на вкладке: слияние серверного ответа с оптимистичными правками. */
import type { UiChatAskAnchor, UiChatResponse } from '@sherpa/protocol';

import type { ChatScrollTarget } from '../components/chat-panel.tsx';
import type { SessionStore } from '../session/session-store.js';

export interface ChatState {
    readonly key: string;
    readonly data: UiChatResponse | null;
    readonly error: string | null;
    readonly loading: boolean;
}

export interface ChatScrollRequest {
    readonly id: number;
    readonly target: ChatScrollTarget;
}

/** Открывает панель и возвращает явную цель ленты для обмена. */
export function openExchangeInChatRequest(
    session: SessionStore,
    exchangeId: number,
    id: number,
): ChatScrollRequest {
    session.setChatOpen(true);
    return { id, target: { kind: 'exchange', exchangeId } };
}

export interface ChatComposerContext {
    readonly key: string;
    readonly anchor: UiChatAskAnchor | null;
    readonly latched: boolean;
}

export const EMPTY_CHAT_RESPONSE: UiChatResponse = { exchanges: [], notes: [], chatRevision: 0 };

export function emptyChatState(key: string, loading: boolean): ChatState {
    return { key, data: null, error: null, loading };
}

export function chatStateForKey(current: ChatState, key: string): ChatState {
    return current.key === key ? current : emptyChatState(key, true);
}

export function mergeChatResponse(
    server: UiChatResponse,
    local: UiChatResponse | null,
    pendingNoteDeletions: ReadonlySet<number> = EMPTY_NOTE_DELETIONS,
): UiChatResponse {
    const notes = server.notes.filter((note) => !pendingNoteDeletions.has(note.id));
    if (local === null) {
        return { ...server, notes };
    }
    const exchanges = new Map(server.exchanges.map((exchange) => [exchange.id, exchange]));
    for (const exchange of local.exchanges) {
        const fromServer = exchanges.get(exchange.id);
        if (fromServer === undefined || Date.parse(exchange.updatedAt) > Date.parse(fromServer.updatedAt)) {
            exchanges.set(exchange.id, exchange);
        }
    }
    return { ...server, notes, exchanges: [...exchanges.values()] };
}

export function withoutChatNote(data: UiChatResponse, noteId: number): UiChatResponse {
    return { ...data, notes: data.notes.filter((note) => note.id !== noteId) };
}

export function updateChatExchange(
    current: ChatState,
    key: string,
    exchangeId: number,
    status: UiChatResponse['exchanges'][number]['status'],
): ChatState {
    const next = chatStateForKey(current, key);
    const data = next.data ?? EMPTY_CHAT_RESPONSE;
    return {
        ...next,
        data: {
            ...data,
            exchanges: data.exchanges.map((exchange) =>
                exchange.id === exchangeId
                    ? {
                          ...exchange,
                          status,
                          answer: status === 'done' ? exchange.answer : null,
                          progressText: null,
                          error: null,
                          updatedAt: new Date().toISOString(),
                      }
                    : exchange,
            ),
        },
    };
}

export const EMPTY_NOTE_DELETIONS: ReadonlySet<number> = new Set();

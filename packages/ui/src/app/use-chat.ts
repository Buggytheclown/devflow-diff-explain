import type { AgentNote, ChatAnchor, ChatExchange, Locale, PrDiff, UiChatAskAnchor } from '@sherpa/protocol';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
    ApiError,
    askReviewChat,
    cancelReviewChat,
    deleteReviewChatNote,
    fetchReviewChat,
    retryReviewChat,
} from '../api.js';
import type { ChatScrollTarget } from '../components/chat-panel.tsx';
import { sameChatAnchor } from '../components/chat-panel.tsx';
import { selectionAskDisabled } from '../components/selection-popover.tsx';
import { noteAnchorForIteration, notesForIteration, noteVisibleInIteration } from '../notes/model.js';
import type { PaletteChat } from '../palette/command-palette.tsx';
import { selectionLinkHash } from '../selection-link.js';
import type { SessionStore } from '../session/session-store.js';
import type { ViewId } from '../session/views.js';
import { useShortcut } from '../shortcuts/context.tsx';
import type { ChatComposerContext, ChatScrollRequest, ChatState } from './chat-state.js';
import {
    chatStateForKey,
    EMPTY_CHAT_RESPONSE,
    EMPTY_NOTE_DELETIONS,
    emptyChatState,
    mergeChatResponse,
    openExchangeInChatRequest,
    updateChatExchange,
    withoutChatNote,
} from './chat-state.js';
import { errorMessage } from './review-state.js';

export interface UseChatOptions {
    readonly chatKey: string;
    readonly token: string;
    readonly uiLocale: Locale;
    readonly session: SessionStore;
    readonly reviewHost: string | null;
    readonly reviewReady: boolean;
    readonly chatRevision: number | null;
    readonly view: ViewId;
    readonly notesDiffId: string | null;
    readonly sliceBase: string | null;
    readonly currentDiff: PrDiff | null;
    readonly now: number;
    readonly agentConnected: boolean;
}

const EMPTY_NOTES: readonly AgentNote[] = [];

/**
 * Панель чата целиком: история и её перечитка, композер с якорем, заметки в коде и переходы
 * между лентой и кодом. Чат ходит своей ручкой и держит собственный `seenChat`, поэтому
 * порядок его эффекта относительно прочих ручек ревью ни на что не влияет.
 */
export function useChat({
    chatKey,
    token,
    uiLocale,
    session,
    reviewHost,
    reviewReady,
    chatRevision,
    view,
    notesDiffId,
    sliceBase,
    currentDiff,
    now,
    agentConnected,
}: UseChatOptions) {
    const [chatState, setChatState] = useState<ChatState>(() => emptyChatState(chatKey, reviewHost !== null));
    const currentChat = chatState.key === chatKey ? chatState : emptyChatState(chatKey, reviewHost !== null);
    const chatData = currentChat.data ?? EMPTY_CHAT_RESPONSE;
    const pendingNoteDeletions = useRef<{ key: string; ids: Set<number> }>({ key: chatKey, ids: new Set() });
    const [chatComposerContext, setChatComposerContext] = useState<ChatComposerContext>(() => ({
        key: chatKey,
        anchor: null,
        latched: false,
    }));
    const currentChatComposer =
        chatComposerContext.key === chatKey
            ? chatComposerContext
            : { key: chatKey, anchor: null, latched: false } satisfies ChatComposerContext;
    const [chatFocusRequest, setChatFocusRequest] = useState(0);
    // Подстановка вопроса в композер: запрос с новым id срабатывает и на том же тексте.
    const [chatPrefillRequest, setChatPrefillRequest] = useState<{ readonly id: number; readonly text: string } | null>(
        null,
    );
    const chatPrefillRequestId = useRef(0);
    const [chatScrollRequest, setChatScrollRequest] = useState<ChatScrollRequest | null>(null);
    const chatScrollRequestId = useRef(0);
    const [chatAnchorNavigationRequest, setChatAnchorNavigationRequest] = useState(0);
    const [noteFocusRequest, setNoteFocusRequest] = useState<{ readonly id: number; readonly noteId: number } | null>(null);
    const noteFocusRequestId = useRef(0);
    // История чата читается при открытии PR и перечитывается только после выросшей SSE-ревизии.
    const seenChat = useRef<{ key: string; revision: number | null; loaded: boolean }>({
        key: chatKey,
        revision: null,
        loaded: false,
    });
    const [chatRetry, setChatRetry] = useState<{ key: string; attempt: number }>({ key: chatKey, attempt: 0 });
    const chatRetryAttempt = chatRetry.key === chatKey ? chatRetry.attempt : 0;
    useEffect(() => {
        if (!reviewReady || reviewHost === null) {
            return;
        }
        if (seenChat.current.key !== chatKey) {
            seenChat.current = { key: chatKey, revision: null, loaded: false };
        }
        const revision = chatRevision;
        if (seenChat.current.loaded && seenChat.current.revision === revision) {
            return;
        }

        let alive = true;
        let retry: ReturnType<typeof setTimeout> | null = null;
        void fetchReviewChat(token).then(
            (response) => {
                if (!alive) {
                    return;
                }
                seenChat.current = { key: chatKey, revision, loaded: true };
                setChatState((current) => ({
                    key: chatKey,
                    data: mergeChatResponse(
                        response,
                        chatStateForKey(current, chatKey).data,
                        pendingNoteDeletions.current.key === chatKey
                            ? pendingNoteDeletions.current.ids
                            : EMPTY_NOTE_DELETIONS,
                    ),
                    error: null,
                    loading: false,
                }));
                if (chatRetryAttempt !== 0) {
                    setChatRetry({ key: chatKey, attempt: 0 });
                }
            },
            (error: unknown) => {
                if (!alive) {
                    return;
                }
                if (error instanceof ApiError && error.status === 404) {
                    seenChat.current = { key: chatKey, revision, loaded: true };
                    setChatState({ key: chatKey, data: EMPTY_CHAT_RESPONSE, error: null, loading: false });
                    return;
                }
                setChatState((current) => {
                    const next = chatStateForKey(current, chatKey);
                    return {
                        ...next,
                        // Фоновый провал не стирает уже показанную историю.
                        error: next.data === null ? errorMessage(error) : null,
                        loading: false,
                    };
                });
                retry = setTimeout(() => {
                    setChatRetry({ key: chatKey, attempt: chatRetryAttempt + 1 });
                }, Math.min(1000 * 2 ** chatRetryAttempt, 15_000));
            },
        );
        return () => {
            alive = false;
            if (retry !== null) {
                clearTimeout(retry);
            }
        };
    }, [chatKey, chatRetryAttempt, reviewHost, reviewReady, chatRevision, token]);
    const openNoteInChat = useCallback(
        (note: AgentNote) => {
            chatScrollRequestId.current += 1;
            setChatScrollRequest(openExchangeInChatRequest(session, note.exchangeId, chatScrollRequestId.current));
        },
        [session],
    );
    /**
     * Заметки, потерявшие якорь после пуша. Дизмисс баннера живёт в сессии вкладки и
     * снимается сам, как только якорь потеряет ещё одна заметка.
     */
    const lostNotes = useMemo(() => chatData.notes.filter((note) => note.lostAnchor), [chatData.notes]);
    const lostNoteIds = useMemo(() => lostNotes.map((note) => note.id), [lostNotes]);
    /** «Показать» ведёт к первой потерявшей якорь заметке — в порядке ленты чата. */
    const firstLostNote = lostNotes[0];
    /**
     * В код уходят заметки этой итерации: с её якорями и без потерявших якорь.
     * В срезе заметок у кода нет — их якоря стоят на `fileId` итерации, а у среза они свои.
     */
    const notesInCode = useMemo(
        () => (sliceBase === null ? notesForIteration(chatData.notes, notesDiffId) : EMPTY_NOTES),
        [chatData.notes, notesDiffId, sliceBase],
    );
    const isSelectionPending = useCallback(
        (anchor: UiChatAskAnchor | null): boolean =>
            anchor !== null &&
            chatData.exchanges.some(
                (exchange) =>
                    (exchange.status === 'queued' || exchange.status === 'running') &&
                    sameChatAnchor(exchange.anchor, anchor),
            ),
        [chatData.exchanges],
    );
    /**
     * Текущее выделение строк как якорь вопроса. Хранится ref-ом рядом с защёлкой композера:
     * клавише `a` нужен именно живой диапазон, а не защёлкнутый в панели чата.
     */
    const selectionAnchor = useRef<UiChatAskAnchor | null>(null);
    const selectChatAnchor = useCallback(
        (anchor: UiChatAskAnchor | null) => {
            selectionAnchor.current = anchor;
            setChatComposerContext((current) => {
                const next = current.key === chatKey ? current : { key: chatKey, anchor: null, latched: false };
                return next.latched ? next : { ...next, anchor };
            });
        },
        [chatKey],
    );
    /**
     * Общая точка входа в чат: якорь защёлкивается, вопрос подставляется, но не уходит — ⏎ жмёт
     * ревьюер (docs/design/README.md §2, §10). Без текста это просто открытие панели под выделение.
     */
    const openChatWithQuestion = useCallback(
        (text: string | null, anchor: UiChatAskAnchor | null) => {
            setChatComposerContext({ key: chatKey, anchor, latched: anchor !== null });
            session.setChatOpen(true);
            if (text !== null) {
                chatPrefillRequestId.current += 1;
                setChatPrefillRequest({ id: chatPrefillRequestId.current, text });
            }
            setChatFocusRequest((request) => request + 1);
        },
        [chatKey, session],
    );
    const openChatForSelection = useCallback(
        (anchor: UiChatAskAnchor) => {
            openChatWithQuestion(null, anchor);
        },
        [openChatWithQuestion],
    );
    useShortcut({
        id: 'agent.ask',
        keys: ['a'],
        label: 'shortcut.agent.ask',
        scope: 'global',
        section: 'agent',
        consequence: 'shortcut.agent.ask.consequence',
        when: () => selectionAnchor.current === null || !selectionAskDisabled(agentConnected),
        action: () => {
            const anchor = selectionAnchor.current;
            // Без выделения вопрос про PR целиком: тот же композер, просто без якоря.
            openChatWithQuestion(null, anchor);
        },
    });
    /** «Прочее» на Маршруте: диапазонов много, а якорь у вопроса один — они перечислены текстом. */
    const composeRouteQuestion = useCallback(
        (text: string) => {
            openChatWithQuestion(text, null);
        },
        [openChatWithQuestion],
    );
    /** Штрихованная полоса Full diff: якорь — ровно её диапазон. */
    const composeDiffQuestion = useCallback(
        (text: string, anchor?: UiChatAskAnchor) => {
            openChatWithQuestion(text, anchor ?? null);
        },
        [openChatWithQuestion],
    );
    const closeChat = useCallback(() => {
        setChatScrollRequest(null);
        // Подстановка живёт ровно пока открыта панель: иначе следующее открытие чата переписало бы
        // композер вопросом, который ревьюер уже видел.
        setChatPrefillRequest(null);
        session.setChatOpen(false);
    }, [session]);
    const toggleChat = useCallback(
        (target: ChatScrollTarget | null) => {
            if (session.getSnapshot().chatOpen) {
                closeChat();
                return;
            }
            session.setChatOpen(true);
            if (target === null) {
                setChatScrollRequest(null);
                return;
            }
            chatScrollRequestId.current += 1;
            setChatScrollRequest({ id: chatScrollRequestId.current, target });
        },
        [closeChat, session],
    );
    const handleChatScrollRequest = useCallback((id: number) => {
        setChatScrollRequest((current) => (current?.id === id ? null : current));
    }, []);
    const askChat = useCallback(
        async (text: string, anchor?: UiChatAskAnchor) => {
            const exchange = await askReviewChat(token, text, anchor, uiLocale);
            setChatState((current) => {
                const next = chatStateForKey(current, chatKey);
                const data = next.data ?? EMPTY_CHAT_RESPONSE;
                return {
                    key: chatKey,
                    error: null,
                    loading: false,
                    data: {
                        ...data,
                        exchanges: [...data.exchanges.filter((candidate) => candidate.id !== exchange.id), exchange],
                    },
                };
            });
            return exchange;
        },
        [chatKey, token, uiLocale],
    );
    const cancelChat = useCallback(
        async (exchangeId: number): Promise<void> => {
            if ((await cancelReviewChat(token, exchangeId)) !== 'cancelled') {
                return;
            }
            setChatState((current) => updateChatExchange(current, chatKey, exchangeId, 'cancelled'));
        },
        [chatKey, token],
    );
    const retryChat = useCallback(
        async (exchangeId: number): Promise<void> => {
            if ((await retryReviewChat(token, exchangeId)) !== 'retried') {
                return;
            }
            setChatState((current) => updateChatExchange(current, chatKey, exchangeId, 'queued'));
        },
        [chatKey, token],
    );
    const deleteNote = useCallback(
        async (noteId: number): Promise<void> => {
            const pending =
                pendingNoteDeletions.current.key === chatKey
                    ? pendingNoteDeletions.current
                    : { key: chatKey, ids: new Set<number>() };
            pendingNoteDeletions.current = pending;
            if (pending.ids.has(noteId)) {
                return;
            }
            pending.ids.add(noteId);
            const removed = chatData.notes.find((note) => note.id === noteId) ?? null;
            setChatState((current) => {
                const next = chatStateForKey(current, chatKey);
                return next.data === null ? next : { ...next, data: withoutChatNote(next.data, noteId) };
            });
            try {
                await deleteReviewChatNote(token, noteId);
                pending.ids.delete(noteId);
            } catch (error) {
                pending.ids.delete(noteId);
                if (removed !== null) {
                    setChatState((current) => {
                        const next = chatStateForKey(current, chatKey);
                        const data = next.data ?? EMPTY_CHAT_RESPONSE;
                        return data.notes.some((note) => note.id === removed.id)
                            ? next
                            : { ...next, data: { ...data, notes: [...data.notes, removed] } };
                    });
                }
                throw error;
            }
        },
        [chatData.notes, chatKey, token],
    );
    const navigateChatAnchor = useCallback(
        (anchor: ChatAnchor) => {
            window.location.hash = selectionLinkHash(window.location.hash, anchor);
            setChatAnchorNavigationRequest((request) => request + 1);
            if (view !== 'route' && view !== 'diff') {
                session.setView('diff');
            }
        },
        [session, view],
    );
    const navigateToNote = useCallback(
        (note: AgentNote) => {
            // Потерявшей якорь заметки в коде этой итерации нет — переходить некуда.
            if (!noteVisibleInIteration(note, notesDiffId)) {
                return;
            }
            session.expandNote(note.id);
            navigateChatAnchor(noteAnchorForIteration(note, notesDiffId));
            noteFocusRequestId.current += 1;
            setNoteFocusRequest({ id: noteFocusRequestId.current, noteId: note.id });
        },
        [navigateChatAnchor, notesDiffId, session],
    );
    /** Строка истории чата в палитре: панель прокручивается к обмену, живой якорь — ещё и в код. */
    const openExchangeFromPalette = useCallback(
        (exchange: ChatExchange, anchorAlive: boolean) => {
            chatScrollRequestId.current += 1;
            setChatScrollRequest(openExchangeInChatRequest(session, exchange.id, chatScrollRequestId.current));
            if (anchorAlive && exchange.anchor !== null) {
                navigateChatAnchor(exchange.anchor);
            }
        },
        [navigateChatAnchor, session],
    );
    const paletteChat = useMemo<PaletteChat | undefined>(
        () =>
            reviewHost === null
                ? undefined
                : {
                      exchanges: chatData.exchanges,
                      notes: chatData.notes,
                      liveFileIds: new Set((currentDiff?.files ?? []).map((file) => file.fileId)),
                      now,
                      loading: currentChat.loading,
                      error: currentChat.error,
                      onSelect: openExchangeFromPalette,
                  },
        [
            chatData.exchanges,
            chatData.notes,
            currentChat.error,
            currentChat.loading,
            currentDiff,
            now,
            openExchangeFromPalette,
            reviewHost,
        ],
    );
    return {
        chatData,
        currentChat,
        currentChatComposer,
        setChatComposerContext,
        chatFocusRequest,
        chatPrefillRequest,
        chatScrollRequest,
        chatAnchorNavigationRequest,
        noteFocusRequest,
        openNoteInChat,
        lostNoteIds,
        firstLostNote,
        notesInCode,
        isSelectionPending,
        selectChatAnchor,
        openChatForSelection,
        composeRouteQuestion,
        composeDiffQuestion,
        closeChat,
        toggleChat,
        handleChatScrollRequest,
        askChat,
        cancelChat,
        retryChat,
        deleteNote,
        navigateChatAnchor,
        navigateToNote,
        paletteChat,
    };
}

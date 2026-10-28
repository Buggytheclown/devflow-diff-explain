import type { AgentNote, ChatAnchor, ChatExplanation, ChatExchange, CodeLocation, UiChatAskAnchor, UiTask, WorkerStatus } from '@sherpa/protocol';
import type { KeyboardEvent, RefObject } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { MessageKey, Translate } from '../i18n/index.js';
import { useT } from '../i18n/index.js';
import { Markdown } from '../markdown/markdown.tsx';
import { NOTE_LOST_ANCHOR_REASON, noteAnchorForIteration, noteVisibleInIteration } from '../notes/model.js';
import { CommandBox } from './command-box.tsx';
import './chat-panel.css';

export type ChatActivityState = 'empty' | 'queued' | 'answering' | 'failed' | 'disconnected' | 'idle';
export type ChatScrollTarget = 'queue' | 'error' | { readonly kind: 'exchange'; readonly exchangeId: number };

export interface ChatPanelProps {
    readonly composerText?: string;
    readonly onComposerTextChange?: (text: string) => void;
    readonly onNavigateCode?: ((location: CodeLocation, diffId: string) => void) | undefined;
    readonly suggestions?: boolean;
    readonly worker: WorkerStatus;
    readonly tasks: readonly UiTask[];
    readonly exchanges: readonly ChatExchange[];
    readonly notes: readonly AgentNote[];
    readonly loading: boolean;
    readonly error: string | null;
    readonly reconnectCommand: string;
    readonly anchor: UiChatAskAnchor | null;
    readonly anchorText?: string | null;
    readonly fileAttachment?: ChatExplanation['file'] | undefined;
    readonly attachmentStale?: boolean;
    readonly onOpenAttachment?: (() => void) | undefined;
    readonly contextCommit?: string | undefined;
    readonly focusRequest: number;
    /**
     * Подставить текст в композер (docs/spec.md §10): вопрос не уходит — его читает, правит и
     * отправляет ревьюер. Запрос с новым `id` срабатывает и на том же тексте.
     */
    readonly prefillRequest?: { readonly id: number; readonly text: string } | null;
    readonly scrollRequest: { readonly id: number; readonly target: ChatScrollTarget } | null;
    readonly onScrollRequestHandled: (id: number) => void;
    readonly onClose: () => void;
    readonly onRemoveAnchor: () => void;
    readonly onAsk: (text: string, anchor?: UiChatAskAnchor) => Promise<ChatExchange>;
    readonly onCancel: (exchangeId: number) => Promise<void>;
    readonly onRetry: (exchangeId: number) => Promise<void>;
    readonly onNavigate: (anchor: ChatAnchor) => void;
    readonly onNavigateToNote: (note: AgentNote) => void;
    /**
     * Итерация, которую смотрит вкладка: по ней решается, есть ли куда переходить
     * у заметки, потерявшей якорь. null — итерация неизвестна, переход недоступен.
     */
    readonly viewDiffId?: string | null;
    /** Фиксированные часы для галереи и тестов. */
    readonly now?: number;
}

export interface ChatFeedEntry {
    readonly exchange: ChatExchange;
    readonly note: AgentNote | null;
}

/** Обмен остаётся единицей статуса, а лента получает вопрос и связанный ответ/заметку. */
export function expandChatExchanges(
    exchanges: readonly ChatExchange[],
    notes: readonly AgentNote[],
): readonly ChatFeedEntry[] {
    const notesByExchange = new Map(notes.map((note) => [note.exchangeId, note]));
    return [...exchanges]
        .sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt) || left.id - right.id)
        .map((exchange) => ({ exchange, note: notesByExchange.get(exchange.id) ?? null }));
}

export function chatActivityState(
    worker: WorkerStatus,
    exchanges: readonly ChatExchange[],
): ChatActivityState {
    if (worker.kind !== 'connected') {
        return 'disconnected';
    }
    if (exchanges.some((exchange) => exchange.status === 'running')) {
        return 'answering';
    }
    if (exchanges.some((exchange) => exchange.status === 'queued')) {
        return 'queued';
    }
    if (exchanges.some((exchange) => exchange.status === 'failed' || exchange.status === 'cancelled')) {
        return 'failed';
    }
    return exchanges.length === 0 ? 'empty' : 'idle';
}

/**
 * Баннер очереди называет маршрут и правку по замечаниям отдельно, любую другую занятую задачу —
 * общо. Занятость считается по держанию: отменённая задача, которую воркер ещё крутит, тоже стоит
 * перед вопросом. Отменённая задача при этом идёт под общим текстом: работы уже нет, а вью
 * маршрута показывает остановки отменёнными — «генерирую маршрут» противоречило бы ей.
 */
export function queueBannerText(tasks: readonly UiTask[]): MessageKey | null {
    const current = tasks.find((task) => task.heldByWorker);
    if (current === undefined) {
        return null;
    }
    if (current.status === 'cancelled') {
        return 'chat.queue.busy';
    }
    if (current.type === 'route.skeleton' || current.type === 'route.section') {
        return 'chat.queue.route';
    }
    return current.type === 'review.feedback' ? 'chat.queue.feedback' : 'chat.queue.busy';
}

export function sameChatAnchor(left: UiChatAskAnchor | null, right: UiChatAskAnchor | null): boolean {
    return (
        left?.fileId === right?.fileId &&
        left?.side === right?.side &&
        left?.start === right?.start &&
        left?.end === right?.end &&
        left?.selectedText === right?.selectedText
    );
}

export function chatAnchorLabel(anchor: UiChatAskAnchor): string {
    const basename = anchor.path.split('/').at(-1) ?? anchor.path;
    return `${basename}:${String(anchor.start)}–${String(anchor.end)}`;
}

function chatAnchorTitle(anchor: UiChatAskAnchor): string {
    return `${anchor.path}:${String(anchor.start)}–${String(anchor.end)}`;
}

/** Один видимый контекст черновика; закрытие удаляет и выделение в документе. */
export function ChatSelectionContext({ anchor, text, onRemove }: { anchor: UiChatAskAnchor; text: string | null; onRemove: () => void }) {
    const t = useT();
    return <div className="chat-panel__selection">
        <div className="chat-panel__contexts"><span className="chat-panel__context chat-panel__context--anchor" title={chatAnchorTitle(anchor)}>
            <span className="chat-panel__context-label">{anchor.path}:{anchor.start}–{anchor.end} · {t(anchor.side === 'old' ? 'chat.selection.before' : 'chat.selection.after')}</span>
            <button type="button" aria-label={t('chat.anchor.remove')} onClick={onRemove}>×</button>
        </span></div>
        {text === null ? <p role="alert">{t('chat.selection.unavailable')}</p> : <details key={`${anchor.diffId ?? ''}:${anchor.fileId}:${anchor.side}:${String(anchor.start)}:${String(anchor.end)}`} open={text.length <= 600 && text.split('\n').length <= 5}>
            <summary>{t('chat.selection.code')}</summary><pre className="chat-panel__selection-quote"><code>{text || ' '}</code></pre>
        </details>}
    </div>;
}

export function ChatPanel(props: ChatPanelProps) {
    const {
        worker,
        tasks,
        exchanges,
        notes,
        loading,
        error,
        anchor,
        focusRequest,
        prefillRequest = null,
        scrollRequest,
        onScrollRequestHandled,
        onClose,
        onRemoveAnchor,
        onAsk,
        onCancel,
        onRetry,
        onNavigate,
        onNavigateToNote,
        viewDiffId = null,
    } = props;
    const t = useT();
    const feed = useMemo(() => expandChatExchanges(exchanges, notes), [exchanges, notes]);
    const feedVersion = feed
        .map(({ exchange, note }) =>
            [exchange.id, exchange.status, exchange.updatedAt, note?.id ?? ''].join(':'),
        )
        .join('|');
    const activity = chatActivityState(worker, exchanges);
    const queued = activity === 'queued' ? queueBannerText(tasks) : null;
    const running = [...exchanges].reverse().find((exchange) => exchange.status === 'running') ?? null;
    const failedExchangeId = [...feed]
        .reverse()
        .find(({ exchange }) => exchange.status === 'failed' || exchange.status === 'cancelled')?.exchange.id;
    // Строка «ещё занят» — только под своим обменом: задача обмена отменена, но воркер её держит.
    const cancelledLeaseExchangeIds = useMemo(
        () =>
            new Set(
                exchanges
                    .filter(
                        (exchange) =>
                            exchange.status === 'cancelled' &&
                            tasks.some(
                                (task) =>
                                    task.id === exchange.taskId &&
                                    task.status === 'cancelled' &&
                                    task.heldByWorker,
                            ),
                    )
                    .map((exchange) => exchange.id),
            ),
        [exchanges, tasks],
    );
    const textareaRef = useRef<HTMLTextAreaElement | null>(null);
    const feedRef = useRef<HTMLDivElement | null>(null);
    const queueRef = useRef<HTMLDivElement | null>(null);
    const errorRef = useRef<HTMLDivElement | null>(null);
    const handledScrollRequest = useRef<number | null>(null);
    const [sending, setSending] = useState(false);
    const [composerError, setComposerError] = useState<string | null>(null);
    const [clock, setClock] = useState(() => props.now ?? Date.now());
    /**
     * Текст композера выводится из подстановки и правки поверх неё: `handled` помнит, какой
     * запрос уже учтён, поэтому один и тот же запрос не переписывает набранное, а новый запрос
     * с тем же текстом срабатывает.
     */
    const [composer, setComposer] = useState<{ readonly handled: number; readonly text: string }>({
        handled: 0,
        text: '',
    });
    const text = props.composerText ?? (
        prefillRequest !== null && prefillRequest.id !== composer.handled ? prefillRequest.text : composer.text);
    const handledPrefill = prefillRequest?.id ?? composer.handled;
    const setText = (value: string): void => {
        setComposer({ handled: handledPrefill, text: value });
        props.onComposerTextChange?.(value);
    };
    // Каретка — в конец подставленного текста: React после коммита восстанавливает выделение
    // сфокусированного поля и иначе вернул бы её в начало.
    const focusComposerEnd = useCallback(() => {
        const textarea = textareaRef.current;
        if (textarea === null) {
            return;
        }
        textarea.focus();
        textarea.setSelectionRange(textarea.value.length, textarea.value.length);
    }, []);

    useEffect(() => {
        textareaRef.current?.focus();
    }, [focusRequest]);

    // Текст запроса приложения виден уже в этом рендере — он выведен из самого запроса.
    const appliedPrefill = useRef(0);
    useEffect(() => {
        if (prefillRequest === null || prefillRequest.id === appliedPrefill.current) {
            return;
        }
        appliedPrefill.current = prefillRequest.id;
        focusComposerEnd();
    }, [focusComposerEnd, prefillRequest]);

    useEffect(() => {
        if (scrollRequest !== null) {
            const target =
                scrollRequest.target === 'queue'
                    ? queueRef.current
                    : scrollRequest.target === 'error'
                      ? errorRef.current
                      : feedRef.current?.querySelector<HTMLElement>(
                            `[data-exchange="${String(scrollRequest.target.exchangeId)}"]`,
                        ) ?? null;
            if (target === null) {
                return;
            }
            target.scrollIntoView({ block: 'center' });
            handledScrollRequest.current = scrollRequest.id;
            onScrollRequestHandled(scrollRequest.id);
            return;
        }
        if (handledScrollRequest.current !== null) {
            handledScrollRequest.current = null;
            return;
        }
        const element = feedRef.current;
        if (element !== null) {
            element.scrollTop = element.scrollHeight;
        }
    }, [error, failedExchangeId, feedVersion, loading, onScrollRequestHandled, queued, scrollRequest]);

    useEffect(() => {
        if (props.now !== undefined || running === null) {
            return;
        }
        const now = Date.now();
        const elapsed = now - Date.parse(running.createdAt);
        const timers = [0, 300, 60_001]
            .filter((threshold) => threshold === 0 || threshold > elapsed)
            .map((threshold) =>
                window.setTimeout(
                    () => {
                        setClock(Date.now());
                    },
                    Math.max(0, threshold - elapsed),
                ),
            );
        return () => {
            for (const timer of timers) {
                window.clearTimeout(timer);
            }
        };
    }, [props.now, running]);

    const connected = worker.kind === 'connected';
    const submit = (): void => {
        const question = text.trim();
        if (!connected || sending || question === '') {
            return;
        }
        setSending(true);
        setComposerError(null);
        void onAsk(question, anchor ?? undefined).then(
            () => {
                setSending(false);
                setText('');
            },
            (error: unknown) => {
                setSending(false);
                setComposerError(error instanceof Error ? error.message : String(error));
            },
        );
    };

    // `updatedAt` меняется с каждой строкой прогресса; `createdAt` — стабильная точка отсчёта и переживает reload.
    const now = props.now ?? clock;
    const runningFor = running === null ? 0 : now - Date.parse(running.createdAt);
    const typingVisible = running !== null && runningFor >= 300;
    const longRunning = running !== null && runningFor > 60_000;

    return (
        // `data-tour="chat"` — цель шага 06 тура первого захода.
        <aside className="chat-panel" aria-label={t('chat.aria')} data-tour="chat">
            <header className="chat-panel__header">
                <details className="chat-panel__details"><summary className="chat-panel__title">{t('chat.title')}</summary><div className="chat-panel__identity">{workerIdentity(worker, t)}{props.contextCommit === undefined ? '' : ` · ${props.contextCommit.slice(0, 12)}`}</div></details>
                {connected ? null : <details className="chat-panel__connect"><summary>{t('chat.connect')}</summary><p>{t('chat.disconnected')}</p><CommandBox command={props.reconnectCommand} hint={t('command.hint')} /></details>}
                <div className="chat-panel__header-actions">
                    {notes.length === 0 ? null : (
                        <span className="chat-panel__notes">{t('chat.notes', notes.length)}</span>
                    )}
                    <button type="button" className="ctl ctl--toolbar-icon chat-panel__close" aria-label={t('app.closeChat')} onClick={onClose}>
                        ×
                    </button>
                </div>
            </header>

            <div className="chat-panel__feed" ref={feedRef}>
                <div className="chat-panel__feed-content">
                    {loading && feed.length === 0 ? (
                        <p className="chat-panel__history-status" role="status">
                            {t('chat.history.loading')}
                        </p>
                    ) : null}
                    {error === null ? null : (
                        <p className="chat-panel__history-error" role="alert">
                            {t('chat.history.failed', error)}
                        </p>
                    )}
                    {queued === null ? null : (
                        <div className="chat-panel__queue" ref={queueRef} role="status">
                            {t(queued)}
                        </div>
                    )}

                    {feed.map(({ exchange, note }) => (
                        <ChatExchangeView
                            key={exchange.id}
                            exchange={exchange}
                            note={note}
                            {...(exchange.id === failedExchangeId ? { errorRef } : {})}
                            cancelledLease={cancelledLeaseExchangeIds.has(exchange.id)}
                            onCancel={onCancel}
                            onRetry={onRetry}
                            onNavigate={onNavigate}
                            onNavigateCode={props.onNavigateCode}
                            onNavigateToNote={onNavigateToNote}
                            viewDiffId={viewDiffId}
                            typingVisible={running?.id === exchange.id && typingVisible}
                            longRunning={running?.id === exchange.id && longRunning}
                        />
                    ))}
                </div>
            </div>

            <div className="chat-panel__composer">
                {props.attachmentStale === true ? <p className="chat-panel__attachment-warning" role="status">{t('chat.context.stale')}{props.onOpenAttachment === undefined ? null : <button className="ctl" onClick={props.onOpenAttachment}>{t('chat.context.open')}</button>}</p> : null}
                {props.fileAttachment === undefined ? null : <div className="chat-panel__contexts"><span className="chat-panel__context" title={props.fileAttachment.path}><span className="chat-panel__context-label">{props.fileAttachment.path}</span><button type="button" aria-label={t('chat.file.remove')} onClick={() => { onRemoveAnchor(); focusComposerEnd(); }}>×</button></span></div>}
                {anchor === null ? null : <ChatSelectionContext anchor={anchor} text={props.anchorText === undefined ? anchor.selectedText ?? null : props.anchorText} onRemove={() => { onRemoveAnchor(); focusComposerEnd(); }} />}
                <textarea
                    ref={textareaRef}
                    className="chat-panel__textarea"
                    aria-label={t('chat.composer.aria')}
                    value={text}
                    disabled={!connected || sending}
                    placeholder={t('chat.composer.placeholder')}
                    onChange={(event) => {
                        setText(event.target.value);
                    }}
                    onKeyDown={(event: KeyboardEvent<HTMLTextAreaElement>) => {
                        if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                            event.preventDefault();
                            submit();
                        }
                    }}
                />
                <div className="chat-panel__composer-footer">
                    <span className="chat-panel__composer-hint visually-hidden">
                        <span>{t('chat.composer.hint.send')}</span>
                        <span>{t('chat.composer.hint.newline')}</span>
                    </span>
                    <button
                        type="button"
                        className="ctl ctl--primary"
                        disabled={!connected || sending || text.trim() === ''}
                        onClick={submit}
                    >
                        {t('chat.composer.send')}
                    </button>
                </div>
                {composerError === null ? null : (
                    <div className="chat-panel__composer-error" role="alert">
                        {composerError}
                    </div>
                )}
            </div>
        </aside>
    );
}

function ChatExchangeView({
    exchange,
    note,
    errorRef,
    cancelledLease,
    onCancel,
    onRetry,
    onNavigate,
    onNavigateCode,
    onNavigateToNote,
    viewDiffId,
    typingVisible,
    longRunning,
}: {
    readonly exchange: ChatExchange;
    readonly note: AgentNote | null;
    readonly errorRef?: RefObject<HTMLDivElement | null>;
    readonly cancelledLease: boolean;
    readonly onCancel: (exchangeId: number) => Promise<void>;
    readonly onRetry: (exchangeId: number) => Promise<void>;
    readonly onNavigate: (anchor: ChatAnchor) => void;
    readonly onNavigateCode?: ((location: CodeLocation, diffId: string) => void) | undefined;
    readonly onNavigateToNote: (note: AgentNote) => void;
    readonly viewDiffId: string | null;
    readonly typingVisible: boolean;
    readonly longRunning: boolean;
}) {
    const t = useT();
    const [actionError, setActionError] = useState<string | null>(null);
    const [actionPending, setActionPending] = useState(false);
    const run = (action: (exchangeId: number) => Promise<void>): void => {
        if (actionPending) {
            return;
        }
        setActionPending(true);
        setActionError(null);
        void action(exchange.id).then(
            () => {
                setActionPending(false);
            },
            (error: unknown) => {
                setActionPending(false);
                setActionError(error instanceof Error ? error.message : String(error));
            },
        );
    };

    return (
        <article className="chat-message-pair" data-exchange={exchange.id}>
            <div className="chat-message chat-message--you">
                <div className="chat-message__author visually-hidden">you</div>
                <div className="chat-message__body chat-message__body--plain">{exchange.question}</div>
                {exchange.explanation?.file === undefined ? null : <span className="chat-message__anchor" title={exchange.explanation.file.path}>↳ {exchange.explanation.file.path}</span>}
                {exchange.anchor === null ? null : (
                    <button
                        type="button"
                        className="chat-message__anchor"
                        title={chatAnchorTitle(exchange.anchor)}
                        onClick={() => {
                            if (exchange.anchor !== null) {
                                onNavigate(exchange.anchor);
                            }
                        }}
                    >
                        ↳ {chatAnchorLabel(exchange.anchor)}
                    </button>
                )}
            </div>

            {exchange.status === 'done' && exchange.answer !== null ? (
                <div className="chat-message chat-message--agent">
                    <div className="chat-message__author visually-hidden">agent</div>
                    <div className="chat-message__body">
                        <Markdown text={exchange.answer} profile="comment" onCodeLink={onNavigateCode === undefined || (exchange.explanation?.diffId ?? exchange.anchor?.diffId) === undefined ? undefined : (location) => {
                            const diffId = exchange.explanation?.diffId ?? exchange.anchor?.diffId;
                            if (diffId !== undefined) onNavigateCode(location, diffId);
                        }} />
                    </div>
                    {note === null ? null : (
                        <div className="chat-message__note-row">
                            <button
                                type="button"
                                className="chat-message__note"
                                disabled={!noteVisibleInIteration(note, viewDiffId)}
                                title={
                                    noteVisibleInIteration(note, viewDiffId)
                                        ? chatAnchorTitle(noteAnchorForIteration(note, viewDiffId))
                                        : t(NOTE_LOST_ANCHOR_REASON)
                                }
                                onClick={() => {
                                    onNavigateToNote(note);
                                }}
                            >
                                {t('chat.note.pinned', chatAnchorLabel(noteAnchorForIteration(note, viewDiffId)))}
                            </button>
                            {note.lostAnchor ? (
                                <span className="chat-message__note-lost" title={chatAnchorTitle(note.anchor)}>
                                    {t('chat.note.lostAnchor', chatAnchorLabel(note.anchor))}
                                </span>
                            ) : null}
                        </div>
                    )}
                </div>
            ) : exchange.status === 'running' ? (
                <div className="chat-message chat-message--agent" role="status">
                    <div className="chat-message__author visually-hidden">agent</div>
                    {typingVisible ? (
                        <div className="chat-message__activity">
                            <span className="chat-message__typing" aria-hidden="true">
                                <i />
                                <i />
                                <i />
                            </span>
                            <span>{longRunning ? t('chat.answering.long') : t('chat.answering')}</span>
                        </div>
                    ) : null}
                    {exchange.progressText === null ? null : (
                        <div className="chat-message__progress">{exchange.progressText}</div>
                    )}
                    <button
                        type="button"
                        className="ctl ctl--ghost chat-message__action"
                        disabled={actionPending}
                        onClick={() => {
                            run(onCancel);
                        }}
                    >
                        {t('chat.stop')}
                    </button>
                </div>
            ) : exchange.status === 'failed' || exchange.status === 'cancelled' ? (
                <div className="chat-message chat-message--agent chat-message--failed" ref={errorRef} role="alert">
                    <div className="chat-message__author visually-hidden">agent</div>
                    <div className="chat-message__body chat-message__body--plain">
                        {exchange.status === 'failed'
                            ? (exchange.error ?? t('chat.answer.missing'))
                            : t('chat.answer.cancelled')}
                    </div>
                    <button
                        type="button"
                        className="ctl ctl--ghost chat-message__action"
                        disabled={actionPending}
                        onClick={() => {
                            run(onRetry);
                        }}
                    >
                        {t('chat.retry')}
                    </button>
                </div>
            ) : null}
            {cancelledLease ? (
                <p className="chat-panel__cancelled-lease" role="status">
                    {t('chat.cancelledLease')}
                </p>
            ) : null}
            {actionError === null ? null : (
                <div className="chat-message__action-error" role="alert">
                    {actionError}
                </div>
            )}
        </article>
    );
}

/**
 * Идентичность исполнителя раскрывается по запросу, не занимает постоянную шапку.
 */
function workerIdentity(worker: WorkerStatus, t: Translate): string {
    if (worker.kind === 'never') {
        return t('chat.worker.never');
    }
    return [worker.harness, worker.model].filter((value): value is string => value !== undefined).join(' · ') || worker.workerId;
}

import type { Comment, CommentDraft, UiSaveDraftResponse, UiUpdateDraftResponse } from '@sherpa/protocol';

import { newUuid } from '../components/uuid.js';

import type { ComposerSnapshot, ThreadStore } from './store.js';

/**
 * `clientKey` — ключ логической записи для буфера сервера: один на запись до её
 * успеха, поэтому повтор безопасен и «повтор может создать копию» больше не бывает.
 */
export interface ComposerTransport {
    readonly save: (draft: CommentDraft, clientKey: string) => Promise<UiSaveDraftResponse>;
    readonly update: (
        commentId: string,
        body: string,
        issue: boolean | undefined,
        clientKey: string,
    ) => Promise<UiUpdateDraftResponse>;
    readonly delete: (commentId: string) => Promise<void>;
    /** Сброс буферной записи: текст ревьюеру не нужен, довозить нечего. */
    readonly discardBuffered?: (id: string) => Promise<void>;
    /** Повтор буферной записи без композера — из списка в модалке комментариев. */
    readonly retryBuffered?: (id: string) => Promise<void>;
}

export interface ComposerController {
    readonly input: (text: string) => void;
    readonly setIssue: (issue: boolean) => void;
    readonly saveNow: (close?: boolean) => Promise<boolean>;
    readonly retry: () => Promise<boolean>;
    readonly restore: (text: string) => Promise<boolean>;
    readonly escape: () => void;
    readonly confirmDiscard: () => Promise<boolean>;
    readonly keepEditing: () => void;
    readonly close: () => void;
}

export interface ComposerControllerOptions {
    readonly store: ThreadStore;
    readonly key: string;
    readonly transport: ComposerTransport;
    readonly slowMs?: number;
    /** Источник `clientKey`; подменяется в тестах ради предсказуемого значения. */
    readonly newClientKey?: () => string;
}

const controllers = new WeakMap<ThreadStore, Map<string, ComposerController>>();

/** Один контроллер на открытие композера: переживает виртуализацию и смену вью. */
export function composerControllerFor(options: ComposerControllerOptions): ComposerController {
    const byKey = controllers.get(options.store) ?? new Map<string, ComposerController>();
    controllers.set(options.store, byKey);
    const existing = byKey.get(options.key);
    if (existing !== undefined) {
        return existing;
    }
    const created = createComposerController(options);
    byKey.set(options.key, created);
    return created;
}

/** Закрывает композеры комментариев, которые больше нельзя редактировать. */
export function closeCommentComposers(store: ThreadStore, commentIds: readonly string[]): void {
    const keys = store.closeComposersForComments(new Set(commentIds));
    const byKey = controllers.get(store);
    for (const key of keys) {
        byKey?.get(key)?.close();
    }
}

/**
 * Закрывает композеры ответа названных тредов, в которых нечего терять: текста в них нет.
 * Композер с набранным текстом остаётся открытым — закрыть его значило бы молча выбросить
 * работу ревьюера; он держит гард публикации и ждёт на своём месте следующего открытия.
 */
export function closeEmptyReplyComposers(store: ThreadStore, threadIds: readonly string[]): void {
    const ids = new Set(threadIds);
    const keys = store
        .listComposers()
        .filter(
            (composer) =>
                composer.threadId !== null &&
                ids.has(composer.threadId) &&
                composer.commentId === null &&
                composer.text.trim() === '',
        )
        .map((composer) => composer.key);
    closeComposersByKey(store, keys);
}

/** Закрывает названные композеры и забывает их контроллеры (сверка с буфером). */
export function closeComposersByKey(store: ThreadStore, keys: readonly string[]): void {
    const byKey = controllers.get(store);
    for (const key of keys) {
        byKey?.get(key)?.close();
        store.closeComposer(key);
    }
}

/** Опубликованный драфт больше нельзя редактировать через старый композер. */
export function closePublishedComposers(store: ThreadStore, commentIds: readonly string[]): void {
    closeCommentComposers(store, commentIds);
}

/**
 * Явное сохранение черновика: первый save возвращает id, дальше идут update.
 *
 * Ответ `buffered` — не ошибка: сервер текст принял, хост его ещё нет. Композер
 * остаётся открытым и редактируемым, `clientKey` держится до успеха записи, поэтому повтор
 * апсёртит ту же запись буфера и дубля не создаёт.
 */
export function createComposerController(options: ComposerControllerOptions): ComposerController {
    const slowMs = options.slowMs ?? 500;
    const newClientKey = options.newClientKey ?? newUuid;
    let slow: ReturnType<typeof setTimeout> | null = null;
    let closed = false;
    let inFlight: Promise<boolean> | null = null;
    let drainPromise: Promise<boolean> | null = null;
    let queuedDraft: { text: string; issue: boolean | undefined } | null = null;
    let closeQueued = false;
    let discardRequested = false;
    let reverting = false;
    let discardPromise: Promise<boolean> | null = null;
    let createdWhileDiscarding: { draft: CommentDraft; comment: Comment } | null = null;
    const opened = options.store.getComposer(options.key);
    // Правка существующего черновика открывается с issue-статусом хоста: он уже записан,
    // и без этой засечки первое же сохранение слало бы хосту то, что там и так стоит.
    // У восстановленного из буфера композера issue — как раз ещё не записанный: он поедет
    // в хост со следующим сохранением.
    let lastWrittenIssue: boolean | undefined = opened?.status === 'buffered' ? undefined : opened?.issue;
    /**
     * Запись буфера этого композера: обновляется по каждому ответу сервера, в том
     * числе когда показывать результат уже некому (идёт сброс). `undefined` — ответов ещё не
     * было, и правду знает снапшот композера.
     */
    let bufferedEntryId: string | null | undefined;

    const forget = (): void => {
        const byKey = controllers.get(options.store);
        if (byKey?.get(options.key) === controller) {
            byKey.delete(options.key);
        }
    };

    const clearSlow = (): void => {
        if (slow !== null) {
            clearTimeout(slow);
            slow = null;
        }
    };

    const clearTimers = (): void => {
        clearSlow();
    };

    const state = () => options.store.getComposer(options.key);
    const bufferedId = (): string | null =>
        bufferedEntryId === undefined ? (state()?.bufferEntry?.id ?? null) : bufferedEntryId;
    const ignoreRequestResult = (): boolean => discardRequested || reverting;

    /** Ключ логической записи: рождается на первый save и живёт до его успеха. */
    const clientKeyOf = (current: Pick<ComposerSnapshot, 'clientKey'>): string => {
        const existing = current.clientKey;
        if (existing !== undefined) {
            return existing;
        }
        const created = newClientKey();
        options.store.updateComposer(options.key, { clientKey: created });
        return created;
    };

    const run = async (closeAfter: boolean): Promise<boolean> => {
        const current = state();
        if (closed || reverting || current === null || current.text.trim() === '') {
            return false;
        }
        clearTimers();
        const body = current.text;
        const issue = current.issue;
        const clientKey = clientKeyOf(current);
        options.store.updateComposer(options.key, { status: 'saving', slow: false, confirmDiscard: false });
        slow = setTimeout(() => {
            options.store.updateComposer(options.key, { slow: true });
        }, slowMs);

        const request = (async () => {
            try {
                /** Запись легла в буфер сервера: композер остаётся открытым и ждёт довоза. */
                let buffered = false;
                if (current.commentId === null) {
                    const draft: CommentDraft = {
                        body,
                        parentId: current.parentId,
                        anchor: current.anchor,
                        ...(issue === undefined ? {} : { issue }),
                    };
                    const response = await options.transport.save(draft, clientKey);
                    if (response.outcome === 'buffered') {
                        bufferedEntryId = response.entry.id;
                        buffered = true;
                        if (!ignoreRequestResult()) {
                            options.store.updateComposer(options.key, {
                                status: 'buffered',
                                bufferEntry: response.entry,
                                slow: false,
                            });
                        }
                    } else {
                        bufferedEntryId = null;
                        // Issue засекается только по факту записи: провал оставляет его
                        // незаписанным, и следующая попытка обязана послать его снова.
                        lastWrittenIssue = issue;
                        if (discardRequested) {
                            createdWhileDiscarding = { draft, comment: response.comment };
                        } else {
                            options.store.addDraft(draft, response.comment);
                            options.store.updateComposer(options.key, {
                                commentId: response.comment.id,
                                originalText: body,
                                clientKey: undefined,
                                bufferEntry: null,
                            });
                        }
                    }
                } else {
                    const issueUpdate = issue === lastWrittenIssue ? undefined : issue;
                    const response = await options.transport.update(current.commentId, body, issueUpdate, clientKey);
                    if (response.outcome === 'buffered') {
                        bufferedEntryId = response.entry.id;
                        buffered = true;
                        if (!ignoreRequestResult()) {
                            options.store.updateComposer(options.key, {
                                status: 'buffered',
                                bufferEntry: response.entry,
                                slow: false,
                            });
                        }
                    } else {
                        bufferedEntryId = null;
                        if (issueUpdate !== undefined) {
                            lastWrittenIssue = issueUpdate;
                        }
                        if (!ignoreRequestResult()) {
                            options.store.updateDraft(current.commentId, body, issueUpdate);
                            options.store.updateComposer(options.key, {
                                originalText: body,
                                clientKey: undefined,
                                bufferEntry: null,
                            });
                        }
                    }
                }
                if (!buffered && !ignoreRequestResult()) {
                    const latest = state();
                    if (latest?.text === body && latest.issue === issue) {
                        options.store.updateComposer(options.key, { status: 'saved', slow: false, savedAt: Date.now() });
                    } else if (latest?.status === 'saving') {
                        options.store.updateComposer(options.key, { status: 'idle', slow: false });
                    }
                }
                return !buffered;
            } catch {
                if (!ignoreRequestResult()) {
                    options.store.updateComposer(options.key, { status: 'error', slow: false });
                }
                return false;
            } finally {
                clearSlow();
                inFlight = null;
            }
        })();
        inFlight = request;
        const ok = await request;

        if (ignoreRequestResult()) {
            queuedDraft = null;
            closeQueued = false;
            return ok;
        }

        const queued = queuedDraft;
        const shouldClose = closeAfter || closeQueued;
        queuedDraft = null;
        closeQueued = false;
        if (ok && queued !== null && (queued.text !== body || queued.issue !== issue)) {
            return run(shouldClose);
        }
        if (ok && shouldClose && state()?.text === body && state()?.issue === issue) {
            options.store.closeComposer(options.key);
            closed = true;
            forget();
        }
        return ok;
    };

    const perform = (closeAfter: boolean): Promise<boolean> => {
        const current = state();
        if (closed || reverting || current === null || current.text.trim() === '') {
            return Promise.resolve(false);
        }
        clearTimers();
        if (drainPromise !== null) {
            queuedDraft = { text: current.text, issue: current.issue };
            closeQueued ||= closeAfter;
            return drainPromise;
        }
        const drain = run(closeAfter).finally(() => {
            if (drainPromise === drain) {
                drainPromise = null;
            }
        });
        drainPromise = drain;
        return drain;
    };

    const discard = (): Promise<boolean> => {
        const current = state();
        if (
            bufferedId() === null &&
            current?.commentId !== null &&
            current?.commentId !== undefined &&
            current.originalText !== undefined
        ) {
            return restore(current.originalText);
        }
        if (discardPromise !== null) {
            return discardPromise;
        }
        clearTimers();
        closed = true;
        discardRequested = true;
        options.store.updateComposer(options.key, {
            status: 'discarding',
            slow: false,
            confirmDiscard: false,
        });
        const active = inFlight;

        discardPromise = (async () => {
            if (active !== null) {
                await active;
            }

            const current = state();
            const created = createdWhileDiscarding;
            const commentId = created?.comment.id ?? current?.commentId ?? null;
            // Запись ещё в буфере сервера: создания на хосте не случилось, а правка туда не
            // доехала — удалять нечего, снимаем саму запись. Для правки это и есть откат:
            // на хосте остался текст, который был до неё.
            const buffered = created === null ? bufferedId() : null;
            if (buffered !== null) {
                try {
                    await options.transport.discardBuffered?.(buffered);
                } catch {
                    closed = false;
                    discardRequested = false;
                    options.store.updateComposer(options.key, { status: 'error', confirmDiscard: true });
                    return false;
                }
                bufferedEntryId = null;
                options.store.closeComposer(options.key);
                forget();
                return true;
            }
            if (commentId === null && active !== null) {
                // Ответ первого save потерян: без id нельзя доказать, что на хосте нечего удалять.
                closed = false;
                discardRequested = false;
                options.store.updateComposer(options.key, { status: 'error', confirmDiscard: false });
                return false;
            }

            try {
                if (commentId !== null) {
                    await options.transport.delete(commentId);
                    if (created === null) {
                        options.store.deleteDraft(commentId);
                    }
                }
                options.store.closeComposer(options.key);
                createdWhileDiscarding = null;
                forget();
                return true;
            } catch {
                if (created !== null) {
                    options.store.addDraft(created.draft, created.comment);
                    options.store.updateComposer(options.key, {
                        commentId: created.comment.id,
                        clientKey: undefined,
                        bufferEntry: null,
                    });
                }
                closed = false;
                discardRequested = false;
                options.store.updateComposer(options.key, { status: 'error', confirmDiscard: true });
                return false;
            }
        })().finally(() => {
            discardPromise = null;
        });
        return discardPromise;
    };

    const restore = async (text: string): Promise<boolean> => {
        const current = state();
        if (closed || reverting || current?.commentId == null) {
            return false;
        }
        const commentId = current.commentId;
        const buffered = bufferedId();
        if (buffered !== null && text === current.originalText) {
            // Правка не доехала до хоста: там лежит как раз `originalText`, и откат — это
            // снятие записи буфера, а не ещё одна запись в хост, который и так не отвечает.
            try {
                await options.transport.discardBuffered?.(buffered);
            } catch {
                options.store.updateComposer(options.key, { status: 'error', slow: false });
                return false;
            }
            bufferedEntryId = null;
            options.store.closeComposer(options.key);
            closed = true;
            forget();
            return true;
        }
        if (current.text === text && current.status === 'saved') {
            options.store.closeComposer(options.key);
            closed = true;
            forget();
            return true;
        }
        clearTimers();
        reverting = true;
        queuedDraft = null;
        closeQueued = false;
        options.store.updateComposer(options.key, {
            status: 'saving',
            slow: false,
            confirmDiscard: false,
        });
        const active = drainPromise;
        if (active !== null) {
            await active;
        }
        try {
            const response = await options.transport.update(commentId, text, undefined, clientKeyOf(current));
            if (response.outcome === 'buffered') {
                // Откат тоже уехал в буфер: композер остаётся открытым с восстановленным
                // текстом, иначе запись висела бы в буфере без единого способа её снять.
                bufferedEntryId = response.entry.id;
                reverting = false;
                options.store.updateComposer(options.key, {
                    text,
                    status: 'buffered',
                    bufferEntry: response.entry,
                    slow: false,
                });
                return false;
            }
            bufferedEntryId = null;
            options.store.updateDraft(commentId, text);
            options.store.closeComposer(options.key);
            closed = true;
            forget();
            return true;
        } catch {
            reverting = false;
            options.store.updateComposer(options.key, { status: 'error', slow: false });
            return false;
        }
    };

    const controller: ComposerController = {
        input: (text) => {
            if (closed || reverting) {
                return;
            }
            const current = state();
            const saving = current?.status === 'saving';
            // Буферный статус переживает правку: запись на сервере никуда не делась, и
            // следующее сохранение уедет тем же `clientKey` в ту же строку буфера.
            options.store.updateComposer(options.key, {
                text,
                status: saving ? 'saving' : current?.status === 'buffered' ? 'buffered' : 'idle',
                slow: saving ? current.slow : false,
                confirmDiscard: false,
            });
        },
        setIssue: (issue) => {
            if (closed || reverting) {
                return;
            }
            const current = state();
            if (current?.issue === undefined || current.issue === issue) {
                return;
            }
            // Смена issue лишь помечает композер несохранённым — запись уедет со следующим
            // явным сохранением (perform сверяет issue с lastWrittenIssue).
            options.store.updateComposer(options.key, {
                issue,
                status: current.status === 'buffered' ? 'buffered' : 'idle',
                slow: false,
                confirmDiscard: false,
            });
        },
        saveNow: (close = false) => perform(close),
        // Повтор безопасен: `clientKey` держится до успеха, и сервер апсёртит ту же запись.
        retry: () => perform(false),
        restore,
        escape: () => {
            const current = state();
            if (current === null) {
                return;
            }
            clearTimers();
            if (current.commentId !== null && current.originalText !== undefined) {
                if (current.text === current.originalText) {
                    void restore(current.originalText);
                } else {
                    options.store.updateComposer(options.key, { confirmDiscard: true });
                }
            } else if (current.text.trim() === '') {
                void discard();
            } else {
                options.store.updateComposer(options.key, { confirmDiscard: true });
            }
        },
        confirmDiscard: discard,
        keepEditing: () => {
            options.store.updateComposer(options.key, { confirmDiscard: false });
        },
        close: () => {
            clearTimers();
            closed = true;
            forget();
        },
    };
    return controller;
}

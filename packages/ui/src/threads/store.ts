import type { Comment, CommentDraft, DraftBufferEntry, FileAnchor, Thread } from '@sherpa/protocol';

import { groupThreads, threadHasDraft, threadResolvedByIssues } from './model.js';
import type { IterationLayout } from './model.js';

/**
 * `buffered` — сервер текст принял, хост его ещё не принял: запись лежит в буфере
 * сервера и уедет сама. Для ревьюера это «сохранено, но не до конца», а не ошибка: текст
 * переживает перезагрузку вкладки, а вот шип до его отправки не пускает (docs/design/SPEC-elements.md §4.5).
 */
export type ComposerStatus = 'idle' | 'saving' | 'saved' | 'discarding' | 'error' | 'buffered';

export interface ComposerSnapshot {
    readonly key: string;
    readonly threadId: string | null;
    readonly parentId: string | null;
    readonly anchor: FileAnchor | null;
    /** undefined — ответы, правка существующего черновика или хост без commentIssues. */
    readonly issue?: boolean;
    readonly text: string;
    /** Исходный текст правки существующего черновика — нужен для отмены после перемонтирования. */
    readonly originalText?: string;
    /** Композер правит уже опубликованный комментарий: чипа «черновик» и буфера у него нет. */
    readonly published?: boolean;
    /**
     * Сообщение, под которым ревьюер нажал «Ответить»: в карточке треда композер стоит там же
     * (docs/design/SPEC-changes-2026-09-20.md §4). Место живёт рядом с текстом, а не в компоненте:
     * модалку можно закрыть и открыть заново, ответ останется под своим сообщением.
     */
    readonly replyUnder?: string | null;
    readonly commentId: string | null;
    readonly status: ComposerStatus;
    /** Время последнего подтверждённого сохранения для статуса под полем. */
    readonly savedAt?: number | null;
    /**
     * Ключ логической записи для сервера: живёт от первого save до его успеха, поэтому
     * повтор не создаёт дубль. `undefined` — записи ещё не было.
     */
    readonly clientKey?: string | undefined;
    /** Запись буфера сервера при `status: 'buffered'`; иначе `null`. */
    readonly bufferEntry?: DraftBufferEntry | null;
    readonly slow: boolean;
    readonly confirmDiscard: boolean;
    readonly resolvedAtOpen: boolean;
}

interface OptimisticDraft {
    readonly draft: CommentDraft;
    readonly comment: Comment;
}

export interface ThreadStoreSnapshot {
    readonly threads: readonly Thread[];
    readonly byFile: ReadonlyMap<string, readonly Thread[]>;
    readonly outside: readonly Thread[];
    /**
     * Итерация нарисованного диффа, когда это не активная итерация PR: по ней
     * раскладка ищет файл треда по `path` и решает, стоит ли тред у своих строк.
     */
    readonly iterationLayout: IterationLayout | null;
    /** Треды, удержанные на экране вопреки линзе по автору. */
    readonly keptVisible: ReadonlySet<string>;
    /** Та же отметка по файлам, со стабильными множествами для memo карточек. */
    readonly keptByFile: ReadonlyMap<string, ReadonlySet<string>>;
    /**
     * Треды, раскрытые у кода. Память вкладки: на диск и в адрес не уходит
     * (`docs/decisions.md`, «Треды, issue и композер»). Решение принимается один раз — когда
     * тред впервые появился в сторе; дальше его двигает только ревьюер, поэтому ни новый
     * ответ от хоста, ни собственный Resolve тред не сворачивают.
     */
    readonly openThreads: ReadonlySet<string>;
    /**
     * Логин ревьюера из `PrMeta.viewer` (кладёт `setViewer`): по нему у своих опубликованных
     * комментариев показываются правка и удаление. `null` — хост личность не знает.
     */
    readonly viewerLogin: string | null;
}

export interface ComposerLayoutSnapshot {
    /**
     * Композеры с якорем на файл: и на строке, и без неё (комментарий к картинке — карточка
     * кладёт такой под шапку). Текст здесь намеренно не публикуется.
     */
    readonly byFile: ReadonlyMap<string, readonly ComposerSnapshot[]>;
    /**
     * Треды с открытым композером ответа или правки черновика. У таких композеров нет якоря,
     * в раскладке строк они не участвуют — но их файл занят, и снимать его с DOM нельзя.
     */
    readonly openThreadIds: ReadonlySet<string>;
}

export interface ComposerGuardSnapshot {
    /** Есть несохранённый текст, save или подтверждённое удаление в полёте. */
    readonly pending: boolean;
}

export interface ThreadStore {
    /**
     * Итерация одна и та же, а её роль меняется: пуш делает активную итерацию прошлой, и
     * раскладка переезжает с `fileId` на `path`. Стор при этом живёт дальше — вместе с
     * открытыми композерами и их несохранённым текстом.
     */
    readonly setIterationLayout: (layout: IterationLayout | null) => void;
    /** Изменения тредов: серверный снапшот, драфт, resolve и kept-in-view. */
    readonly subscribe: (listener: () => void) => () => void;
    readonly getSnapshot: () => ThreadStoreSnapshot;
    /** Появление и исчезновение позиционного композера, но не ввод текста. */
    readonly subscribeComposers: (listener: () => void) => () => void;
    readonly getComposersSnapshot: () => ComposerLayoutSnapshot;
    /** Гард публикации следит только за переходами «всё сохранено» ↔ «есть несохранённое». */
    readonly subscribeComposerGuard: (listener: () => void) => () => void;
    readonly getComposerGuardSnapshot: () => ComposerGuardSnapshot;
    /** Локальная подписка одного композера: печатание не будит список карточек. */
    readonly subscribeComposer: (key: string, listener: () => void) => () => void;
    readonly getComposer: (key: string) => ComposerSnapshot | null;
    /** Все открытые композеры: по ним сверяется буфер черновиков. */
    readonly listComposers: () => readonly ComposerSnapshot[];
    readonly setServerThreads: (threads: readonly Thread[]) => void;
    /** Личность ревьюера из снапшота UI; `null` — хост её не знает. */
    readonly setViewer: (login: string | null) => void;
    readonly addDraft: (draft: CommentDraft, comment: Comment) => void;
    /** `issue` — только когда правка его меняла: иначе статус комментария остаётся как есть. */
    readonly updateDraft: (commentId: string, body: string, issue?: boolean) => void;
    readonly deleteDraft: (commentId: string) => void;
    /** Держит гард публикации, пока подтверждённое удаление черновика не завершилось. */
    readonly beginDraftDeletion: (commentId: string) => void;
    readonly endDraftDeletion: (commentId: string) => void;
    readonly setResolved: (threadId: string, resolved: boolean) => void;
    /** Откат запроса принимается до следующего серверного снапшота, затем истина снова у сервера. */
    readonly restoreResolved: (threadId: string, resolved: boolean) => void;
    readonly clearResolved: (threadId: string) => void;
    readonly hasResolvedOverride: (threadId: string) => boolean;
    readonly getServerResolved: (threadId: string) => boolean | null;
    /** Resolve одного issue-комментария на хосте с `commentResolve`; тред пересчитывается по правилу. */
    readonly setCommentResolved: (commentId: string, resolved: boolean) => void;
    readonly restoreCommentResolved: (commentId: string, resolved: boolean) => void;
    readonly hasCommentResolvedOverride: (commentId: string) => boolean;
    readonly getCommentResolved: (commentId: string) => boolean;
    readonly getServerCommentResolved: (commentId: string) => boolean | null;
    /** Раскрытие треда у кода; `setThreadsOpen` — «свернуть все / развернуть все» одним обновлением. */
    readonly toggleThreadOpen: (threadId: string) => void;
    readonly setThreadsOpen: (threadIds: readonly string[], open: boolean) => void;
    readonly isThreadOpen: (threadId: string) => boolean;
    readonly keepVisible: (threadId: string) => void;
    readonly releaseVisible: (threadId: string) => void;
    readonly openComposer: (composer: ComposerSnapshot) => void;
    readonly updateComposer: (key: string, patch: Partial<Omit<ComposerSnapshot, 'key'>>) => void;
    readonly closeComposer: (key: string) => void;
    /** Закрывает композеры заданных комментариев и возвращает их ключи контроллерам. */
    readonly closeComposersForComments: (commentIds: ReadonlySet<string>) => readonly string[];
}

export function createThreadStore(
    initial: readonly Thread[],
    fileIds: ReadonlySet<string>,
    initialIterationLayout: IterationLayout | null = null,
): ThreadStore {
    let iterationLayout = initialIterationLayout;
    const listeners = new Set<() => void>();
    const composerListeners = new Set<() => void>();
    const composerGuardListeners = new Set<() => void>();
    const listenersByComposer = new Map<string, Set<() => void>>();
    let serverThreads = [...initial];
    const drafts = new Map<string, OptimisticDraft>();
    const resolved = new Map<string, boolean>();
    const reconcileResolved = new Set<string>();
    const commentResolved = new Map<string, boolean>();
    const reconcileCommentResolved = new Set<string>();
    const threadOpen = new Map<string, boolean>();
    const keptVisible = new Set<string>();
    const composers = new Map<string, ComposerSnapshot>();
    const draftDeletions = new Map<string, number>();
    let viewerLogin: string | null = null;
    let snapshot = buildSnapshot(null);
    let composersSnapshot: ComposerLayoutSnapshot = { byFile: new Map(), openThreadIds: new Set() };
    let composerGuardSnapshot: ComposerGuardSnapshot = { pending: false };

    function buildSnapshot(previous: ThreadStoreSnapshot | null): ThreadStoreSnapshot {
        const threads = mergeThreads(serverThreads, drafts, resolved, commentResolved);
        const grouped = groupThreads(threads, fileIds, iterationLayout);
        const byFile = stableGroups(previous?.byFile ?? null, grouped.byFile);
        const openThreads = reconcileOpenThreads(threadOpen, threads);
        return {
            threads,
            byFile,
            outside: sameItems(previous?.outside ?? null, grouped.outside) ? (previous?.outside ?? grouped.outside) : grouped.outside,
            iterationLayout,
            keptVisible: new Set(keptVisible),
            keptByFile: stableKeptByFile(previous?.keptByFile ?? null, byFile, keptVisible),
            openThreads:
                previous !== null && sameSet(previous.openThreads, openThreads) ? previous.openThreads : openThreads,
            viewerLogin,
        };
    }

    const publish = (): void => {
        snapshot = buildSnapshot(snapshot);
        for (const listener of [...listeners]) {
            listener();
        }
    };

    const notifyComposer = (key: string): void => {
        for (const listener of [...(listenersByComposer.get(key) ?? [])]) {
            listener();
        }
    };

    const publishComposerGuard = (): void => {
        const pending =
            draftDeletions.size > 0 ||
            [...composers.values()].some(
                (composer) =>
                    composer.status === 'saving' ||
                    composer.status === 'discarding' ||
                    // Буферный текст уже на сервере: уходить с ним не страшно, а шип его ждёт
                    // отдельной причиной (`publishDisabledReason`). Дописанное после
                    // провала — другое дело: на сервере его ещё нет, и уход его потеряет.
                    (composer.status === 'buffered'
                        ? composer.text !== composer.bufferEntry?.draft.body
                        : composer.commentId === null
                          ? composer.text.trim() !== ''
                          : composer.status !== 'saved'),
            );
        if (pending === composerGuardSnapshot.pending) {
            return;
        }
        composerGuardSnapshot = { pending };
        for (const listener of [...composerGuardListeners]) {
            listener();
        }
    };

    const publishComposerLayout = (fileId: string | null): void => {
        const openThreadIds = new Set<string>();
        for (const composer of composers.values()) {
            if (composer.threadId !== null) {
                openThreadIds.add(composer.threadId);
            }
        }
        if (fileId === null) {
            // Композер без якоря раскладку строк не двигает: подписчиков будим, только когда
            // изменился состав тредов с открытым композером, и `byFile` оставляем тем же.
            if (sameSet(composersSnapshot.openThreadIds, openThreadIds)) {
                return;
            }
            composersSnapshot = { byFile: composersSnapshot.byFile, openThreadIds };
        } else {
            const byFile = new Map(composersSnapshot.byFile);
            const next = [...composers.values()].filter((composer) => composer.anchor?.fileId === fileId);
            if (next.length === 0) {
                byFile.delete(fileId);
            } else {
                byFile.set(fileId, next);
            }
            composersSnapshot = { byFile, openThreadIds };
        }
        for (const listener of [...composerListeners]) {
            listener();
        }
    };

    const closeComposer = (key: string): boolean => {
        const current = composers.get(key);
        if (current === undefined || !composers.delete(key)) {
            return false;
        }
        publishComposerLayout(current.anchor?.fileId ?? null);
        publishComposerGuard();
        notifyComposer(key);
        return true;
    };

    return {
        setIterationLayout: (next) => {
            // Дифф итерации неизменен, поэтому `diffId` исчерпывает раскладку: пересобирать
            // снапшот на каждый новый объект той же итерации незачем.
            if ((iterationLayout?.diffId ?? null) === (next?.diffId ?? null)) {
                return;
            }
            iterationLayout = next;
            publish();
        },
        subscribe: (listener) => {
            listeners.add(listener);
            return () => {
                listeners.delete(listener);
            };
        },
        getSnapshot: () => snapshot,
        subscribeComposers: (listener) => {
            composerListeners.add(listener);
            return () => {
                composerListeners.delete(listener);
            };
        },
        getComposersSnapshot: () => composersSnapshot,
        subscribeComposerGuard: (listener) => {
            composerGuardListeners.add(listener);
            return () => {
                composerGuardListeners.delete(listener);
            };
        },
        getComposerGuardSnapshot: () => composerGuardSnapshot,
        subscribeComposer: (key, listener) => {
            const bucket = listenersByComposer.get(key) ?? new Set<() => void>();
            bucket.add(listener);
            listenersByComposer.set(key, bucket);
            return () => {
                bucket.delete(listener);
                if (bucket.size === 0) {
                    listenersByComposer.delete(key);
                }
            };
        },
        getComposer: (key) => composers.get(key) ?? null,
        listComposers: () => [...composers.values()],
        setServerThreads: (threads) => {
            serverThreads = [...threads];
            const serverIds = commentIds(serverThreads);
            for (const id of drafts.keys()) {
                if (serverIds.has(id)) {
                    drafts.delete(id);
                }
            }
            for (const [threadId, value] of resolved) {
                if (
                    reconcileResolved.delete(threadId) ||
                    serverThreads.find((thread) => thread.id === threadId)?.resolved === value
                ) {
                    resolved.delete(threadId);
                }
            }
            for (const [commentId, value] of commentResolved) {
                if (
                    reconcileCommentResolved.delete(commentId) ||
                    findComment(serverThreads, commentId)?.resolved === value
                ) {
                    commentResolved.delete(commentId);
                }
            }
            publish();
        },
        setViewer: (login) => {
            if (login === viewerLogin) {
                return;
            }
            viewerLogin = login;
            publish();
        },
        addDraft: (draft, comment) => {
            drafts.set(comment.id, { draft, comment });
            publish();
        },
        updateDraft: (commentId, body, issue) => {
            const patch = { body, ...(issue === undefined ? {} : { issue }) };
            const optimistic = drafts.get(commentId);
            if (optimistic !== undefined) {
                drafts.set(commentId, { ...optimistic, comment: { ...optimistic.comment, ...patch } });
            } else {
                serverThreads = mapComments(serverThreads, commentId, (comment) => ({ ...comment, ...patch }));
            }
            publish();
        },
        deleteDraft: (commentId) => {
            drafts.delete(commentId);
            serverThreads = removeComment(serverThreads, commentId);
            publish();
        },
        beginDraftDeletion: (commentId) => {
            draftDeletions.set(commentId, (draftDeletions.get(commentId) ?? 0) + 1);
            publishComposerGuard();
        },
        endDraftDeletion: (commentId) => {
            const count = draftDeletions.get(commentId);
            if (count === undefined) {
                return;
            }
            if (count === 1) {
                draftDeletions.delete(commentId);
            } else {
                draftDeletions.set(commentId, count - 1);
            }
            publishComposerGuard();
        },
        setResolved: (threadId, value) => {
            reconcileResolved.delete(threadId);
            resolved.set(threadId, value);
            publish();
        },
        restoreResolved: (threadId, value) => {
            resolved.set(threadId, value);
            reconcileResolved.add(threadId);
            publish();
        },
        clearResolved: (threadId) => {
            reconcileResolved.delete(threadId);
            if (resolved.delete(threadId)) {
                publish();
            }
        },
        hasResolvedOverride: (threadId) => resolved.has(threadId),
        getServerResolved: (threadId) => serverThreads.find((thread) => thread.id === threadId)?.resolved ?? null,
        setCommentResolved: (commentId, value) => {
            reconcileCommentResolved.delete(commentId);
            commentResolved.set(commentId, value);
            publish();
        },
        restoreCommentResolved: (commentId, value) => {
            commentResolved.set(commentId, value);
            reconcileCommentResolved.add(commentId);
            publish();
        },
        hasCommentResolvedOverride: (commentId) => commentResolved.has(commentId),
        getCommentResolved: (commentId) =>
            commentResolved.get(commentId) ?? findComment(serverThreads, commentId)?.resolved ?? false,
        getServerCommentResolved: (commentId) => findComment(serverThreads, commentId)?.resolved ?? null,
        toggleThreadOpen: (threadId) => {
            threadOpen.set(threadId, !(threadOpen.get(threadId) ?? false));
            publish();
        },
        setThreadsOpen: (threadIds, open) => {
            let changed = false;
            for (const threadId of threadIds) {
                if (threadOpen.get(threadId) !== open) {
                    threadOpen.set(threadId, open);
                    changed = true;
                }
            }
            if (changed) {
                publish();
            }
        },
        isThreadOpen: (threadId) => threadOpen.get(threadId) ?? false,
        keepVisible: (threadId) => {
            if (!keptVisible.has(threadId)) {
                keptVisible.add(threadId);
                publish();
            }
        },
        releaseVisible: (threadId) => {
            if (keptVisible.delete(threadId)) {
                publish();
            }
        },
        openComposer: (composer) => {
            const previous = composers.get(composer.key);
            const previousFileId = previous?.anchor?.fileId ?? null;
            const nextFileId = composer.anchor?.fileId ?? null;
            composers.set(composer.key, composer);
            if (previousFileId !== null && previousFileId !== nextFileId) {
                publishComposerLayout(previousFileId);
            }
            publishComposerLayout(nextFileId);
            publishComposerGuard();
            notifyComposer(composer.key);
        },
        updateComposer: (key, patch) => {
            const current = composers.get(key);
            if (current !== undefined) {
                composers.set(key, { ...current, ...patch });
                publishComposerGuard();
                notifyComposer(key);
            }
        },
        closeComposer: (key) => {
            closeComposer(key);
        },
        closeComposersForComments: (commentIds) => {
            const keys = [...composers.values()]
                .filter((composer) => composer.commentId !== null && commentIds.has(composer.commentId))
                .map((composer) => composer.key);
            for (const key of keys) {
                closeComposer(key);
            }
            return keys;
        },
    };
}

function mergeThreads(
    server: readonly Thread[],
    drafts: ReadonlyMap<string, OptimisticDraft>,
    resolved: ReadonlyMap<string, boolean>,
    commentResolved: ReadonlyMap<string, boolean>,
): Thread[] {
    let threads = server.map((thread) => {
        const value = resolved.get(thread.id);
        return value === undefined || value === thread.resolved ? thread : { ...thread, resolved: value };
    });

    // Оптимистичный кадр резолва по комментарию: пересчитываем и сам тред — иначе до ответа
    // хоста кромка и маркер показывали бы прежнее состояние.
    for (const [commentId, value] of commentResolved) {
        threads = mapComments(threads, commentId, (comment) =>
            comment.resolved === value ? comment : { ...comment, resolved: value },
        );
    }
    if (commentResolved.size > 0) {
        threads = threads.map((thread) => {
            const byIssues = threadResolvedByIssues(thread);
            return byIssues === null || byIssues === thread.resolved ? thread : { ...thread, resolved: byIssues };
        });
    }

    const known = commentIds(threads);
    for (const { draft, comment } of drafts.values()) {
        if (known.has(comment.id)) {
            continue;
        }
        if (draft.parentId === null) {
            threads = [
                ...threads,
                {
                    id: comment.id,
                    anchor: draft.anchor,
                    resolved: false,
                    resolvedBy: null,
                    outdated: false,
                    // Пин треда приезжает с хоста при следующем чтении.
                    pinnedTo: null,
                    root: comment,
                },
            ];
            continue;
        }
        threads = mapComments(threads, draft.parentId, (parent) => ({
            ...parent,
            replies: [...parent.replies, comment],
        }));
    }
    return threads;
}

function mapComments(threads: readonly Thread[], id: string, map: (comment: Comment) => Comment): Thread[] {
    const visit = (comment: Comment): Comment => {
        if (comment.id === id) {
            return map(comment);
        }
        const replies = comment.replies.map(visit);
        return replies.some((reply, index) => reply !== comment.replies[index]) ? { ...comment, replies } : comment;
    };
    return threads.map((thread) => {
        const root = visit(thread.root);
        return root === thread.root ? thread : { ...thread, root };
    });
}

function removeComment(threads: readonly Thread[], id: string): Thread[] {
    const visit = (comment: Comment): Comment => {
        const kept = comment.replies.filter((reply) => reply.id !== id);
        const replies = kept.map(visit);
        const changed = kept.length !== comment.replies.length || replies.some((reply, index) => reply !== kept[index]);
        return changed ? { ...comment, replies } : comment;
    };
    return threads
        .filter((thread) => thread.root.id !== id)
        .map((thread) => {
            const root = visit(thread.root);
            return root === thread.root ? thread : { ...thread, root };
        });
}

function findComment(threads: readonly Thread[], id: string): Comment | null {
    const visit = (comment: Comment): Comment | null => {
        if (comment.id === id) {
            return comment;
        }
        for (const reply of comment.replies) {
            const found = visit(reply);
            if (found !== null) {
                return found;
            }
        }
        return null;
    };
    for (const thread of threads) {
        const found = visit(thread.root);
        if (found !== null) {
            return found;
        }
    }
    return null;
}

/**
 * Раскрытость тредов у кода. Появившийся тред получает дефолт один раз: свёрнут только
 * закрытый тред без моего черновика (`docs/decisions.md`, «Треды, issue и композер»);
 * ушедший из снапшота — забывается.
 */
function reconcileOpenThreads(state: Map<string, boolean>, threads: readonly Thread[]): Set<string> {
    const open = new Set<string>();
    const alive = new Set<string>();
    for (const thread of threads) {
        alive.add(thread.id);
        const known = state.get(thread.id);
        const value = known ?? !(thread.resolved && !threadHasDraft(thread));
        if (known === undefined) {
            state.set(thread.id, value);
        }
        if (value) {
            open.add(thread.id);
        }
    }
    for (const id of state.keys()) {
        if (!alive.has(id)) {
            state.delete(id);
        }
    }
    return open;
}

function commentIds(threads: readonly Thread[]): Set<string> {
    const ids = new Set<string>();
    const visit = (comment: Comment): void => {
        ids.add(comment.id);
        comment.replies.forEach(visit);
    };
    for (const thread of threads) {
        visit(thread.root);
    }
    return ids;
}

function stableGroups(
    previous: ReadonlyMap<string, readonly Thread[]> | null,
    next: ReadonlyMap<string, readonly Thread[]>,
): ReadonlyMap<string, readonly Thread[]> {
    if (previous === null) {
        return next;
    }
    const stable = new Map<string, readonly Thread[]>();
    for (const [fileId, threads] of next) {
        const before = previous.get(fileId) ?? null;
        stable.set(fileId, sameItems(before, threads) ? (before ?? threads) : threads);
    }
    return stable;
}

function stableKeptByFile(
    previous: ReadonlyMap<string, ReadonlySet<string>> | null,
    byFile: ReadonlyMap<string, readonly Thread[]>,
    kept: ReadonlySet<string>,
): ReadonlyMap<string, ReadonlySet<string>> {
    const next = new Map<string, ReadonlySet<string>>();
    for (const [fileId, threads] of byFile) {
        const ids = new Set(threads.filter((thread) => kept.has(thread.id)).map((thread) => thread.id));
        if (ids.size === 0) {
            continue;
        }
        const before = previous?.get(fileId) ?? null;
        next.set(fileId, before !== null && sameSet(before, ids) ? before : ids);
    }
    return next;
}

function sameItems<T>(left: readonly T[] | null, right: readonly T[]): boolean {
    return left !== null && left.length === right.length && left.every((item, index) => item === right[index]);
}

function sameSet<T>(left: ReadonlySet<T>, right: ReadonlySet<T>): boolean {
    return left.size === right.size && [...left].every((item) => right.has(item));
}

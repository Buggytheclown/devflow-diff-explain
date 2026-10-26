import type { Comment, FileAnchor, Locale, Thread } from '@sherpa/protocol';
import type { CSSProperties, ReactNode } from 'react';
import { useCallback, useMemo, useState, useSyncExternalStore } from 'react';

import { Avatar } from '../components/avatar.tsx';
import type { Translate } from '../i18n/index.js';
import { relativeTime, shortCommit, useLocale, useT } from '../i18n/index.js';
import { Icon } from '../icons/icon.tsx';
import { useReadOnlyIteration, useReadOnlyReason } from '../iterations/read-only.tsx';
import { useThreadPin } from '../iterations/thread-pin.tsx';
import type { ThreadPinState } from '../iterations/thread-pin.tsx';
import { Markdown } from '../markdown/markdown.tsx';
import { closeCommentComposers, composerControllerFor } from './composer.js';
import type { ComposerTransport } from './composer.js';
import { CommentComposer } from './comment-composer.tsx';
import type { ComposerSaveLabel } from './comment-composer.tsx';
import type { ComposerLayout } from './composer-markdown.js';
import { DeleteConfirm } from './delete-confirm.tsx';
import { draftEditComposerKey, DraftEditor, openDraftEditor, useActiveDraftEditor } from './draft-editor.tsx';
import { authorName, commentFirstLine, flattenThread } from './model.js';
import type { ComposerSnapshot, ThreadStore } from './store.js';
import type { PublishedCommentTransport } from './transport.js';
import { publishedCommentComposerTransport } from './transport.js';
import './threads.css';

export interface ThreadActions {
    readonly transport: ComposerTransport;
    /** `capabilities.commentIssues` хоста: без него у ответа нет свитчера issue. */
    readonly commentIssues?: boolean;
    readonly resolve: (threadId: string, resolved: boolean) => Promise<boolean>;
    /**
     * Резолв одного issue-комментария; `null`/отсутствует — хост без `capabilities.commentResolve`,
     * и кнопка остаётся одна, у корня треда.
     */
    readonly resolveComment?: ((commentId: string, resolved: boolean) => Promise<boolean>) | null;
    /** Правка и удаление своих опубликованных; `null` — хост без `capabilities.editPublished`. */
    readonly published?: PublishedCommentTransport | null;
}

/** Оформление треда: полоса под строкой кода или карточка в модалке «Комментарии к PR» (§4). */
export type ThreadVariant = 'line' | 'card';

/**
 * Сворачивание треда целиком в строку с превью — только в модалке PR: у кода ту же роль
 * играет маркер на кромке карточки (docs/design/SPEC-changes-2026-09-20.md §3, §4).
 * Раскрытость хранит стор тредов, одна на тред и на оба места.
 */
export interface ThreadCollapse {
    readonly openThreads: ReadonlySet<string>;
    readonly onToggle: (threadId: string) => void;
}

export function ThreadList({
    threads,
    store,
    actions,
    now,
    onFocusThread,
    initialLayout,
    variant = 'line',
    collapse,
}: {
    threads: readonly Thread[];
    store: ThreadStore;
    actions: ThreadActions;
    now: number;
    onFocusThread?: ((threadId: string | null) => void) | undefined;
    initialLayout?: ComposerLayout;
    variant?: ThreadVariant;
    collapse?: ThreadCollapse;
}) {
    return (
        <div className={`thread-list${variant === 'card' ? ' thread-list--card' : ''}`}>
            {threads.map((thread) => (
                <ThreadBlock
                    key={thread.id}
                    thread={thread}
                    store={store}
                    actions={actions}
                    now={now}
                    onFocusThread={onFocusThread}
                    variant={variant}
                    {...(collapse === undefined ? {} : { collapse })}
                    {...(initialLayout === undefined ? {} : { initialLayout })}
                />
            ))}
        </div>
    );
}

function ThreadBlock({
    thread,
    store,
    actions,
    now,
    onFocusThread,
    initialLayout,
    variant = 'line',
    collapse,
}: {
    thread: Thread;
    store: ThreadStore;
    actions: ThreadActions;
    now: number;
    onFocusThread?: ((threadId: string | null) => void) | undefined;
    initialLayout?: ComposerLayout;
    variant?: ThreadVariant;
    collapse?: ThreadCollapse;
}) {
    const t = useT();
    const locale = useLocale();
    // Тред прошлой итерации только читается: ни ответа, ни резолва, ни правки черновика.
    const readOnly = useReadOnlyIteration();
    const readOnlyReason = useReadOnlyReason();
    // Пин к коммиту, на котором тред написан: чип и переход «Показать на старом коммите».
    const pinned = useThreadPin(thread);
    const all = useMemo(() => flattenThread(thread.root), [thread.root]);
    const commentIds = useMemo(() => all.map((row) => row.comment.id), [all]);
    const editingId = useActiveDraftEditor(store, commentIds);
    const [confirmingId, setConfirmingId] = useState<string | null>(null);
    const [deletingId, setDeletingId] = useState<string | null>(null);
    const [deleteErrorId, setDeleteErrorId] = useState<string | null>(null);
    const draftReply = replyDraft(thread);
    const replyComposer = useComposerSnapshot(store, replyComposerKey(thread.id));
    // Под каким сообщением ревьюер нажал «Ответить»: композер разворачивается там же,
    // а не в конце треда (§3, §4). Ключ композера у треда один — это только место.
    const replyUnder = replyComposer?.replyUnder ?? null;
    // Третий аргумент — тот же снимок: стор изоморфен, и карточки рисуются статически в тестах.
    const viewerLogin = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot).viewerLogin;
    const publishedTransport = actions.published ?? null;
    const editorTransport = useMemo(
        () => (publishedTransport === null ? null : publishedCommentComposerTransport(publishedTransport)),
        [publishedTransport],
    );
    const hideReplyComposer = thread.root.draft;
    const card = variant === 'card';
    const editingComment = all.find((row) => row.comment.id === editingId)?.comment ?? null;
    /**
     * Открытый композер (ответ или правка) и подтверждение удаления держат тред раскрытым:
     * свёрнутая строка унесла бы набранный текст с экрана, а гард публикации продолжал бы его
     * считать. Поэтому сворачивание идёт через `toggleCollapsed`, а не прямо в `collapse.onToggle`.
     */
    const busy = replyComposer !== null || editingComment !== null || confirmingId !== null;
    // Свёрнутый тред оставляет на экране одну строку: шеврон, шапку корня и превью первой строки.
    const collapsed = collapse !== undefined && !collapse.openThreads.has(thread.id) && !busy;
    const rows = collapsed ? all.slice(0, 1) : all;
    const replies = all.length - 1;
    // Композер ответа стоит под своим сообщением, только пока он открыт и сообщение на экране.
    const inlineReplyId =
        replyComposer !== null && replyUnder !== null && rows.some((row) => row.comment.id === replyUnder)
            ? replyUnder
            : null;

    const setThreadResolved = (resolved: boolean): void => {
        void actions.resolve(thread.id, resolved);
    };

    /**
     * Шеврон и превью: сворачивают и раскрывают тред, но сперва убирают то, что держит его
     * раскрытым — пустой композер закрывается сам, с набранным текстом спрашивает про сброс,
     * подтверждение удаления отменяется. Следующий клик сворачивает тред.
     */
    const toggleCollapsed = (): void => {
        if (collapse === undefined) {
            return;
        }
        if (!busy) {
            collapse.onToggle(thread.id);
            return;
        }
        setDeleteErrorId(null);
        setConfirmingId(null);
        if (replyComposer !== null) {
            composerControllerFor({ store, key: replyComposer.key, transport: actions.transport }).escape();
        }
        if (editingComment !== null) {
            composerControllerFor({
                store,
                key: draftEditComposerKey(editingComment.id),
                transport: editingComment.draft ? actions.transport : (editorTransport ?? actions.transport),
            }).escape();
        }
    };

    const remove = async (comment: Comment): Promise<void> => {
        setDeletingId(comment.id);
        setDeleteErrorId(null);
        store.beginDraftDeletion(comment.id);
        try {
            if (comment.draft) {
                await actions.transport.delete(comment.id);
            } else {
                await publishedTransport?.delete(comment.id);
            }
            closeCommentComposers(store, [comment.id]);
            // Оптимистичное снятие комментария с экрана; следующий снапшот хоста его подтвердит.
            store.deleteDraft(comment.id);
            setConfirmingId(null);
        } catch {
            setDeleteErrorId(comment.id);
        } finally {
            store.endDraftDeletion(comment.id);
            setDeletingId(null);
        }
    };

    const composer = hideReplyComposer ? null : (
        <ComposerForThread
            thread={thread}
            store={store}
            transport={actions.transport}
            draft={draftReply}
            composer={replyComposer}
        />
    );

    return (
        <section
            className={`thread thread-fade${thread.root.author.bot ? ' thread--bot' : ''}${thread.resolved ? ' thread--resolved' : ''}${card ? ' thread--card' : ''}${card && thread.root.draft ? ' thread--draft' : ''}${collapsed ? ' is-collapsed' : ''}`}
            id={`thread-${thread.id}`}
            data-thread-id={thread.id}
            tabIndex={0}
            onFocus={() => {
                onFocusThread?.(thread.id);
            }}
            onBlur={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget)) {
                    onFocusThread?.(null);
                }
            }}
        >
            {rows.map((row, index) => {
                const comment = row.comment;
                const editing = editingId === comment.id;
                const mine = comment.draft || (viewerLogin !== null && comment.author.login === viewerLogin);
                // Черновик, уже открытый в композере ответа, правится там — второй пары ссылок не нужно.
                const editable =
                    replyComposer?.commentId !== comment.id &&
                    (comment.draft || (mine && editorTransport !== null));
                // Сообщение с ответами не удаляется ни на одном хосте: ответы остались бы без
                // родителя. Ссылки «Удалить» у него нет вовсе, а не выключенной.
                const deletable = editable && comment.replies.length === 0;
                const resolve = resolveControl(thread, comment, index, actions);
                return (
                    <div
                        key={comment.id}
                        className={`thread__row${index > 0 ? ' thread__row--reply' : ''}${editing ? ' is-editing' : ''}`}
                        data-comment-id={comment.id}
                        style={replyIndentStyle(row.indent)}
                    >
                        <div className="thread__author-line">
                            {collapse === undefined || index !== 0 ? null : (
                                <button
                                    type="button"
                                    className="ctl ctl--chevron thread__chevron"
                                    aria-expanded={!collapsed}
                                    aria-label={t(
                                        collapsed ? 'thread.marker.expand' : 'thread.marker.collapse',
                                        authorName(thread.root),
                                        commentFirstLine(thread.root.body, 60),
                                    )}
                                    onClick={toggleCollapsed}
                                >
                                    <Icon name={collapsed ? 'chev-right' : 'chev-down'} size={13} />
                                </button>
                            )}
                            <Avatar
                                className="thread__avatar"
                                name={comment.author.displayName ?? comment.author.login}
                                url={comment.author.avatarUrl}
                            />
                            <strong className="thread__author">
                                {comment.author.bot ? comment.author.login : authorName(comment)}
                            </strong>
                            {/* Глубже четвёртого уровня отступ не растёт, и адресата называет подпись. */}
                            {row.replyHintAuthor === null ? null : (
                                <span className="thread__reply-hint">↳ {row.replyHintAuthor}</span>
                            )}
                            {comment.issue === true ? (
                                <span className="thread__chip thread__chip--issue">issue</span>
                            ) : null}
                            {comment.author.bot ? (
                                <span className="thread__chip">
                                    {comment.author.displayName ?? comment.author.login}
                                </span>
                            ) : null}
                            {thread.outdated && index === 0 ? <span className="thread__chip">outdated</span> : null}
                            {pinned === null || index !== 0 ? null : <ThreadPinChip pinned={pinned} />}
                            {editing ? (
                                <span className="thread__chip thread__chip--editing">{t('thread.chip.editing')}</span>
                            ) : comment.draft ? (
                                <span className="thread__chip thread__chip--draft">{t('thread.chip.draft')}</span>
                            ) : null}
                            <span className="thread__meta">{metaOf(thread, comment.createdAt, now, t, locale)}</span>
                            {collapsed ? (
                                <>
                                    {/* Превью — та же мишень, что шеврон: клавиатуре хватает шеврона. */}
                                    <button
                                        type="button"
                                        className="thread__preview"
                                        tabIndex={-1}
                                        aria-hidden="true"
                                        onClick={toggleCollapsed}
                                    >
                                        {commentFirstLine(comment.body)}
                                    </button>
                                    {replies === 0 ? null : (
                                        <span className="thread__reply-count">{t('thread.replies', replies)}</span>
                                    )}
                                </>
                            ) : (
                                <span className="thread__spacer" />
                            )}
                            {resolve === null ? null : (
                                <button
                                    type="button"
                                    className={`ctl ctl--toggle ctl--toggle-compact thread__resolve${resolve.on ? ' is-on' : ''}`}
                                    aria-pressed={resolve.on}
                                    disabled={readOnly}
                                    title={readOnly ? readOnlyReason : resolve.on ? t('thread.reopen') : undefined}
                                    onClick={() => {
                                        if (resolve.kind === 'thread') {
                                            setThreadResolved(!resolve.on);
                                        } else {
                                            void actions.resolveComment?.(comment.id, !resolve.on);
                                        }
                                    }}
                                >
                                    {resolve.on ? (
                                        <Icon name="check" size={11} />
                                    ) : (
                                        <Icon name="dot" size={11} className="ctl__dot" />
                                    )}
                                    {resolve.on ? t('thread.resolved') : t('thread.resolve')}
                                </button>
                            )}
                        </div>
                        {collapsed ? null : editing ? (
                            <DraftEditor
                                comment={comment}
                                store={store}
                                transport={comment.draft ? actions.transport : (editorTransport ?? actions.transport)}
                                placeholder={t('thread.composer.linePlaceholder')}
                                inputLabel={t(comment.draft ? 'thread.composer.editLabel' : 'thread.composer.editPublishedLabel')}
                                {...(initialLayout === undefined ? {} : { initialLayout })}
                            />
                        ) : (
                            <div className="thread__body">
                                <Markdown text={comment.body} profile="comment" />
                            </div>
                        )}
                        {collapsed ? null : confirmingId === comment.id ? (
                            <DeleteConfirm
                                question={
                                    deleteErrorId === comment.id
                                        ? t(comment.draft ? 'thread.draft.deleteFailed' : 'thread.comment.deleteFailed')
                                        : t(comment.draft ? 'thread.draft.deleteConfirm' : 'thread.comment.deleteConfirm')
                                }
                                confirmLabel={
                                    deletingId === comment.id
                                        ? t('thread.draft.deleting')
                                        : t('thread.draft.deleteAction')
                                }
                                busy={deletingId === comment.id}
                                onConfirm={() => void remove(comment)}
                                onCancel={() => {
                                    setDeleteErrorId(null);
                                    setConfirmingId(null);
                                }}
                            />
                        ) : editing ? null : (
                            <div className="thread__row-actions">
                                {comment.draft ? null : (
                                    <button
                                        type="button"
                                        className="ctl ctl--link thread__action"
                                        disabled={readOnly}
                                        title={readOnly ? readOnlyReason : undefined}
                                        onClick={() => {
                                            openReply(store, thread, actions.commentIssues === true, undefined, comment.id);
                                        }}
                                    >
                                        {t('thread.reply.action')}
                                    </button>
                                )}
                                {editable ? (
                                    <>
                                        <button
                                            type="button"
                                            className="ctl ctl--link-muted thread__action"
                                            aria-label={t(
                                                comment.draft ? 'thread.draft.editAria' : 'thread.comment.editAria',
                                                comment.id,
                                            )}
                                            disabled={readOnly || editingId !== null || deletingId !== null}
                                            title={readOnly ? readOnlyReason : undefined}
                                            onClick={() => {
                                                setConfirmingId(null);
                                                openDraftEditor(store, thread, comment);
                                            }}
                                        >
                                            {t('thread.comment.edit')}
                                        </button>
                                        {deletable ? (
                                            <button
                                                type="button"
                                                className="ctl ctl--link-danger thread__action thread__action--delete"
                                                aria-label={t(
                                                    comment.draft ? 'thread.draft.deleteAria' : 'thread.comment.deleteAria',
                                                    comment.id,
                                                )}
                                                disabled={readOnly || editingId !== null || deletingId !== null}
                                                title={readOnly ? readOnlyReason : undefined}
                                                onClick={() => {
                                                    setDeleteErrorId(null);
                                                    setConfirmingId(comment.id);
                                                }}
                                            >
                                                {t('thread.comment.delete')}
                                            </button>
                                        ) : null}
                                    </>
                                ) : null}
                            </div>
                        )}
                        {inlineReplyId === comment.id ? composer : null}
                    </div>
                );
            })}

            {collapsed || inlineReplyId !== null ? null : composer}
        </section>
    );
}

/**
 * Отступ ответа слева, 27px на уровень до четвёртого (`FlatComment.indent`): аватар ответа
 * встаёт под колонкой текста родителя. У корня отступа нет, и переменная ему не нужна.
 */
function replyIndentStyle(indent: number): CSSProperties | undefined {
    return indent === 0 ? undefined : ({ '--reply-indent': `${String(indent)}px` } as CSSProperties);
}

interface ResolveControl {
    readonly kind: 'thread' | 'comment';
    readonly on: boolean;
}

/**
 * Где стоит кнопка Resolve (docs/design/SPEC-changes-2026-09-20.md §3, §5): на хосте с резолвом
 * по комментарию — у каждого комментария с issue, без issue закрывать нечего; на остальных
 * хостах — одна кнопка у корня треда. У черновика кнопки нет: закрывать неопубликованное нечего.
 */
function resolveControl(
    thread: Thread,
    comment: Comment,
    index: number,
    actions: ThreadActions,
): ResolveControl | null {
    if (comment.draft) {
        return null;
    }
    if (actions.resolveComment != null) {
        return comment.issue === true ? { kind: 'comment', on: comment.resolved === true } : null;
    }
    return index === 0 ? { kind: 'thread', on: thread.resolved } : null;
}


/** Чип пина и переход к нему: коммит в подписи короткий, полный — в подсказке (docs/design/README.md §13). */
export function ThreadPinChip({ pinned }: { pinned: ThreadPinState }) {
    const t = useT();
    return (
        <>
            <span className="thread__chip thread__chip--pinned" title={pinned.pin.commit}>
                {t('thread.pin.chip', shortCommit(pinned.pin.commit))}
            </span>
            {pinned.open === null ? null : (
                <button type="button" className="ctl ctl--link-muted thread__pin-action" onClick={pinned.open}>
                    {t('thread.pin.open')}
                </button>
            )}
        </>
    );
}

/**
 * Треды, которых нет ни у одной строки нарисованного диффа: файл ушёл из PR (docs/design/SPEC-elements.md §2.17)
 * или это бот уровня PR. Заголовок называет причину, только когда она у всех одна.
 */
function outsideTitle(threads: readonly Thread[], t: Translate): string {
    const count = threads.length;
    return threads.every((thread) => thread.anchor !== null)
        ? t('thread.outside.gone', count)
        : t('thread.outside.offDiff', count);
}

export function OutsideThreads({
    threads,
    store,
    actions,
    now,
    initialThreadId = null,
    defaultOpen = false,
    onFocusThread,
}: {
    threads: readonly Thread[];
    store: ThreadStore;
    actions: ThreadActions;
    now: number;
    initialThreadId?: string | null;
    defaultOpen?: boolean;
    onFocusThread?: ((threadId: string | null) => void) | undefined;
}) {
    const t = useT();
    const [opened, setOpened] = useState(defaultOpen);
    const open = opened || threads.some((thread) => thread.id === initialThreadId);
    if (threads.length === 0) {
        return null;
    }
    return (
        <section className="thread-outside">
            <button
                type="button"
                className="thread-outside__toggle"
                aria-expanded={open}
                onClick={() => {
                    setOpened(!open);
                }}
            >
                {outsideTitle(threads, t)}
                <Icon name={open ? 'chev-down' : 'chev-right'} size={13} />
            </button>
            {open ? (
                <ThreadList threads={threads} store={store} actions={actions} now={now} onFocusThread={onFocusThread} />
            ) : null}
        </section>
    );
}

export function NewCommentComposer({
    composerKey,
    store,
    transport,
    placeholder,
    saveLabel,
    footerHint,
    initialLayout,
    onSaveComplete,
}: {
    composerKey: string;
    store: ThreadStore;
    transport: ComposerTransport;
    placeholder?: string;
    saveLabel?: ComposerSaveLabel;
    footerHint?: ReactNode;
    initialLayout?: ComposerLayout;
    onSaveComplete?: (() => void) | undefined;
}) {
    const t = useT();
    const composer = useComposerSnapshot(store, composerKey);
    if (composer === null) {
        return null;
    }
    // Три случая: без якоря — комментарий к PR, якорь без строки — к файлу целиком
    // (картинка), якорь со строкой — к диапазону кода.
    const anchor = composer.anchor;
    const position = anchor?.position ?? null;
    return (
        <CommentComposer
            composer={composer}
            store={store}
            transport={transport}
            placeholder={
                placeholder ??
                (anchor === null
                    ? t('thread.composer.prPlaceholder')
                    : position === null
                      ? t('thread.composer.filePlaceholder')
                      : t('thread.composer.codePlaceholder'))
            }
            inputLabel={t('thread.composer.newLabel')}
            saveLabel={
                saveLabel ??
                (composer.commentId === null ? 'thread.composer.saveDraft' : 'thread.composer.saveChanges')
            }
            closeOnSave
            {...(composer.commentId === null
                ? {}
                : { restoreOnCancel: composer.originalText ?? composer.text })}
            {...(footerHint === undefined ? {} : { footerHint })}
            {...(initialLayout === undefined ? {} : { initialLayout })}
            {...(onSaveComplete === undefined ? {} : { onSaveComplete })}
        />
    );
}

function ComposerForThread({
    thread,
    store,
    transport,
    draft,
    composer,
}: {
    thread: Thread;
    store: ThreadStore;
    transport: ComposerTransport;
    draft: Comment | null;
    composer: ComposerSnapshot | null;
}) {
    const t = useT();
    if (composer === null) {
        // Вход в ответ живёт ссылкой «Ответить» под каждым сообщением (§3), отдельной полосы нет;
        // сохранённый черновик-ответ — обычная строка треда, её правит `DraftEditor`.
        return null;
    }
    const resolvedWhileTyping = !composer.resolvedAtOpen && thread.resolved;
    return (
        <CommentComposer
            composer={composer}
            store={store}
            transport={transport}
            placeholder={t('thread.reply.placeholder')}
            inputLabel={t('thread.reply.label')}
            saveLabel={composer.commentId === null ? 'thread.composer.saveDraft' : 'thread.composer.saveChanges'}
            closeOnSave
            {...(composer.commentId === null
                ? {}
                : { restoreOnCancel: composer.originalText ?? draft?.body ?? composer.text })}
            notice={
                resolvedWhileTyping
                    ? t('thread.resolvedWhileTyping', thread.resolvedBy ?? t('thread.otherReviewer'))
                    : undefined
            }
        />
    );
}

function useComposerSnapshot(store: ThreadStore, key: string): ComposerSnapshot | null {
    const subscribe = useCallback((listener: () => void) => store.subscribeComposer(key, listener), [key, store]);
    const getSnapshot = useCallback(() => store.getComposer(key), [key, store]);
    return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/** Родитель уже сохранённого черновика-ответа: композер открывается под тем же сообщением. */
function draftParentId(thread: Thread, draft: Comment | null): string | null {
    if (draft === null) {
        return null;
    }
    return flattenThread(thread.root).find((row) => row.comment.id === draft.id)?.parent?.id ?? null;
}

function replyDraft(thread: Thread): Comment | null {
    let draft: Comment | null = null;
    for (const row of flattenThread(thread.root)) {
        if (row.comment.id !== thread.root.id && row.comment.draft) {
            draft = row.comment;
        }
    }
    return draft;
}

export const PR_COMPOSER_KEY = 'new:pr';

export function openPrComposer(store: ThreadStore, commentIssues: boolean): void {
    const key = PR_COMPOSER_KEY;
    if (store.getComposer(key) !== null) {
        return;
    }
    store.openComposer({
        key,
        threadId: null,
        parentId: null,
        anchor: null,
        ...(commentIssues ? { issue: true } : {}),
        text: '',
        commentId: null,
        status: 'idle',
        slow: false,
        confirmDiscard: false,
        resolvedAtOpen: false,
    });
}

/**
 * `initialText` — посев текста композера (цитата заметки агента). Уже открытый композер с
 * набранным текстом посев не трогает: там работа ревьюера, затирать её нельзя.
 */
export function openNewComposer(
    store: ThreadStore,
    key: string,
    anchor: FileAnchor,
    commentIssues: boolean,
    initialText = '',
): void {
    const open = store.getComposer(key);
    if (open !== null) {
        // Ключ композера строится по первой строке, без размера диапазона: композер карандаша на
        // строке 148 и заметка на 148–151 попадают в один ключ. При посеве берём якорь заметки,
        // иначе черновик сохранится на диапазон, который не соответствует цитате.
        if (initialText !== '' && open.text.trim() === '') {
            store.updateComposer(key, { text: initialText, anchor });
        }
        return;
    }
    store.openComposer({
        key,
        threadId: null,
        parentId: null,
        anchor,
        ...(commentIssues ? { issue: true } : {}),
        text: initialText,
        commentId: null,
        status: 'idle',
        slow: false,
        confirmDiscard: false,
        resolvedAtOpen: false,
    });
}

/**
 * Композер комментария к файлу без строки: якорь с `position: null` уводит его под
 * шапку карточки — туда же, где живут треды, потерявшие строку.
 */
export function openFileComposer(store: ThreadStore, fileId: string, path: string, commentIssues: boolean): void {
    openNewComposer(store, `new:${fileId}:file`, { fileId, path, position: null }, commentIssues);
}

export function replyComposerKey(threadId: string): string {
    return `reply:${threadId}`;
}

/**
 * `replyUnder` — сообщение, под которым композер разворачивается и чьим ответом станет
 * черновик (§3, §4); по умолчанию это корень треда. Уже открытый композер переезжает туда же
 * вместе с набранным текстом и меняет родителя: ответ у треда один.
 *
 * Не переезжает композер, чей текст уже ушёл на запись: родитель либо записан вместе с
 * черновиком (`commentId !== null`), либо записывается прямо сейчас (`clientKey` живёт от
 * первого сохранения до его успеха), и сменить его можно только удалением черновика. У такого
 * композера «Ответить» под другим сообщением просто возвращает к месту черновика — по той же
 * причине родитель сохранённого черновика сильнее `replyUnder` и при открытии композера.
 */
export function openReply(
    store: ThreadStore,
    thread: Thread,
    commentIssues: boolean,
    draft: Comment | null = replyDraft(thread),
    replyUnder: string | null = null,
): void {
    const key = replyComposerKey(thread.id);
    const target = draftParentId(thread, draft) ?? replyUnder ?? thread.root.id;
    const open = store.getComposer(key);
    if (open !== null) {
        const written = open.commentId !== null || open.clientKey !== undefined;
        if (!written && open.replyUnder !== target) {
            store.updateComposer(key, { replyUnder: target, parentId: target });
        }
        return;
    }
    if (draft !== null && store.getComposer(draftEditComposerKey(draft.id)) !== null) {
        return;
    }
    store.openComposer({
        key,
        threadId: thread.id,
        parentId: target,
        anchor: null,
        replyUnder: target,
        // Ответ тоже бывает замечанием: issue у него свой, дефолт — включён, как у нового треда.
        ...(commentIssues ? { issue: draft?.issue ?? true } : {}),
        text: draft?.body ?? '',
        ...(draft === null ? {} : { originalText: draft.body }),
        commentId: draft?.id ?? null,
        status: draft === null ? 'idle' : 'saved',
        savedAt: draft === null ? null : Date.parse(draft.editedAt ?? draft.createdAt),
        slow: false,
        confirmDiscard: false,
        resolvedAtOpen: thread.resolved,
    });
}

function metaOf(thread: Thread, createdAt: string, now: number, t: Translate, locale: Locale): string {
    const path = thread.anchor?.path.split('/').at(-1) ?? 'PR';
    const position = thread.anchor?.position;
    const when = relativeTime(createdAt, now, locale);
    return position == null ? t('thread.meta', path, when) : t('thread.meta.line', path, lineRange(position), when);
}

function lineRange(position: { readonly line: number; readonly size: number }): string {
    const last = position.line + Math.max(position.size, 1) - 1;
    return last === position.line ? String(position.line) : `${String(position.line)}–${String(last)}`;
}


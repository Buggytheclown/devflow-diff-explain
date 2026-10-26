import type { DraftBufferEntry, PrMeta } from '@sherpa/protocol';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';

import type { DraftDestination } from '../app/review-state.js';
import type { MessageKey } from '../i18n/index.js';
import { useT } from '../i18n/index.js';
import { Icon } from '../icons/icon.tsx';
import { useEscapeLayer, useShortcutRegistry } from '../shortcuts/context.tsx';
import { closeCommentComposers, closeEmptyReplyComposers, composerControllerFor } from '../threads/composer.js';
import type { ComposerTransport } from '../threads/composer.js';
import type { ComposerLayout } from '../threads/composer-markdown.js';
import { flattenThread, prLevelThreads } from '../threads/model.js';
import {
    NewCommentComposer,
    openPrComposer,
    PR_COMPOSER_KEY,
    ThreadList,
} from '../threads/thread-list.tsx';
import type { ThreadActions } from '../threads/thread-list.tsx';
import type { ComposerSnapshot, ThreadStore } from '../threads/store.js';
import { useFocusTrap } from './use-focus-trap.js';
import './pr-comments-modal.css';

const EMPTY_DRAFT_BUFFER: readonly DraftBufferEntry[] = [];

export interface PrCommentsModalProps {
    readonly pr: PrMeta;
    readonly store: ThreadStore;
    readonly transport: ComposerTransport;
    /**
     * Действия тредов: Resolve, правка и удаление опубликованного. Без них (галерея, тесты
     * компонента) остаётся только то, что умеет сам транспорт черновиков.
     */
    readonly actions?: ThreadActions;
    /** Записи буфера черновиков; показываются все, снять их можно только здесь. */
    readonly draftBuffer?: readonly DraftBufferEntry[];
    /** Куда уйдут черновики: от этого зависят подсказки про публикацию. */
    readonly draftDestination?: DraftDestination;
    readonly onClose: () => void;
    readonly now?: number;
    readonly initialLayout?: ComposerLayout;
}

/**
 * Комментарии к PR: треды уровня PR карточками (docs/design/SPEC-changes-2026-09-20.md §4)
 * и композер нового комментария внизу. Анатомия сообщений, ответ на месте, Resolve и правка —
 * общие с тредами у кода; своё здесь только сворачивание треда в строку с превью.
 */
export function PrCommentsModal({
    pr,
    store,
    transport,
    actions,
    draftBuffer = EMPTY_DRAFT_BUFFER,
    draftDestination = 'pr',
    onClose,
    now,
    initialLayout,
}: PrCommentsModalProps) {
    const t = useT();
    const shortcutRegistry = useShortcutRegistry();
    const commentIssues = pr.capabilities.commentIssues;
    const [openedAt] = useState(() => now ?? Date.now());
    const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
    const prComposer = useComposerSnapshot(store, PR_COMPOSER_KEY);
    // Порядок — новое сверху, по времени корня треда.
    const prThreads = useMemo(
        () =>
            prLevelThreads(snapshot.threads).sort(
                (left, right) => Date.parse(right.root.createdAt) - Date.parse(left.root.createdAt),
            ),
        [snapshot.threads],
    );
    const threads = useMemo(
        () => prThreads.filter((thread) => thread.root.id !== prComposer?.commentId),
        [prComposer?.commentId, prThreads],
    );
    const fallbackActions = useMemo<ThreadActions>(
        () => ({
            transport,
            commentIssues,
            resolve: () => Promise.resolve(false),
            resolveComment: null,
            published: null,
        }),
        [commentIssues, transport],
    );
    const threadActions = actions ?? fallbackActions;
    const collapse = useMemo(
        () => ({ openThreads: snapshot.openThreads, onToggle: store.toggleThreadOpen }),
        [snapshot.openThreads, store],
    );
    const modalRef = useRef<HTMLElement | null>(null);
    const closeRef = useRef<HTMLButtonElement | null>(null);
    const listRef = useRef<HTMLDivElement | null>(null);

    useEffect(() => {
        openPrComposer(store, commentIssues);
    }, [commentIssues, store]);

    useEffect(() => {
        shortcutRegistry?.setModalOpen(true);
        return () => {
            shortcutRegistry?.setModalOpen(false);
        };
    }, [shortcutRegistry]);

    useEffect(() => {
        const previousOverflow = document.body.style.overflow;
        document.body.style.overflow = 'hidden';
        closeRef.current?.focus();
        return () => {
            document.body.style.overflow = previousOverflow;
        };
    }, []);

    /**
     * Композеры модалки живут только в ней: закрылась — закрываем и их, иначе невидимая правка
     * продолжала бы держать гард публикации. Закрываем то, где нечего терять: правку (её текст
     * лежит в черновике и вернётся при следующем открытии) и пустой композер ответа. Набранный
     * ответ остаётся открытым — он ждёт на своём месте, под своим сообщением, и тред с ним
     * не сворачивается; молча уйти от него нельзя, закрытие сперва спрашивает про сброс
     * (`requestClose`), так что скрытым гард публикации не становится.
     */
    const shownComments = useMemo(
        () => threads.flatMap((thread) => flattenThread(thread.root).map((row) => row.comment.id)),
        [threads],
    );
    const shownThreads = useMemo(() => threads.map((thread) => thread.id), [threads]);
    const shownRef = useRef({ comments: shownComments, threads: shownThreads });
    useEffect(() => {
        shownRef.current = { comments: shownComments, threads: shownThreads };
    }, [shownComments, shownThreads]);
    useEffect(
        () => () => {
            closeCommentComposers(store, shownRef.current.comments);
            closeEmptyReplyComposers(store, shownRef.current.threads);
        },
        [store],
    );

    /**
     * Закрытие модалки: ✕, клик по фону и Esc. Композер с набранным, но не сохранённым текстом
     * закрыться молча не даёт — иначе гард публикации держал бы текст, которого не видно
     * на экране. Спрашиваем про сброс там же, где текст набран (тот же вопрос, что у шеврона
     * треда), и подводим к вопросу список; пустой композер закрывается сам и не мешает.
     */
    const requestClose = useCallback((): void => {
        const shownThreadIds = new Set(shownRef.current.threads);
        const unsaved = store
            .listComposers()
            .filter(
                (composer) =>
                    composer.commentId === null &&
                    composer.text.trim() !== '' &&
                    (composer.key === PR_COMPOSER_KEY ||
                        (composer.threadId !== null && shownThreadIds.has(composer.threadId))),
            );
        if (unsaved.length === 0) {
            onClose();
            return;
        }
        for (const composer of unsaved) {
            composerControllerFor({ store, key: composer.key, transport }).escape();
        }
        const threadId = unsaved.find((composer) => composer.threadId !== null)?.threadId ?? null;
        if (threadId !== null) {
            const nodes = [...(modalRef.current?.querySelectorAll<HTMLElement>('[data-thread-id]') ?? [])];
            nodes.find((node) => node.dataset.threadId === threadId)?.scrollIntoView({ block: 'nearest' });
        }
    }, [onClose, store, transport]);

    useFocusTrap(modalRef);
    useEscapeLayer('modal', requestClose);

    const savedNewComment = useCallback((): void => {
        openPrComposer(store, commentIssues);
        queueMicrotask(() => {
            if (listRef.current !== null) {
                listRef.current.scrollTop = 0;
            }
        });
    }, [commentIssues, store]);

    const content = (
        <div
            className="pr-comments-modal__overlay"
            onMouseDown={(event) => {
                if (event.target === event.currentTarget) {
                    requestClose();
                }
            }}
        >
            <section
                ref={modalRef}
                className="pr-comments-modal"
                role="dialog"
                aria-modal="true"
                aria-labelledby="pr-comments-modal-title"
                tabIndex={-1}
            >
                <header className="pr-comments-modal__header">
                    <h2 id="pr-comments-modal-title">{t('prComments.title')}</h2>
                    <span className="pr-comments-modal__context">{t('prComments.context', pr.id)}</span>
                    <span className="pr-comments-modal__header-spacer" />
                    <button
                        ref={closeRef}
                        type="button"
                        className="ctl ctl--icon pr-comments-modal__icon-button"
                        aria-label={t('prComments.close')}
                        title={t('prComments.close.title')}
                        onClick={requestClose}
                    >
                        <Icon name="cross" size={14} />
                    </button>
                </header>

                {draftBuffer.length === 0 ? null : (
                    <BufferedDrafts entries={draftBuffer} transport={transport} />
                )}

                <div className="pr-comments-modal__list-shell">
                    <div ref={listRef} className="pr-comments-modal__list">
                        {threads.length === 0 ? (
                            <div className="pr-comments-modal__empty">
                                {t(draftDestination === 'agent' ? 'prComments.empty.agent' : 'prComments.empty')}
                            </div>
                        ) : (
                            <ThreadList
                                threads={threads}
                                store={store}
                                actions={threadActions}
                                now={openedAt}
                                variant="card"
                                collapse={collapse}
                                {...(initialLayout === undefined ? {} : { initialLayout })}
                            />
                        )}
                    </div>
                    <div className="pr-comments-modal__list-fade" aria-hidden="true" />
                </div>

                <footer className="pr-comments-modal__composer">
                    {prComposer === null ? (
                        <button
                            type="button"
                            className="pr-comments-modal__composer-entry"
                            onClick={() => {
                                openPrComposer(store, commentIssues);
                            }}
                        >
                            <span>{t('prComments.new')}</span>
                            <Icon name="pencil" size={13} />
                        </button>
                    ) : (
                        <NewCommentComposer
                            composerKey={PR_COMPOSER_KEY}
                            store={store}
                            transport={transport}
                            footerHint={<ComposerShortcutHint escapeLabel="prComments.escape.close" />}
                            {...(initialLayout === undefined ? {} : { initialLayout })}
                            onSaveComplete={savedNewComment}
                        />
                    )}
                    <div className="pr-comments-modal__ship-note">
                        <Icon name="updown" size={13} />
                        {t(draftDestination === 'agent' ? 'prComments.footer.agent' : 'prComments.footer')}
                    </div>
                </footer>
            </section>
        </div>
    );

    return typeof document === 'undefined' ? content : createPortal(content, document.body);
}

/**
 * Черновики, которые сервер принял, а хост ещё нет. Здесь они все, а не только
 * уровня PR: пока запись жива, ship недоступен, а её композер может быть не на экране —
 * например, у строки файла из прошлой итерации. Это единственное место, где такую запись
 * видно и можно снять.
 */
function BufferedDrafts({
    entries,
    transport,
}: {
    readonly entries: readonly DraftBufferEntry[];
    readonly transport: ComposerTransport;
}) {
    const t = useT();
    const [busyId, setBusyId] = useState<string | null>(null);
    const act = (id: string, action: ((id: string) => Promise<void>) | undefined): void => {
        if (action === undefined) {
            return;
        }
        setBusyId(id);
        void action(id).finally(() => {
            setBusyId((current) => (current === id ? null : current));
        });
    };
    return (
        <section className="pr-comments-modal__buffered" aria-label={t('prComments.buffered.label')}>
            <h3>{t('prComments.buffered.title', entries.length)}</h3>
            {entries.map((entry) => (
                <div key={entry.id} className="pr-comments-modal__buffered-item">
                    <span
                        className="pr-comments-modal__buffered-text"
                        {...(entry.error === null ? {} : { title: entry.error })}
                    >
                        {entry.draft.body}
                    </span>
                    <span className="pr-comments-modal__item-spacer" />
                    <button
                        type="button"
                        className="ctl ctl--ghost ctl--compact pr-comments-modal__keep-button"
                        disabled={busyId !== null}
                        onClick={() => {
                            act(entry.id, transport.retryBuffered);
                        }}
                    >
                        {t('prComments.buffered.retry')}
                    </button>
                    <button
                        type="button"
                        className="ctl ctl--danger pr-comments-modal__delete-button"
                        disabled={busyId !== null}
                        onClick={() => {
                            act(entry.id, transport.discardBuffered);
                        }}
                    >
                        {t('prComments.buffered.discard')}
                    </button>
                </div>
            ))}
        </section>
    );
}

function ComposerShortcutHint({ escapeLabel }: { escapeLabel: MessageKey }) {
    const t = useT();
    return (
        <span className="pr-comments-modal__shortcuts">
            <kbd>⌘⏎</kbd> {t('prComments.hint.save')} <kbd>Esc</kbd> {t(escapeLabel)}
        </span>
    );
}

function useComposerSnapshot(store: ThreadStore, key: string): ComposerSnapshot | null {
    const subscribe = useCallback((listener: () => void) => store.subscribeComposer(key, listener), [key, store]);
    const getSnapshot = useCallback(() => store.getComposer(key), [key, store]);
    return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

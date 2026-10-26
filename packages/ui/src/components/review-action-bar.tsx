import type { DraftBufferEntry, PrDiff, PrMeta, PublishResult, Verdict } from '@sherpa/protocol';
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';

import { draftDestinationOf } from '../app/review-state.js';
import type { DraftDestination } from '../app/review-state.js';
import type { DiffViewStore } from '../diff-view/store.js';
import { Icon } from '../icons/icon.tsx';
import type { IconName } from '../icons/icon.tsx';
import type { Translate } from '../i18n/index.js';
import { useFormat, useT } from '../i18n/index.js';
import { useReadOnlyIteration, useReadOnlyReason } from '../iterations/read-only.tsx';
import { useThreadPinContext } from '../iterations/thread-pin.tsx';
import type { ReviewProgressSummary } from '../progress/summary.js';
import {
    commentBodies,
    countDraftComments,
    countIssueDraftComments,
    countPinnedDraftComments,
    countPublishedReplies,
    reviewProgressSummary,
} from '../progress/summary.js';
import { useEscapeLayer, useShortcut } from '../shortcuts/context.tsx';
import { useUiSettings, useUiSettingsStore } from '../settings/context.tsx';
import type { ConnectionState } from '../store.js';
import { closePublishedComposers } from '../threads/composer.js';
import type { ComposerTransport } from '../threads/composer.js';
import type { ThreadStore } from '../threads/store.js';
import type { ThreadActions } from '../threads/thread-list.tsx';
import { discussionStats } from '../views/overview-model.js';
import { chatOverlaysContent } from './dock.js';
import type { PrCommentsGate } from './pr-comments-gate.js';
import { usePrCommentsGate } from './pr-comments-gate.js';
import { PrCommentsModal } from './pr-comments-modal.tsx';
import {
    availableShipMode,
    draftsCounterKey,
    noDraftsKey,
    partialPublicationFailure,
    type PublicationFailure,
    publishConsequenceKey,
    publishDisabledReason,
    requestPublicationFailure,
    SHIP_MENU_MODES,
    type ShipMode,
    shipModeLabelKey,
    shipModeOf,
    shipModesOf,
    shipOptionDisabledKey,
    unreachableVerdict,
} from './review-action-model.js';
import './review-action-bar.css';

const EMPTY_DRAFT_BUFFER: readonly DraftBufferEntry[] = [];

// Обещания отмены по a.yaml-зоне из docs/design/README.md §5 в описании sticky нет: публикуется обычный
// sticky ship хоста, зонной механики у нас нет.

/**
 * Слой маршрута в панели действий (docs/design/SPEC-elements.md §2.19, docs/design/README.md
 * §13): гардрейл считает непросмотренные остановки вместо файлов, а итог ревью — строки про маршрут. `null` — маршрута нет,
 * гардрейл и итог считают файлы.
 */
export interface RouteProgress {
    /** Слоты маршрута в порядке рендера, включая «Прочее». */
    readonly stopIds: readonly string[];
    readonly otherStopId: string | null;
    /** Строки, которые модель не разместила; `null` — вью маршрута ещё не открывали. */
    readonly uncoveredLines: number | null;
    readonly viewed: ReadonlyMap<string, boolean>;
}

/** Числа маршрута в итоге ревью — снимок на момент публикации. */
export interface ReviewCompletionRoute {
    readonly stopsTotal: number;
    readonly stopsViewed: number;
    /** «Прочее» прочитано сырым диффом (docs/design/README.md §13). */
    readonly otherViewed: boolean;
    readonly uncoveredLines: number | null;
}

export interface ReviewCompletion {
    readonly verdict: Verdict;
    readonly prId: string;
    readonly headCommit: string;
    readonly hostName: string;
    /** Имя адаптера (`uiState.reviewHost`): у локального ревью своя строка доставки. */
    readonly reviewHost: string;
    readonly publishedComments: number;
    readonly publishedReplies: number;
    readonly progress: ReviewProgressSummary;
    readonly route: ReviewCompletionRoute | null;
    readonly openThreads: number;
    readonly firstOpenThreadId: string | null;
}

export interface ReviewActionBarProps {
    readonly pr: PrMeta;
    readonly diff: PrDiff;
    readonly diffStore: DiffViewStore;
    readonly threadStore: ThreadStore;
    readonly connection: ConnectionState;
    readonly hostName: string;
    /** Имя адаптера: едет в итог публикации и решает, куда уходят черновики; подпись хоста — `hostName`. */
    readonly reviewHost: string;
    readonly route?: RouteProgress | null;
    readonly composerTransport: ComposerTransport;
    /** Действия тредов для модалки комментариев: Resolve, правка и удаление опубликованного. */
    readonly threadActions?: ThreadActions;
    /** Черновики в буфере сервера: считаются в пакете и держат ship до отправки. */
    readonly draftBuffer?: readonly DraftBufferEntry[];
    readonly onPublish: (verdict: Verdict) => Promise<PublishResult>;
    readonly onComplete: (completion: ReviewCompletion) => void;
    readonly defaultMenuOpen?: boolean;
    /**
     * Общее состояние модалки комментариев к PR: её открывает и панель, и карточка обсуждения
     * на Обзоре (docs/design/SPEC-additions-2026-08-26.md §1e). Без него панель держит своё — так она живёт в галерее.
     */
    readonly prComments?: PrCommentsGate;
    readonly initialFailure?: PublicationFailure | null;
    /**
     * Открыт ли чат: пока он работает оверлеем (<1280), панель лежит под его скримом. Мышь до
     * неё не доходит — скрим ловит клик, — а хоткеи публикации гасит этот флаг.
     */
    readonly chatOpen?: boolean;
}

interface PublishOptions {
    /** Повтор после сбоя: разрешён даже когда обычная публикация заблокирована. */
    readonly retry?: boolean;
    /** Ревьюер выбрал режим в меню Ship — запомнить его в глобальных настройках. */
    readonly remember?: boolean;
}

/**
 * Условие монтирования панели: только с рабочими данными ревью. Пока они грузятся, панели нет вовсе —
 * заглушка показывала бы режимы публикации, которых у этого PR может не оказаться.
 */
export function reviewActionBarVisible({
    completed,
    reviewHost,
    pr,
    dataReady,
}: {
    readonly completed: boolean;
    readonly reviewHost: string | null;
    readonly pr: PrMeta | null;
    readonly dataReady: boolean;
}): boolean {
    return !completed && reviewHost !== null && pr !== null && dataReady;
}

/** Терминальные действия ревью: живые счётчики, гард сохранения и один пакет публикации. */
export function ReviewActionBar({
    pr,
    diff,
    diffStore,
    threadStore,
    connection,
    hostName,
    reviewHost,
    route = null,
    composerTransport,
    draftBuffer = EMPTY_DRAFT_BUFFER,
    onPublish,
    onComplete,
    defaultMenuOpen = false,
    prComments,
    threadActions,
    initialFailure = null,
    chatOpen = false,
}: ReviewActionBarProps) {
    const t = useT();
    const format = useFormat();
    const diffSnapshot = useSyncExternalStore(diffStore.subscribe, diffStore.getSnapshot, diffStore.getSnapshot);
    const threadSnapshot = useSyncExternalStore(threadStore.subscribe, threadStore.getSnapshot, threadStore.getSnapshot);
    const composerGuard = useSyncExternalStore(
        threadStore.subscribeComposerGuard,
        threadStore.getComposerGuardSnapshot,
        threadStore.getComposerGuardSnapshot,
    );
    // Панель рисует ровно те режимы, которые хост примет на этом PR; хосты она не различает.
    const publishVerdicts = pr.capabilities.publishVerdicts;
    const requestChangesAvailable = publishVerdicts.includes('request_changes');
    const shipModes = shipModesOf(publishVerdicts);
    // Один режим (локальное ревью, свой PR на GitHub) — кнопка без каретки и меню.
    const hasShipMenu = shipModes.length > 1;
    const destination = draftDestinationOf(reviewHost);
    const settings = useUiSettingsStore();
    // Режим шипа глобальный (docs/design/SPEC-elements.md §2.8); недоступный на PR откатывается к доступному.
    const shipMode = useUiSettings().shipMode;
    const effectiveShipMode = availableShipMode(shipMode, shipModes);
    // null — хост на этом PR не принимает ни одного режима сплит-кнопки: её нет вовсе.
    const effectiveCursor = effectiveShipMode === null ? 0 : SHIP_MENU_MODES.indexOf(effectiveShipMode);
    const [menuOpen, setMenuOpen] = useState(defaultMenuOpen && hasShipMenu);
    const [cursor, setCursor] = useState(effectiveCursor);
    const ownPrComments = usePrCommentsGate();
    const prCommentsGate = prComments ?? ownPrComments;
    const prCommentsOpen = prCommentsGate.open;
    const [publishing, setPublishing] = useState<Verdict | null>(null);
    const [failure, setFailure] = useState<PublicationFailure | null>(initialFailure);
    const rootRef = useRef<HTMLDivElement | null>(null);
    const shipButtonRef = useRef<HTMLButtonElement | null>(null);
    const commentButtonRef = useRef<HTMLButtonElement | null>(null);
    const menuRef = useRef<HTMLDivElement | null>(null);
    const publicationRef = useRef<{
        verdict: Verdict;
        // Режим выбран руками — значит его можно запомнить и при повторе после сбоя.
        remember: boolean;
        publishedIds: Set<string>;
    } | null>(null);

    const threadPin = useThreadPinContext();
    // Буферные записи — такие же черновики пакета: они уйдут при публикации, как только доедут в хост.
    // Считаются только создания: правка относится к черновику, который в тредах уже посчитан.
    const buffered = draftBuffer.length;
    const bufferedNew = draftBuffer.filter((entry) => entry.commentId === null).length;
    const drafts = countDraftComments(threadSnapshot.threads) + bufferedNew;
    // Хвост «· N issue» у счётчика: сколько из этих черновиков откроют замечание (§1).
    const issueDrafts =
        countIssueDraftComments(threadSnapshot.threads) +
        draftBuffer.filter((entry) => entry.commentId === null && entry.draft.issue === true).length;
    // Черновики, написанные до пуша: уйдут к коммиту, которого в голове PR уже нет
    // (docs/design/SPEC-elements.md §4.5).
    const pinnedDrafts = countPinnedDraftComments(threadSnapshot.threads, threadPin.activeDiffId);
    const progress = reviewProgressSummary(diff.files, diffSnapshot.readState);
    const unviewed = progress.filesTotal - progress.filesSeen;
    const routeCompletion = routeCompletionOf(route);
    // Маршрут есть — гардрейл считает остановки, а не файлы (docs/design/SPEC-elements.md §2.19).
    const unviewedStops = routeCompletion === null ? 0 : routeCompletion.stopsTotal - routeCompletion.stopsViewed;
    const draggingSelection = diffSnapshot.selectionDragging;
    // Публикация меняет PR — она живёт только в активной итерации.
    const readOnlyIteration = useReadOnlyIteration();
    const readOnlyReason = useReadOnlyReason();
    const retryDisabledReason = publishDisabledReason({
        t,
        connection,
        pendingComposer: composerGuard.pending,
        bufferedDrafts: buffered,
        publishing: publishing !== null,
        readOnlyIteration,
        readOnlyReason,
    });
    const disabledReason = publishDisabledReason({
        t,
        connection,
        pendingComposer: composerGuard.pending,
        bufferedDrafts: buffered,
        publishing: publishing !== null,
        failure: failure !== null,
        readOnlyIteration,
        readOnlyReason,
    });
    const disabled = disabledReason !== null;
    // Публикацию без вердикта хост может не принимать, а без черновиков ей и нечего нести.
    const publishCommentsReason =
        disabledReason ??
        (publishVerdicts.includes('comment')
            ? drafts === 0
                ? t(noDraftsKey(destination))
                : null
            : t('ship.mode.comment.unavailable'));
    const primaryDisabledReason = effectiveShipMode === 'comment' ? publishCommentsReason : disabledReason;
    const optionDisabledReason = (mode: ShipMode): string | null => {
        const key = shipOptionDisabledKey(mode, shipModes, drafts, destination);
        return key === null ? null : t(key);
    };

    const closeMenu = useCallback((returnFocus: boolean): void => {
        setMenuOpen(false);
        if (returnFocus) {
            shipButtonRef.current?.focus();
        }
    }, [setMenuOpen]);

    useEffect(() => {
        if (!menuOpen) {
            return;
        }
        menuRef.current?.focus();
        const closeOutside = (event: MouseEvent): void => {
            if (event.target instanceof Node && !rootRef.current?.contains(event.target)) {
                closeMenu(true);
            }
        };
        document.addEventListener('mousedown', closeOutside);
        return () => {
            document.removeEventListener('mousedown', closeOutside);
        };
    }, [closeMenu, menuOpen]);

    useEscapeLayer('popover', () => {
        closeMenu(true);
    }, menuOpen);

    /**
     * Публикует вердикт. `remember` ставится только на выборе в меню: главная часть может
     * публиковать уже понижённый режим (на этом PR нет sticky), и запись понижения в глобальные
     * настройки сбросила бы выбор на всех остальных PR.
     */
    const publish = useCallback(
        async (verdict: Verdict, { retry = false, remember = false }: PublishOptions = {}): Promise<void> => {
            if ((retry ? retryDisabledReason : disabledReason) !== null) {
                return;
            }
            const threadsBefore = threadStore.getSnapshot().threads;
            const draftCount = countDraftComments(threadsBefore);
            const publication =
                publicationRef.current?.verdict === verdict
                    ? publicationRef.current
                    : { verdict, remember, publishedIds: new Set<string>() };
            publicationRef.current = publication;
            setMenuOpen(false);
            setFailure(null);
            setPublishing(verdict);
            try {
                const result = await onPublish(verdict);
                closePublishedComposers(threadStore, result.publishedCommentIds);
                for (const commentId of result.publishedCommentIds) {
                    publication.publishedIds.add(commentId);
                }
                const currentThreads = threadStore.getSnapshot().threads;
                const partial = partialPublicationFailure(verdict, result, commentBodies(currentThreads), t);
                if (partial !== null) {
                    setFailure(partial);
                    return;
                }
                const chosenShipMode = shipModeOf(verdict);
                if (publication.remember && chosenShipMode !== null) {
                    settings.update({ shipMode: chosenShipMode });
                }
                const discussion = discussionStats(currentThreads);
                const publishedIds = [...publication.publishedIds];
                publicationRef.current = null;
                onComplete({
                    verdict,
                    prId: pr.id,
                    headCommit: diff.headCommit,
                    hostName,
                    reviewHost,
                    publishedComments: publishedIds.length,
                    publishedReplies: countPublishedReplies(currentThreads, publishedIds),
                    progress: reviewProgressSummary(diff.files, diffStore.getSnapshot().readState),
                    route: routeCompletion,
                    openThreads: discussion.open,
                    firstOpenThreadId: currentThreads.find((thread) => !thread.resolved)?.id ?? null,
                });
            } catch (error) {
                setFailure(requestPublicationFailure(verdict, draftCount, error));
            } finally {
                setPublishing(null);
            }
        },
        [
            diff.files,
            diff.headCommit,
            diffStore,
            disabledReason,
            hostName,
            onComplete,
            onPublish,
            pr.id,
            retryDisabledReason,
            reviewHost,
            routeCompletion,
            setFailure,
            setMenuOpen,
            setPublishing,
            settings,
            t,
            threadStore,
        ],
    );

    useShortcut({
        id: 'review.shipMenu',
        keys: ['mod+enter'],
        label: 'shortcut.review.shipMenu',
        scope: 'global',
        section: 'ship',
        ...(effectiveShipMode === null ? {} : { consequence: publishConsequenceKey(effectiveShipMode, destination) }),
        consequenceArg: drafts,
        when: () =>
            hasShipMenu &&
            !draggingSelection &&
            !disabled &&
            !prCommentsOpen &&
            !chatOverlaysContent(chatOpen),
        action: () => {
            setCursor(effectiveCursor);
            setMenuOpen(true);
        },
    });
    useShortcut({
        id: 'review.requestChanges',
        keys: ['mod+shift+enter'],
        label: 'shortcut.review.requestChanges',
        scope: 'global',
        section: 'ship',
        consequence: publishConsequenceKey('request_changes', destination),
        consequenceArg: drafts,
        when: () =>
            requestChangesAvailable &&
            !draggingSelection &&
            !disabled &&
            !prCommentsOpen &&
            !chatOverlaysContent(chatOpen),
        action: () => {
            void publish('request_changes');
        },
    });
    useShortcut({
        id: 'review.publishComments',
        keys: [],
        label: 'shortcut.review.publishComments',
        scope: 'global',
        section: 'ship',
        consequence: publishConsequenceKey('comment', destination),
        consequenceArg: drafts,
        when: () =>
            publishCommentsReason === null &&
            !draggingSelection &&
            !prCommentsOpen &&
            !chatOverlaysContent(chatOpen),
        action: () => {
            void publish('comment');
        },
    });

    if (draggingSelection) {
        return null;
    }

    if (failure !== null) {
        return (
            <div className="review-action-bar review-action-bar--error" ref={rootRef} role="alert">
                <div className="review-action-error__summary">
                    {failure.failedCount === 0
                        ? t('ship.error.failed')
                        : t('ship.error.comments', failure.failedCount)}
                    {' · '}
                    <button
                        type="button"
                        className="ctl ctl--link-muted"
                        onClick={() => void publish(failure.verdict, { retry: true })}
                        disabled={retryDisabledReason !== null}
                        title={retryDisabledReason ?? undefined}
                    >
                        {t('ship.error.retry')}
                    </button>
                </div>
                {failure.message === null ? null : <div className="review-action-error__message">{failure.message}</div>}
                {failure.comments.length === 0 ? null : (
                    <ul className="review-action-error__comments">
                        {failure.comments.map((comment) => (
                            <li key={comment.commentId}>
                                <span>{comment.body ?? t('ship.error.comment', comment.commentId)}</span>
                                <small>{comment.message}</small>
                            </li>
                        ))}
                    </ul>
                )}
            </div>
        );
    }

    return (
        <div className="review-action-bar" ref={rootRef} data-tour="ship">
            <span className="review-action-bar__progress">
                {t('ship.progress', progress.filesSeen, progress.filesTotal)}
            </span>
            <span className="review-action-bar__divider" aria-hidden="true" />
            {drafts === 0 ? (
                <span className="review-action-bar__no-drafts">{t(noDraftsKey(destination))}</span>
            ) : (
                <span className="review-action-bar__drafts">
                    <span className="review-action-bar__draft-dot" aria-hidden="true" />
                    {t(draftsCounterKey(destination), drafts)}
                    {issueDrafts === 0 ? null : <> {t('ship.drafts.issues', issueDrafts)}</>}
                    {buffered === 0 ? null : (
                        <span className="review-action-bar__pinned-drafts">
                            {' '}
                            {t('ship.drafts.buffered', buffered)}
                        </span>
                    )}
                    {pinnedDrafts === 0 ? null : (
                        <span className="review-action-bar__pinned-drafts">
                            {' '}
                            {t('ship.drafts.pinned', pinnedDrafts)}
                        </span>
                    )}
                </span>
            )}
            <span className="review-action-bar__divider" aria-hidden="true" />
            <button
                ref={commentButtonRef}
                type="button"
                className="ctl ctl--ghost review-action-bar__button"
                aria-expanded={prCommentsOpen}
                aria-haspopup="dialog"
                onClick={() => {
                    prCommentsGate.openModal(() => {
                        commentButtonRef.current?.focus();
                    });
                    setMenuOpen(false);
                }}
            >
                {t('ship.prComment')}
            </button>
            {requestChangesAvailable ? (
                <button
                    type="button"
                    className="ctl ctl--danger-ghost review-action-bar__button"
                    disabled={disabled}
                    title={disabledReason ?? t(publishConsequenceKey('request_changes', destination), drafts)}
                    onClick={() => void publish('request_changes')}
                >
                    {t('shortcut.review.requestChanges')}
                    {drafts === 0 ? '' : ` · ${format.count(drafts)}`}
                </button>
            ) : null}
            {effectiveShipMode === null ? null : (
                <div className="review-action-bar__ship">
                    <button
                        ref={shipButtonRef}
                        type="button"
                        className="ctl ctl--primary review-action-bar__ship-primary"
                        disabled={primaryDisabledReason !== null}
                        title={primaryDisabledReason ?? t(publishConsequenceKey(effectiveShipMode, destination), drafts)}
                        onClick={() => void publish(effectiveShipMode)}
                    >
                        <ShipModeIcon mode={effectiveShipMode} />
                        {publishing === null
                            ? `${t(shipModeLabelKey(effectiveShipMode))}${drafts === 0 ? '' : ` · ${format.count(drafts)}`}`
                            : t('ship.publishing')}
                    </button>
                    {hasShipMenu ? (
                        <button
                            type="button"
                            className="ctl ctl--primary review-action-bar__ship-caret"
                            aria-haspopup="listbox"
                            aria-expanded={menuOpen}
                            disabled={disabled}
                            title={disabledReason ?? t('ship.chooseMode')}
                            onClick={() => {
                                if (menuOpen) {
                                    closeMenu(false);
                                } else {
                                    setCursor(effectiveCursor);
                                    setMenuOpen(true);
                                    prCommentsGate.close();
                                }
                            }}
                            onKeyDown={(event) => {
                                if (event.key === 'ArrowDown' && !menuOpen) {
                                    event.preventDefault();
                                    setCursor(effectiveCursor);
                                    setMenuOpen(true);
                                }
                            }}
                        >
                            <Icon name="chev-down" size={14} />
                        </button>
                    ) : null}
                    {hasShipMenu && menuOpen ? (
                        <div
                            ref={menuRef}
                            className="review-action-menu"
                            role="listbox"
                            aria-label={t('ship.menu')}
                            tabIndex={-1}
                            aria-activedescendant={`review-ship-option-${String(cursor)}`}
                            onKeyDown={(event) => {
                                if (event.key === 'ArrowDown') {
                                    event.preventDefault();
                                    setCursor((value) => Math.min(value + 1, SHIP_MENU_MODES.length - 1));
                                } else if (event.key === 'ArrowUp') {
                                    event.preventDefault();
                                    setCursor((value) => Math.max(value - 1, 0));
                                } else if (event.key === 'Enter' || event.key === ' ') {
                                    event.preventDefault();
                                    const mode = SHIP_MENU_MODES[cursor];
                                    if (mode !== undefined && optionDisabledReason(mode) === null) {
                                        void publish(mode, { remember: true });
                                    }
                                } else if (event.key === 'Tab') {
                                    closeMenu(false);
                                }
                            }}
                        >
                            <ShipGuard files={unviewed} stops={routeCompletion === null ? null : unviewedStops} />
                            {SHIP_MENU_MODES.map((mode, index) => (
                                <ShipOption
                                    key={mode}
                                    index={index}
                                    cursor={cursor}
                                    mode={mode}
                                    active={effectiveShipMode === mode}
                                    label={t(shipModeLabelKey(mode))}
                                    description={shipOptionDescription(mode, drafts, destination, t)}
                                    drafts={mode === 'comment' ? 0 : drafts}
                                    disabledReason={optionDisabledReason(mode)}
                                    onHover={setCursor}
                                    onChoose={(chosen) => void publish(chosen, { remember: true })}
                                />
                            ))}
                        </div>
                    ) : null}
                </div>
            )}

            {prCommentsOpen ? (
                <PrCommentsModal
                    pr={pr}
                    store={threadStore}
                    transport={composerTransport}
                    {...(threadActions === undefined ? {} : { actions: threadActions })}
                    draftBuffer={draftBuffer}
                    draftDestination={destination}
                    onClose={prCommentsGate.close}
                />
            ) : null}
        </div>
    );
}

/**
 * Информационный гардрейл меню шипа: он сообщает, но не блокирует (docs/design/SPEC-elements.md §2.19). При готовом
 * маршруте счёт идёт по остановкам — файловый счётчик рядом с ним только сбивал бы.
 */
function ShipGuard({ files, stops }: { files: number; stops: number | null }) {
    const t = useT();
    if (stops !== null) {
        return stops === 0 ? null : <div className="review-action-menu__guard">{t('ship.guard.stops', stops)}</div>;
    }
    return files === 0 ? null : <div className="review-action-menu__guard">{t('ship.guard.files', files)}</div>;
}

/** Снимок маршрута для гардрейла и итога: считается от реальных отметок, а не от снапшота. */
function routeCompletionOf(route: RouteProgress | null): ReviewCompletionRoute | null {
    if (route === null || route.stopIds.length === 0) {
        return null;
    }
    return {
        stopsTotal: route.stopIds.length,
        stopsViewed: route.stopIds.filter((stopId) => route.viewed.get(stopId) === true).length,
        otherViewed: route.otherStopId !== null && route.viewed.get(route.otherStopId) === true,
        uncoveredLines: route.uncoveredLines,
    };
}

function ShipOption({
    index,
    cursor,
    mode,
    active,
    label,
    description,
    drafts,
    disabledReason,
    onHover,
    onChoose,
}: {
    index: number;
    cursor: number;
    mode: ShipMode;
    active: boolean;
    label: string;
    description: string | null;
    /** Черновики для приписки «Опубликует N»; 0 — без приписки. */
    drafts: number;
    disabledReason: string | null;
    onHover: (index: number) => void;
    onChoose: (mode: ShipMode) => void;
}) {
    const t = useT();
    const disabled = disabledReason !== null;
    return (
        <div
            id={`review-ship-option-${String(index)}`}
            role="option"
            aria-selected={active}
            aria-disabled={disabled}
            title={disabledReason ?? undefined}
            className={`review-action-menu__option${index === cursor ? ' is-cursor' : ''}`}
            onMouseEnter={() => {
                onHover(index);
            }}
            onClick={() => {
                if (!disabled) {
                    onChoose(mode);
                }
            }}
        >
            <span className="review-action-menu__tick" aria-hidden="true">
                {active ? <Icon name="check" size={13} /> : null}
            </span>
            <span>
                <strong>{label}</strong>
                {description === null ? null : <span>{description}</span>}
                {drafts === 0 ? null : <small>{t('ship.option.publishes', drafts)}</small>}
                {disabled ? <small>{disabledReason}</small> : null}
            </span>
        </div>
    );
}

/**
 * Пояснение строки меню. У Comment это его следствие; без черновиков строка выключена,
 * и «опубликует 0» в ней не пишется — причину показывает сама строка.
 */
function shipOptionDescription(
    mode: ShipMode,
    drafts: number,
    destination: DraftDestination,
    t: Translate,
): string | null {
    switch (mode) {
        case 'ship':
            return t('ship.mode.ship.description');
        case 'sticky_ship':
            return t('ship.mode.sticky.description');
        case 'comment':
            return drafts === 0 ? null : t(publishConsequenceKey('comment', destination), drafts);
        default:
            return unreachableVerdict(mode);
    }
}

/** Иконка главной части: большой палец у шипов; пузыря комментария в наборе нет — у Comment иконки нет. */
function ShipModeIcon({ mode }: { mode: ShipMode }) {
    const name = shipModeIcon(mode);
    return name === null ? null : <Icon name={name} size={15} className="review-action-bar__thumb" />;
}

function shipModeIcon(mode: ShipMode): IconName | null {
    switch (mode) {
        case 'ship':
        case 'sticky_ship':
            return 'thumb';
        case 'comment':
            return null;
        default:
            return unreachableVerdict(mode);
    }
}

import type { AgentNote, FileDiff, PrMeta, Thread, UiSeenRange } from '@sherpa/protocol';
import type { Dispatch, ReactNode, RefObject, SetStateAction } from 'react';
import { useCallback, useMemo, useState } from 'react';

import type { ContextExpandRequest, ContextExpandResult } from '../../diff-view/context-expansion.js';
import type { Feedback, FileCardActions } from '../../diff-view/file-card.tsx';
import type { DiffViewSnapshot, DiffViewStore } from '../../diff-view/store.js';
import { collapseReasonOf, viewedCollapsible } from '../../diff-view/store.js';
import type { CardNoteActions } from '../../notes/card-notes.tsx';
import type { FileReadState } from '../../progress/read-state.js';
import { readStateOf } from '../../progress/read-state.js';
import type { RouteFileGroup } from '../../route/route-model.js';
import { composersForGroup, notesForGroup, threadsForGroup } from '../../route/route-model.js';
import type { CardViewedMark } from '../../route/stop-coverage.js';
import { cardViewedMark, groupReadState } from '../../route/stop-coverage.js';
import type { RoutePreset, SessionStore } from '../../session/session-store.js';
import type { ComposerLayoutSnapshot, ThreadStore, ThreadStoreSnapshot } from '../../threads/store.js';
import { openFileComposer, openNewComposer } from '../../threads/thread-list.tsx';
import type { ThreadActions } from '../../threads/thread-list.tsx';
import { commentPosition } from '../full-diff.tsx';
import { nextCardInStop, topFileCard } from './stop-dom.js';
import { StopFileCard, stopFileShownModel } from './stop-file-card.tsx';
import { collapsedKey, EMPTY_EXPANSION, expansionKey } from './stop-lookup.js';
import type { RequestJump } from './use-route-jump.js';

export interface StopCardsOptions {
    readonly files: readonly FileDiff[];
    readonly capabilities: PrMeta['capabilities'];
    readonly session: SessionStore;
    readonly store: DiffViewStore;
    readonly threadStore: ThreadStore;
    readonly threadActions: ThreadActions;
    /** Фиксированные часы тредов: одни и те же на всё вью. */
    readonly threadNow: number;
    readonly diffSnapshot: DiffViewSnapshot;
    readonly threadSnapshot: ThreadStoreSnapshot;
    readonly composersSnapshot: ComposerLayoutSnapshot;
    readonly preset: RoutePreset;
    readonly noteActions: CardNoteActions;
    readonly notesByFile: ReadonlyMap<string, readonly AgentNote[]>;
    readonly parseErrors: ReadonlyMap<string, string>;
    /** Вручную раскрытые свёрнутые карточки: ключ — остановка и файл вместе. */
    readonly openedCollapsed: ReadonlySet<string>;
    readonly setOpenedCollapsed: Dispatch<SetStateAction<ReadonlySet<string>>>;
    /** Временно развёрнутые просмотренные карточки: ключ — остановка и файл вместе. */
    readonly openedViewed: ReadonlySet<string>;
    readonly setOpenedViewed: Dispatch<SetStateAction<ReadonlySet<string>>>;
    readonly containerRef: RefObject<HTMLElement | null>;
    /** Карточка, в которой ревьюер начал выделение: её показанная модель и решает, что выделено. */
    readonly selectionCard: { readonly stopId: string; readonly group: RouteFileGroup } | null;
    readonly setSelectionCard: Dispatch<
        SetStateAction<{ readonly stopId: string; readonly group: RouteFileGroup } | null>
    >;
    readonly expand: (fileId: string, request: ContextExpandRequest) => Promise<ContextExpandResult>;
    readonly retryParse: (fileIds: readonly string[]) => void;
    readonly markViewed: (fileId: string, viewed: boolean) => Promise<Feedback>;
    readonly markStopFile: (
        stopId: string,
        fileId: string,
        viewed: boolean,
        ranges: readonly UiSeenRange[],
    ) => Promise<Feedback>;
    readonly requestJump: RequestJump;
}

export interface StopCards {
    /** Карточка файла внутри остановки: один и тот же файл в разных остановках — разные карточки. */
    readonly cardFor: (stopId: string, group: RouteFileGroup) => ReactNode;
    readonly busyFileIds: ReadonlySet<string>;
    readonly stopLayoutKey: (stopId: string, files: readonly RouteFileGroup[]) => string | null;
    readonly commentLine: (fileId: string, side: 'old' | 'new', line: number) => void;
    readonly focusedLine: { readonly fileId: string; readonly side: 'old' | 'new'; readonly line: number } | null;
    readonly focusedThreadId: string | null;
    readonly selectedShownModel: ReturnType<typeof stopFileShownModel>;
    /** Треды по файлам, как их рисует карточка: на маршруте линза по автору не ставится. */
    readonly visibleByFile: ReadonlyMap<string, readonly Thread[]>;
    readonly iterationLayout: ThreadStoreSnapshot['iterationLayout'];
}

/**
 * Карточки файлов маршрута: что в них нарисовано, чем они управляются и что мешает снять
 * остановку с DOM. Здесь же живёт фокус строки и треда — от него зависят и карточка, и клавиши.
 */
export function useStopCards({
    files,
    capabilities,
    session,
    store,
    threadStore,
    threadActions,
    threadNow,
    diffSnapshot,
    threadSnapshot,
    composersSnapshot,
    preset,
    noteActions,
    notesByFile,
    parseErrors,
    openedCollapsed,
    setOpenedCollapsed,
    openedViewed,
    setOpenedViewed,
    containerRef,
    selectionCard,
    setSelectionCard,
    expand,
    retryParse,
    markViewed,
    markStopFile,
    requestJump,
}: StopCardsOptions): StopCards {
    // Итерация нарисованного диффа: в старой тред у своих строк стоит только по своему пину.
    const iterationLayout = threadSnapshot.iterationLayout;
    // Фильтра источников больше нет (SPEC-changes-2026-09-20 §3), линза по автору на маршруте
    // не ставится: карточка показывает все треды своих строк, шум снимает сворачивание в маркер.
    const visibleThreads = useCallback(
        (group: RouteFileGroup): readonly Thread[] =>
            threadsForGroup(group, threadSnapshot.byFile, iterationLayout),
        [iterationLayout, threadSnapshot.byFile],
    );
    const visibleByFile = threadSnapshot.byFile;

    const [focusedLine, setFocusedLine] = useState<{ fileId: string; side: 'old' | 'new'; line: number } | null>(null);
    const [focusedThreadId, setFocusedThreadId] = useState<string | null>(null);
    const selectedShownModel = useMemo(() => {
        if (selectionCard === null || diffSnapshot.selection?.fileId !== selectionCard.group.fileId) {
            return null;
        }
        const key = collapsedKey(selectionCard.stopId, selectionCard.group.fileId);
        return stopFileShownModel(
            selectionCard.group,
            diffSnapshot.models.get(selectionCard.group.fileId) ?? null,
            diffSnapshot.content.get(selectionCard.group.fileId) ?? null,
            diffSnapshot.expansion.get(selectionCard.group.fileId) ?? EMPTY_EXPANSION,
            openedCollapsed.has(key),
        );
    }, [diffSnapshot, openedCollapsed, selectionCard]);
    const commentLine = useCallback(
        (fileId: string, side: 'old' | 'new', line: number) => {
            const file = files.find((candidate) => candidate.fileId === fileId);
            if (file === undefined) {
                return;
            }
            const position = commentPosition(
                diffSnapshot.selection,
                selectedShownModel ?? diffSnapshot.models.get(fileId) ?? null,
                fileId,
                side,
                line,
            );
            const key = `new:${fileId}:${position.side}:${String(position.line)}`;
            openNewComposer(threadStore, key, { fileId, path: file.path, position }, capabilities.commentIssues);
            // Диапазон переехал в композер: живое выделение больше не нужно, а оставленное
            // держало бы карандаш строки видимым и подмешивалось бы в следующий комментарий.
            store.clearSelection();
        },
        [
            capabilities.commentIssues,
            diffSnapshot.models,
            diffSnapshot.selection,
            files,
            selectedShownModel,
            store,
            threadStore,
        ],
    );
    const commentFile = useCallback(
        (fileId: string) => {
            const file = files.find((candidate) => candidate.fileId === fileId);
            if (file !== undefined) {
                openFileComposer(threadStore, fileId, file.path, capabilities.commentIssues);
            }
        },
        [capabilities.commentIssues, files, threadStore],
    );

    /**
     * Отметка файла внутри остановки (docs/design/SPEC-elements.md §2.10): пишет только строки
     * карточки, пин файлу не ставит (кроме нетекстового файла, `cardViewedMark`). Пин файла
     * (ручной, хоста, generated) держит `read` во всех карточках, поэтому снимается только
     * целиком — через файловую отметку.
     *
     * Карточка, которую ревьюер сейчас читает, после сворачивания уводит экран к следующей карточке
     * той же остановки — то же «прокрутка следует за сворачиванием», что и у остановок. Последняя
     * карточка прокрутку не заказывает: покрытая остановка отметится сама и уже она уведёт к следующей.
     */
    const markCardViewed = useCallback(
        (
            stopId: string,
            group: RouteFileGroup,
            fileRead: FileReadState,
            mark: CardViewedMark,
            viewed: boolean,
        ): Promise<Feedback> => {
            const pin = mark === 'pin' || (!viewed && fileRead.state === 'read' && fileRead.pinned);
            if (!pin && mark !== 'ranges') {
                return Promise.resolve(null);
            }
            const container = containerRef.current;
            // Геометрия снимается до записи: отметка сворачивает карточку тем же кадром.
            const top = viewed && container !== null ? topFileCard(container) : null;
            const advance =
                container !== null && top?.stopId === stopId && top.fileId === group.fileId
                    ? nextCardInStop(container, stopId, group.fileId)
                    : null;
            const key = collapsedKey(stopId, group.fileId);
            setOpenedViewed((previous) => {
                if (!previous.has(key)) {
                    return previous;
                }
                const next = new Set(previous);
                next.delete(key);
                return next;
            });
            const written = pin
                ? markViewed(group.fileId, viewed)
                : markStopFile(
                      stopId,
                      group.fileId,
                      viewed,
                      group.seenRanges.map(({ side, start, end }) => ({ side, start, end })),
                  );
            if (advance !== null) {
                requestJump(stopId, advance, null, null, false);
            }
            return written;
        },
        [containerRef, markStopFile, markViewed, requestJump, setOpenedViewed],
    );

    const actions = useMemo<FileCardActions>(
        () => ({
            // Карточка остановки подменяет отметку своей (`cardFor`).
            onViewed: markViewed,
            onExpand: expand,
            onRetryParse: (fileId: string) => {
                retryParse([fileId]);
            },
            onOpenFile: store.openFile,
            onShowWhitespace: store.showWhitespace,
            onToggleMarkdown: store.toggleMarkdown,
            onSelectText: store.selectText,
            onClearSelection: store.clearSelection,
            onSelectStart: (fileId, key, side, extend) => {
                store.beginSelection();
                if (extend) {
                    store.extendSelection(fileId, key, side);
                } else {
                    store.startSelection(fileId, key, side);
                }
            },
            onSelectExtend: store.dragSelection,
            onCommentLine: commentLine,
            onCommentFile: commentFile,
            onLineFocus: (fileId, side, line) => {
                setFocusedLine({ fileId, side, line });
            },
            onLineBlur: () => {
                setFocusedLine(null);
            },
        }),
        [commentFile, commentLine, expand, markViewed, retryParse, store],
    );

    const cardFor = useCallback(
        (stopId: string, group: RouteFileGroup) => {
            const key = collapsedKey(stopId, group.fileId);
            const record = diffSnapshot.progress.get(group.fileId) ?? null;
            const fileRead = diffSnapshot.readState.get(group.fileId) ?? readStateOf({ file: group.file, record });
            // Тумблер, коробка и свёртка карточки говорят о её строках, а не о всём файле.
            const read = groupReadState(group, fileRead, record);
            const collapseReason = collapseReasonOf(diffSnapshot, group.file, read, openedViewed.has(key));
            const model = diffSnapshot.models.get(group.fileId) ?? null;
            const parseError = parseErrors.get(group.fileId) ?? null;
            const mark = cardViewedMark(group, model, parseError !== null);
            const shownModel = stopFileShownModel(
                group,
                model,
                diffSnapshot.content.get(group.fileId) ?? null,
                diffSnapshot.expansion.get(group.fileId) ?? EMPTY_EXPANSION,
                openedCollapsed.has(key),
            );
            const cardActions: FileCardActions = {
                ...actions,
                // Композер без строки рисуется только там, где запись объясняет файл целиком
                // (`composersForGroup`). В остальных карточках пункт меню открывал бы черновик,
                // которого нигде не видно, — прячем его, комментарий к такому файлу ставится
                // в полном диффе.
                onCommentFile: group.whole ? actions.onCommentFile : undefined,
                onViewed: (_fileId, viewed) => markCardViewed(stopId, group, fileRead, mark, viewed),
                onSelectText: (selection) => {
                    setSelectionCard({ stopId, group });
                    store.selectText(selection);
                },
                onSelectStart: (fileId, lineKey, side, extend) => {
                    setSelectionCard({ stopId, group });
                    actions.onSelectStart(fileId, lineKey, side, extend);
                },
            };
            return (
                <StopFileCard
                    key={group.fileId}
                    group={group}
                    model={model}
                    parseError={parseError}
                    mode={diffSnapshot.effectiveMode}
                    content={diffSnapshot.content.get(group.fileId)}
                    contentAvailable={capabilities.fileContent}
                    expansion={diffSnapshot.expansion.get(group.fileId) ?? EMPTY_EXPANSION}
                    shownModel={shownModel}
                    read={read}
                    viewedBlocked={mark === 'pending' || mark === 'parseFailed' ? mark : null}
                    collapseReason={collapseReason}
                    onToggleCollapse={() => {
                        actions.onLineBlur?.();
                        // Просмотренная карточка разворачивается и сворачивается сама по себе;
                        // ручная и generated-свёртка — общие для файла.
                        if (collapseReason === 'viewed' || (collapseReason === null && viewedCollapsible(read))) {
                            setOpenedViewed((previous) => {
                                const next = new Set(previous);
                                if (!next.delete(key)) {
                                    next.add(key);
                                }
                                return next;
                            });
                            return;
                        }
                        store.toggleFileCollapse(group.fileId);
                    }}
                    showWhitespace={diffSnapshot.whitespaceShown.has(group.fileId)}
                    markdown={diffSnapshot.markdownShown.has(group.fileId)}
                    selection={diffSnapshot.selection?.fileId === group.fileId ? diffSnapshot.selection : null}
                    session={session}
                    notes={notesForGroup(group, notesByFile)}
                    noteActions={noteActions}
                    threads={visibleThreads(group)}
                    composers={composersForGroup(group, composersSnapshot.byFile)}
                    threadStore={threadStore}
                    threadActions={threadActions}
                    threadNow={threadNow}
                    onFocusThread={setFocusedThreadId}
                    actions={cardActions}
                    collapsedOpen={openedCollapsed.has(key)}
                    onToggleCollapsed={() => {
                        setOpenedCollapsed((previous) => {
                            const next = new Set(previous);
                            if (next.has(key)) {
                                next.delete(key);
                            } else {
                                next.add(key);
                            }
                            return next;
                        });
                    }}
                />
            );
        },
        [
            actions,
            capabilities.fileContent,
            composersSnapshot.byFile,
            diffSnapshot,
            markCardViewed,
            noteActions,
            notesByFile,
            openedCollapsed,
            openedViewed,
            parseErrors,
            session,
            setOpenedCollapsed,
            setOpenedViewed,
            setSelectionCard,
            store,
            threadActions,
            threadNow,
            threadStore,
            visibleThreads,
        ],
    );

    /**
     * Файлы, из-за которых остановку нельзя снять с DOM: размонтирование потеряло бы живое
     * выделение, инстанс редактора комментария вместе с кареткой и undo, и фокус строки.
     */
    const busyFileIds = useMemo(() => {
        const ids = new Set<string>(composersSnapshot.byFile.keys());
        // Ответ и правка черновика открываются без якоря — их файл ищется через тред.
        if (composersSnapshot.openThreadIds.size > 0) {
            for (const [fileId, threads] of threadSnapshot.byFile) {
                if (threads.some((thread) => composersSnapshot.openThreadIds.has(thread.id))) {
                    ids.add(fileId);
                }
            }
        }
        if (diffSnapshot.selection !== null) {
            ids.add(diffSnapshot.selection.fileId);
        }
        if (focusedLine !== null) {
            ids.add(focusedLine.fileId);
        }
        return ids;
    }, [
        composersSnapshot.byFile,
        composersSnapshot.openThreadIds,
        diffSnapshot.selection,
        focusedLine,
        threadSnapshot.byFile,
    ]);

    /**
     * Метка раскладки колонки диффа одной остановки: пока метка та же, измеренная высота
     * плейсхолдера остаётся верной. Метка считается по файлам самой остановки — глобальная
     * обнулялась бы на каждое раскрытие перемычки, и весь маршрут монтировался бы обратно
     * ради перезамера. Список файлов входит целиком: после линзы в остановке остаётся часть
     * карточек, и старая высота соврала бы на разницу.
     *
     * `null` — раскладка ещё не устоялась: у файла нет разобранной модели, на его месте
     * скелетон разбора, и мерить по нему высоту карточки нельзя.
     */
    const stopLayoutKey = useCallback(
        (stopId: string, files: readonly RouteFileGroup[]): string | null => {
            const parts: string[] = [diffSnapshot.effectiveMode, preset];
            for (const group of files) {
                const model = diffSnapshot.models.get(group.fileId) ?? null;
                if (model === null) {
                    return null;
                }
                // Раскрытые треды файла входят в метку: сворачивание меняет высоту карточки.
                const openThreads = visibleThreads(group)
                    .filter((thread) => threadSnapshot.openThreads.has(thread.id))
                    .map((thread) => thread.id)
                    .join(',');
                const state =
                    (diffSnapshot.whitespaceShown.has(group.fileId) ? 'w' : '') +
                    (diffSnapshot.markdownShown.has(group.fileId) ? 'm' : '') +
                    (diffSnapshot.collapseExpanded.has(group.fileId) ? 'e' : '') +
                    (openedViewed.has(collapsedKey(stopId, group.fileId)) ? 'v' : '') +
                    (diffSnapshot.collapseCollapsed.has(group.fileId) ? 'c' : '') +
                    (diffSnapshot.opened.has(group.fileId) ? 'o' : '') +
                    (openedCollapsed.has(collapsedKey(stopId, group.fileId)) ? 'k' : '');
                parts.push(
                    group.fileId,
                    // Размер патча вместо самой модели: перезапуск разбора того же файла даёт
                    // те же строки, и обнулять из-за него измеренную высоту незачем.
                    `${String(model.additions)}+${String(model.deletions)}${state}`,
                    openThreads,
                    expansionKey(diffSnapshot.expansion.get(group.fileId)),
                );
            }
            return parts.join('|');
        },
        [
            diffSnapshot.collapseCollapsed,
            diffSnapshot.collapseExpanded,
            diffSnapshot.effectiveMode,
            diffSnapshot.expansion,
            diffSnapshot.markdownShown,
            diffSnapshot.models,
            diffSnapshot.opened,
            diffSnapshot.whitespaceShown,
            openedCollapsed,
            openedViewed,
            preset,
            threadSnapshot.openThreads,
            visibleThreads,
        ],
    );

    return {
        cardFor,
        busyFileIds,
        stopLayoutKey,
        commentLine,
        focusedLine,
        focusedThreadId,
        selectedShownModel,
        visibleByFile,
        iterationLayout,
    };
}

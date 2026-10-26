import type { Thread } from '@sherpa/protocol';
import type { RefObject } from 'react';
import { useCallback } from 'react';

import type { ContextExpandRequest, ContextExpandResult } from '../../diff-view/context-expansion.js';
import type { HunkExpandRequest } from '../../diff-view/hunk-expansion.js';
import { hunkContextRequests } from '../../diff-view/hunk-expansion.js';
import { lineAt } from '../../diff-view/line-target.js';
import type { DiffViewSnapshot } from '../../diff-view/store.js';
import type { StopProgressStore } from '../../progress/stop-progress-store.js';
import type { RouteEntry, RouteFileGroup, RouteModel } from '../../route/route-model.js';
import { changeFilterAvailable, entryParseFailed, entryPending } from '../../route/route-model.js';
import type { SessionStore } from '../../session/session-store.js';
import { usePointerTarget, useShortcut } from '../../shortcuts/context.tsx';
import { neighbourId, unreadNeighbourId } from '../../shortcuts/navigation.js';
import type { ThreadStore } from '../../threads/store.js';
import { openReply } from '../../threads/thread-list.tsx';
import { stopFileShownModel } from './stop-file-card.tsx';
import { EMPTY_EXPANSION, entryId } from './stop-lookup.js';
import type { StopViewed } from './use-stop-viewed.js';

export interface RouteShortcutsOptions {
    readonly model: RouteModel;
    /** Записи, оставшиеся после линзы и фильтра: клавиши ходят только по ним. */
    readonly shown: readonly RouteEntry[];
    /** Прошлая итерация только читается: отметок в ней нет вовсе. */
    readonly readOnly: boolean;
    readonly stopProgress: StopProgressStore;
    readonly unfilledEntry: StopViewed['unfilledEntry'];
    readonly markStop: StopViewed['markStop'];
    readonly toggleCollapse: (entry: RouteEntry) => void;
    readonly focusedLine: { readonly fileId: string; readonly side: 'old' | 'new'; readonly line: number } | null;
    readonly focusedThreadId: string | null;
    readonly threads: readonly Thread[];
    readonly threadStore: ThreadStore;
    /** `capabilities.commentIssues` хоста: ответ с клавиатуры открывается с тем же свитчером, что и мышью. */
    readonly commentIssues: boolean;
    readonly commentLine: (fileId: string, side: 'old' | 'new', line: number) => void;
    readonly session: SessionStore;
    readonly changeFilterOn: boolean;
    readonly keyboardStopRef: RefObject<string | null>;
    readonly topStopRef: RefObject<{ stopId: string; offset: number } | null>;
    readonly jumpToStop: (stopId: string) => void;
    readonly diffSnapshot: DiffViewSnapshot;
    readonly openedCollapsed: ReadonlySet<string>;
    readonly expand: (fileId: string, request: ContextExpandRequest) => Promise<ContextExpandResult>;
}

/**
 * Клавиши маршрута (docs/design/SPEC-elements.md §5): отметка и свёртка остановки, комментарий и ответ,
 * перемещение по остановкам, фильтр «что нового» и раскрытие перемычки. Цель действия — элемент
 * под мышью, если она двигалась после последней смены фокуса, иначе сфокусированный. Хук только
 * регистрирует команды — ничего не возвращает.
 */
export function useRouteShortcuts({
    model,
    shown,
    readOnly,
    stopProgress,
    unfilledEntry,
    markStop,
    toggleCollapse,
    focusedLine,
    focusedThreadId,
    threads,
    threadStore,
    commentIssues,
    commentLine,
    session,
    changeFilterOn,
    keyboardStopRef,
    topStopRef,
    jumpToStop,
    diffSnapshot,
    openedCollapsed,
    expand,
}: RouteShortcutsOptions): void {
    const pointer = usePointerTarget();
    /** Остановка-цель — та, внутри которой стоит курсор или фокус: секция несёт `data-stop`. */
    const targetStopId = useCallback(
        (): string | null => pointer.target('[data-stop]')?.getAttribute('data-stop') ?? null,
        [pointer],
    );
    const targetEntry = useCallback((): RouteEntry | null => {
        const stopId = targetStopId();
        return stopId === null ? null : (shown.find((entry) => entryId(entry) === stopId) ?? null);
    }, [shown, targetStopId]);
    /** Строка-цель: под мышью, иначе сфокусированная. Считается в момент нажатия. */
    const targetLine = useCallback(
        (): { readonly fileId: string; readonly side: 'old' | 'new'; readonly line: number } | null =>
            lineAt(pointer.hovered()) ?? focusedLine,
        [focusedLine, pointer],
    );
    /** Тред-цель: под мышью, иначе сфокусированный. */
    const targetThreadId = useCallback(
        (): string | null => pointer.target('[data-thread-id]')?.getAttribute('data-thread-id') ?? focusedThreadId,
        [focusedThreadId, pointer],
    );
    /**
     * Отметку можно поставить, только когда диапазоны остановки посчитаны; снять — всегда.
     * В прошлой итерации отметок нет вовсе.
     */
    const canToggleViewed = useCallback(
        (entry: RouteEntry): boolean =>
            !readOnly &&
            (stopProgress.isViewed(entryId(entry)) ||
                (!entryPending(entry, model.totals) &&
                    !entryParseFailed(entry, model.totals) &&
                    !unfilledEntry(entry))),
        [model.totals, readOnly, stopProgress, unfilledEntry],
    );
    useShortcut({
        id: 'route.toggleStopViewed',
        keys: ['v'],
        label: 'shortcut.route.toggleStopViewed',
        scope: 'route',
        section: 'reading',
        when: () => {
            const entry = targetEntry();
            return entry !== null && canToggleViewed(entry);
        },
        action: () => {
            const entry = targetEntry();
            if (entry !== null) {
                void markStop(entryId(entry), !stopProgress.isViewed(entryId(entry)));
            }
        },
    });
    useShortcut({
        id: 'route.toggleStopCollapse',
        keys: ['x'],
        label: 'shortcut.route.toggleStopCollapse',
        scope: 'route',
        section: 'route',
        when: () => targetEntry() !== null,
        action: () => {
            const entry = targetEntry();
            if (entry !== null) {
                toggleCollapse(entry);
            }
        },
    });

    useShortcut({
        id: 'route.commentLine',
        keys: ['c'],
        label: 'shortcut.thread.commentLine',
        scope: 'route',
        section: 'comments',
        when: () => targetLine() !== null,
        action: () => {
            const line = targetLine();
            if (line !== null) {
                commentLine(line.fileId, line.side, line.line);
            }
        },
    });
    useShortcut({
        id: 'route.reply',
        keys: ['r'],
        label: 'shortcut.thread.reply',
        scope: 'route',
        section: 'comments',
        when: () => targetThreadId() !== null,
        action: () => {
            const threadId = targetThreadId();
            const thread = threads.find((candidate) => candidate.id === threadId);
            if (thread !== undefined) {
                openReply(threadStore, thread, commentIssues);
            }
        },
    });

    // --- Клавиши перемещения по маршруту (docs/design/SPEC-elements.md §5) ---

    /** Точка отсчёта клавиш перемещения: цель прошлого прыжка, иначе верхняя видимая остановка. */
    const anchorStopId = useCallback(
        (): string | null => keyboardStopRef.current ?? topStopRef.current?.stopId ?? null,
        [keyboardStopRef, topStopRef],
    );
    const jumpFromKeyboard = useCallback(
        (target: string | null) => {
            if (target === null) {
                return;
            }
            keyboardStopRef.current = target;
            jumpToStop(target);
        },
        [jumpToStop, keyboardStopRef],
    );
    const stepToStop = useCallback(
        (direction: 1 | -1) => {
            jumpFromKeyboard(neighbourId(shown, anchorStopId(), direction, entryId));
        },
        [anchorStopId, jumpFromKeyboard, shown],
    );
    const stepToUnviewedStop = useCallback(
        (direction: 1 | -1) => {
            jumpFromKeyboard(
                unreadNeighbourId(
                    shown,
                    anchorStopId(),
                    direction,
                    entryId,
                    (entry) => !stopProgress.isViewed(entryId(entry)),
                ),
            );
        },
        [anchorStopId, jumpFromKeyboard, shown, stopProgress],
    );
    useShortcut({
        id: 'route.nextStop',
        keys: ['j'],
        label: 'shortcut.route.nextStop',
        scope: 'route',
        section: 'navigation',
        action: () => {
            stepToStop(1);
        },
    });
    useShortcut({
        id: 'route.prevStop',
        keys: ['k'],
        label: 'shortcut.route.prevStop',
        scope: 'route',
        section: 'navigation',
        action: () => {
            stepToStop(-1);
        },
    });
    useShortcut({
        id: 'route.nextUnviewed',
        keys: ['n'],
        label: 'shortcut.route.nextUnviewed',
        scope: 'route',
        section: 'reading',
        action: () => {
            stepToUnviewedStop(1);
        },
    });
    useShortcut({
        id: 'route.prevUnviewed',
        keys: ['p'],
        label: 'shortcut.route.prevUnviewed',
        scope: 'route',
        section: 'reading',
        action: () => {
            stepToUnviewedStop(-1);
        },
    });
    useShortcut({
        id: 'route.changeFilter',
        keys: ['w'],
        label: 'shortcut.route.changeFilter',
        scope: 'route',
        section: 'route',
        consequence: changeFilterOn ? 'shortcut.route.changeFilter.off' : 'shortcut.route.changeFilter.on',
        when: () => changeFilterAvailable(model.entries),
        action: () => {
            session.setRouteFilter(changeFilterOn ? 'all' : 'new');
        },
    });

    /**
     * Карточка-цель и строка в ней. Один и тот же файл живёт на нескольких остановках, поэтому
     * по одному `fileId` карточку не найти: остановку даёт тот же узел, что дал строку, — под мышью
     * или под фокусом. Разные источники склеили бы строку одной остановки с секцией другой,
     * и раскрытие контекста ушло бы не туда, куда показывает ревьюер.
     */
    const targetCard = useCallback((): {
        readonly stopId: string;
        readonly group: RouteFileGroup;
        readonly line: { readonly fileId: string; readonly side: 'old' | 'new'; readonly line: number };
    } | null => {
        const hovered = pointer.hovered();
        const hoveredLine = lineAt(hovered);
        const line = hoveredLine ?? focusedLine;
        const source = hoveredLine === null ? document.activeElement : hovered;
        const stopId = source?.closest('[data-stop]')?.getAttribute('data-stop') ?? null;
        if (line === null || stopId === null) {
            return null;
        }
        const entry = shown.find((candidate) => entryId(candidate) === stopId);
        if (entry?.kind !== 'stop') {
            return null;
        }
        const group = entry.view.files.find((candidate) => candidate.fileId === line.fileId);
        return group === undefined ? null : { stopId, group, line };
    }, [focusedLine, pointer, shown]);
    const targetHunkRequests = useCallback((): readonly HunkExpandRequest[] => {
        const card = targetCard();
        if (card === null) {
            return [];
        }
        const model = stopFileShownModel(
            card.group,
            diffSnapshot.models.get(card.group.fileId) ?? null,
            diffSnapshot.content.get(card.group.fileId) ?? null,
            diffSnapshot.expansion.get(card.group.fileId) ?? EMPTY_EXPANSION,
            openedCollapsed.has(`${card.stopId}\u0000${card.group.fileId}`),
        );
        return model === null ? [] : hunkContextRequests(model, card.line.side, card.line.line);
    }, [diffSnapshot, openedCollapsed, targetCard]);
    useShortcut({
        id: 'route.expandContext',
        keys: ['e'],
        label: 'shortcut.diff.expandContext',
        scope: 'route',
        section: 'reading',
        when: () => targetHunkRequests().length > 0,
        action: () => {
            const card = targetCard();
            if (card === null) {
                return;
            }
            for (const request of targetHunkRequests()) {
                void expand(card.group.fileId, { kind: 'gap', ...request });
            }
        },
    });
}

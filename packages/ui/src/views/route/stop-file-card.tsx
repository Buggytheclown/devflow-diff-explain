import type { AgentNote, FileContent, Thread } from '@sherpa/protocol';
import type { ReactNode } from 'react';
import { useCallback, useMemo } from 'react';

import type { DiffFileModel } from '../../diff/model.js';
import type { FileCardActions } from '../../diff-view/file-card.tsx';
import { FileCard, shownFileModel } from '../../diff-view/file-card.tsx';
import type { LineSelection } from '../../diff-view/selection.js';
import type { FileExpansion } from '../../diff-view/expand.js';
import type { DiffMode, FileCollapseReason } from '../../diff-view/store.js';
import { useT } from '../../i18n/index.js';
import { Icon } from '../../icons/icon.tsx';
import type { CardNoteActions } from '../../notes/card-notes.tsx';
import { useCardNotes } from '../../notes/card-notes.tsx';
import type { FileReadState } from '../../progress/read-state.js';
import { ANCHOR_CONTEXT, anchorSpans, clipModelToAnchors } from '../../route/anchor-clip.js';
import type { RouteFileGroup } from '../../route/route-model.js';
import type { SessionStore } from '../../session/session-store.js';
import { useCardThreads, useThreadsCollapse } from '../../threads/card-threads.tsx';
import type { ComposerSnapshot, ThreadStore } from '../../threads/store.js';
import type { ThreadActions } from '../../threads/thread-list.tsx';

/**
 * Карточка файла внутри остановки: та же `FileCard`, что и в полном диффе, но модель обрезана
 * якорями остановки. Обрезка идёт после раскрытия контекста, поэтому «Expand context» работает
 * как везде — просто расширяет окно неизменённых строк вокруг диапазонов остановки.
 *
 * Свёрнутые якоря (директива `collapsed`) рисуются строкой-сводкой со счётчиком: спрятано
 * ничего не бывает, всё видно как свёртка (docs/product.md §3, принцип 3).
 */

export interface StopFileCardProps {
    readonly group: RouteFileGroup;
    readonly model: DiffFileModel | null;
    readonly parseError: string | null;
    readonly mode: DiffMode;
    readonly content: FileContent | null | undefined;
    readonly contentAvailable: boolean;
    readonly expansion: FileExpansion;
    readonly shownModel: DiffFileModel | null;
    readonly read: FileReadState;
    /** Почему карточку нельзя отметить: у файла ещё нет модели; `null` — можно. */
    readonly viewedBlocked: 'pending' | 'parseFailed' | null;
    readonly collapseReason: FileCollapseReason | null;
    readonly onToggleCollapse: () => void;
    readonly showWhitespace: boolean;
    readonly markdown: boolean;
    readonly session: SessionStore;
    readonly notes: readonly AgentNote[];
    readonly noteActions: CardNoteActions;
    readonly threads: readonly Thread[];
    readonly composers: readonly ComposerSnapshot[];
    readonly threadStore: ThreadStore;
    readonly threadActions: ThreadActions;
    readonly threadNow: number;
    readonly onFocusThread: (threadId: string | null) => void;
    readonly actions: FileCardActions;
    /** Свёрнутые якоря раскрыты вручную. */
    readonly collapsedOpen: boolean;
    readonly onToggleCollapsed: () => void;
    readonly selection: LineSelection | null;
}

/** Ровно та модель, которую карточка остановки передаёт строкам диффа. */
export function stopFileShownModel(
    group: RouteFileGroup,
    model: DiffFileModel | null,
    content: FileContent | null,
    expansion: FileExpansion,
    collapsedOpen: boolean,
): DiffFileModel | null {
    const anchors = anchorSpans(collapsedOpen ? [...group.anchors, ...group.collapsedAnchors] : group.anchors);
    return shownFileModel(
        model,
        content,
        expansion,
        (source) => clipModelToAnchors(source, anchors, ANCHOR_CONTEXT, expansion).model,
    );
}

export function StopFileCard({
    group,
    model,
    parseError,
    mode,
    content,
    contentAvailable,
    expansion,
    shownModel,
    read,
    viewedBlocked,
    collapseReason,
    onToggleCollapse,
    showWhitespace,
    markdown,
    session,
    notes,
    noteActions,
    threads,
    composers,
    threadStore,
    threadActions,
    threadNow,
    onFocusThread,
    actions,
    collapsedOpen,
    onToggleCollapsed,
    selection,
}: StopFileCardProps) {
    const t = useT();
    const anchors = useMemo(
        () => anchorSpans(collapsedOpen ? [...group.anchors, ...group.collapsedAnchors] : group.anchors),
        [collapsedOpen, group.anchors, group.collapsedAnchors],
    );
    const clip = useCallback(
        (source: DiffFileModel) => clipModelToAnchors(source, anchors, ANCHOR_CONTEXT, expansion).model,
        [anchors, expansion],
    );
    // Условие — то же, что у карточки полного диффа: нотисы (binary, «только пробелы»)
    // рисуются вместо строк, и раскладывать по ним треды нельзя — они бы просто пропали.
    const rowsShown =
        collapseReason === null &&
        parseError === null &&
        shownModel?.content.kind === 'text' &&
        (!shownModel.whitespaceOnly || showWhitespace);
    const {
        threadsUnderHeader,
        renderAfterLine: renderThreads,
        renderLineMarker,
        collapsedMarkers,
        focusedThreadRange,
        lineThreadIds,
    } = useCardThreads({
        model: shownModel,
        rowsShown,
        cardCollapsed: collapseReason !== null,
        placement: 'exact',
        shownSpans: anchors,
        threads,
        composers,
        store: threadStore,
        actions: threadActions,
        now: threadNow,
        onFocusThread,
    });
    const { notesUnderHeader, renderAfterLine: renderNotes } = useCardNotes({
        model: shownModel,
        rowsShown,
        notes,
        placement: 'exact',
        session,
        actions: noteActions,
    });
    const underHeader = threadsUnderHeader === null && notesUnderHeader === null ? null : (
        <>
            {threadsUnderHeader}
            {notesUnderHeader}
        </>
    );
    const renderAfterLine = useCallback(
        (side: 'old' | 'new', line: number): ReactNode => {
            const threadRows = renderThreads(side, line);
            const noteRows = renderNotes(side, line);
            return threadRows === null && noteRows === null ? null : (
                <>
                    {threadRows}
                    {noteRows}
                </>
            );
        },
        [renderNotes, renderThreads],
    );
    const threadsCollapse = useThreadsCollapse(threadStore, lineThreadIds);

    const collapsedHidden = !collapsedOpen && group.collapsedLines > 0;
    return (
        <div className="route-stop__card">
            <FileCard
                file={group.file}
                model={model}
                parseError={parseError}
                mode={mode}
                content={content}
                contentAvailable={contentAvailable}
                expansion={expansion}
                transform={clip}
                shownModel={shownModel}
                counts={{ additions: group.additions, deletions: group.deletions }}
                read={read}
                viewedDisabledReason={
                    // Снять пин можно и без модели — диапазоны для этого не нужны.
                    viewedBlocked === null || read.state === 'read'
                        ? null
                        : t(
                              viewedBlocked === 'pending'
                                  ? 'route.stopFile.viewed.pending'
                                  : 'route.stopFile.viewed.parseFailed',
                          )
                }
                collapseReason={collapseReason}
                onToggleCollapse={onToggleCollapse}
                opened
                showWhitespace={showWhitespace}
                markdown={markdown}
                selection={selection}
                threadsUnderHeader={underHeader}
                focusedThreadRange={focusedThreadRange}
                renderAfterLine={renderAfterLine}
                renderLineMarker={renderLineMarker}
                collapsedMarkers={collapsedMarkers}
                threadsCollapse={threadsCollapse}
                actions={actions}
            />
            {collapseReason === null && collapsedHidden ? (
                <button type="button" className="ctl ctl--quiet route-stop__collapsed-lines" onClick={onToggleCollapsed}>
                    <span className="route-stop__collapsed-mark" aria-hidden="true">
                        <Icon name="updown" size={13} />
                    </span>
                    {t('route.stopFile.collapsed', group.collapsedLines)}
                    <span className="route-stop__spacer" />
                    <span className="route-stop__collapsed-hint">{t('route.collapsed.hint')}</span>
                </button>
            ) : null}
            {collapseReason === null && collapsedOpen && group.collapsedLines > 0 ? (
                <button type="button" className="ctl ctl--quiet route-stop__collapsed-lines" onClick={onToggleCollapsed}>
                    <span className="route-stop__collapsed-mark" aria-hidden="true">
                        <Icon name="chev-down" size={13} className="route-stop__collapsed-icon--up" />
                    </span>
                    {t('route.stopFile.collapse')}
                </button>
            ) : null}
        </div>
    );
}

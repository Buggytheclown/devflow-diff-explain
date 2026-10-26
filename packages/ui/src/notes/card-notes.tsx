import type { AgentNote } from '@sherpa/protocol';
import type { ReactNode } from 'react';
import { useCallback, useMemo, useState, useSyncExternalStore } from 'react';

import type { DiffFileModel } from '../diff/model.js';
import type { Translate } from '../i18n/index.js';
import { useT } from '../i18n/index.js';
import { useReadOnlyIteration, useReadOnlyReason } from '../iterations/read-only.tsx';
import { Markdown } from '../markdown/markdown.tsx';
import type { SessionStore } from '../session/session-store.js';
import { isNoteExpanded, isNoteStackExpanded } from '../session/session-store.js';
import type { NoteGroup } from './model.js';
import { NOTE_LOST_DRAFT_REASON, noteStackKey, noteStackNeedsSummary, placeNotesOnVisibleLines } from './model.js';
import './notes.css';

export interface CardNoteActions {
    readonly onOpenInChat: (note: AgentNote) => void;
    /** Композер нового комментария у якоря заметки, предзаполненный её цитатой (docs/design/SPEC-elements.md §2.16). */
    readonly onTurnIntoDraft: (note: AgentNote) => void;
    readonly onDelete: (noteId: number) => Promise<void>;
}

export interface CardNotesInput {
    readonly model: DiffFileModel | null;
    readonly rowsShown: boolean;
    readonly notes: readonly AgentNote[];
    readonly placement: 'nearest' | 'exact';
    readonly session: SessionStore;
    readonly actions: CardNoteActions;
}

export interface CardNotes {
    readonly notesUnderHeader: ReactNode;
    readonly renderAfterLine: (side: 'old' | 'new', line: number) => ReactNode;
}

/** Одна раскладка заметок для полного диффа и маршрута; различается только режим поиска строки. */
export function useCardNotes({
    model,
    rowsShown,
    notes,
    placement,
    session,
    actions,
}: CardNotesInput): CardNotes {
    const snapshot = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot);
    const layout = useMemo(
        () => placeNotesOnVisibleLines(model, rowsShown, notes, placement),
        [model, notes, placement, rowsShown],
    );
    const renderGroups = useCallback(
        (groups: readonly NoteGroup[]): ReactNode =>
            groups.map((group) => (
                <NoteGroupView
                    key={groupKey(group)}
                    group={group}
                    expanded={snapshot.notesExpanded}
                    stacksExpanded={snapshot.noteStacksExpanded}
                    session={session}
                    actions={actions}
                />
            )),
        [actions, session, snapshot.noteStacksExpanded, snapshot.notesExpanded],
    );
    const notesUnderHeader = useMemo(
        () =>
            layout.underHeader.length === 0 ? null : (
                <div className="agent-notes agent-notes--under-header">{renderGroups(layout.underHeader)}</div>
            ),
        [layout.underHeader, renderGroups],
    );
    const renderAfterLine = useCallback(
        (side: 'old' | 'new', line: number): ReactNode => {
            const groups = layout.byLine.get(`${side}:${String(line)}`);
            return groups === undefined ? null : (
                <div className="diff-row-extra agent-notes">{renderGroups(groups)}</div>
            );
        },
        [layout.byLine, renderGroups],
    );

    return { notesUnderHeader, renderAfterLine };
}

function NoteGroupView({
    group,
    expanded,
    stacksExpanded,
    session,
    actions,
}: {
    readonly group: NoteGroup;
    readonly expanded: ReadonlySet<string>;
    readonly stacksExpanded: ReadonlySet<string>;
    readonly session: SessionStore;
    readonly actions: CardNoteActions;
}) {
    const t = useT();
    const stackKey = noteStackKey(group);
    const summarized = noteStackNeedsSummary(group);
    const open =
        isNoteStackExpanded({ noteStacksExpanded: stacksExpanded }, stackKey) ||
        group.notes.some((note) => expanded.has(String(note.id)));

    if (summarized && !open) {
        return (
            <button
                type="button"
                className="agent-note-stack-summary"
                aria-expanded="false"
                onClick={() => {
                    session.setNoteStackExpanded(stackKey, true);
                }}
            >
                <span className="agent-note__diamond" aria-hidden="true">◆</span>
                {t('note.here', group.notes.length)}
            </button>
        );
    }

    return (
        <div className="agent-note-stack">
            {summarized ? (
                <button
                    type="button"
                    className="ctl ctl--link agent-note-stack__collapse"
                    aria-expanded="true"
                    onClick={() => {
                        session.collapseNoteStack(stackKey, group.notes.map((note) => note.id));
                    }}
                >
                    {t('note.collapseList')}
                </button>
            ) : null}
            {group.notes.map((note) => (
                <AgentNoteView
                    key={note.id}
                    note={note}
                    expanded={isNoteExpanded({ notesExpanded: expanded }, note.id)}
                    session={session}
                    actions={actions}
                />
            ))}
        </div>
    );
}

function AgentNoteView({
    note,
    expanded,
    session,
    actions,
}: {
    readonly note: AgentNote;
    readonly expanded: boolean;
    readonly session: SessionStore;
    readonly actions: CardNoteActions;
}) {
    const t = useT();
    const [deleting, setDeleting] = useState(false);
    // Заметка читается всегда, а черновик комментария из неё — только в активной итерации.
    const readOnly = useReadOnlyIteration();
    const readOnlyReason = useReadOnlyReason();
    const [error, setError] = useState<string | null>(null);

    if (!expanded) {
        return (
            <button
                type="button"
                className="agent-note agent-note--collapsed"
                data-note={note.id}
                aria-expanded="false"
                onClick={() => {
                    session.toggleNoteExpanded(note.id);
                }}
            >
                <span className="agent-note__diamond" aria-hidden="true">◆</span>
                <span className="agent-note__label">{t('note.label')}</span>
                <span className="agent-note__separator" aria-hidden="true">·</span>
                <span className="agent-note__preview">{firstTextLine(note.text)}</span>
                <span className="agent-note__separator" aria-hidden="true">·</span>
                <span className="agent-note__count">{lineCountLabel(note.text, t)}</span>
            </button>
        );
    }

    const range =
        note.anchor.start === note.anchor.end
            ? t('note.at.line', note.anchor.start)
            : t('note.at.lines', note.anchor.start, note.anchor.end);
    return (
        <article className="agent-note agent-note--expanded" data-note={note.id} tabIndex={-1}>
            <header className="agent-note__header">
                <span className="agent-note__diamond" aria-hidden="true">◆</span>
                <span>{t('note.header', range)}</span>
            </header>
            <div className="agent-note__provenance">{t('note.provenance')}</div>
            <div className="agent-note__body">
                <Markdown text={note.text} profile="comment" />
            </div>
            <div className="agent-note__actions">
                <button
                    type="button"
                    className="ctl ctl--link"
                    onClick={() => {
                        actions.onOpenInChat(note);
                    }}
                >
                    {t('note.openInChat')}
                </button>
                <button
                    type="button"
                    className="ctl ctl--link"
                    disabled={readOnly || note.lostAnchor}
                    title={draftReason(note, readOnly, readOnlyReason, t)}
                    onClick={() => {
                        actions.onTurnIntoDraft(note);
                    }}
                >
                    {t('note.toDraft')}
                </button>
                <button
                    type="button"
                    className="ctl ctl--link"
                    onClick={() => {
                        session.toggleNoteExpanded(note.id);
                    }}
                >
                    {t('note.collapse')}
                </button>
                <button
                    type="button"
                    className="ctl ctl--link-danger"
                    disabled={deleting}
                    onClick={() => {
                        setDeleting(true);
                        setError(null);
                        void actions.onDelete(note.id).catch((reason: unknown) => {
                            setDeleting(false);
                            setError(reason instanceof Error ? reason.message : String(reason));
                        });
                    }}
                >
                    {deleting ? t('note.deleting') : t('note.delete')}
                </button>
            </div>
            {error === null ? null : (
                <div className="agent-note__error" role="alert">
                    {t('note.deleteFailed', error)}
                </div>
            )}
        </article>
    );
}

/** Почему черновика комментария нет: потерянный якорь важнее режима чтения — он необратим. */
function draftReason(
    note: AgentNote,
    readOnly: boolean,
    readOnlyReason: string,
    t: Translate,
): string | undefined {
    if (note.lostAnchor) {
        return t(NOTE_LOST_DRAFT_REASON);
    }
    return readOnly ? readOnlyReason : undefined;
}

function firstTextLine(text: string): string {
    return text.split(/\r?\n/u).find((line) => line.trim() !== '')?.trim() ?? text.trim();
}

function lineCountLabel(text: string, t: Translate): string {
    return t('note.lines', text.split('\n').length);
}

function groupKey(group: NoteGroup): string {
    return noteStackKey(group);
}

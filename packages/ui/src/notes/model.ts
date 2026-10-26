import type { AgentNote, ChatAnchor } from '@sherpa/protocol';

import type { DiffFileModel } from '../diff/model.js';
import type { MessageKey } from '../i18n/index.js';

/** Почему у заметки без якоря нет черновика комментария. */
export const NOTE_LOST_DRAFT_REASON: MessageKey = 'thread.note.lostDraft';

/** Почему из чата некуда переходить: в коде этой итерации заметки нет. */
export const NOTE_LOST_ANCHOR_REASON: MessageKey = 'thread.note.lostAnchor';

/**
 * Якорь заметки глазами просматриваемой итерации: в той итерации, где заметку
 * закрепили, она стоит у своих исходных строк, в любой другой — у перенесённых.
 */
export function noteAnchorForIteration(note: AgentNote, viewDiffId: string | null): ChatAnchor {
    return viewDiffId !== null && viewDiffId === note.origin.anchor.diffId ? note.origin.anchor : note.anchor;
}

/**
 * Заметка стоит у кода этой итерации. Потерявшая якорь уходит из кода везде, кроме своей
 * исходной итерации: там строки, к которым её задали, никуда не делись (docs/design/SPEC-elements.md §2.16).
 */
export function noteVisibleInIteration(note: AgentNote, viewDiffId: string | null): boolean {
    return !note.lostAnchor || (viewDiffId !== null && viewDiffId === note.origin.anchor.diffId);
}

/** Заметки для раскладки в код выбранной итерации: с её якорями и без потерявших якорь. */
export function notesForIteration(
    notes: readonly AgentNote[],
    viewDiffId: string | null,
): readonly AgentNote[] {
    return notes
        .filter((note) => noteVisibleInIteration(note, viewDiffId))
        .map((note) => {
            const anchor = noteAnchorForIteration(note, viewDiffId);
            return anchor === note.anchor ? note : { ...note, anchor };
        });
}

export interface NoteGroup {
    readonly fileId: string;
    readonly side: 'old' | 'new';
    readonly start: number;
    readonly end: number;
    readonly notes: readonly AgentNote[];
}

export interface NotePlacement {
    readonly byLine: ReadonlyMap<string, readonly NoteGroup[]>;
    readonly underHeader: readonly NoteGroup[];
    /** В exact-режиме группа не относится к этой обрезанной карточке и не рисуется. */
    readonly hidden: readonly NoteGroup[];
}

export const NOTE_STACK_SUMMARY_THRESHOLD = 3;

/** Сессионный ключ стопки не зависит от состава заметок. */
export function noteStackKey(group: Pick<NoteGroup, 'fileId' | 'side' | 'start' | 'end'>): string {
    return `${group.fileId}:${group.side}:${String(group.start)}:${String(group.end)}`;
}

/** Связные по пересечениям диапазоны образуют стопку; внутри новые заметки идут первыми. */
export function groupOverlappingNotes(notes: readonly AgentNote[]): readonly NoteGroup[] {
    const ordered = [...notes].sort(
        (left, right) =>
            left.anchor.fileId.localeCompare(right.anchor.fileId) ||
            left.anchor.side.localeCompare(right.anchor.side) ||
            left.anchor.start - right.anchor.start ||
            left.anchor.end - right.anchor.end ||
            left.id - right.id,
    );
    const groups: NoteGroup[] = [];

    for (const note of ordered) {
        const previous = groups.at(-1);
        if (
            previous?.fileId !== note.anchor.fileId ||
            previous.side !== note.anchor.side ||
            note.anchor.start > previous.end
        ) {
            groups.push({
                fileId: note.anchor.fileId,
                side: note.anchor.side,
                start: note.anchor.start,
                end: note.anchor.end,
                notes: [note],
            });
            continue;
        }

        groups[groups.length - 1] = {
            ...previous,
            start: Math.min(previous.start, note.anchor.start),
            end: Math.max(previous.end, note.anchor.end),
            notes: [...previous.notes, note],
        };
    }

    return groups.map((group) => ({
        ...group,
        notes: [...group.notes].sort(
            (left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt) || right.id - left.id,
        ),
    }));
}

/** Раскладывает стопки под последней строкой объединённого диапазона. */
export function placeNotesOnVisibleLines(
    model: DiffFileModel | null,
    rowsShown: boolean,
    notes: readonly AgentNote[],
    placement: 'nearest' | 'exact',
): NotePlacement {
    const byLine = new Map<string, NoteGroup[]>();
    const groups = groupOverlappingNotes(notes);
    if (!rowsShown || model?.content.kind !== 'text') {
        return { byLine, underHeader: groups, hidden: [] };
    }

    const visible = { old: new Set<number>(), new: new Set<number>() };
    for (const block of model.content.blocks) {
        if (block.kind !== 'hunk') {
            continue;
        }
        for (const line of block.lines) {
            if (line.oldLine !== null) {
                visible.old.add(line.oldLine);
            }
            if (line.newLine !== null) {
                visible.new.add(line.newLine);
            }
        }
    }

    const underHeader: NoteGroup[] = [];
    const hidden: NoteGroup[] = [];
    for (const group of groups) {
        const candidates = [...visible[group.side]];
        if (candidates.length === 0) {
            underHeader.push(group);
            continue;
        }
        if (placement === 'exact' && !groupIntersectsVisibleLines(group, visible[group.side])) {
            hidden.push(group);
            continue;
        }
        if (placement === 'exact' && !visible[group.side].has(group.end)) {
            underHeader.push(group);
            continue;
        }
        const line = visible[group.side].has(group.end)
            ? group.end
            : candidates.reduce((nearest, candidate) =>
                  Math.abs(candidate - group.end) < Math.abs(nearest - group.end) ? candidate : nearest,
              );
        const key = `${group.side}:${String(line)}`;
        const bucket = byLine.get(key);
        if (bucket === undefined) {
            byLine.set(key, [group]);
        } else {
            bucket.push(group);
        }
    }

    return { byLine, underHeader, hidden };
}

function groupIntersectsVisibleLines(group: NoteGroup, visible: ReadonlySet<number>): boolean {
    for (const line of visible) {
        if (line >= group.start && line <= group.end) {
            return true;
        }
    }
    return false;
}

export function noteStackNeedsSummary(group: NoteGroup): boolean {
    return group.notes.length > NOTE_STACK_SUMMARY_THRESHOLD;
}

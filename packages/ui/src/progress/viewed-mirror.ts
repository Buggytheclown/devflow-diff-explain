import type { UiFileProgress, UiViewedMirrorRequest } from '@sherpa/protocol';

import type { FileReadState } from './read-state.js';

export interface ViewedMirrorSource {
    readonly readStates: ReadonlyMap<string, FileReadState>;
    readonly progress: ReadonlyMap<string, UiFileProgress>;
    /** Явные снятия файлов уже зеркалит reviewFileViewed; до перечитки не раскрываем старые диапазоны. */
    readonly fileWrites: ReadonlySet<string>;
}

export interface ViewedMirrorUpdate {
    readonly state: ReadonlyMap<string, boolean>;
    readonly entries: UiViewedMirrorRequest['entries'];
}

/**
 * Дельта зеркала от последнего отправленного состояния. Первый расчёт становится baseline
 * без отправки; исчезнувшие из текущего диффа файлы хосту не переотмечаются.
 */
export function viewedMirrorUpdate(
    previous: ReadonlyMap<string, boolean> | null,
    source: ViewedMirrorSource,
): ViewedMirrorUpdate {
    const state = new Map<string, boolean>();
    const entries: { fileId: string; viewed: boolean }[] = [];

    for (const [fileId, read] of source.readStates) {
        const record = source.progress.get(fileId);
        const fromCoverage = record !== undefined && !record.viewed && record.seenRanges.length > 0;
        const fileWrite = source.fileWrites.has(fileId);
        const mirroredByFileWrite = record?.viewed === true || fileWrite;
        const viewed = fileWrite
            ? false
            : fromCoverage && read.state === 'read' && !read.pinned && !read.generatedDefault;
        state.set(fileId, viewed);
        if (
            previous !== null &&
            (previous.get(fileId) ?? false) !== viewed &&
            !(mirroredByFileWrite && !viewed)
        ) {
            entries.push({ fileId, viewed });
        }
    }

    return { state, entries };
}

import type { Comment, FileDiff, HostId, Thread } from '@sherpa/protocol';

import type { FileReadState } from './read-state.js';

export interface ReviewProgressSummary {
    readonly filesSeen: number;
    readonly filesTotal: number;
    readonly linesSeen: number;
    readonly linesTotal: number;
    readonly percentSeen: number;
}

/**
 * Общие числа панели и Review complete из той же read-state модели, которую рисует дерево.
 * Конфликтные файлы (docs/design/SPEC-elements.md §4.1) не входят ни в числитель, ни в знаменатель: их разрешают
 * в Аркануме, и требовать их прочтения перед шипом нечестно.
 */
export function reviewProgressSummary(
    files: readonly FileDiff[],
    readState: ReadonlyMap<string, FileReadState>,
): ReviewProgressSummary {
    let filesSeen = 0;
    let filesTotal = 0;
    let linesSeen = 0;
    let linesTotal = 0;
    for (const file of files) {
        if (file.changeType === 'conflict') {
            continue;
        }
        filesTotal += 1;
        const state = readState.get(file.fileId);
        if (state?.state === 'read') {
            filesSeen += 1;
        }
        linesSeen += state?.seen ?? 0;
        linesTotal += file.additions + file.deletions;
    }
    return {
        filesSeen,
        filesTotal,
        linesSeen,
        linesTotal,
        percentSeen: linesTotal === 0 ? 100 : Math.floor((linesSeen / linesTotal) * 100),
    };
}

/** Все мои неопубликованные комментарии, включая ответы любой глубины. */
export function countDraftComments(threads: readonly Thread[]): number {
    let count = 0;
    visitComments(threads, (comment) => {
        if (comment.draft) {
            count += 1;
        }
    });
    return count;
}

/** Черновики, открывающие issue: их число идёт хвостом к счётчику черновиков перед шипом. */
export function countIssueDraftComments(threads: readonly Thread[]): number {
    let count = 0;
    visitComments(threads, (comment) => {
        if (comment.draft && comment.issue === true) {
            count += 1;
        }
    });
    return count;
}

/**
 * Черновики в тредах, приколотых не к активной итерации (docs/design/SPEC-elements.md §4.5): написаны до пуша,
 * уйдут к коммиту, которого в голове PR уже нет.
 */
export function countPinnedDraftComments(threads: readonly Thread[], activeDiffId: string | null): number {
    if (activeDiffId === null) {
        return 0;
    }
    const pinned = threads.filter((thread) => thread.pinnedTo !== null && thread.pinnedTo.diffId !== activeDiffId);
    return countDraftComments(pinned);
}

/** Сколько опубликованных id были ответами, а не корнями тредов. */
export function countPublishedReplies(threads: readonly Thread[], publishedIds: readonly HostId[]): number {
    const published = new Set(publishedIds);
    let replies = 0;
    for (const thread of threads) {
        visitComment(thread.root, 0, (comment, depth) => {
            if (depth > 0 && published.has(comment.id)) {
                replies += 1;
            }
        });
    }
    return replies;
}

/** Тексты комментариев по id — error-панель не должна показывать одни непрозрачные идентификаторы. */
export function commentBodies(threads: readonly Thread[]): ReadonlyMap<HostId, string> {
    const bodies = new Map<HostId, string>();
    visitComments(threads, (comment) => {
        bodies.set(comment.id, comment.body);
    });
    return bodies;
}

function visitComments(threads: readonly Thread[], visit: (comment: Comment) => void): void {
    for (const thread of threads) {
        visitComment(thread.root, 0, (comment) => {
            visit(comment);
        });
    }
}

function visitComment(comment: Comment, depth: number, visit: (comment: Comment, depth: number) => void): void {
    visit(comment, depth);
    for (const reply of comment.replies) {
        visitComment(reply, depth + 1, visit);
    }
}

import type { Comment, FileAnchor, HostId, Lens, LensZone, PrDiff, ReviewUser, Thread, ThreadPin } from '@sherpa/protocol';

import type { FixtureIteration } from './data/types.js';
import { makeFileId } from './patch.js';

/**
 * Мелкие конструкторы доменных объектов для фикстур: тредов, комментариев, якорей, линз.
 * Всё детерминированно — никаких `Date.now()`/`Math.random()`, только переданные значения.
 */

export function human(login: string, displayName: string | null = null): ReviewUser {
    return { login, displayName, bot: false, avatarUrl: null };
}

/**
 * Бот-источник. `displayName` — метка вида «AI Review (security)», которую отдаёт хост;
 * UI показывает её чипом источника.
 */
export function bot(login: string, displayName: string): ReviewUser {
    return { login, displayName, bot: true, avatarUrl: null };
}

export interface CommentSpec {
    id: HostId;
    author: ReviewUser;
    body: string;
    createdAt: string;
    editedAt?: string;
    draft?: boolean;
    /** По умолчанию статуса нет — как у комментария, заведённого мимо Шерпы. */
    issue?: boolean;
    /** Закрыт ли issue комментария; статус хост проставляет сам, если его данные не задали. */
    resolved?: boolean;
    replies?: readonly Comment[];
}

export function comment(spec: CommentSpec): Comment {
    return {
        id: spec.id,
        author: spec.author,
        body: spec.body,
        draft: spec.draft ?? false,
        issue: spec.issue ?? null,
        resolved: spec.resolved ?? null,
        createdAt: spec.createdAt,
        editedAt: spec.editedAt ?? null,
        replies: [...(spec.replies ?? [])],
    };
}

export interface ThreadSpec {
    /** По умолчанию — id корневого комментария: тред и есть его корень. */
    id?: HostId;
    anchor: FileAnchor | null;
    resolved?: boolean;
    resolvedBy?: string;
    outdated?: boolean;
    /** Итерация исходного якоря; у тредов уровня PR пина нет. */
    pinnedTo?: ThreadPin;
    root: Comment;
}

export function thread(spec: ThreadSpec): Thread {
    return {
        id: spec.id ?? spec.root.id,
        anchor: spec.anchor,
        resolved: spec.resolved ?? false,
        resolvedBy: spec.resolvedBy ?? null,
        outdated: spec.outdated ?? false,
        pinnedTo: spec.pinnedTo ?? null,
        root: spec.root,
    };
}

/** Якорь на строку файла. Без `line` — комментарий на весь файл. */
export function anchor(
    diffId: HostId,
    path: string,
    position: { side: 'old' | 'new'; line: number; size?: number } | null = null,
): FileAnchor {
    return {
        fileId: makeFileId(diffId, path),
        path,
        position: position === null ? null : { side: position.side, line: position.line, size: position.size ?? 1 },
    };
}

export interface LensSpec {
    id: string;
    label: string;
    paths?: readonly string[];
    available?: boolean;
    note?: string;
    zones?: readonly LensZone[] | null;
}

export function lens(spec: LensSpec): Lens {
    return {
        id: spec.id,
        label: spec.label,
        paths: [...(spec.paths ?? [])],
        available: spec.available ?? true,
        note: spec.note ?? null,
        zones: spec.zones?.map((zone) => ({ ...zone, paths: [...zone.paths] })) ?? null,
    };
}

/**
 * Фикстура с единственной итерацией: прошлых итераций у неё нет, срезы отклоняются хостом.
 * `createdAt` — момент появления итерации у хоста (обычно `pr.updatedAt`).
 */
export function singleIteration(diff: PrDiff, threads: Thread[], createdAt: string): FixtureIteration[] {
    return [
        {
            iteration: {
                diffId: diff.diffId,
                baseCommit: diff.baseCommit,
                headCommit: diff.headCommit,
                createdAt,
            },
            diff,
            threads,
            replaces: null,
        },
    ];
}

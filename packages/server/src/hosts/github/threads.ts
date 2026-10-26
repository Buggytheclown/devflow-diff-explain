import type { AnchorPosition, Comment, FileAnchor, ReviewUser, Thread, ThreadPin } from '@sherpa/protocol';

import { parseReviewBody } from './drafts.js';
import type { GithubActor, GithubIssueComment, GithubReview, GithubReviewThread, GithubThreadComment } from './schemas.js';

/**
 * Сборка контрактных тредов из того, что отдаёт GraphQL GitHub.
 *
 * Три источника, три вида тредов: `reviewThreads` — обсуждения строк диффа; ревью с непустым
 * телом и issue-комментарии — обсуждения уровня PR. Тред диффа — корень и ответы одним уровнем:
 * ответить можно только на корень («Replies to replies are not supported», REST
 * `POST …/comments/{comment_id}/replies`), а `addPullRequestReviewThreadReply` пишет в тред
 * целиком. У issue-комментариев ответов нет вовсе.
 *
 * Тело ревью Шерпа режет на абзацы (`drafts.ts`): у GitHub это один комментарий, но черновику
 * уровня PR больше негде жить. Первый абзац становится корнем треда, остальные — его ответами.
 */

/** Префиксы id: по ним правка и удаление знают, какую мутацию звать. */
export const THREAD_PREFIX = 'th:';
export const REVIEW_COMMENT_PREFIX = 'rc:';
export const ISSUE_COMMENT_PREFIX = 'ic:';
export const REVIEW_BODY_PREFIX = 'rv:';
export const REVIEW_PARAGRAPH_PREFIX = 'rvb:';

/** Комментарий, опознанный по префиксу id. */
export type ParsedCommentId =
    | { readonly kind: 'review-comment'; readonly nodeId: string }
    | { readonly kind: 'issue-comment'; readonly nodeId: string }
    | { readonly kind: 'review-body'; readonly nodeId: string }
    | { readonly kind: 'review-paragraph'; readonly nodeId: string; readonly n: number };

export function parseCommentId(id: string): ParsedCommentId | null {
    if (id.startsWith(REVIEW_PARAGRAPH_PREFIX)) {
        const rest = id.slice(REVIEW_PARAGRAPH_PREFIX.length);
        const separator = rest.lastIndexOf(':');
        const n = Number(rest.slice(separator + 1));
        if (separator <= 0 || !Number.isInteger(n) || n < 0) {
            return null;
        }
        return { kind: 'review-paragraph', nodeId: rest.slice(0, separator), n };
    }
    if (id.startsWith(REVIEW_COMMENT_PREFIX)) {
        return { kind: 'review-comment', nodeId: id.slice(REVIEW_COMMENT_PREFIX.length) };
    }
    if (id.startsWith(ISSUE_COMMENT_PREFIX)) {
        return { kind: 'issue-comment', nodeId: id.slice(ISSUE_COMMENT_PREFIX.length) };
    }
    if (id.startsWith(REVIEW_BODY_PREFIX)) {
        return { kind: 'review-body', nodeId: id.slice(REVIEW_BODY_PREFIX.length) };
    }
    return null;
}

/** Node id треда диффа из контрактного id; null — это не тред диффа. */
export function parseThreadId(id: string): string | null {
    return id.startsWith(THREAD_PREFIX) ? id.slice(THREAD_PREFIX.length) : null;
}

export function reviewCommentId(nodeId: string): string {
    return `${REVIEW_COMMENT_PREFIX}${nodeId}`;
}

export function reviewParagraphId(reviewId: string, n: number): string {
    return `${REVIEW_PARAGRAPH_PREFIX}${reviewId}:${String(n)}`;
}

/** Комментарий — абзац тела именно этого ревью? */
export function isReviewParagraphOf(commentId: string, reviewId: string): boolean {
    const parsed = parseCommentId(commentId);
    return parsed?.kind === 'review-paragraph' && parsed.nodeId === reviewId;
}

export interface BuildThreadsInput {
    readonly threads: readonly GithubReviewThread[];
    readonly reviews: readonly GithubReview[];
    readonly comments: readonly GithubIssueComment[];
    /** Логин владельца токена; null — whoami не сработал, чужих pending-ревью GitHub и так не отдаёт. */
    readonly viewer: string | null;
}

/**
 * Порядок тредов: сначала обсуждения строк диффа, затем ревью, затем issue-комментарии.
 * Внутри группы — порядок GitHub (он хронологический).
 */
export function buildThreads(input: BuildThreadsInput): Thread[] {
    const diffThreads = input.threads.map(toDiffThread);
    const reviewThreads = input.reviews
        .map((review) => toReviewThread(review, input.viewer))
        .filter((thread): thread is Thread => thread !== null);
    const issueThreads = input.comments.map(toIssueThread);
    return [...diffThreads, ...reviewThreads, ...issueThreads];
}

function toDiffThread(thread: GithubReviewThread): Thread {
    const comments = compactNodes(thread.comments.nodes).map(toDiffComment);
    const root = comments[0] ?? placeholderComment(thread);

    return {
        id: `${THREAD_PREFIX}${thread.id}`,
        anchor: anchorOf(thread),
        resolved: thread.isResolved,
        resolvedBy: thread.resolvedBy?.login ?? null,
        outdated: thread.isOutdated,
        pinnedTo: pinOf(compactNodes(thread.comments.nodes)[0]),
        root: { ...root, replies: comments.slice(1) },
    };
}

/**
 * Тред уровня PR из ревью: абзацы его тела. Ревью без тела треда не даёт — его комментарии
 * живут в своих тредах диффа. Pending-ревью принадлежит владельцу токена, и его абзацы — черновики.
 */
function toReviewThread(review: GithubReview, viewer: string | null): Thread | null {
    const draft = review.state === 'PENDING';
    if (draft && viewer !== null && review.author?.login !== viewer) {
        return null;
    }

    const parsed = parseReviewBody(review.body);
    if (parsed.paragraphs.length === 0) {
        return null;
    }

    const author = userOf(review.author);
    const createdAt = isoTime(review.createdAt);
    const editedAt = review.lastEditedAt === null ? null : isoTime(review.lastEditedAt);
    const comments: Comment[] = parsed.paragraphs.map((paragraph) => ({
        // Тело pending-ревью — черновик-абзац и без маркера (его писали на вебе GitHub): маркер
        // оно получит при первой перезаписи, а править и удалять его надо как обычный абзац.
        // `rv:` остаётся телу опубликованного ревью — его GitHub удалять не умеет.
        id:
            parsed.marked || draft
                ? reviewParagraphId(review.id, paragraph.n)
                : `${REVIEW_BODY_PREFIX}${review.id}`,
        author,
        body: paragraph.body,
        draft,
        issue: null,
        resolved: null,
        createdAt,
        editedAt,
        replies: [],
    }));

    const root = comments[0];
    if (root === undefined) {
        return null;
    }
    return {
        id: root.id,
        anchor: null,
        resolved: false,
        resolvedBy: null,
        outdated: false,
        pinnedTo: null,
        root: { ...root, replies: comments.slice(1) },
    };
}

function toIssueThread(comment: GithubIssueComment): Thread {
    const root: Comment = {
        id: `${ISSUE_COMMENT_PREFIX}${comment.id}`,
        author: userOf(comment.author),
        body: comment.body,
        draft: false,
        issue: null,
        resolved: null,
        createdAt: isoTime(comment.createdAt),
        editedAt: comment.lastEditedAt === null ? null : isoTime(comment.lastEditedAt),
        replies: [],
    };
    return {
        id: root.id,
        anchor: null,
        resolved: false,
        resolvedBy: null,
        outdated: false,
        pinnedTo: null,
        root,
    };
}

export function toDiffComment(comment: GithubThreadComment): Comment {
    return {
        id: reviewCommentId(comment.id),
        author: userOf(comment.author),
        body: comment.body,
        // Чужих pending-ревью GitHub не показывает вовсе: PENDING здесь — всегда мой черновик.
        draft: comment.pullRequestReview?.state === 'PENDING',
        issue: null,
        resolved: null,
        createdAt: isoTime(comment.createdAt),
        editedAt: comment.lastEditedAt === null ? null : isoTime(comment.lastEditedAt),
        replies: [],
    };
}

/**
 * Тред без единого комментария GitHub не отдаёт, но связь может прийти пустой страницей.
 * Пустой корень лучше выброшенного треда: якорь и статус у него настоящие.
 */
function placeholderComment(thread: GithubReviewThread): Comment {
    const now = new Date(0).toISOString();
    return {
        id: `${THREAD_PREFIX}${thread.id}`,
        author: { login: 'ghost', displayName: null, bot: false, avatarUrl: null },
        body: '',
        draft: false,
        issue: null,
        resolved: null,
        createdAt: now,
        editedAt: null,
        replies: [],
    };
}

/**
 * Якорь треда. `line` у устаревшего треда приходит нулём — тогда берутся исходные координаты
 * (`originalLine`), а `subjectType: FILE` означает комментарий на файл целиком.
 */
function anchorOf(thread: GithubReviewThread): FileAnchor {
    return { fileId: thread.path, path: thread.path, position: positionOf(thread) };
}

function positionOf(thread: GithubReviewThread): AnchorPosition | null {
    if (thread.subjectType === 'FILE') {
        return null;
    }

    const usesOriginal = thread.line === null;
    const last = usesOriginal ? thread.originalLine : thread.line;
    const first = (usesOriginal ? thread.originalStartLine : thread.startLine) ?? last;
    if (last === null || last < 1 || first === null || first < 1) {
        return null;
    }

    const start = Math.min(first, last);
    return { side: thread.diffSide === 'LEFT' ? 'old' : 'new', line: start, size: last - start + 1 };
}

/**
 * Пин треда к коммиту, на котором он написан: у GitHub это ревью первого комментария.
 * Итерация у хоста одна, поэтому `diffId` пина — тот же коммит.
 */
function pinOf(first: GithubThreadComment | undefined): ThreadPin | null {
    const oid = first?.pullRequestReview?.commit?.oid;
    return oid === undefined ? null : { diffId: oid, commit: oid };
}

export function userOf(actor: GithubActor | null): ReviewUser {
    if (actor === null) {
        // Удалённый аккаунт: GitHub отдаёт `author: null`, а комментарий показывает как ghost.
        return { login: 'ghost', displayName: null, bot: false, avatarUrl: null };
    }
    return {
        login: actor.login,
        displayName: actor.name ?? null,
        bot: actor.__typename === 'Bot' || actor.login.endsWith('[bot]'),
        avatarUrl: avatarOf(actor.avatarUrl),
    };
}

/** Фото GitHub; не-https адрес протокол не пропустит, поэтому вместо него — инициалы. */
export function avatarOf(url: string | undefined): string | null {
    return url?.startsWith('https://') === true ? url : null;
}

function compactNodes<T>(nodes: readonly (T | null)[] | null): T[] {
    return (nodes ?? []).filter((node): node is T => node !== null);
}

/** Время GitHub уже в ISO, но контракт обещает UI одну форму — приводим через `Date`. */
export function isoTime(raw: string): string {
    const time = new Date(raw);
    if (Number.isNaN(time.getTime())) {
        throw new Error(`GitHub прислал нечитаемое время: ${JSON.stringify(raw)}`);
    }
    return time.toISOString();
}

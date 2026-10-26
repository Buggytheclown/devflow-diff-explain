import type { Comment, Thread } from '@sherpa/protocol';

import type { DiffFileModel } from '../diff/model.js';

/** Плоская строка дерева ответов: глубина не ограничена, визуальный отступ — до четырёх уровней. */
export interface FlatComment {
    readonly comment: Comment;
    readonly parent: Comment | null;
    /** Корень — 1, его ответы — 2 и так далее. */
    readonly depth: number;
    /** Отступ ответа слева в пикселях: 27 на уровень (колонка текста родителя), потолок — 108. */
    readonly indent: number;
    /** Автор родителя глубже четвёртого уровня ответов: подпись «↳ кому» собирает вью. */
    readonly replyHintAuthor: string | null;
    readonly subtreeReplies: number;
}

/** Колонка текста сообщения: аватар 18 + gap 9. Она же — шаг отступа ответа. */
const INDENT_STEP = 27;
/** Глубже отступ не растёт — вместо него в шапке появляется «↳ кому». */
const INDENT_MAX_LEVEL = 4;

export interface ThreadGroups {
    readonly byFile: ReadonlyMap<string, readonly Thread[]>;
    readonly outside: readonly Thread[];
}

/**
 * Итерация, дифф которой сейчас нарисован, когда это не активная итерация PR.
 * `fileId` принадлежит итерации (фикстуры — `makeFileId(diffId, path)`, Арканум — `entry_id`
 * диффсета), а треды приезжают один раз для активной: в старой итерации файл треда ищется
 * по `anchor.path`, а у своих строк тред стоит только в итерации своего пина.
 */
export interface IterationLayout {
    readonly diffId: string;
    readonly fileIdByPath: ReadonlyMap<string, string>;
}

/**
 * Тред встаёт у своих строк, а не под шапкой файла. В активной итерации (`layout === null`)
 * устаревший якорь уводит тред под шапку (docs/design/SPEC-elements.md §2.17); в прошлой итерации решает пин —
 * «view at the old commit» и показывает тред у кода, к которому он написан.
 */
export function threadAtLines(thread: Thread, layout: IterationLayout | null): boolean {
    if (thread.anchor?.position == null) {
        return false;
    }
    return layout === null ? !thread.outdated : thread.pinnedTo?.diffId === layout.diffId;
}

/** Файл нарисованного диффа, к которому относится тред; null — файла в этом диффе нет. */
export function threadFileId(thread: Thread, layout: IterationLayout | null): string | null {
    const anchor = thread.anchor;
    if (anchor === null) {
        return null;
    }
    return layout === null ? anchor.fileId : (layout.fileIdByPath.get(anchor.path) ?? null);
}

/** PR-level тред не привязан ни к файлу, ни к строке. */
export function isPrLevelThread(thread: Thread): boolean {
    return thread.anchor === null;
}

/**
 * Треды уровня PR — люди и боты: их целиком показывает модалка «Комментарии к PR»
 * (docs/design/SPEC-changes-2026-09-20.md §4). Бот-треды видны ещё и в группе «вне диффа».
 */
export function prLevelThreads(threads: readonly Thread[]): Thread[] {
    return threads.filter(isPrLevelThread);
}

/** Первая непустая строка тела: превью свёрнутого треда — маркера у кода и строки в модалке. */
export function commentFirstLine(body: string, limit = 0): string {
    const trimmed = (body.split('\n').find((candidate) => candidate.trim() !== '') ?? '').trim();
    return limit > 0 && trimmed.length > limit ? `${trimmed.slice(0, limit)}…` : trimmed;
}

/** Сплющивает ветвящееся дерево в порядок depth-first и считает всё поддерево каждого ответа. */
export function flattenThread(root: Comment): FlatComment[] {
    const rows: FlatComment[] = [];

    const visit = (comment: Comment, parent: Comment | null, depth: number): number => {
        const index = rows.length;
        rows.push({
            comment,
            parent,
            depth,
            indent: Math.min(depth - 1, INDENT_MAX_LEVEL) * INDENT_STEP,
            replyHintAuthor: depth - 1 > INDENT_MAX_LEVEL && parent !== null ? authorName(parent) : null,
            subtreeReplies: 0,
        });

        let descendants = 0;
        for (const reply of comment.replies) {
            descendants += 1 + visit(reply, comment, depth + 1);
        }
        const row = rows[index];
        if (row !== undefined) {
            rows[index] = { ...row, subtreeReplies: descendants };
        }
        return descendants;
    };

    visit(root, null, 1);
    return rows;
}

/** Треды известного диффа идут к файлам; outside оставляет ботов уровня PR и исчезнувшие файлы. */
export function groupThreads(
    threads: readonly Thread[],
    fileIds: ReadonlySet<string>,
    layout: IterationLayout | null = null,
): ThreadGroups {
    const byFile = new Map<string, Thread[]>();
    const outside: Thread[] = [];

    for (const thread of threads) {
        if (thread.anchor === null) {
            if (thread.root.author.bot) {
                outside.push(thread);
            }
            continue;
        }
        const fileId = threadFileId(thread, layout);
        if (fileId === null || !fileIds.has(fileId)) {
            outside.push(thread);
            continue;
        }
        const bucket = byFile.get(fileId);
        if (bucket === undefined) {
            byFile.set(fileId, [thread]);
        } else {
            bucket.push(thread);
        }
    }

    return { byFile, outside };
}

/**
 * Линза по участнику из карточки обсуждения — единственный фильтр тредов, который остался:
 * шум ботов и закрытых замечаний снимает сворачивание в маркер (docs/design/SPEC-changes-2026-09-20.md §3).
 * `author === null` — линзы нет, виден каждый тред.
 */
export function threadIsVisible(thread: Thread, author: string | null = null): boolean {
    return author === null || threadHasAuthor(thread, author);
}

/** Сообщений в треде на всех уровнях — число на маркере у строки. */
export function threadCommentCount(thread: Thread): number {
    return flattenThread(thread.root).length;
}

/** В треде есть мой неопубликованный черновик — корнем или ответом. */
export function threadHasDraft(thread: Thread): boolean {
    return flattenThread(thread.root).some((row) => row.comment.draft);
}

/**
 * Правило Арканума по комментариям: тред закрыт, если в нём есть хотя бы один комментарий
 * с issue и все они закрыты. `null` — хост резолв по комментарию не ведёт (`Comment.resolved`
 * у всех `null`), и правду про тред знает только `Thread.resolved` от адаптера.
 *
 * На сервере то же правило считает адаптер (`docs/decisions.md`, «Треды, issue и композер»);
 * здесь оно нужно ровно для оптимистичного кадра между кликом Resolve и ответом хоста.
 */
export function threadResolvedByIssues(thread: Thread): boolean | null {
    const rows = flattenThread(thread.root);
    if (rows.every((row) => row.comment.resolved === null)) {
        return null;
    }
    const issues = rows.filter((row) => row.comment.issue === true);
    return issues.length > 0 && issues.every((row) => row.comment.resolved === true);
}

/** Логин встречается в корне треда или в любом ответе на любой глубине. */
export function threadHasAuthor(thread: Thread, login: string): boolean {
    const visit = (comment: Comment): boolean =>
        comment.author.login === login || comment.replies.some(visit);
    return visit(thread.root);
}

/** Имя автора по логину из уже загруженных тредов; неизвестный логин остаётся логином. */
export function authorDisplayName(threads: readonly Thread[], login: string): string {
    for (const thread of threads) {
        const rows = flattenThread(thread.root);
        for (const row of rows) {
            if (row.comment.author.login === login) {
                return row.comment.author.displayName ?? login;
            }
        }
    }
    return login;
}

export function authorName(comment: Comment): string {
    return comment.author.displayName ?? comment.author.login;
}

export function positionLastLine(position: { readonly line: number; readonly size: number }): number {
    return position.line + Math.max(position.size, 1) - 1;
}

export interface ThreadPlacement {
    readonly byLine: ReadonlyMap<string, readonly Thread[]>;
    /** Позиционные треды, для стороны которых в модели нет ни одной видимой строки. */
    readonly unplaced: readonly Thread[];
}

/**
 * Раскладывает позиционные треды по видимым строкам; скрытый контекст притягивается к ближайшей.
 * Кому у строк не место (устаревший якорь, чужая итерация), решает вызывающий: `threadAtLines`.
 */
export function placeThreadsOnVisibleLines(
    model: DiffFileModel | null,
    threads: readonly Thread[],
): ThreadPlacement {
    const byLine = new Map<string, Thread[]>();
    if (model?.content.kind !== 'text') {
        return { byLine, unplaced: threads };
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

    const unplaced: Thread[] = [];
    for (const thread of threads) {
        const position = thread.anchor?.position;
        if (position === null || position === undefined) {
            unplaced.push(thread);
            continue;
        }
        const candidates = [...visible[position.side]];
        if (candidates.length === 0) {
            unplaced.push(thread);
            continue;
        }
        const lastLine = positionLastLine(position);
        const line = visible[position.side].has(lastLine)
            ? lastLine
            : candidates.reduce((nearest, candidate) =>
                  Math.abs(candidate - lastLine) < Math.abs(nearest - lastLine) ? candidate : nearest,
              );
        const key = `${position.side}:${String(line)}`;
        const bucket = byLine.get(key);
        if (bucket === undefined) {
            byLine.set(key, [thread]);
        } else {
            bucket.push(thread);
        }
    }
    return { byLine, unplaced };
}

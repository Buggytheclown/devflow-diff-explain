import type { Comment, FileAnchor, ReviewUser, Thread, ThreadPin } from '@sherpa/protocol';

import type { ArcComment } from './schemas.js';

/**
 * Сборка контрактных тредов из плоских списков комментариев Арканума.
 *
 * Факты разведки API (`docs/research/arcanum-api.md`), на которых стоит эта логика:
 * - тред — дерево: `reply_to_id` указывает на фактического родителя (глубина до 14, ветвление ~7%);
 * - `outdated` полем не приходит — это разность двух списков: комментарий есть в списке PR,
 *   но не доехал до активной итерации;
 * - id знаковые (PR-level отрицательные) — наружу уходит непрозрачная строка;
 * - боты: `review_system.is_ai` либо префикс логина `robot-`.
 */

const BOT_LOGIN_PREFIX = 'robot-';

/** Робот опознаётся по префиксу логина — там, где `review_system` не приходит вовсе (автор PR). */
export function isBotLogin(login: string): boolean {
    return login.startsWith(BOT_LOGIN_PREFIX);
}

/** Фото со Стаффа: центр отдаёт его по логину без авторизации, браузер ревьюера грузит напрямую. */
const STAFF_AVATAR_BASE = 'https://center.yandex-team.ru/api/v1/user/';

/** Человек или робот Арканума; адаптер собирает `ReviewUser` только здесь. */
export function arcanumUser(login: string, displayName: string | null, bot: boolean): ReviewUser {
    return {
        login,
        displayName,
        bot,
        avatarUrl: `${STAFF_AVATAR_BASE}${encodeURIComponent(login)}/avatar/100.jpg`,
    };
}

export interface BuildThreadsInput {
    /** Все комментарии PR (`…/comments`). */
    readonly all: readonly ArcComment[];
    /** Комментарии, перепривязанные к активной итерации (`…/diff-sets/{xid}/comments`). */
    readonly active: readonly ArcComment[];
    /**
     * Ревьюируемые коммиты итераций по их id — из них берётся пин треда к итерации исходного
     * якоря (`docs/design/SPEC-elements.md §4.5`). Пустая карта (список итераций не сложился) — пин `null` у всех.
     */
    readonly iterationCommits?: ReadonlyMap<string, string>;
}

export function buildThreads(input: BuildThreadsInput): Thread[] {
    // Soft-deleted комментарии наружу не отдаём: в UI их нет ни у Арканума, ни у нас.
    const alive = input.all.filter((comment) => comment.deleted_at === undefined);
    const activeById = new Map(input.active.map((comment) => [comment.id, comment]));

    // Якорь у перепривязанного комментария указывает на активную итерацию — он и нужен UI.
    const merged = alive.map((comment) => activeById.get(comment.id) ?? comment);
    // Пин считается по исходному якорю: у перепривязанного комментария `merged` несёт якорь
    // активной итерации, а «закреплён за 9f3c1ab» — про ту, где его написали.
    const originalById = new Map(alive.map((comment) => [comment.id, comment]));
    const byId = new Map(merged.map((comment) => [comment.id, comment]));

    const children = new Map<number, ArcComment[]>();
    const roots: ArcComment[] = [];
    for (const comment of merged) {
        const parentId = comment.reply_to_id;
        // Осиротевший ответ (родителя удалили) поднимается в корень: терять его нельзя.
        if (parentId === undefined || !byId.has(parentId) || parentId === comment.id) {
            roots.push(comment);
            continue;
        }
        const siblings = children.get(parentId);
        if (siblings === undefined) {
            children.set(parentId, [comment]);
        } else {
            siblings.push(comment);
        }
    }

    return sortByTime(roots).map((root) =>
        toThread(root, children, activeById, originalById, input.iterationCommits ?? new Map()),
    );
}

/**
 * Одиночный комментарий из ответа ручки записи: у только что созданного черновика ответов нет
 * по построению, поэтому дерево ему собирать не из чего.
 */
export function toSingleComment(comment: ArcComment): Comment {
    return toComment(comment, new Map());
}

function toThread(
    root: ArcComment,
    children: Map<number, ArcComment[]>,
    activeById: ReadonlyMap<number, ArcComment>,
    originalById: ReadonlyMap<number, ArcComment>,
    iterationCommits: ReadonlyMap<string, string>,
): Thread {
    const anchor = anchorOf(root);
    const issues = flatten(root, children).filter(isIssue);
    // Правило Арканума: закрыт тред, в котором есть issue и все они закрыты. Статус корня сам
    // по себе ничего не решает — открытый issue в ответе держит тред открытым.
    const resolved = issues.length > 0 && issues.every(isResolved);
    return {
        id: String(root.id),
        anchor,
        resolved,
        resolvedBy: resolved ? (lastClosed(issues)?.status_updated_by?.name ?? null) : null,
        // Комментарий уровня PR к итерации не привязан и устареть не может.
        outdated: anchor !== null && !activeById.has(root.id),
        pinnedTo: pinOf(originalById.get(root.id) ?? root, iterationCommits),
        root: toComment(root, children),
    };
}

/**
 * Рекурсия конечна, потому что родитель всегда старше ребёнка: кольцо в `reply_to_id` не даёт
 * ни одного корня, и такое поддерево просто не попадёт в вывод — зациклиться на нём невозможно.
 */
function toComment(comment: ArcComment, children: Map<number, ArcComment[]>): Comment {
    return {
        id: String(comment.id),
        author: authorOf(comment),
        body: comment.content ?? '',
        draft: isDraft(comment),
        issue: isIssue(comment),
        resolved: isResolved(comment),
        createdAt: isoTime(comment.created_at),
        editedAt: comment.edited_at === undefined ? null : isoTime(comment.edited_at),
        replies: sortByTime(children.get(comment.id) ?? []).map((reply) => toComment(reply, children)),
    };
}

/**
 * Закрытым считается и `dropped`: issue закрыли, пусть и «не будем чинить» — в открытых он не висит.
 * `not_issue` и отсутствие статуса — обычный комментарий, issue он никогда не был, и закрывать
 * в нём нечего.
 */
function isResolved(comment: ArcComment): boolean {
    return comment.issue_status === 'resolved' || comment.issue_status === 'dropped';
}

/** Комментарий треда и все его ответы — плоским списком. */
function flatten(root: ArcComment, children: Map<number, ArcComment[]>): ArcComment[] {
    return [root, ...(children.get(root.id) ?? []).flatMap((reply) => flatten(reply, children))];
}

/**
 * Чей логин подписывает закрытый тред: последним закрывшим issue. Времени смены статуса в
 * проекции нет — берётся `updated_at` (при равенстве времён порядок решает id).
 */
function lastClosed(issues: readonly ArcComment[]): ArcComment | null {
    let last: ArcComment | null = null;
    for (const issue of issues) {
        if (!isResolved(issue)) {
            continue;
        }
        if (last === null || statusTimeOf(issue).localeCompare(statusTimeOf(last)) >= 0) {
            last = issue;
        }
    }
    return last;
}

function statusTimeOf(comment: ArcComment): string {
    return comment.updated_at ?? comment.created_at;
}

/**
 * Открывает ли комментарий issue. Закрытый issue остаётся issue, поэтому «нет» — только явный
 * `not_issue` и отсутствие статуса: Арканум не хранит его у комментариев, которые issue никогда
 * не были (schemas.ts), и «не знаю» здесь непредставимо — `null` остаётся хостам без issue вовсе.
 */
function isIssue(comment: ArcComment): boolean {
    return comment.issue_status !== undefined && comment.issue_status !== 'not_issue';
}

/** Черновик — `published_at IS NULL`; флаг `draft` Арканум шлёт только автору. */
function isDraft(comment: ArcComment): boolean {
    return comment.draft === true || comment.published_at === undefined;
}

function authorOf(comment: ArcComment): ReviewUser {
    const system = comment.review_system;
    const login = comment.user.name;
    return arcanumUser(login, system?.display_name ?? null, system?.is_ai === true || isBotLogin(login));
}

/**
 * Итерация исходного якоря треда. `null` — обсуждение уровня PR либо итерация якоря уже не
 * перечисляется хостом (после force-push): выдумывать коммит для неё нечем.
 */
function pinOf(original: ArcComment, iterationCommits: ReadonlyMap<string, string>): ThreadPin | null {
    const diff = original.anchor?.review_request?.diff;
    if (diff?.file === undefined || diff.diff_set_xid === undefined) {
        return null;
    }
    const commit = iterationCommits.get(diff.diff_set_xid);
    return commit === undefined ? null : { diffId: diff.diff_set_xid, commit };
}

function anchorOf(comment: ArcComment): FileAnchor | null {
    const file = comment.anchor?.review_request?.diff?.file;
    if (file === undefined) {
        return null;
    }

    const position = file.position;
    return {
        fileId: file.entry_id,
        path: file.path,
        // Нулевая или отрицательная строка — якорь на файл целиком: врать позицией хуже, чем её не дать.
        position:
            position === undefined || position.line < 1
                ? null
                : { side: position.side, line: position.line, size: Math.max(position.size ?? 1, 1) },
    };
}

/** Порядок ответов — по времени создания, при совпадении — по id (стабильность снапшотов). */
function sortByTime(comments: readonly ArcComment[]): ArcComment[] {
    return [...comments].sort((left, right) => {
        const byTime = left.created_at.localeCompare(right.created_at);
        return byTime === 0 ? left.id - right.id : byTime;
    });
}

/**
 * Таймштампы приводятся к ISO с миллисекундами: Арканум отдаёт микросекунды, а контракт
 * обещает UI одну форму. Непарсящееся время — ошибка данных, тихо подменять его нечем.
 */
export function isoTime(raw: string): string {
    const time = new Date(raw);
    if (Number.isNaN(time.getTime())) {
        throw new Error(`Арканум прислал нечитаемое время: ${JSON.stringify(raw)}`);
    }
    return time.toISOString();
}

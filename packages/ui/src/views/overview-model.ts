import type { Comment, FileDiff, Lens, LensZone, ReviewUser, Thread } from '@sherpa/protocol';

import type { Translate } from '../i18n/index.js';

export type OwnershipKind = 'mine' | 'other' | 'mixed' | 'generated';
export type OwnershipSegment = 'mine' | 'all';

export interface OwnershipGroup {
    readonly path: string;
    readonly files: number;
    readonly lines: number;
    readonly additions: number;
    readonly deletions: number;
    readonly ownership: OwnershipKind | null;
    readonly owner: string | null;
    readonly note: string;
}

export interface OwnershipSummary {
    readonly available: boolean;
    readonly note: string | null;
    readonly mineFiles: number;
    readonly totalFiles: number;
    readonly mineLines: number;
    readonly totalLines: number;
    readonly groups: readonly OwnershipGroup[];
}



/**
 * Группирует дифф по зонам линзы; старый префиксный путь остаётся честной деградацией.
 * `zoneSource` — чем хост называет источник зон (`UiReviewLensesResponse.ownershipSource`), он же
 * стоит в подписях; null — линз нет вовсе, и линзу без подписи сводка не учитывает.
 */
export function ownershipSummary(
    files: readonly FileDiff[],
    lens: Lens | null,
    segment: OwnershipSegment,
    t: Translate,
    fallbackNote: string,
    zoneSource: string | null,
): OwnershipSummary {
    const ownership = lens === null || zoneSource === null ? null : { lens, source: zoneSource };
    const available = ownership?.lens.available === true;
    const minePaths = new Set(ownership !== null && available ? ownership.lens.paths : []);
    const mineFiles = available ? files.filter((file) => minePaths.has(file.path)) : [];
    const shown = segment === 'mine' && available ? mineFiles : files;
    const zones = ownership?.lens.zones ?? null;

    return {
        available,
        // Хост объясняет и неполный ответ у работающей линзы («команды не назвались»),
        // поэтому `note` показывается и при `available`.
        note: ownership?.lens.note ?? (available ? null : fallbackNote),
        mineFiles: mineFiles.length,
        totalFiles: files.length,
        mineLines: changedLines(mineFiles),
        totalLines: changedLines(files),
        groups:
            ownership === null || zones === null
                ? groupsByPrefix(shown, available ? ownership : null, minePaths, t)
                : groupsByZones(shown, zones, t, ownership.source),
    };
}

/** Корневой сегмент сохраняется как есть, остальные пути сворачиваются до двух первых частей. */
export function ownershipGroupPath(path: string): string {
    return path.split('/').slice(0, 2).join('/');
}

function groupsByZones(
    files: readonly FileDiff[],
    zones: readonly LensZone[],
    t: Translate,
    zoneSource: string,
): OwnershipGroup[] {
    const byPath = new Map(files.map((file) => [file.path, file] as const));
    const zoned = new Set<string>();
    const groups: OwnershipGroup[] = [];

    for (const zone of zones) {
        const grouped = zone.paths.flatMap((path) => {
            const file = byPath.get(path);
            return file === undefined ? [] : [file];
        });
        if (grouped.length === 0) {
            continue;
        }
        for (const file of grouped) {
            zoned.add(file.path);
        }
        groups.push(
            groupOf(
                zone.path,
                grouped,
                zone.mine ? 'mine' : 'other',
                zone.owner,
                t(zone.mine ? 'overview.ownership.note.mineZone' : 'overview.ownership.note.otherZone', zoneSource),
            ),
        );
    }

    const outside = files.filter((file) => !zoned.has(file.path));
    const uncovered = outside.filter((file) => !file.generated);
    const generated = outside.filter((file) => file.generated);
    if (uncovered.length > 0) {
        groups.push(
            groupOf(
                t('overview.ownership.outsideZones', zoneSource),
                uncovered,
                'other',
                null,
                t('overview.ownership.note.uncovered', zoneSource),
            ),
        );
    }
    if (generated.length > 0) {
        groups.push(
            groupOf(
                t('overview.ownership.generatedPath'),
                generated,
                'generated',
                null,
                t('overview.ownership.note.generated'),
            ),
        );
    }
    return groups;
}

/** `ownership` — работающая линза с именем источника; null — принадлежность файлов неизвестна. */
function groupsByPrefix(
    files: readonly FileDiff[],
    ownership: { readonly source: string } | null,
    minePaths: ReadonlySet<string>,
    t: Translate,
): OwnershipGroup[] {
    const buckets = new Map<string, FileDiff[]>();
    for (const file of files) {
        const path = ownershipGroupPath(file.path);
        const bucket = buckets.get(path);
        if (bucket === undefined) {
            buckets.set(path, [file]);
        } else {
            bucket.push(file);
        }
    }

    return [...buckets].map(([path, grouped]) => {
        if (ownership === null) {
            return groupOf(path, grouped, null, null, t('overview.ownership.note.prefixUnknown'));
        }
        const kind = ownershipOf(grouped, minePaths);
        return groupOf(path, grouped, kind, null, prefixNote(kind, t, ownership.source));
    });
}

function groupOf(
    path: string,
    files: readonly FileDiff[],
    ownership: OwnershipKind | null,
    owner: string | null,
    note: string,
): OwnershipGroup {
    return {
        path,
        files: files.length,
        lines: changedLines(files),
        additions: sum(files, 'additions'),
        deletions: sum(files, 'deletions'),
        ownership,
        owner,
        note,
    };
}

function prefixNote(ownership: OwnershipKind, t: Translate, zoneSource: string): string {
    switch (ownership) {
        case 'mine':
            return t('overview.ownership.note.prefixMine', zoneSource);
        case 'other':
            return t('overview.ownership.note.prefixOther', zoneSource);
        case 'mixed':
            return t('overview.ownership.note.prefixMixed', zoneSource);
        case 'generated':
            return t('overview.ownership.note.generated');
    }
}

export interface DiscussionStats {
    readonly open: number;
    readonly resolved: number;
    readonly bots: number;
}

/** Счётчики Overview: открытые и закрытые взаимоисключающие, бот — независимый признак источника. */
export function discussionStats(threads: readonly Thread[]): DiscussionStats {
    let open = 0;
    let resolved = 0;
    let bots = 0;
    for (const thread of threads) {
        if (thread.resolved) {
            resolved += 1;
        } else {
            open += 1;
        }
        if (thread.root.author.bot) {
            bots += 1;
        }
    }
    return { open, resolved, bots };
}

function ownershipOf(files: readonly FileDiff[], minePaths: ReadonlySet<string>): OwnershipKind {
    if (files.every((file) => file.generated)) {
        return 'generated';
    }
    const mine = files.filter((file) => minePaths.has(file.path)).length;
    if (mine === files.length) {
        return 'mine';
    }
    return mine === 0 ? 'other' : 'mixed';
}

function changedLines(files: readonly FileDiff[]): number {
    return files.reduce((total, file) => total + file.additions + file.deletions, 0);
}

function sum(files: readonly FileDiff[], key: 'additions' | 'deletions'): number {
    return files.reduce((total, file) => total + file[key], 0);
}


/** Строка участника в карточке обсуждения (docs/design/SPEC-additions-2026-08-26.md §1e п.3). */
export interface DiscussionParticipant {
    readonly login: string;
    readonly name: string;
    readonly bot: boolean;
    readonly avatarUrl: string | null;
    /** Треды с его словом (корень или ответ) под текущими чипами: фильтры правят и строками, и счётчиками. */
    readonly threads: number;
    readonly open: number;
    /** Последний комментарий в этих тредах; null — считать не по чему. */
    readonly lastActivity: string | null;
}

export interface DiscussionSummary {
    /** Шапка карточки считает все треды PR — чипы её не трогают. */
    readonly total: number;
    readonly open: number;
    readonly participants: readonly DiscussionParticipant[];
    /** Треды людей, которых нет ни у одной строки нарисованного диффа; бот-тредов здесь не бывает. */
    readonly outside: readonly Thread[];
}

/**
 * Модель карточки «Обсуждение» (docs/design/SPEC-additions-2026-08-26.md §1e). Строка участника собирается по тому же
 * правилу, что и линза по автору на Полном диффе (`threadHasAuthor`): в неё идёт каждый, кто
 * написал корень или любой ответ, — счётчик строки и выдача линзы по ней совпадают. Бот
 * получает свою строку со счётчиком, но тела его тредов в карточку не попадают.
 */
export function discussionSummary(threads: readonly Thread[], fileIds: ReadonlySet<string>): DiscussionSummary {
    const byLogin = new Map<string, { participant: DiscussionParticipant; lastMs: number }>();

    for (const thread of threads) {
        const lastMs = lastActivityMs(thread.root);
        for (const author of threadAuthors(thread)) {
            const entry = byLogin.get(author.login);
            if (entry === undefined) {
                byLogin.set(author.login, {
                    participant: {
                        login: author.login,
                        name: author.displayName ?? author.login,
                        bot: author.bot,
                        avatarUrl: author.avatarUrl,
                        threads: 1,
                        open: thread.resolved ? 0 : 1,
                        lastActivity: lastActivityIso(thread.root),
                    },
                    lastMs,
                });
                continue;
            }
            const fresher = lastMs > entry.lastMs;
            byLogin.set(author.login, {
                lastMs: fresher ? lastMs : entry.lastMs,
                participant: {
                    ...entry.participant,
                    threads: entry.participant.threads + 1,
                    open: entry.participant.open + (thread.resolved ? 0 : 1),
                    lastActivity: fresher ? lastActivityIso(thread.root) : entry.participant.lastActivity,
                },
            });
        }
    }

    const participants = [...byLogin.values()]
        .sort((left, right) => {
            if (left.participant.bot !== right.participant.bot) {
                return left.participant.bot ? 1 : -1;
            }
            if (left.participant.open !== right.participant.open) {
                return right.participant.open - left.participant.open;
            }
            if (left.lastMs !== right.lastMs) {
                return right.lastMs - left.lastMs;
            }
            return left.participant.login.localeCompare(right.participant.login);
        })
        .map((entry) => entry.participant);

    const outside = threads
        .filter((thread) => !thread.root.author.bot && !atCode(thread, fileIds))
        .sort((left, right) => Date.parse(right.root.createdAt) - Date.parse(left.root.createdAt));

    return {
        total: threads.length,
        open: threads.filter((thread) => !thread.resolved).length,
        participants,
        outside,
    };
}

/** Все, кто писал в треде, в порядке появления; повторный логин берёт имя первого вхождения. */
function threadAuthors(thread: Thread): readonly ReviewUser[] {
    const byLogin = new Map<string, ReviewUser>();
    const visit = (comment: Comment): void => {
        if (!byLogin.has(comment.author.login)) {
            byLogin.set(comment.author.login, comment.author);
        }
        comment.replies.forEach(visit);
    };
    visit(thread.root);
    return [...byLogin.values()];
}

/** Тред стоит у кода нарисованного диффа: якорь есть и его файл в этом диффе остался. */
function atCode(thread: Thread, fileIds: ReadonlySet<string>): boolean {
    return thread.anchor !== null && fileIds.has(thread.anchor.fileId);
}

function lastActivityMs(root: Comment): number {
    const own = Date.parse(root.editedAt ?? root.createdAt);
    const time = Number.isFinite(own) ? own : 0;
    return root.replies.reduce((latest, reply) => Math.max(latest, lastActivityMs(reply)), time);
}

function lastActivityIso(root: Comment): string | null {
    let best: string | null = null;
    let bestMs = Number.NEGATIVE_INFINITY;
    const visit = (comment: Comment): void => {
        const iso = comment.editedAt ?? comment.createdAt;
        const ms = Date.parse(iso);
        if (Number.isFinite(ms) && ms > bestMs) {
            bestMs = ms;
            best = iso;
        }
        comment.replies.forEach(visit);
    };
    visit(root);
    return best;
}

/** Ширина колонки карточки (360px) при 12px тела — примерно столько знаков влезает в строку. */
const CARD_LINE_CHARS = 48;
const CARD_BODY_LINES = 4;

/**
 * Тело треда длиннее четырёх строк — его показывают обрезанным с «раскрыть» (§1e п.4).
 * Считается по исходному markdown: измерить раскладку до рендера негде, а решение о кнопке
 * нужно и в статическом рендере галереи.
 */
export function bodyNeedsExpand(body: string, lineChars = CARD_LINE_CHARS): boolean {
    let lines = 0;
    let fenced = false;
    for (const raw of body.split('\n')) {
        const line = raw.trimEnd();
        if (line.startsWith('```')) {
            fenced = !fenced;
            lines += 1;
            continue;
        }
        // Блок кода не переносится (§1e): сколько строк в исходнике, столько и на экране.
        lines += fenced || line === '' ? 1 : Math.ceil(line.length / lineChars) || 1;
    }
    return lines > CARD_BODY_LINES;
}

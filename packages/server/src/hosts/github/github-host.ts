import { createHash } from 'node:crypto';

import type {
    AnchorPosition,
    Comment,
    CommentDraft,
    FileAnchor,
    FileContent,
    FileDiff,
    FileImage,
    HostCapabilities,
    HostId,
    ImageSide,
    Iteration,
    Lens,
    LensZone,
    PrChecks,
    PrDiff,
    PrMeta,
    PublishResult,
    ReviewHost,
    ReviewUser,
    ReviewerVerdict,
    Thread,
    Verdict,
} from '@sherpa/protocol';
import {
    commentDraftSchema,
    IMAGE_BLOB_MAX_BYTES,
    imageMimeOf,
    verdictSchema,
} from '@sherpa/protocol';

import { RpcFailure } from '../../errors.js';

import type { FetchLike, GithubClientOptions } from './client.js';
import { GithubClient } from './client.js';
import type { CodeownersRule } from './codeowners.js';
import { ownersOf, parseCodeowners, zonePathOf } from './codeowners.js';
import {
    appendParagraph,
    BODY_PLACEHOLDER,
    parseReviewBody,
    removeParagraph,
    renderReviewBody,
    replaceParagraph,
} from './drafts.js';
import type { IdempotencyStore } from './idempotency-store.js';
import { memoryIdempotencyStore } from './idempotency-store.js';
import {
    ADD_REVIEW_THREAD_MUTATION,
    ADD_REVIEW_THREAD_REPLY_MUTATION,
    CODEOWNERS_QUERY,
    CREATE_REVIEW_MUTATION,
    DELETE_ISSUE_COMMENT_MUTATION,
    DELETE_REVIEW_COMMENT_MUTATION,
    FILE_CONTENT_QUERY,
    FILES_QUERY,
    MARK_FILE_VIEWED_MUTATION,
    PR_QUERY,
    RESOLVE_THREAD_MUTATION,
    REVIEW_BODY_QUERY,
    SUBMIT_REVIEW_MUTATION,
    THREAD_COMMENTS_QUERY,
    THREADS_PAGE_QUERY,
    TICK_QUERY,
    UNMARK_FILE_VIEWED_MUTATION,
    UNRESOLVE_THREAD_MUTATION,
    UPDATE_ISSUE_COMMENT_MUTATION,
    UPDATE_REVIEW_BODY_MUTATION,
    UPDATE_REVIEW_COMMENT_MUTATION,
    VERDICT_REVIEW_MUTATION,
    VIEWER_QUERY,
    blobBinaryQuery,
    blobSizesQuery,
    orgTeamsQuery,
} from './queries.js';
import type {
    GithubFilesResponse,
    GithubOrgTeams,
    GithubPrMeta,
    GithubRestFile,
    GithubReview,
    GithubReviewThread,
} from './schemas.js';
import {
    addReviewThreadMutationSchema,
    addReviewThreadReplyMutationSchema,
    blobAliasesResponseSchema,
    codeownersResponseSchema,
    commentMutationSchema,
    compact,
    compareSchema,
    orgTeamsResponseSchema,
    fileContentResponseSchema,
    filesResponseSchema,
    prResponseSchema,
    resolveThreadMutationSchema,
    restFilesSchema,
    reviewBodyResponseSchema,
    submitReviewMutationSchema,
    threadCommentsResponseSchema,
    threadsPageResponseSchema,
    tickResponseSchema,
    unresolveThreadMutationSchema,
    updateReviewBodyMutationSchema,
    reviewMutationSchema,
    verdictMutationSchema,
    viewedMutationSchema,
    viewerResponseSchema,
} from './schemas.js';
import type { ParsedCommentId } from './threads.js';
import {
    avatarOf,
    buildThreads,
    isoTime,
    isReviewParagraphOf,
    parseCommentId,
    parseThreadId,
    reviewParagraphId,
    toDiffComment,
    userOf,
} from './threads.js';

/**
 * Хост-адаптер github.com: чтение и запись PR через GraphQL, три REST-ручки на то, чего в
 * GraphQL нет (`docs/research/github-api.md`).
 *
 * Опорные решения (`docs/decisions.md`, «Хост-адаптеры»):
 * - итерация одна: у GitHub нет понятия диффсета, ревьюится текущая голова ветки против
 *   merge-base, поэтому `capabilities.iterations: false` и срезов хост не строит;
 * - черновики живут в pending-ревью GitHub — комментарии строк заводятся прямо в нём, а
 *   черновик уровня PR ложится абзацем в тело ревью (`drafts.ts`), потому что другого места
 *   для неопубликованного текста у GitHub нет;
 * - публикация — один `submitPullRequestReview`: частичного успеха у GitHub не бывает;
 * - своё опубликованное правится и удаляется (`capabilities.editPublished`), но отдельной парой
 *   ручек: `updateDraft`/`deleteDraft` остаются черновикам. Комментарий, начавший обсуждение
 *   строки, с ответами не удаляется: GitHub снёс бы обсуждение целиком;
 * - реактивности нет: один поллер на хост, тик — один GraphQL-запрос «мета + треды».
 */

/** Интервал общего поллера: тик стоит очков GraphQL, чаще смысла нет. */
const POLL_INTERVAL_MS = 15_000;

const WEB_BASE_URL = 'https://github.com';

/** Больше этого числа файлов GitHub в списке не отдаёт — дифф был бы молча обрезан. */
const MAX_PR_FILES = 3000;

/**
 * Потолок содержимого для «Expand context»: на файлах такого размера расширение бессмысленно —
 * UI и так сворачивает дифф длиннее 2000 строк.
 */
const MAX_CONTENT_BYTES = 2_000_000;

/** Три места, где GitHub ищет CODEOWNERS; побеждает первый найденный (`docs/research/github-api.md`). */
const CODEOWNERS_PATHS = {
    githubDir: '.github/CODEOWNERS',
    root: 'CODEOWNERS',
    docsDir: 'docs/CODEOWNERS',
} as const;

/** Потолок страниц списка команд: по сотне на страницу это заведомо больше, чем бывает у человека. */
const MAX_TEAM_PAGES = 10;

/** Приписка к `note` линзы, когда команды ревьюера остались неизвестными. */
const TEAMS_UNKNOWN_NOTE =
    'GitHub did not tell which teams you are in (read:org scope?): ownership by team is not counted.';

const CAPABILITIES: Omit<HostCapabilities, 'publishVerdicts'> = {
    fileViewedSync: true,
    fileContent: true,
                sourceAtRevision: true,
    // Отдельного статуса «комментарий требует ответа» у GitHub нет — есть только resolve треда.
    commentIssues: false,
    // Закрывается тред целиком: резолвить по комментарию GitHub не умеет.
    commentResolve: false,
    // Флаг держится на личности ревьюера: шапка без `viewer` не отдаётся вовсе (`viewerUser`).
    editPublished: true,
    iterations: false,
    blobs: true,
};

const CHANGE_TYPES: Readonly<Record<string, FileDiff['changeType']>> = {
    added: 'add',
    removed: 'delete',
    renamed: 'move',
    copied: 'copy',
    modified: 'modify',
    changed: 'modify',
    unchanged: 'modify',
};

export interface GithubHostOptions {
    readonly owner: string;
    readonly repo: string;
    readonly number: number;
    readonly client?: GithubClient;
    readonly fetch?: FetchLike;
    readonly token?: () => Promise<string>;
    readonly baseUrl?: string;
    readonly pollIntervalMs?: number;
    /** Карта повторов черновиков; по умолчанию — в памяти процесса. */
    readonly idempotency?: IdempotencyStore;
    /** Ретраи и паузы клиента; тестам нужны нулевые задержки. */
    readonly transport?: Omit<GithubClientOptions, 'token' | 'fetch' | 'baseUrl'>;
}

/** Что живёт ровно одну итерацию: сменилась голова ветки — кэш выбрасывается целиком. */
interface IterationCache {
    readonly headRefOid: string;
    mergeBase?: Promise<string>;
    diff?: Promise<PrDiff>;
    ownership?: OwnershipCache;
}

/** Линза владения считана на этой паре «голова + база»: база двигается и без пуша. */
interface OwnershipCache {
    readonly baseRefOid: string;
    readonly lens: Promise<Lens>;
}

/** Разобранный CODEOWNERS коммита базы; `null` в `rules` — файла там нет. */
interface CodeownersCache {
    readonly baseRefOid: string;
    readonly rules: Promise<readonly CodeownersRule[] | null>;
}

/** Значение с пометкой «ответ неполон»: такое наружу отдаётся, но в кэше не остаётся. */
interface Degradable<T> {
    readonly value: T;
    readonly degraded: boolean;
}

/** Запись кэша шапки; `headRefOid` известен после ответа. */
interface MetaCache {
    readonly promise: Promise<GithubPrMeta>;
    headRefOid: string | null;
    confirmedAt: number;
}

/** Комментарий, к которому идёт запись: разбор id и он же из свежего снапшота. */
interface CommentTarget {
    readonly parsed: ParsedCommentId;
    readonly comment: Comment;
}

/** Результат тика: то, что отдаёт один GraphQL-запрос опроса. */
interface TickSnapshot {
    readonly meta: GithubPrMeta;
    readonly reviews: readonly GithubReview[];
    readonly threads: Thread[];
}

type PollHandler = (tick: TickSnapshot | null, alive: () => boolean) => Promise<void>;

interface PollSubscription {
    readonly handler: PollHandler;
    stopped: boolean;
    /** Начальный тик этой подписки уже отработал. */
    served: boolean;
}

export class GithubHost implements ReviewHost {
    readonly ownershipSource = 'CODEOWNERS';

    private readonly owner: string;
    private readonly repo: string;
    private readonly number: number;
    private readonly client: GithubClient;
    private readonly idempotency: IdempotencyStore;
    private readonly pollIntervalMs: number;

    private readonly pollSubscriptions = new Set<PollSubscription>();
    private pollTimer: NodeJS.Timeout | null = null;
    private polling = false;
    private tickRequested = false;

    private metaCache: MetaCache | null = null;
    private cache: IterationCache | null = null;
    private codeowners: CodeownersCache | null = null;
    /** Команды ревьюера по списку организаций (ключ — их отсортированный список). */
    private readonly teams = new Map<string, Promise<Degradable<ReadonlySet<string>>>>();
    /** Владелец токена; промис нулевой — его ещё не спрашивали. */
    private viewer: Promise<ReviewUser> | null = null;

    /**
     * Очередь записей в pending-ревью. Тело ревью — один общий ресурс: абзац в него добавляется
     * чтением, правкой и записью целиком, и два таких цикла внахлёст затёрли бы текст друг друга.
     * Сюда же заведение самого pending-ревью: параллельные черновики иначе завели бы его дважды.
     */
    private reviewWrites: Promise<unknown> = Promise.resolve();

    /** Размеры сторон картинок по `ImageSide.blobId`: по ним стоит лимит `getBlob`. */
    private readonly imageBlobs = new Map<string, number>();

    constructor(options: GithubHostOptions) {
        this.owner = options.owner;
        this.repo = options.repo;
        this.number = options.number;
        this.idempotency = options.idempotency ?? memoryIdempotencyStore();
        this.client =
            options.client ??
            new GithubClient({
                token: options.token ?? (() => Promise.reject(new Error('токен GitHub не задан'))),
                ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
                ...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }),
                ...options.transport,
            });
        this.pollIntervalMs = options.pollIntervalMs ?? POLL_INTERVAL_MS;
    }

    /** Логин владельца токена; null — `viewer` не ответил. */
    currentUser(): Promise<string | null> {
        return this.viewerLogin();
    }

    async getPr(): Promise<PrMeta> {
        const [meta, viewer] = await Promise.all([this.meta(), this.viewerUser()]);
        return this.toPrMeta(meta, viewer);
    }

    /**
     * Итерация у GitHub одна: ревьюется голова ветки против merge-base с базовой веткой.
     * Диффсетов, которые можно перечислить и сравнить, у хоста нет (`capabilities.iterations: false`).
     */
    async listIterations(): Promise<Iteration[]> {
        const meta = await this.meta();
        return [
            {
                diffId: meta.headRefOid,
                baseCommit: await this.mergeBase(meta),
                headCommit: meta.headRefOid,
                createdAt: isoTime(meta.updatedAt),
                status: 'active',
            },
        ];
    }

    async getDiff(slice?: { base: HostId; head: HostId }): Promise<PrDiff> {
        if (slice !== undefined) {
            throw new RpcFailure(
                'bad_request',
                'GitHub: у этого PR одна итерация — срез между итерациями построить не из чего.',
            );
        }
        return this.cachedDiff(await this.meta());
    }

    watchIterations(onChange: (iterations: Iteration[]) => void): () => void {
        let started = false;
        let lastHead: string | null = null;

        return this.subscribePoll(async (tick, alive) => {
            if (tick === null || (started && tick.meta.headRefOid === lastHead)) {
                return;
            }

            const iterations = await this.listIterations();
            started = true;
            lastHead = tick.meta.headRefOid;
            if (alive()) {
                onChange(iterations);
            }
        });
    }

    async getThreads(): Promise<Thread[]> {
        return (await this.loadTick()).threads;
    }

    /**
     * Поллинг вместо подписки: один GraphQL-запрос раз в `pollIntervalMs` на всех подписчиков.
     * Снапшот отдаётся только когда он действительно изменился; ошибка тика подписку не роняет.
     */
    watchThreads(onChange: (threads: Thread[]) => void): () => void {
        let started = false;
        let last: string | null = null;

        return this.subscribePoll((tick, alive) => {
            if (tick === null) {
                return Promise.resolve();
            }
            const snapshot = JSON.stringify(tick.threads);
            if (started && snapshot === last) {
                return Promise.resolve();
            }
            started = true;
            last = snapshot;
            if (alive()) {
                onChange(tick.threads);
            }
            return Promise.resolve();
        });
    }

    /**
     * Смена состояния ревью — хост-специфичная подписка поверх того же тика: по ней сервер
     * перечитывает мету и узнаёт, что кто-то апрувнул PR раньше.
     */
    watchStatus(onChange: () => void): () => void {
        let started = false;
        let last: string | null = null;

        return this.subscribePoll((tick, alive) => {
            if (tick === null) {
                return Promise.resolve();
            }
            const stamp = statusStampOf(tick.meta);
            if (started && stamp !== last && alive()) {
                onChange();
            }
            last = stamp;
            started = true;
            return Promise.resolve();
        });
    }

    /**
     * Черновик уходит в pending-ревью GitHub сразу (двухступенчатая модель, `docs/product.md §3`).
     * Три случая контракта: якорь — новый тред в pending-ревью, `parentId` — ответ в чужой тред,
     * ни того ни другого — абзац в тело ревью.
     *
     * Ключей повтора GitHub не понимает, поэтому соответствие «ключ → комментарий» держит сам
     * адаптер: повтор из буфера черновиков возвращает уже созданный комментарий, а не дубль.
     */
    async saveDraft(draft: CommentDraft, options?: { idempotencyKey?: string }): Promise<Comment> {
        const parsed = commentDraftSchema.parse(draft);
        const key = options?.idempotencyKey;

        if (key !== undefined) {
            const known = this.idempotency.get(key);
            if (known !== null) {
                const existing = await this.findComment(known);
                if (existing !== null) {
                    return existing;
                }
            }
        }

        const created =
            parsed.parentId !== null
                ? await this.createReply(parsed.parentId, parsed.body)
                : parsed.anchor !== null
                  ? await this.createThreadDraft(parsed.anchor, parsed.body)
                  : await this.createBodyDraft(parsed.body);

        if (key !== undefined) {
            this.idempotency.set(key, created.id);
        }
        this.refreshSoon();
        return created;
    }

    /** Правка своего черновика: комментарий pending-ревью или абзац его тела. */
    async updateDraft(commentId: HostId, body: string): Promise<void> {
        const { parsed } = await this.parseForWrite(commentId, true);
        await this.writeComment(parsed, body);
        this.refreshSoon();
    }

    async deleteDraft(commentId: HostId): Promise<void> {
        await this.eraseComment(await this.parseForWrite(commentId, true));
        this.refreshSoon();
    }

    /**
     * Правка своего опубликованного комментария. Абзац опубликованного ревью правится
     * перезаписью всего тела: маркеры Шерпы в нём остаются, иначе абзацы потеряли бы номера.
     * `issue` игнорируется — статуса «требует ответа» у GitHub нет (`capabilities.commentIssues`).
     */
    async updateComment(commentId: HostId, body: string, _issue?: boolean): Promise<void> {
        const { parsed } = await this.parseForWrite(commentId, false);
        await this.writeComment(parsed, body);
        this.refreshSoon();
    }

    async deleteComment(commentId: HostId): Promise<void> {
        await this.eraseComment(await this.parseForWrite(commentId, false));
        this.refreshSoon();
    }

    /**
     * Id комментария для записи: разобран и сверен с состоянием. Черновик от опубликованного
     * отличает снапшот, а не форма id: и комментарий треда (`rc:`), и абзац тела ревью (`rvb:`)
     * бывают и тем и другим. Вместе с разбором отдаётся и сам комментарий из снапшота: удалению
     * нужно знать про ответы.
     */
    private async parseForWrite(commentId: HostId, draft: boolean): Promise<CommentTarget> {
        const parsed = parseCommentId(commentId);
        if (parsed === null) {
            throw new RpcFailure('bad_request', `GitHub: непонятный id комментария ${commentId}.`);
        }

        const found = await this.findComment(commentId);
        if (found === null) {
            throw new RpcFailure('bad_request', `GitHub: комментария ${commentId} нет в обсуждениях этого PR.`);
        }
        if (found.draft !== draft) {
            throw new RpcFailure(
                'bad_request',
                draft
                    ? `GitHub: комментарий ${commentId} уже опубликован — правьте и удаляйте его как опубликованный.`
                    : `GitHub: комментарий ${commentId} ещё черновик — правьте и удаляйте его как черновик.`,
            );
        }
        return { parsed, comment: found };
    }

    /** Новый текст комментария: мутация выбирается по виду id. */
    private async writeComment(parsed: ParsedCommentId, body: string): Promise<void> {
        switch (parsed.kind) {
            case 'review-comment':
                await this.client.graphql(
                    UPDATE_REVIEW_COMMENT_MUTATION,
                    { commentId: parsed.nodeId, body },
                    commentMutationSchema,
                );
                return;
            case 'issue-comment':
                await this.client.graphql(
                    UPDATE_ISSUE_COMMENT_MUTATION,
                    { commentId: parsed.nodeId, body },
                    commentMutationSchema,
                );
                return;
            case 'review-body':
                await this.withReviewLock(() => this.writeReviewBody(parsed.nodeId, body));
                return;
            case 'review-paragraph':
                await this.rewriteParagraph(parsed.nodeId, parsed.n, body);
                return;
        }
    }

    private async eraseComment({ parsed, comment }: CommentTarget): Promise<void> {
        switch (parsed.kind) {
            case 'review-comment':
                // Корень обсуждения GitHub удаляет вместе с тредом: чужие ответы уехали бы с ним.
                if (comment.replies.length > 0) {
                    throw new RpcFailure(
                        'bad_request',
                        'GitHub удаляет обсуждение строки целиком: этот комментарий начинает обсуждение, и ответы в нём пропали бы вместе с ним. Удалите сначала ответы.',
                    );
                }
                await this.client.graphql(
                    DELETE_REVIEW_COMMENT_MUTATION,
                    { commentId: parsed.nodeId },
                    commentMutationSchema,
                );
                return;
            case 'issue-comment':
                await this.client.graphql(
                    DELETE_ISSUE_COMMENT_MUTATION,
                    { commentId: parsed.nodeId },
                    commentMutationSchema,
                );
                return;
            case 'review-body':
                throw new RpcFailure(
                    'bad_request',
                    'GitHub не умеет удалять текст ревью — его можно только переписать.',
                );
            case 'review-paragraph':
                await this.rewriteParagraph(parsed.nodeId, parsed.n, null);
                return;
        }
    }

    /** Resolve у GitHub есть только у обсуждений строк диффа: тела ревью и комментарии PR он не резолвит. */
    async setThreadResolved(threadId: HostId, resolved: boolean): Promise<void> {
        const nodeId = parseThreadId(threadId);
        if (nodeId === null) {
            throw new RpcFailure(
                'bad_request',
                'GitHub помечает решёнными только обсуждения строк диффа — обсуждение уровня PR так не закрыть.',
            );
        }

        if (resolved) {
            await this.client.graphql(RESOLVE_THREAD_MUTATION, { threadId: nodeId }, resolveThreadMutationSchema);
        } else {
            await this.client.graphql(UNRESOLVE_THREAD_MUTATION, { threadId: nodeId }, unresolveThreadMutationSchema);
        }
        this.refreshSoon();
    }

    /**
     * Публикация пакетом — один `submitPullRequestReview`: все черновики pending-ревью уезжают
     * вместе с вердиктом, частичного успеха у GitHub нет. Сабмит не прошёл — в `failed` едут все
     * черновики, вердикт не применён, а само pending-ревью остаётся для повтора.
     */
    async publishBatch(verdict: Verdict): Promise<PublishResult> {
        const parsed = verdictSchema.parse(verdict);
        if (parsed === 'sticky_ship') {
            throw new RpcFailure('bad_request', 'GitHub не умеет стики-шип: апрув действует до следующего пуша.');
        }
        const [meta, viewer] = await Promise.all([this.meta(), this.viewerUser()]);
        if (!publishVerdictsOf(meta, viewer.login).includes(parsed)) {
            throw new RpcFailure(
                'bad_request',
                'На своём PR GitHub не даёт ни одобрить, ни запросить изменения — можно опубликовать только комментарии.',
            );
        }
        const event = REVIEW_EVENTS[parsed];

        // В общей очереди с правками тела: сабмит посреди недописанного абзаца потерял бы его текст.
        const result = await this.withReviewLock(() => this.submitVerdict(event));
        this.refreshSoon();
        return result;
    }

    private async submitVerdict(event: ReviewEvent): Promise<PublishResult> {
        const tick = await this.loadTick();
        const pending = await this.pendingReviewOf(tick.reviews);
        const drafts = pending === null ? [] : draftIdsOf(tick.threads);
        // Без черновиков публиковать нечего: pending-ревью с одной заглушкой тела остаётся как есть.
        if (event === 'COMMENT' && drafts.length === 0) {
            return { publishedCommentIds: [], failed: [], verdictApplied: true };
        }
        if (pending === null) {
            const meta = await this.meta();
            await this.client.graphql(
                VERDICT_REVIEW_MUTATION,
                { pullRequestId: meta.id, commitOID: meta.headRefOid, event },
                verdictMutationSchema,
            );
            return { publishedCommentIds: [], failed: [], verdictApplied: true };
        }

        try {
            await this.client.graphql(
                SUBMIT_REVIEW_MUTATION,
                { reviewId: pending.id, event, body: publishedBodyOf(pending.body) },
                submitReviewMutationSchema,
                1,
            );
        } catch (error) {
            const message = messageOf(error);
            return {
                publishedCommentIds: [],
                failed: drafts.map((commentId) => ({ commentId, message })),
                verdictApplied: false,
            };
        }

        return { publishedCommentIds: drafts, failed: [], verdictApplied: true };
    }

    /**
     * Синхронизация «просмотрено» с GitHub. После успеха кэшированный дифф правится точечно:
     * состояние хоста известно ровно, а перечитывать список файлов ради одного флага дорого.
     */
    async setFileViewed(fileId: HostId, viewed: boolean): Promise<void> {
        const meta = await this.meta();
        await this.client.graphql(
            viewed ? MARK_FILE_VIEWED_MUTATION : UNMARK_FILE_VIEWED_MUTATION,
            { pullRequestId: meta.id, path: fileId },
            viewedMutationSchema,
        );
        await this.rememberViewed(meta.headRefOid, fileId, viewed);
    }

    /**
     * Содержимое файла по обе стороны — топливо «Expand context» (`docs/design/SPEC-elements.md §2.13`).
     * Обе стороны читаются одним запросом по адресу `<коммит>:<путь>`: старая на merge-base,
     * новая на голове ветки.
     *
     * `null` здесь — свойство самого файла (контракт `getFileContent`): двоичный, картинка или
     * слишком большой. Сорвавшийся вызов им не прикидывается — он поднимается ошибкой.
     */
    async getSourceAtRevision(filePath: string, revision: string): Promise<string | null> {
        const expression = blobExpression(revision, filePath);
        const response = await this.client.graphql(FILE_CONTENT_QUERY, {
            owner: this.owner, repo: this.repo, oldExpression: expression, newExpression: expression,
        }, fileContentResponseSchema);
        return sideTextOf(response.repository?.new ?? null) ?? null;
    }

    async getFileContent(fileId: HostId): Promise<FileContent | null> {
        const meta = await this.meta();
        const diff = await this.cachedDiff(meta);
        const file = diff.files.find((candidate) => candidate.fileId === fileId);
        if (file === undefined) {
            throw new RpcFailure('bad_request', `GitHub: файла ${fileId} нет в диффе этого PR.`);
        }
        // Картинке текстовый контекст расширять нечем — даже svg показывается карточкой.
        if (file.binary || file.image !== null) {
            return null;
        }

        const mergeBase = await this.mergeBase(meta);
        const response = await this.client.graphql(
            FILE_CONTENT_QUERY,
            {
                owner: this.owner,
                repo: this.repo,
                oldExpression: blobExpression(mergeBase, file.oldPath ?? file.path),
                newExpression: blobExpression(meta.headRefOid, file.path),
            },
            fileContentResponseSchema,
        );

        const repository = response.repository;
        if (repository === null) {
            return null;
        }
        const oldText = sideTextOf(repository.old);
        const newText = sideTextOf(repository.new);
        if (oldText === undefined || newText === undefined) {
            return null;
        }
        return { oldText, newText };
    }

    /**
     * Байты стороны картинки. `blobId` — адрес `<коммит>:<путь>`, размер известен из диффа:
     * сторона за лимитом контракта не читается вовсе, как и неизвестный адрес.
     */
    async getBlob(blobId: HostId): Promise<Uint8Array | null> {
        const parsed = parseBlobId(blobId);
        if (parsed === null) {
            return null;
        }

        let size = this.imageBlobs.get(blobId);
        if (size === undefined) {
            // Блоб мог приехать из диффа, который этот процесс ещё не читал.
            await this.cachedDiff(await this.meta());
            size = this.imageBlobs.get(blobId);
        }
        if (size === undefined || size > IMAGE_BLOB_MAX_BYTES) {
            return null;
        }

        return this.client.restBytes(`/repos/${this.owner}/${this.repo}/contents/${encodePath(parsed.path)}`, {
            query: { ref: parsed.sha },
            headers: { accept: 'application/vnd.github.raw+json' },
        });
    }

    /**
     * Линза «мои файлы» по CODEOWNERS базовой ветки. Владельцев файла называет последнее
     * совпавшее правило, зоны PR — статические границы этих правил; файл без правила и файл,
     * у которого правило сняло владение, остаются вне зон.
     *
     * Кэш — на голову ветки (пуш меняет состав диффа) и на коммит базы: база ушла вперёд —
     * владельцев мог переписать другой CODEOWNERS, а голова при этом не двигалась. Неполный
     * ответ (CODEOWNERS не прочитался, команды не назвались) в кэше не задерживается —
     * следующий вызов пробует снова.
     */
    async ownershipLens(): Promise<Lens | null> {
        const meta = await this.meta();
        const cache = this.iteration(meta.headRefOid);
        const known = cache.ownership;
        if (known?.baseRefOid === meta.baseRefOid) {
            return known.lens;
        }

        const entry: OwnershipCache = {
            baseRefOid: meta.baseRefOid,
            lens: this.loadOwnership(meta).then(
                (result) => {
                    if (result.degraded) {
                        this.forgetOwnership(cache, entry);
                    }
                    return result.value;
                },
                (error: unknown) => {
                    this.forgetOwnership(cache, entry);
                    throw error;
                },
            ),
        };
        cache.ownership = entry;
        return entry.lens;
    }

    /** Снять из кэша итерации именно эту запись: за время ответа её мог сменить другой вызов. */
    private forgetOwnership(cache: IterationCache, entry: OwnershipCache): void {
        if (cache.ownership === entry) {
            delete cache.ownership;
        }
    }

    extraLenses(): Promise<Lens[]> {
        return Promise.resolve([]);
    }

    private async loadOwnership(meta: GithubPrMeta): Promise<Degradable<Lens>> {
        let rules: readonly CodeownersRule[] | null;
        try {
            rules = await this.codeownersRules(meta.baseRefOid);
        } catch (error) {
            // Ревьюеру — фраза про файл, причина (имя запроса, код ответа) уходит в server.log.
            process.stderr.write(`sherpa-server: GitHub не отдал CODEOWNERS: ${messageOf(error)}\n`);
            return degraded(mineLens([], 'GitHub could not read the CODEOWNERS file of this repository.', null));
        }
        // Понятие владения у GitHub есть и без файла — линза выключается с объяснением, а не исчезает.
        if (rules === null) {
            return settled(mineLens([], 'This repository has no CODEOWNERS file.', null));
        }
        if (rules.length === 0) {
            return settled(mineLens([], 'CODEOWNERS has no rules.', null));
        }

        const [diff, viewer] = await Promise.all([this.cachedDiff(meta), this.viewerUser()]);
        const owned = diff.files.map((file) => ({ path: file.path, rule: ownersOf(rules, file.path) }));
        const teams = await this.myTeams(viewer.login, orgsOf(owned));

        const mine = (rule: CodeownersRule): boolean => isMine(rule, viewer.login, teams.value);
        const paths = owned.filter((entry) => entry.rule !== null && mine(entry.rule)).map((entry) => entry.path);
        // Чужие зоны остаются и без единого моего файла: ревьюер видит, кому принадлежит PR.
        const value = mineLens(paths, ownershipNote(paths.length === 0, teams.degraded), ownershipZones(owned, mine));
        return teams.degraded ? degraded(value) : settled(value);
    }

    /**
     * Правила CODEOWNERS базовой ветки; `null` — файла нет ни в одном из трёх мест.
     * Кэш — по коммиту базы: именно он решает, какой файл считает владельцев.
     */
    private codeownersRules(baseRefOid: string): Promise<readonly CodeownersRule[] | null> {
        const cached = this.codeowners;
        if (cached !== null && cached.baseRefOid === baseRefOid) {
            return cached.rules;
        }

        const entry: CodeownersCache = { baseRefOid, rules: this.loadCodeowners(baseRefOid) };
        this.codeowners = entry;
        entry.rules.catch(() => {
            // Сорвавшееся чтение в кэше не оставляем: линза деградирует только на один вызов.
            if (this.codeowners === entry) {
                this.codeowners = null;
            }
        });
        return entry.rules;
    }

    private async loadCodeowners(baseRefOid: string): Promise<readonly CodeownersRule[] | null> {
        const response = await this.client.graphql(
            CODEOWNERS_QUERY,
            {
                owner: this.owner,
                repo: this.repo,
                githubDir: blobExpression(baseRefOid, CODEOWNERS_PATHS.githubDir),
                root: blobExpression(baseRefOid, CODEOWNERS_PATHS.root),
                docsDir: blobExpression(baseRefOid, CODEOWNERS_PATHS.docsDir),
            },
            codeownersResponseSchema,
        );
        const repository = response.repository;
        if (repository === null) {
            throw this.prNotFound();
        }

        // Порядок мест — тот же, что у GitHub: побеждает первый найденный файл.
        const text = repository.githubDir?.text ?? repository.root?.text ?? repository.docsDir?.text ?? null;
        return text === null ? null : parseCodeowners(text);
    }

    /**
     * Команды ревьюера в организациях владельцев — множество `org/slug` в нижнем регистре.
     * Кэш живёт весь век хоста: PR один и ревьюер один. Неполный ответ (нет скоупа `read:org`,
     * организация не видна) не кэшируется.
     */
    private myTeams(viewer: string, orgs: readonly string[]): Promise<Degradable<ReadonlySet<string>>> {
        if (orgs.length === 0) {
            return Promise.resolve(settled<ReadonlySet<string>>(new Set()));
        }

        const key = [...orgs].sort().join(',');
        const cached = this.teams.get(key);
        if (cached !== undefined) {
            return cached;
        }

        const pending = this.loadMyTeams(viewer, orgs);
        this.teams.set(key, pending);
        void pending.then(
            (result) => {
                if (result.degraded) {
                    this.teams.delete(key);
                }
            },
            () => {
                this.teams.delete(key);
            },
        );
        return pending;
    }

    /**
     * Команды всех организаций одним запросом с алиасами; страницы дочитываются тем же запросом
     * по оставшимся организациям. Отказ — деградация, а не ошибка: линза строится по логинам.
     */
    private async loadMyTeams(viewer: string, orgs: readonly string[]): Promise<Degradable<ReadonlySet<string>>> {
        const teams = new Set<string>();
        let pending = orgs.map((org, index) => ({ alias: `o${String(index)}`, org, after: null as string | null }));
        let degradedAnswer = false;

        for (let page = 0; pending.length > 0 && page < MAX_TEAM_PAGES; page += 1) {
            const aliases = pending.map((entry) => entry.alias);
            const variables: Record<string, unknown> = { viewer };
            for (const entry of pending) {
                variables[entry.alias] = entry.org;
                variables[`${entry.alias}After`] = entry.after;
            }

            let response: Record<string, GithubOrgTeams>;
            try {
                response = await this.client.graphql(
                    orgTeamsQuery(aliases),
                    variables,
                    orgTeamsResponseSchema(aliases),
                );
            } catch (error) {
                process.stderr.write(
                    `sherpa-server: GitHub не назвал команды ревьюера: ${messageOf(error)}; владение считается по логинам\n`,
                );
                return degraded(teams);
            }

            const next: typeof pending = [];
            for (const entry of pending) {
                const node = response[entry.alias] ?? null;
                if (node === null) {
                    // Организация не видна токену — её команды моими не считаются.
                    degradedAnswer = true;
                    continue;
                }
                for (const team of compact(node.teams.nodes)) {
                    teams.add(`${entry.org}/${team.slug}`.toLowerCase());
                }
                if (node.teams.pageInfo.hasNextPage) {
                    next.push({ ...entry, after: node.teams.pageInfo.endCursor });
                }
            }
            pending = next;
        }

        return pending.length > 0 || degradedAnswer ? degraded(teams) : settled(teams);
    }

    private toPrMeta(meta: GithubPrMeta, viewer: ReviewUser): PrMeta {
        const headOwner = meta.headRepositoryOwner?.login ?? null;
        return {
            id: String(meta.number),
            url: meta.url,
            title: meta.title,
            author: userOf(meta.author),
            // Ветка из форка называется владельцем: в своём репозитории он только шумел бы.
            fromBranch:
                headOwner === null || headOwner === this.owner ? meta.headRefName : `${headOwner}:${meta.headRefName}`,
            toBranch: meta.baseRefName,
            state: meta.merged ? 'merged' : meta.state === 'OPEN' ? 'open' : 'closed',
            // Статус словами GitHub: UI показывает его как есть (контракт `statusLabel`).
            statusLabel: meta.isDraft ? 'draft' : meta.state.toLowerCase(),
            checks: checksOf(meta),
            updatedAt: isoTime(meta.updatedAt),
            capabilities: { ...CAPABILITIES, publishVerdicts: publishVerdictsOf(meta, viewer.login) },
            verdicts: verdictsOf(meta),
            viewer,
        };
    }

    /**
     * Шапка PR из кэша. Запись живёт, пока тик опроса её подтверждает: без поллера кэша нет —
     * контракт обещает, что после пуша `getDiff` отдаёт новую голову и без подписок.
     */
    private meta(): Promise<GithubPrMeta> {
        const cached = this.metaCache;
        if (cached !== null && this.pollTimer !== null && Date.now() - cached.confirmedAt < this.pollIntervalMs) {
            return cached.promise;
        }

        const entry: MetaCache = { promise: this.fetchMeta(), headRefOid: null, confirmedAt: Date.now() };
        this.metaCache = entry;
        entry.promise.then(
            (meta) => {
                entry.headRefOid = meta.headRefOid;
            },
            () => {
                if (this.metaCache === entry) {
                    this.metaCache = null;
                }
            },
        );
        return entry.promise;
    }

    private async fetchMeta(): Promise<GithubPrMeta> {
        const response = await this.client.graphql(
            PR_QUERY,
            { owner: this.owner, repo: this.repo, number: this.number },
            prResponseSchema,
        );
        const pr = response.repository?.pullRequest ?? null;
        if (pr === null) {
            throw this.prNotFound();
        }
        return pr;
    }

    /** Тик опроса освежает шапку: отдельный запрос за ней после этого не нужен. */
    private rememberMeta(meta: GithubPrMeta): void {
        this.metaCache = { promise: Promise.resolve(meta), headRefOid: meta.headRefOid, confirmedAt: Date.now() };
    }

    /**
     * Владелец токена целиком — личность ревьюера в шапке PR (`PrMeta.viewer`). Ошибка отсюда
     * поднимается наружу: `capabilities.editPublished` у этого хоста поднят всегда, а он держится
     * на известной личности — без неё «своё» не с чем сверить, и шапка была бы ложной.
     */
    private viewerUser(): Promise<ReviewUser> {
        this.viewer ??= this.client.graphql(VIEWER_QUERY, {}, viewerResponseSchema).then(
            (response) => ({
                login: response.viewer.login,
                displayName: response.viewer.name ?? null,
                // `viewer` — владелец токена Шерпы: ревьюит человек, а не бот.
                bot: false,
                avatarUrl: avatarOf(response.viewer.avatarUrl),
            }),
            (error: unknown) => {
                // Сорвавшийся ответ в кэше не оставляем: следующий вызов спросит заново.
                this.viewer = null;
                throw new RpcFailure('host_unavailable', `GitHub не назвал владельца токена: ${messageOf(error)}`);
            },
        );
        return this.viewer;
    }

    /**
     * Логин владельца токена; null — `viewer` не ответил. Мягкий вариант для опроса и поиска
     * pending-ревью: там незнание личности только ухудшает разметку черновиков, а не врёт о правах.
     */
    private viewerLogin(): Promise<string | null> {
        return this.viewerUser().then(
            (user) => user.login,
            (error: unknown) => {
                process.stderr.write(`sherpa-server: ${messageOf(error)}\n`);
                return null;
            },
        );
    }

    /** Всё состояние PR одним запросом: шапка, треды диффа, ревью и комментарии уровня PR. */
    private async loadTick(): Promise<TickSnapshot> {
        const [viewer, response] = await Promise.all([
            this.viewerLogin(),
            this.client.graphql(
                TICK_QUERY,
                { owner: this.owner, repo: this.repo, number: this.number, threadCursor: null },
                tickResponseSchema,
            ),
        ]);

        const pr = response.repository?.pullRequest ?? null;
        if (pr === null) {
            throw this.prNotFound();
        }

        const threadNodes = compact(pr.reviewThreads.nodes);
        let page = pr.reviewThreads.pageInfo;
        while (page.hasNextPage) {
            const next = await this.client.graphql(
                THREADS_PAGE_QUERY,
                { owner: this.owner, repo: this.repo, number: this.number, threadCursor: page.endCursor },
                threadsPageResponseSchema,
            );
            const connection = next.repository?.pullRequest?.reviewThreads;
            if (connection === undefined) {
                break;
            }
            threadNodes.push(...compact(connection.nodes));
            page = connection.pageInfo;
        }

        const threads = await Promise.all(threadNodes.map((thread) => this.withAllComments(thread)));
        const reviews = compact(pr.reviews.nodes);
        return {
            meta: pr,
            reviews,
            threads: buildThreads({ threads, reviews, comments: compact(pr.comments.nodes), viewer }),
        };
    }

    /** Тред глубже десяти ответов: дочитываем комментарии, иначе ответы молча пропадут. */
    private async withAllComments(thread: GithubReviewThread): Promise<GithubReviewThread> {
        if (!thread.comments.pageInfo.hasNextPage) {
            return thread;
        }

        const nodes = compact(thread.comments.nodes);
        let page = thread.comments.pageInfo;
        while (page.hasNextPage) {
            const next = await this.client.graphql(
                THREAD_COMMENTS_QUERY,
                { threadId: thread.id, commentCursor: page.endCursor },
                threadCommentsResponseSchema,
            );
            const connection = next.node?.comments;
            if (connection === undefined) {
                break;
            }
            nodes.push(...compact(connection.nodes));
            page = connection.pageInfo;
        }
        return { ...thread, comments: { pageInfo: { hasNextPage: false, endCursor: null }, nodes } };
    }

    private async cachedDiff(meta: GithubPrMeta): Promise<PrDiff> {
        const cache = this.iteration(meta.headRefOid);
        cache.diff ??= this.loadDiff(meta).catch((error: unknown) => {
            this.forget(cache);
            throw error;
        });
        return cache.diff;
    }

    private async loadDiff(meta: GithubPrMeta): Promise<PrDiff> {
        const [files, viewed, mergeBase] = await Promise.all([
            this.client.restList(`/repos/${this.owner}/${this.repo}/pulls/${String(this.number)}/files`, restFilesSchema, {
                query: { per_page: 100 },
            }),
            this.loadViewed(),
            this.mergeBase(meta),
        ]);

        if (files.length >= MAX_PR_FILES) {
            throw new RpcFailure(
                'host_unavailable',
                `GitHub отдаёт не больше ${String(MAX_PR_FILES)} файлов PR, а этот не меньше — дифф был бы неполным.`,
            );
        }

        const [sizes, binaries] = await Promise.all([
            this.loadImageSizes(files, meta.headRefOid, mergeBase),
            this.loadBinaryFlags(files, meta.headRefOid, mergeBase),
        ]);
        return {
            diffId: meta.headRefOid,
            baseCommit: mergeBase,
            headCommit: meta.headRefOid,
            files: files.map((file) => this.toFileDiff(file, meta.headRefOid, mergeBase, viewed, sizes, binaries)),
        };
    }

    private toFileDiff(
        file: GithubRestFile,
        headRefOid: string,
        mergeBase: string,
        viewed: ReadonlyMap<string, boolean>,
        sizes: ReadonlyMap<string, number>,
        binaries: ReadonlySet<string>,
    ): FileDiff {
        const path = file.filename;
        const changeType = CHANGE_TYPES[file.status] ?? 'modify';
        const patch = file.patch ?? null;

        return {
            fileId: path,
            path,
            oldPath: file.previous_filename ?? null,
            changeType,
            // Двоичность известна только у файлов без патча — остальных в списке нет.
            binary: binaries.has(path),
            // Понятия «файл исключён из ревью» у GitHub нет: CODEOWNERS говорит о владельцах, не о ревью.
            generated: false,
            additions: file.additions,
            deletions: file.deletions,
            patch,
            viewed: viewed.get(path) ?? false,
            blameUrl:
                changeType === 'delete' ? null : `${WEB_BASE_URL}/${this.owner}/${this.repo}/blame/${headRefOid}/${encodePath(path)}`,
            hostFileUrl: `${WEB_BASE_URL}/${this.owner}/${this.repo}/pull/${String(this.number)}/files#diff-${sha256(path)}`,
            image: imageOf(file, changeType, headRefOid, mergeBase, sizes),
        };
    }

    /** Отметки «просмотрено»: в REST-списке файлов их нет, они живут только в GraphQL. */
    private async loadViewed(): Promise<Map<string, boolean>> {
        const viewed = new Map<string, boolean>();
        let cursor: string | null = null;

        for (;;) {
            const response: GithubFilesResponse = await this.client.graphql(
                FILES_QUERY,
                { owner: this.owner, repo: this.repo, number: this.number, fileCursor: cursor },
                filesResponseSchema,
            );
            const connection = response.repository?.pullRequest?.files;
            if (connection === undefined) {
                return viewed;
            }
            for (const node of compact(connection.nodes)) {
                viewed.set(node.path, node.viewerViewedState === 'VIEWED');
            }
            if (!connection.pageInfo.hasNextPage) {
                return viewed;
            }
            cursor = connection.pageInfo.endCursor;
        }
    }

    /**
     * Размеры сторон картинок одним запросом с алиасами: без размера контракт `ImageSide`
     * не собрать, а поштучные запросы стоили бы по очку на сторону.
     */
    private async loadImageSizes(
        files: readonly GithubRestFile[],
        headRefOid: string,
        mergeBase: string,
    ): Promise<Map<string, number>> {
        const expressions = new Map<string, string>();
        for (const file of files) {
            if (imageMimeOf(file.filename) === null) {
                continue;
            }
            const changeType = CHANGE_TYPES[file.status] ?? 'modify';
            if (changeType !== 'add') {
                const before = blobExpression(mergeBase, file.previous_filename ?? file.filename);
                expressions.set(before, before);
            }
            if (changeType !== 'delete') {
                const after = blobExpression(headRefOid, file.filename);
                expressions.set(after, after);
            }
        }

        const sizes = new Map<string, number>();
        if (expressions.size === 0) {
            return sizes;
        }

        const blobIds = [...expressions.keys()];
        const aliases = blobIds.map((_, index) => `b${String(index)}`);
        const variables: Record<string, unknown> = { owner: this.owner, repo: this.repo };
        aliases.forEach((alias, index) => {
            variables[alias] = blobIds[index];
        });

        const response = await this.client.graphql(blobSizesQuery(aliases), variables, blobAliasesResponseSchema);
        const repository = response.repository;
        if (repository === null) {
            return sizes;
        }
        aliases.forEach((alias, index) => {
            const blobId = blobIds[index];
            const byteSize = repository[alias]?.byteSize;
            if (blobId !== undefined && byteSize !== undefined) {
                sizes.set(blobId, byteSize);
                this.imageBlobs.set(blobId, byteSize);
            }
        });
        return sizes;
    }

    /**
     * Двоичные среди файлов, которым REST не отдал патча. Признака двоичности в списке файлов нет,
     * а по статистике его не вывести: у чистого переименования она нулевая, как у двоичного, — и
     * обычный `.ts` уезжал бы в UI строкой «двоичный файл не показан». Поэтому спрашиваем сам блоб:
     * у удалённого файла — старую сторону на merge-base, у остальных — новую на голове ветки.
     *
     * Запрос один на весь дифф и только при наличии таких файлов. Блоб не нашёлся или запрос
     * сорвался — файл считается текстовым: текстовый без патча честнее ложного двоичного.
     */
    private async loadBinaryFlags(
        files: readonly GithubRestFile[],
        headRefOid: string,
        mergeBase: string,
    ): Promise<Set<string>> {
        const binary = new Set<string>();
        const asked = files
            .filter((file) => file.patch === undefined)
            .map((file, index) => ({
                alias: `b${String(index)}`,
                path: file.filename,
                expression:
                    (CHANGE_TYPES[file.status] ?? 'modify') === 'delete'
                        ? blobExpression(mergeBase, file.previous_filename ?? file.filename)
                        : blobExpression(headRefOid, file.filename),
            }));
        if (asked.length === 0) {
            return binary;
        }

        const variables: Record<string, unknown> = { owner: this.owner, repo: this.repo };
        for (const entry of asked) {
            variables[entry.alias] = entry.expression;
        }

        const blobs = await this.client
            .graphql(
                blobBinaryQuery(asked.map((entry) => entry.alias)),
                variables,
                blobAliasesResponseSchema,
            )
            .then(
                (response) => response.repository,
                (error: unknown) => {
                    process.stderr.write(
                        `sherpa-server: GitHub не сказал, двоичные ли файлы без патча: ${messageOf(error)}\n`,
                    );
                    return null;
                },
            );
        if (blobs === null) {
            return binary;
        }

        for (const entry of asked) {
            if (blobs[entry.alias]?.isBinary === true) {
                binary.add(entry.path);
            }
        }
        return binary;
    }

    /** База сравнения: GraphQL merge-base не отдаёт, это единственная ручка REST ради него. */
    private mergeBase(meta: GithubPrMeta): Promise<string> {
        const cache = this.iteration(meta.headRefOid);
        cache.mergeBase ??= this.client
            .rest(
                `/repos/${this.owner}/${this.repo}/compare/${meta.baseRefOid}...${meta.headRefOid}`,
                compareSchema,
            )
            .then((response) => response.merge_base_commit.sha)
            .catch((error: unknown) => {
                this.forget(cache);
                throw error;
            });
        return cache.mergeBase;
    }

    /**
     * Отметка «просмотрено» в кэшированном диффе. Файлы пересобираются, а не правятся на месте:
     * ранее отданный наружу `PrDiff` мутировать нельзя.
     */
    private async rememberViewed(headRefOid: string, fileId: HostId, viewed: boolean): Promise<void> {
        const cache = this.cache;
        if (cache?.headRefOid !== headRefOid || cache.diff === undefined) {
            return;
        }

        const pending = cache.diff;
        const current = await pending.catch(() => null);
        // Пока ждали, голова могла сдвинуться, а дифф — выпасть из кэша: чинить тогда нечего.
        if (current === null || cache.diff !== pending) {
            return;
        }
        const files = current.files.map((file) => (file.fileId === fileId ? { ...file, viewed } : file));
        cache.diff = Promise.resolve({ ...current, files });
    }

    /** Pending-ревью владельца токена; null — его нет, и первый черновик заведёт своё. */
    private async pendingReviewOf(reviews: readonly GithubReview[]): Promise<GithubReview | null> {
        const viewer = await this.viewerLogin();
        return (
            reviews.find(
                (review) => review.state === 'PENDING' && (viewer === null || review.author?.login === viewer),
            ) ?? null
        );
    }

    /**
     * Запись в pending-ревью по одной за раз. Очередь — цепочка промисов: упавшая запись
     * следующую не роняет, но и не пускает её вперёд себя.
     */
    private withReviewLock<T>(action: () => Promise<T>): Promise<T> {
        const result = this.reviewWrites.then(action);
        // Очередь хранит порядок, но не отказ: упавшая запись следующую не роняет.
        this.reviewWrites = result.catch(() => null);
        return result;
    }

    /** Pending-ревью для записи: нет — заводим лениво на текущей голове ветки. */
    private ensurePendingReview(): Promise<GithubReview> {
        return this.withReviewLock(() => this.ensurePendingReviewUnderLock());
    }

    /**
     * То же, но для вызовов, которые уже держат очередь записей. Заведённое здесь ревью всегда
     * с непустым телом: GitHub не даёт дописать тело ревью, созданного без него.
     */
    private async ensurePendingReviewUnderLock(): Promise<GithubReview> {
        const tick = await this.loadTick();
        const existing = await this.pendingReviewOf(tick.reviews);
        if (existing !== null) {
            return existing;
        }

        const meta = await this.meta();
        const response = await this.client.graphql(
            CREATE_REVIEW_MUTATION,
            { pullRequestId: meta.id, commitOID: meta.headRefOid, body: BODY_PLACEHOLDER },
            reviewMutationSchema,
            1,
        );
        const created = response.addPullRequestReview?.pullRequestReview ?? null;
        if (created === null) {
            throw new RpcFailure('host_unavailable', 'GitHub не завёл черновик ревью для этого PR.');
        }
        return created;
    }

    private async createThreadDraft(anchor: FileAnchor, body: string): Promise<Comment> {
        const review = await this.ensurePendingReview();
        const position = anchor.position;
        const side = position?.side === 'old' ? 'LEFT' : 'RIGHT';
        const multiline = position !== null && position.size > 1;

        return this.createWithDedup(
            async () => {
                const response = await this.client.graphql(
                    ADD_REVIEW_THREAD_MUTATION,
                    {
                        reviewId: review.id,
                        path: anchor.path,
                        body,
                        line: position === null ? null : position.line + position.size - 1,
                        side: position === null ? null : side,
                        startLine: multiline ? position.line : null,
                        startSide: multiline ? side : null,
                        subjectType: position === null ? 'FILE' : 'LINE',
                    },
                    addReviewThreadMutationSchema,
                    1,
                );
                const node = compact(response.addPullRequestReviewThread?.thread?.comments.nodes ?? null)[0];
                if (node === undefined) {
                    throw new RpcFailure('host_unavailable', 'GitHub не вернул созданный комментарий.');
                }
                return toDiffComment(node);
            },
            async () => {
                const threads = (await this.loadTick()).threads;
                const found = threads.find(
                    (thread) =>
                        thread.anchor?.path === anchor.path &&
                        thread.root.draft &&
                        thread.root.body === body &&
                        samePosition(thread.anchor.position, position),
                );
                return found?.root ?? null;
            },
        );
    }

    /**
     * Ответ черновиком. В тред диффа GitHub отвечает своей мутацией (дерева у него нет — ответы
     * плоские); «ответ» в черновик уровня PR — это ещё один абзац тела pending-ревью.
     */
    private async createReply(parentId: HostId, body: string): Promise<Comment> {
        const tick = await this.loadTick();
        const owner = threadOfComment(tick.threads, parentId);
        if (owner === null) {
            throw new RpcFailure('bad_request', `GitHub: комментария ${parentId} нет в обсуждениях этого PR.`);
        }

        const threadNodeId = parseThreadId(owner.id);
        if (threadNodeId === null) {
            if (!owner.root.draft) {
                throw new RpcFailure(
                    'bad_request',
                    'GitHub не умеет отвечать на опубликованное обсуждение уровня PR черновиком — напишите новый комментарий.',
                );
            }
            return this.createBodyDraft(body);
        }

        const review = await this.ensurePendingReview();
        return this.createWithDedup(
            async () => {
                const response = await this.client.graphql(
                    ADD_REVIEW_THREAD_REPLY_MUTATION,
                    { reviewId: review.id, threadId: threadNodeId, body },
                    addReviewThreadReplyMutationSchema,
                    1,
                );
                const comment = response.addPullRequestReviewThreadReply?.comment ?? null;
                if (comment === null) {
                    throw new RpcFailure('host_unavailable', 'GitHub не вернул созданный ответ.');
                }
                return toDiffComment(comment);
            },
            async () => {
                const threads = (await this.loadTick()).threads;
                const thread = threads.find((candidate) => candidate.id === owner.id);
                return thread?.root.replies.find((reply) => reply.draft && reply.body === body) ?? null;
            },
        );
    }

    /**
     * Черновик уровня PR — абзац тела pending-ревью: другого места для него у GitHub нет.
     * Чтение тела, добавление абзаца и запись идут одной операцией очереди: иначе соседний
     * черновик, начавшийся с тем же телом, получил бы тот же номер абзаца и затёр этот.
     */
    private createBodyDraft(body: string): Promise<Comment> {
        return this.withReviewLock(async () => {
            const review = await this.ensurePendingReviewUnderLock();
            if (review.body === '') {
                // Чужое незавершённое ревью, заведённое без тела: дописать его GitHub уже не даст.
                throw new RpcFailure(
                    'bad_request',
                    'GitHub: на этом PR уже начато ревью с пустым текстом, а дописывать текст в такое ревью GitHub не разрешает. Отправьте или удалите это незавершённое ревью на GitHub и повторите — комментарии к строкам при этом работают как обычно.',
                );
            }

            return this.createWithDedup(
                async () => {
                    const next = appendParagraph(review.body, body);
                    const saved = await this.writeReviewBody(review.id, next.body);
                    return {
                        id: reviewParagraphId(review.id, next.n),
                        author: userOf(saved.author),
                        body,
                        draft: true,
                        issue: null,
                        resolved: null,
                        createdAt: isoTime(saved.createdAt),
                        editedAt: saved.lastEditedAt === null ? null : isoTime(saved.lastEditedAt),
                        replies: [],
                    };
                },
                async () => {
                    // Сверка только среди абзацев этого же ревью: черновик строки с тем же текстом —
                    // обычное дело, и принять его за абзац тела значило бы править потом не тот.
                    const threads = (await this.loadTick()).threads;
                    return findCommentIn(
                        threads,
                        (comment) =>
                            comment.draft && comment.body === body && isReviewParagraphOf(comment.id, review.id),
                    );
                },
            );
        });
    }

    /**
     * Создание с проверкой на дубль: ретраить мутацию вслепую нельзя — сорвавшийся ответ мог
     * означать успешную запись. Поэтому попытка одна, а после неё адаптер перечитывает состояние
     * и признаёт комментарий, если он всё-таки завёлся.
     */
    private async createWithDedup(
        create: () => Promise<Comment>,
        find: () => Promise<Comment | null>,
    ): Promise<Comment> {
        try {
            return await create();
        } catch (error) {
            const existing = await find().catch(() => null);
            if (existing !== null) {
                return existing;
            }
            throw error;
        }
    }

    private async writeReviewBody(reviewId: string, body: string): Promise<GithubReview> {
        const response = await this.client.graphql(
            UPDATE_REVIEW_BODY_MUTATION,
            { reviewId, body },
            updateReviewBodyMutationSchema,
            1,
        );
        const saved = response.updatePullRequestReview?.pullRequestReview ?? null;
        if (saved === null) {
            throw new RpcFailure('host_unavailable', 'GitHub не подтвердил запись текста ревью.');
        }
        return saved;
    }

    /**
     * Правка или удаление одного абзаца тела ревью; `null` вместо текста — удаление.
     * Чтение и запись — одна операция очереди: соседний абзац пишется тем же телом целиком.
     */
    private rewriteParagraph(reviewId: string, n: number, text: string | null): Promise<void> {
        return this.withReviewLock(async () => {
            const response = await this.client.graphql(
                REVIEW_BODY_QUERY,
                { reviewId },
                reviewBodyResponseSchema,
            );
            const review = response.node;
            if (review === null) {
                throw new RpcFailure('bad_request', 'GitHub: такого ревью в этом PR нет.');
            }

            const next =
                text === null ? removeParagraph(review.body, n) : replaceParagraph(review.body, n, text);
            if (next === null) {
                throw new RpcFailure('bad_request', 'GitHub: этого комментария больше нет в тексте ревью.');
            }
            await this.writeReviewBody(reviewId, next);
        });
    }

    private async findComment(commentId: HostId): Promise<Comment | null> {
        const threads = (await this.loadTick()).threads;
        return findCommentIn(threads, (comment) => comment.id === commentId);
    }

    /** Запись состоялась — подписчикам нужен свежий снапшот, а не ожидание целого тика. */
    private refreshSoon(): void {
        void this.pollTick();
    }

    /**
     * Общий поллер: один таймер и один GraphQL-запрос на тик для всех подписчиков.
     * Поллинг стартует с первым подписчиком и гаснет с последним; ошибка тика подписку не роняет.
     */
    private subscribePoll(handler: PollHandler): () => void {
        const subscription: PollSubscription = { handler, stopped: false, served: false };
        this.pollSubscriptions.add(subscription);

        if (this.pollTimer === null) {
            const timer = setInterval(() => {
                void this.pollTick();
            }, this.pollIntervalMs);
            // Таймер адаптера процесс живым не держит и активностью сервера не считается (см. idle.ts).
            timer.unref();
            this.pollTimer = timer;
        }
        void this.pollTick();

        return () => {
            if (subscription.stopped) {
                return;
            }
            subscription.stopped = true;
            this.pollSubscriptions.delete(subscription);
            if (this.pollSubscriptions.size === 0 && this.pollTimer !== null) {
                clearInterval(this.pollTimer);
                this.pollTimer = null;
            }
        };
    }

    private async pollTick(): Promise<void> {
        if (this.polling) {
            // Тик уже в пути: он мог начаться до записи, поэтому за ним обязан пойти ещё один.
            this.tickRequested = true;
            return;
        }
        if (this.pollSubscriptions.size === 0) {
            return;
        }

        this.polling = true;
        try {
            let tick: TickSnapshot | null = null;
            try {
                tick = await this.loadTick();
                this.rememberMeta(tick.meta);
            } catch (error) {
                // Следующий тик повторит: сеть моргнула — подписки не должны умирать.
                process.stderr.write(`sherpa-server: поллинг GitHub: ${messageOf(error)}\n`);
            }

            for (const subscription of [...this.pollSubscriptions]) {
                if (subscription.stopped) {
                    continue;
                }
                subscription.served = true;
                try {
                    await subscription.handler(tick, () => !subscription.stopped);
                } catch (error) {
                    process.stderr.write(`sherpa-server: поллинг GitHub: ${messageOf(error)}\n`);
                }
            }
        } finally {
            this.polling = false;
        }

        // Подписка, пришедшая во время тика, и запись, случившаяся тогда же, ждать интервал не должны.
        const requested = this.tickRequested;
        this.tickRequested = false;
        if (requested || [...this.pollSubscriptions].some((subscription) => !subscription.served)) {
            void this.pollTick();
        }
    }

    private iteration(headRefOid: string): IterationCache {
        if (this.cache?.headRefOid !== headRefOid) {
            this.cache = { headRefOid };
        }
        return this.cache;
    }

    /** Провалившееся обещание в кэше не оставляем: следующий вызов должен попробовать заново. */
    private forget(cache: IterationCache): void {
        if (this.cache === cache) {
            this.cache = null;
        }
    }

    private prNotFound(): RpcFailure {
        return new RpcFailure(
            'host_unavailable',
            `GitHub не отдал PR ${this.owner}/${this.repo}#${String(this.number)}: его нет или токен его не видит.`,
        );
    }
}

/** Сводный статус проверок: у GitHub он живёт на последнем коммите ветки. */
function checksOf(meta: GithubPrMeta): PrChecks | null {
    const state = compact(meta.commits.nodes)[0]?.commit.statusCheckRollup?.state ?? null;
    switch (state) {
        case 'SUCCESS':
            return 'passed';
        case 'FAILURE':
        case 'ERROR':
            return 'failed';
        case 'PENDING':
        case 'EXPECTED':
            return 'pending';
        default:
            return null;
    }
}

/** Событие `submitPullRequestReview` на режим публикации; стики-шипа у GitHub нет. */
type ReviewEvent = 'COMMENT' | 'APPROVE' | 'REQUEST_CHANGES';

const REVIEW_EVENTS: Readonly<Record<Exclude<Verdict, 'sticky_ship'>, ReviewEvent>> = {
    comment: 'COMMENT',
    ship: 'APPROVE',
    request_changes: 'REQUEST_CHANGES',
};

/**
 * Режимы публикации на этом PR. Автору GitHub запрещает и апрув, и запрос правок — на своём PR
 * остаётся только ревью без вердикта. Стики-шипа у GitHub нет: апрув снимается новым ревью, а не
 * живёт сквозь пуши.
 */
function publishVerdictsOf(meta: GithubPrMeta, viewerLogin: string): Exclude<Verdict, 'sticky_ship'>[] {
    const own = meta.author !== null && meta.author.login.toLowerCase() === viewerLogin.toLowerCase();
    return own ? ['comment'] : ['comment', 'ship', 'request_changes'];
}

/**
 * Вердикты из «последних значащих ревью»: апрув и запрос правок. Прочие состояния
 * (`COMMENTED`, `DISMISSED`) вердикта не несут — врать «отшипил» из-за комментария нельзя.
 */
function verdictsOf(meta: GithubPrMeta): ReviewerVerdict[] {
    const verdicts: ReviewerVerdict[] = [];
    for (const review of compact(meta.latestOpinionatedReviews?.nodes ?? null)) {
        const author = review.author;
        if (author === null) {
            continue;
        }
        if (review.state === 'APPROVED') {
            verdicts.push({ user: userOf(author), verdict: 'ship' });
        } else if (review.state === 'CHANGES_REQUESTED') {
            verdicts.push({ user: userOf(author), verdict: 'request_changes' });
        }
    }
    return verdicts;
}

/** Ответ полон — его можно кэшировать до конца итерации. */
function settled<T>(value: T): Degradable<T> {
    return { value, degraded: false };
}

/** Ответ неполон из-за сорвавшейся ручки: значение отдаём, но кэшировать его нельзя. */
function degraded<T>(value: T): Degradable<T> {
    return { value, degraded: true };
}

/** Линза «мои файлы»: пустая приходит выключенной с объяснением, зоны при этом остаются. */
function mineLens(paths: readonly string[], note: string | null, zones: readonly LensZone[] | null): Lens {
    return {
        id: 'mine',
        label: 'My files',
        paths: [...paths],
        available: paths.length > 0,
        note,
        zones: zones === null ? null : zones.map((zone) => ({ ...zone, paths: [...zone.paths] })),
    };
}

/** Текст `note`: почему линза пуста и почему её ответ неполон — обе причины ревьюеру видны. */
function ownershipNote(empty: boolean, teamsDegraded: boolean): string | null {
    const reason = empty ? 'No files of this PR are in your CODEOWNERS zones.' : null;
    if (!teamsDegraded) {
        return reason;
    }
    return reason === null ? TEAMS_UNKNOWN_NOTE : `${reason} ${TEAMS_UNKNOWN_NOTE}`;
}

/** Владелец — это я: мой логин без учёта регистра либо команда, в которой я состою. */
function isMine(rule: CodeownersRule, login: string, teams: ReadonlySet<string>): boolean {
    return rule.owners.some((owner) => {
        // Владелец-почта: чей это ящик, GitHub не говорит — своим он не считается никогда.
        if (!owner.startsWith('@')) {
            return false;
        }
        const name = owner.slice(1).toLowerCase();
        return name.includes('/') ? teams.has(name) : name === login.toLowerCase();
    });
}

/** Организации команд-владельцев, по одной записи на организацию без учёта регистра. */
function orgsOf(owned: readonly { readonly rule: CodeownersRule | null }[]): string[] {
    const orgs = new Map<string, string>();
    for (const entry of owned) {
        for (const owner of entry.rule?.owners ?? []) {
            const [org, slug] = owner.startsWith('@') ? owner.slice(1).split('/') : [];
            if (org !== undefined && org !== '' && slug !== undefined && slug !== '') {
                orgs.set(org.toLowerCase(), org);
            }
        }
    }
    return [...orgs.values()];
}

/**
 * Зоны PR: файл лежит ровно в одной — правило у него одно. Ключ зоны — граница, «моё» и
 * владелец: одну границу разные правила делят по владельцам.
 */
function ownershipZones(
    owned: readonly { readonly path: string; readonly rule: CodeownersRule | null }[],
    mine: (rule: CodeownersRule) => boolean,
): LensZone[] {
    const zones = new Map<string, LensZone>();

    for (const { path, rule } of owned) {
        // Непокрытый файл и файл, у которого правило сняло владение, — вне зон: их группирует UI.
        if (rule === null || rule.owners.length === 0) {
            continue;
        }
        const zone = { path: zonePathOf(rule, path), mine: mine(rule), owner: ownerLabel(rule) };
        const key = JSON.stringify([zone.path, zone.mine, zone.owner]);
        const existing = zones.get(key);
        if (existing === undefined) {
            zones.set(key, { ...zone, paths: [path] });
        } else {
            existing.paths.push(path);
        }
    }

    return [...zones.values()].sort(compareZones);
}

/** Подпись чипа зоны — первый владелец правила без `@`: `org/team`, логин или почта как есть. */
function ownerLabel(rule: CodeownersRule): string | null {
    const owner = rule.owners[0];
    if (owner === undefined) {
        return null;
    }
    return owner.startsWith('@') ? owner.slice(1) : owner;
}

/** Порядок зон детерминированный: по границе, затем по «моё» и владельцу. */
function compareZones(left: LensZone, right: LensZone): number {
    if (left.path !== right.path) {
        return left.path < right.path ? -1 : 1;
    }
    if (left.mine !== right.mine) {
        return left.mine ? -1 : 1;
    }
    const leftOwner = left.owner ?? '';
    const rightOwner = right.owner ?? '';
    if (leftOwner === rightOwner) {
        return 0;
    }
    return leftOwner < rightOwner ? -1 : 1;
}

/** Картинка файла: тип по расширению, стороны — адреса блобов по обе стороны диффа. */
function imageOf(
    file: GithubRestFile,
    changeType: FileDiff['changeType'],
    headRefOid: string,
    mergeBase: string,
    sizes: ReadonlyMap<string, number>,
): FileImage | null {
    const mime = imageMimeOf(file.filename);
    if (mime === null) {
        return null;
    }

    const before =
        changeType === 'add'
            ? null
            : sideOf(blobExpression(mergeBase, file.previous_filename ?? file.filename), sizes);
    const after = changeType === 'delete' ? null : sideOf(blobExpression(headRefOid, file.filename), sizes);
    return before === null && after === null ? null : { mime, before, after };
}

/** Сторона без известного размера наружу не едет: `size` — часть контракта `ImageSide`. */
function sideOf(blobId: string, sizes: ReadonlyMap<string, number>): ImageSide | null {
    const size = sizes.get(blobId);
    return size === undefined ? null : { blobId, size };
}

/** Блоб GraphQL в том объёме, в каком его запрашивает адаптер. */
interface GithubBlob {
    readonly text?: string | null | undefined;
    readonly isBinary?: boolean | null | undefined;
    readonly byteSize?: number | undefined;
}

/** Текст стороны файла; `undefined` — содержимого нет у файла целиком (двоичный, слишком большой). */
function sideTextOf(blob: GithubBlob | null): string | null | undefined {
    if (blob === null) {
        // Стороны нет вовсе: так у add и delete.
        return null;
    }
    if (blob.isBinary === true || (blob.byteSize ?? 0) > MAX_CONTENT_BYTES) {
        return undefined;
    }
    return blob.text ?? undefined;
}

/** Адрес блоба у GitHub: `<коммит>:<путь>` — он же `ImageSide.blobId`. */
function blobExpression(sha: string, path: string): string {
    return `${sha}:${path}`;
}

function parseBlobId(blobId: string): { sha: string; path: string } | null {
    const separator = blobId.indexOf(':');
    if (separator <= 0 || separator === blobId.length - 1) {
        return null;
    }
    return { sha: blobId.slice(0, separator), path: blobId.slice(separator + 1) };
}

/** Якорь ссылки на файл в вебе GitHub — sha256 пути, а не сам путь. */
function sha256(value: string): string {
    return createHash('sha256').update(value).digest('hex');
}

function encodePath(path: string): string {
    return path.split('/').map(encodeURIComponent).join('/');
}

function samePosition(left: AnchorPosition | null, right: AnchorPosition | null): boolean {
    if (left === null || right === null) {
        return left === right;
    }
    return left.side === right.side && left.line === right.line && left.size === right.size;
}

/** Тред, которому принадлежит комментарий (корень или ответ); null — такого комментария нет. */
function threadOfComment(threads: readonly Thread[], commentId: string): Thread | null {
    for (const thread of threads) {
        if (thread.root.id === commentId || thread.root.replies.some((reply) => reply.id === commentId)) {
            return thread;
        }
    }
    return null;
}

function findCommentIn(threads: readonly Thread[], match: (comment: Comment) => boolean): Comment | null {
    for (const thread of threads) {
        for (const comment of [thread.root, ...thread.root.replies]) {
            if (match(comment)) {
                return comment;
            }
        }
    }
    return null;
}

/**
 * Тело, с которым pending-ревью уезжает в публикацию. Маркеры абзацев остаются — по ним
 * адресуются уже опубликованные абзацы; абзацев нет вовсе — едет пустая строка, чтобы заглушка
 * не показалась ревьюерам PR пустым комментарием.
 */
function publishedBodyOf(body: string): string {
    const { paragraphs } = parseReviewBody(body);
    return paragraphs.length === 0 ? '' : renderReviewBody(paragraphs);
}

/** Id всех черновиков снапшота: ровно они уедут в публикацию. */
function draftIdsOf(threads: readonly Thread[]): string[] {
    const ids: string[] = [];
    for (const thread of threads) {
        for (const comment of [thread.root, ...thread.root.replies]) {
            if (comment.draft) {
                ids.push(comment.id);
            }
        }
    }
    return ids;
}

/** Отпечаток состояния ревью: сдвинулся — мету пора перечитать. */
function statusStampOf(meta: GithubPrMeta): string {
    const verdicts = compact(meta.latestOpinionatedReviews?.nodes ?? null)
        .map((review) => `${review.author?.login ?? ''}:${review.state}`)
        .join(',');
    return `${meta.updatedAt}#${meta.state}#${String(meta.isDraft)}#${verdicts}`;
}

function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

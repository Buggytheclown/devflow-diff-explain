import { randomUUID } from 'node:crypto';

import type {
    Comment,
    CommentDraft,
    FileContent,
    FileDiff,
    FileImage,
    HostId,
    ImageSide,
    Iteration,
    Lens,
    LensZone,
    PrDiff,
    PrMeta,
    PrState,
    PublishResult,
    ReviewerVerdict,
    ReviewHost,
    ReviewUser,
    Thread,
    Verdict,
} from '@sherpa/protocol';
import { commentDraftSchema, IMAGE_BLOB_MAX_BYTES, imageMimeOf, verdictSchema } from '@sherpa/protocol';

import { RpcFailure } from '../../errors.js';

import { ArcCli } from './arc-cli.js';
import type { ArcanumClientOptions, FetchLike } from './client.js';
import { ArcanumClient } from './client.js';
import { countPatchStats, splitPatchByFile } from './patch.js';
import type {
    AppliedReviewRules,
    FileRuleIndex,
    FileRuleVerdict,
    ReviewRule,
} from './review-rules.js';
import {
    appliedReviewRules,
    isAppliedReviewRule,
    isSummonedReviewer,
    loadFileReviewRules,
    summoningReviewRules,
} from './review-rules.js';
import { ruleZonePath } from './rules/subpaths.js';
import type { ArcChangelistEntry, ArcDiffSet, ArcReviewRule } from './schemas.js';
import {
    ACTIVE_DIFF_FIELDS,
    activeDiffSchema,
    CHANGELIST_FIELDS,
    changelistSchema,
    COMMENT_ACK_FIELDS,
    COMMENT_FIELDS,
    commentAckSchema,
    commentSchema,
    commentsSchema,
    DIFF_SETS_FIELDS,
    diffSetsSchema,
    DRAFT_IDS_FIELDS,
    draftIdsSchema,
    PCI_FIELDS,
    pciSchema,
    POLL_FIELDS,
    pollSchema,
    PR_REF_FIELDS,
    prRefSchema,
    publishedDraftsSchema,
    resolveMembersSchema,
    REVIEW_REQUEST_FIELDS,
    REVIEW_RULES_FIELDS,
    reviewRequestSchema,
    reviewRulesSchema,
} from './schemas.js';
import type { TokenSource } from './token.js';
import { arcTokenSource } from './token.js';
import { arcanumUser, buildThreads, isBotLogin, isoTime, toSingleComment } from './threads.js';

    /**
 * Хост-адаптер Арканума: чтение и запись.
 *
 * Опорные решения (`docs/architecture.md`, `docs/architecture.md`):
 * - реактивности нет — общий поллер дёргает дешёвую ручку и будит подписки: `watchThreads`
 *   перечитывает треды, `watchIterations` — список итераций;
 * - Арканум отдаёт только метаданные: мету PR, итерации, changelist, треды, правила, линзы;
 *   текст диффа и байты сторон читаются локальным `arc` по хэшам changelist (`arc-cli.ts`),
 *   поэтому ревью требует живого смонтированного чекаута, а фолбэка в Арканум за контентом нет;
 * - `headCommit` — merge-коммит итерации, не HEAD ветки; дифф считается между `base` и `merge`;
 * - `generated` и линза «мои» считаются per-file матчингом правил ревью a.yaml, без эвристик
 *   (`review-rules.ts`); данные не собрались — деградация, не падение;
 * - дифф и линзы кэшируются на итерацию, ключ кэша — id активного диффсета;
 * - запись сходится через тот же поллинг: своих ревизий адаптер не дёргает;
 * - адаптер обслуживает оба тенанта Арканума — Аркадию и Cloudia. Тенант PR (`vcs.arc_repo_name`)
 *   выбирает чекаут `arc`, репозиторий в ручках правил ревью и веб-ссылки; PCI DSS есть только
 *   у Аркадии.
 */

/** Интервал общего поллера: тик — один запрос дешёвой ручки на 90 байт, чаще не нужно. */
const POLL_INTERVAL_MS = 7_000;

/** Веб Аркадии и Cloudia: под ним живёт просмотр файла с blame; ссылку на сам PR даёт мета. */
const WEB_BASE_URL = 'https://a.yandex-team.ru';

/** Единственный тенант Арканума со скоупом PCI DSS (`allow_pci_dss` репо-дескриптора). */
const PCI_TENANT = 'arcadia';

    /**
 * Потолок содержимого для «Expand context»: на файлах такого размера расширение бессмысленно —
 * UI и так сворачивает дифф длиннее 2000 строк. Размер известен из changelist до запроса.
 */
const MAX_CONTENT_BYTES = 2_000_000;

/** Черновик остался черновиком: ручка выборочной публикации не назвала его среди опубликованных. */
const PUBLISH_REFUSED = 'Арканум не подтвердил публикацию этого черновика.';

export interface ArcanumHostOptions {
    /** Числовой id PR (он же review-request и pull-request). */
    readonly prId: number;
    readonly client?: ArcanumClient;
    /** Локальный `arc`: дифф и содержимое файлов. Тесты подсовывают свой — живой не зовётся. */
    readonly arc?: ArcCli;
    readonly fetch?: FetchLike;
    readonly token?: TokenSource;
    readonly baseUrl?: string;
    readonly pollIntervalMs?: number;
    /** Ретраи и паузы клиента; тестам нужны нулевые задержки. */
    readonly transport?: Omit<ArcanumClientOptions, 'token' | 'fetch' | 'baseUrl'>;
}

interface ActiveDiff {
    readonly diffSetId: number;
    readonly baseCommit: string;
    readonly mergeCommit: string;
    /** Вершина ветки (`commit_ids.head`): её просит веб-ссылка на файл; `undefined` — ручка не назвала. */
    readonly headCommit: string | undefined;
}

/** Запись кэша `active-diff`; `diffSetId` известен после ответа, до него тик опроса запись не трогает. */
interface ActiveDiffCache {
    readonly promise: Promise<ActiveDiff>;
    diffSetId: number | null;
    confirmedAt: number;
}

/** Ответ дешёвой ручки поллинга: по нему решают и треды, и итерации. */
interface PollSnapshot {
    readonly updatedAt: string;
    readonly activeDiffSetId: number;
    /** Статус ревью словами хоста; `null` — тик его не назвал. */
    readonly commonStatus: string | null;
}

    /**
 * Подписчик общего поллера. `poll` — `null`, если ручка не ответила на этом тике;
 * `alive` — «подписка ещё жива» (её могли снять, пока обработчик ходил в сеть).
 */
type PollHandler = (poll: PollSnapshot | null, alive: () => boolean) => Promise<void>;

interface PollSubscription {
    readonly handler: PollHandler;
    stopped: boolean;
    /** Начальный тик этой подписки уже отработал: до него тик не пропускается. */
    served: boolean;
}

/** Всё, что живёт ровно одну итерацию: сменился id диффсета — кэш выбрасывается целиком. */
interface IterationCache {
    readonly diffSetId: number;
    diff?: Promise<Degradable<PrDiff>>;
    /** Элементы changelist итерации по `entry_id`: из них берутся хэши блобов сторон файла. */
    entries?: Map<string, ArcChangelistEntry>;
    /** Вердикты правил ревью по путям — считаются вместе с диффом (`generated` живёт в нём же). */
    fileRules?: FileRuleIndex;
    /** Список итераций: пины тредов перечитывают его на каждом снапшоте, а меняется он с пушем. */
    iterations?: Promise<Iteration[]>;
    /** Применённые правила PR, суженные до призвавших меня; деградация не сбрасывает дифф. */
    appliedRules?: Promise<Degradable<AppliedReviewRules | null>>;
    ownership?: Promise<Degradable<Lens | null>>;
    extra?: Promise<Degradable<Lens[]>>;
}

/**
 * Результат вместе с ответом на вопрос «это свойство итерации или моргнувшая ручка».
 * Деградировавшее в кэш не ложится: разовый 500 не должен до конца ревью выключать линзу
 * или прятать `generated`.
 */
interface Degradable<T> {
    readonly value: T;
    readonly degraded: boolean;
}

/** Неизменные свойства PR, от которых зависят чекаут `arc`, ручки правил и веб-ссылки. */
interface PrRef {
    /** Репозиторий PR, он же тенант Арканума: `arcadia` или `cloudia`. */
    readonly tenant: string;
    /** Ссылка на PR в вебе — из меты, а не собранная из id. */
    readonly url: string;
}

export class ArcanumHost implements ReviewHost {
    readonly ownershipSource = 'a.yaml';

    private readonly prId: number;
    private readonly client: ArcanumClient;
    private readonly arc: ArcCli;
    private readonly pollIntervalMs: number;
    private readonly pollSubscriptions = new Set<PollSubscription>();
    private pollTimer: NodeJS.Timeout | null = null;
    private polling = false;
    private cache: IterationCache | null = null;

    /**
     * Размеры сторон картинок по `ImageSide.blobId`: сам блоб `arc` отдаёт и без changelist, а вот
     * лимит `IMAGE_BLOB_MAX_BYTES` считается по `meta_*.size`. Карта переживает смену итерации
     * вместе со срезами: блоб содержательно адресуем, и размер из прошлого диффа остаётся верным.
     */
    private readonly imageBlobs = new Map<string, number>();

    /**
     * Кэш `active-diff`: ручку зовут почти все методы, а меняется она только с пушем. Запись живёт,
     * пока тик дешёвого опроса подтверждает тот же id диффсета. Без опроса кэша нет: контракт
     * обещает, что после пуша `getDiff` отдаёт новую итерацию и без подписок. Отказ не кэшируется.
     */
    private activeDiffCache: ActiveDiffCache | null = null;

    /**
     * Последний прочитанный снапшот тредов: по нему `setCommentResolved` узнаёт, есть ли у
     * комментария issue. Отдельной ручки «один комментарий» у адаптера нет, а список комментариев
     * PR стоит дорого — перечитывается он только когда снапшот issue не подтверждает.
     */
    private lastThreads: Thread[] | null = null;

    /**
     * Тенант и веб-ссылка PR: у PR они не меняются, поэтому один запрос на процесс. Отказ кэш
     * не отравляет — следующий вызов спросит заново.
     */
    private prRefCache: Promise<PrRef> | null = null;

    constructor(options: ArcanumHostOptions) {
        this.prId = options.prId;
        this.arc = options.arc ?? new ArcCli();
        this.client =
            options.client ??
            new ArcanumClient({
                token: options.token ?? arcTokenSource(),
                ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
                ...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }),
                ...options.transport,
            });
        this.pollIntervalMs = options.pollIntervalMs ?? POLL_INTERVAL_MS;
    }

    /** Логин из последнего ответа Арканума; сеть ради whoami не вызывается. */
    currentUser(): string | null {
        return this.client.currentUser();
    }

    async getPr(): Promise<PrMeta> {
        const pr = await this.client.getJson(
            `/v1/review-requests/${String(this.prId)}`,
            { fields: REVIEW_REQUEST_FIELDS },
            reviewRequestSchema,
        );
        // Мета уже содержит всё, ради чего ходят в `prRef`: отдельного запроса можно избежать.
        this.prRefCache ??= Promise.resolve({ tenant: pr.vcs.arc_repo_name, url: pr.url });

        // Логин владельца токена известен после ответа выше; null — заголовка с ним не было.
        const viewer = viewerOf(this.client.currentUser());

        return {
            id: String(pr.id),
            url: pr.url,
            title: pr.summary ?? '',
            // Робота-автора (релизные PR) метим тем же признаком, что и авторов комментариев.
            author: arcanumUser(pr.author.name, null, isBotLogin(pr.author.name)),
            fromBranch: pr.vcs.from_branch ?? '',
            toBranch: pr.vcs.to_branch ?? '',
            state: prStateOf(pr.state, pr.common_status),
            // Статус ревью словами хоста: UI показывает как есть (контракт `statusLabel`).
            statusLabel: pr.common_status,
            // Статус проверок CI — отдельная поверхность API Арканума, она не разведана:
            // врать нечем, UI прячет строку.
            checks: null,
            updatedAt: isoTime(pr.updated_at),
            capabilities: {
                publishVerdicts: publishVerdictsOf(pr.caps?.disable_sticky_ships),
                fileViewedSync: true,
                fileContent: true,
                sourceAtRevision: true,
                commentIssues: true,
                commentResolve: true,
                // Без личности править своё опубликованное не с чем сверить — возможности нет.
                editPublished: viewer !== null,
                iterations: true,
                blobs: true,
            },
            verdicts: verdictsOf(pr.review?.reviewers ?? []),
            viewer,
        };
    }

    /**
     * Смена статуса ревью (`common_status`) — хост-специфичная подписка поверх того же дешёвого
     * полла: по ней сервер перечитывает мету и узнаёт, что кто-то отшипил PR раньше.
     * В `ReviewHost` её нет намеренно: это заплатка под API Арканума, а не общая механика.
     */
    watchStatus(onChange: () => void): () => void {
        let started = false;
        let last: string | null = null;

        return this.subscribePoll((poll, alive) => {
            const status = poll?.commonStatus ?? null;
            if (status === null) {
                return Promise.resolve();
            }
            if (started && status !== last && alive()) {
                onChange();
            }
            last = status;
            started = true;
            return Promise.resolve();
        });
    }

    /**
     * Итерации PR — опубликованные диффсеты в порядке появления. Коммиты активной берутся из
     * `active-diff` (форма проверена живьём), остальных — из `commit_ids` элемента списка;
     * диффсет без коммитов или без даты не перечисляется вовсе: соврать чужим коммитом хуже,
     * чем не показать итерацию (её дифф всё равно не с чем сопоставить).
     */
    async listIterations(): Promise<Iteration[]> {
        return (await this.loadIterations()).iterations;
    }

    /**
     * Итерации вместе с вершинами веток их диффсетов (`commit_ids.head`): вершина в контракт
     * итерации не входит, а веб-ссылке на файл (`hostFileUrl`) она нужна. Одна ручка `/diffs`
     * на оба ответа — считать их раздельно значило бы звать её дважды.
     */
    private async loadIterations(): Promise<{
        iterations: Iteration[];
        headCommits: ReadonlyMap<string, string>;
    }> {
        const [active, diffSets] = await Promise.all([this.activeDiff(), this.diffSets()]);
        const headCommits = new Map<string, string>();
        for (const diffSet of diffSets) {
            const head = diffSet.id === active.diffSetId ? active.headCommit : diffSet.commit_ids?.head;
            if (head !== undefined) {
                headCommits.set(String(diffSet.id), head);
            }
        }

        const iterations: Iteration[] = [];
        for (const diffSet of diffSets) {
            if (diffSet.published === false) {
                continue;
            }

            const isActive = diffSet.id === active.diffSetId;
            const baseCommit = isActive ? active.baseCommit : diffSet.commit_ids?.base;
            const headCommit = isActive ? active.mergeCommit : diffSet.commit_ids?.merge;
            if (diffSet.created_at === undefined || baseCommit === undefined || headCommit === undefined) {
                process.stderr.write(
                    `sherpa-server: диффсет ${String(diffSet.id)} Арканума без даты или коммитов — не перечисляем\n`,
                );
                continue;
            }
            iterations.push({
                diffId: String(diffSet.id),
                baseCommit,
                headCommit,
                createdAt: isoTime(diffSet.created_at),
                status: isActive ? 'active' : 'previous',
            });
        }

        // Активная итерация в списке обязана быть ровно одна (контракт): не нашлась среди
        // диффсетов — добираем её из `active-diff`, чтобы список не остался без активной.
        if (!iterations.some((iteration) => iteration.status === 'active')) {
            const fallback = await this.activeIteration();
            iterations.push(fallback);
            if (active.headCommit !== undefined) {
                headCommits.set(fallback.diffId, active.headCommit);
            }
        }
        return {
            iterations: iterations.sort((left, right) => left.createdAt.localeCompare(right.createdAt)),
            headCommits,
        };
    }

    async getDiff(slice?: { base: HostId; head: HostId }): Promise<PrDiff> {
        if (slice !== undefined) {
            return this.loadInterdiff(slice.base, slice.head);
        }

        return (await this.cachedDiff(await this.activeDiff())).diff;
    }

    /**
     * Подписка на итерации: тот же общий поллер, что у тредов (один таймер, одна дешёвая ручка
     * на тик). Сменился id активного диффсета — перечитываем список; начальный список приезжает
     * сразу после подписки, ошибка тика подписку не роняет.
     */
    watchIterations(onChange: (iterations: Iteration[]) => void): () => void {
        let started = false;
        let lastActiveDiffId: string | null = null;
        let lastSnapshot: string | null = null;

        return this.subscribePoll(async (poll, alive) => {
            if (started && (poll === null || String(poll.activeDiffSetId) === lastActiveDiffId)) {
                return;
            }

            const iterations = await this.listIterations();
            started = true;
            lastActiveDiffId =
                iterations.find((iteration) => iteration.status === 'active')?.diffId ?? lastActiveDiffId;
            const snapshot = JSON.stringify(iterations);
            if (snapshot !== lastSnapshot) {
                lastSnapshot = snapshot;
                if (alive()) {
                    onChange(iterations);
                }
            }
        });
    }

    getThreads(): Promise<Thread[]> {
        return this.loadThreads();
    }

    /**
     * Поллинг вместо подписки: дешёвая ручка раз в `pollIntervalMs`, и только
     * если `updated_at` или активная итерация сдвинулись — перечитывание тредов. Снапшот отдаётся
     * лишь когда он действительно изменился; ошибка тика подписку не роняет.
     */
    watchThreads(onChange: (threads: Thread[]) => void): () => void {
        /** Начального снапшота ещё не было: до него отпечаток не даёт права пропустить тик. */
        let started = false;
        let lastStamp: string | null = null;
        let lastSnapshot: string | null = null;

        return this.subscribePoll(async (poll, alive) => {
            const stamp = poll === null ? null : stampOf(poll);
            // До первого снапшота отпечаток необязателен: не ответил — просто читаем треды.
            if (started && (stamp === null || stamp === lastStamp)) {
                return;
            }

            const threads = await this.loadThreads();
            // Отпечаток потребляется только после удачного перечитывания: иначе моргнувшая
            // сеть съела бы изменение навсегда — следующие тики видели бы тот же отпечаток.
            lastStamp = stamp;
            started = true;
            const snapshot = JSON.stringify(threads);
            if (snapshot !== lastSnapshot) {
                lastSnapshot = snapshot;
                // Между чтением тредов и вызовом колбэка подписку могли снять — тогда никого не будим.
                if (alive()) {
                    onChange(threads);
                }
            }
        });
    }

/**
     * Черновик уходит в Арканум сразу (двухступенчатая модель, `docs/spec.md`, принцип 6).
     * Две ручки на три случая контракта `CommentDraft`: `parentId` — ответ в тред отдельной
     * ручкой (якорь не передаётся, тред принадлежит корню); иначе общая ручка комментариев, где
     * `anchor` даёт инлайн в активной итерации, а `anchor: null` — комментарий уровня PR
     * (он получит отрицательный id, знаковое соглашение хоста) — этот выбор делает `newCommentBody`.
     *
     * `Idempotency-Key` один на логический вызов и переживает внутренние ретраи клиента: повтор
     * с тем же ключом возвращает тот же комментарий, а не дубль (проверено живьём на write-ручках).
     * Ключ буфера черновиков — тот же механизм, но живущий дольше процесса: повтор
     * записи через минуты уходит с ключом первой попытки.
     * Наружу отдаётся комментарий из ответа ручки — перечитывать список незачем.
     */
    async saveDraft(draft: CommentDraft, options?: { idempotencyKey?: string }): Promise<Comment> {
        const parsed = commentDraftSchema.parse(draft);
        const request = { headers: { 'Idempotency-Key': options?.idempotencyKey ?? randomUUID() } };

        if (parsed.parentId !== null) {
            const reply = await this.client.postJson(
                `${commentPath(parsed.parentId)}/replies`,
                {
                    content: parsed.body,
                    draft: true,
                    ...(parsed.issue === undefined ? {} : { issue_status: parsed.issue ? 'open' : 'not_issue' }),
                },
                commentSchema,
                { fields: COMMENT_FIELDS },
                request,
            );
            return toSingleComment(reply);
        }

        const created = await this.client.postJson(
            `/v1/review-requests/${String(this.prId)}/comments`,
            await this.newCommentBody(parsed),
            commentSchema,
            { fields: COMMENT_FIELDS },
            request,
        );
        return toSingleComment(created);
    }

    updateDraft(commentId: HostId, body: string, issue?: boolean): Promise<void> {
        return this.patchComment(commentId, {
            content: body,
            ...(issue === undefined ? {} : { issue_status: issue ? 'open' : 'not_issue' }),
        });
    }

    /** Удаление черновика физическое (у опубликованного было бы soft) — проверено живьём. */
    deleteDraft(commentId: HostId): Promise<void> {
        return this.client.sendVoid('DELETE', commentPath(commentId));
    }

    /**
     * Статус issue ставится на корне треда. Наша модель считает закрытым и `dropped`, но пишем
     * только каноничную пару: `dropped` — решение человека в UI Арканума, не наше.
     */
    setThreadResolved(threadId: HostId, resolved: boolean): Promise<void> {
        return this.patchComment(threadId, { issue_status: resolved ? 'resolved' : 'open' });
    }

    /**
     * Resolve отдельного комментария — тот же PATCH статуса, что у треда, но по любому
     * issue-комментарию. Комментарий без issue отклоняется: в Арканума такой PATCH завёл бы
     * issue там, где его не было, а ревьюер нажал бы кнопку, которой у комментария нет.
     */
    async setCommentResolved(commentId: HostId, resolved: boolean): Promise<void> {
        await this.requireIssueComment(commentId);
        await this.patchComment(commentId, { issue_status: resolved ? 'resolved' : 'open' });
    }

    /** Правка опубликованного — тот же PATCH, что у черновика: Арканум их не различает. */
    updateComment(commentId: HostId, body: string, issue?: boolean): Promise<void> {
        return this.updateDraft(commentId, body, issue);
    }

    /** Удаление опубликованного у Арканума мягкое: комментарий получает `deleted_at`. */
    deleteComment(commentId: HostId): Promise<void> {
        return this.client.sendVoid('DELETE', commentPath(commentId));
    }

/**
     * Публикация пакетом: свои черновики → выборочная публикация → вердикт. Вердикт применяется,
     * только если опубликовались все (`docs/spec.md`): частичный провал оставляет ревью незавершённым,
     * а несдавшиеся черновики — черновиками. `comment` вердикта не применяет вовсе.
     */
    async publishBatch(verdict: Verdict): Promise<PublishResult> {
        const parsed = verdictSchema.parse(verdict);
        // Доступность зависит от PR только у стики-шипа: остальные режимы Арканум принимает всегда,
        // и шапку ради них не перечитываем.
        if (parsed === 'sticky_ship') {
            const pr = await this.client.getJson(
                `/v1/review-requests/${String(this.prId)}`,
                { fields: REVIEW_REQUEST_FIELDS },
                reviewRequestSchema,
            );
            if (!publishVerdictsOf(pr.caps?.disable_sticky_ships).includes(parsed)) {
                throw new RpcFailure('bad_request', 'Sticky ship на этом PR выключен его настройками.');
            }
        }
        const published = await this.publishDrafts(await this.myDrafts());

        const verdictApplied = published.failed.length === 0;
        if (verdictApplied) {
            await this.applyVerdict(parsed);
        }
        return { ...published, verdictApplied };
    }

    /**
     * Синхронизация «просмотрено» с хостом: `PUT …/reviewed-files` — инкрементальный upsert,
     * идемпотентный по природе. После успеха кэшированный дифф правится точечно: состояние хоста
     * известно ровно, а перечитывать changelist с патчем ради одного флага дорого.
     */
    async setFileViewed(fileId: HostId, viewed: boolean): Promise<void> {
        await this.client.sendVoid('PUT', `/v1/review-requests/${String(this.prId)}/reviewed-files`, {
            entry_ids: [fileId],
            reviewed: viewed,
        });
        await this.rememberViewed(fileId, viewed);
    }

/**
     * Содержимое файла по обе стороны — топливо «Expand context» (`docs/spec.md`). Хэши блобов
     * живут в changelist, поэтому сначала гарантируем дифф итерации, потом читаем стороны из
     * локального `arc`. Гейты (бинарник, размер, отсутствующая сторона) считаются из changelist
     * до всякого чтения.
     *
     * `null` здесь — только свойство самого файла (контракт `getFileContent`). Сорвавшийся вызов
     * им не прикидывается: UI кэширует ответ по fileId и на `null` навсегда гасит «Expand context»
     * с ложной причиной «у этого файла нет содержимого», а на ошибку — предлагает повторить.
     */
    async getSourceAtRevision(filePath: string, revision: string): Promise<string | null> {
        return this.arc.showText(await this.tenant(), `${revision}:${filePath}`);
    }

    async getFileContent(fileId: HostId): Promise<FileContent | null> {
        const active = await this.activeDiff();
        // Заодно наполняет карту элементов: хэши блобов приходят тем же changelist.
        const { cache } = await this.cachedDiff(active);
        const entry = cache.entries?.get(fileId);
        if (entry === undefined) {
            throw new RpcFailure('bad_request', `Арканум: файла ${fileId} нет в диффе этой итерации.`);
        }

        const before = entry.blob_before;
        const after = entry.blob_after;
        // Картинке текстовый контекст расширять нечем — даже svg показывается карточкой.
        if (isBinaryEntry(entry) || imageOf(entry) !== null || (before === undefined && after === undefined)) {
            return null;
        }
        if (tooBig(entry.meta_before?.size) || tooBig(entry.meta_after?.size)) {
            return null;
        }

        const tenant = await this.tenant();
        // Равные blob'ы (так у чистого переименования) — содержимое сторон совпадает: одно чтение.
        if (before !== undefined && after !== undefined && before === after) {
            const text = await this.arc.showText(tenant, after);
            return { oldText: text, newText: text };
        }
        const [oldText, newText] = await Promise.all([
            before === undefined ? null : this.arc.showText(tenant, before),
            after === undefined ? null : this.arc.showText(tenant, after),
        ]);
        return { oldText, newText };
    }

    /**
     * Байты стороны картинки (`ImageSide.blobId`). Сам блоб читается локальным `arc` — `blobId`
     * и есть его хэш; changelist нужен только ради размера, по которому стоит лимит контракта.
     * Неизвестный блоб — `null`, как и сторона за лимитом (её незачем читать вовсе).
     */
    async getBlob(blobId: HostId): Promise<Uint8Array | null> {
        // Блоб мог приехать из диффа, который этот процесс ещё не читал: дифф активной итерации
        // кэшируется, так что повторной загрузки changelist здесь не будет.
        const size = this.imageBlobs.get(blobId) ?? (await this.withActiveDiffLoaded(blobId));
        if (size === undefined || size > IMAGE_BLOB_MAX_BYTES) {
            return null;
        }
        return this.arc.showBytes(await this.tenant(), blobId);
    }

    async ownershipLens(): Promise<Lens | null> {
        const active = await this.activeDiff();
        const cache = this.iteration(active.diffSetId);
        const pending = (cache.ownership ??= this.loadOwnership(active).catch((error: unknown) => {
            this.forget(cache);
            throw error;
        }));

        const result = await pending;
        // Деградировавшую линзу в кэше не держим: моргнувшая ручка не свойство итерации.
        if (result.degraded && cache.ownership === pending) {
            delete cache.ownership;
        }
        return result.value;
    }

    async extraLenses(): Promise<Lens[]> {
        // Скоуп PCI DSS есть только у Аркадии: у остальных тенантов линзы нет вовсе — это
        // не деградация, и ручку `pci-dss` дёргать незачем.
        if ((await this.tenant()) !== PCI_TENANT) {
            return [];
        }

        const active = await this.activeDiff();
        const cache = this.iteration(active.diffSetId);
        const pending = (cache.extra ??= this.loadPci(active).catch((error: unknown) => {
            this.forget(cache);
            throw error;
        }));

        const result = await pending;
        if (result.degraded && cache.extra === pending) {
            delete cache.extra;
        }
        return result.value;
    }

    /**
     * Тело создания комментария: у уровня PR — текст и выбранный issue-статус, у инлайна ещё
     * якорь активной итерации. Без `diff_side`/`diff_line` Арканум деградирует якорь до файла
     * целиком — ровно то, что означает `position: null` в контракте.
     */
    private async newCommentBody(draft: CommentDraft): Promise<Record<string, unknown>> {
        const base = {
            content: draft.body,
            draft: true,
            ...(draft.issue === undefined ? {} : { issue_status: draft.issue ? 'open' : 'not_issue' }),
        };
        if (draft.anchor === null) {
            return base;
        }

        const active = await this.activeDiff();
        const position = draft.anchor.position;
        return {
            ...base,
            entry_id: draft.anchor.fileId,
            file_path: draft.anchor.path,
            diff_set_xid: String(active.diffSetId),
            ...(position === null
                ? {}
                : { diff_side: position.side, diff_line: position.line, diff_size: position.size }),
        };
    }

    /** Правка комментария: ответ узкий — важно только, что она легла на запрошенный объект. */
    private async patchComment(commentId: HostId, body: Record<string, unknown>): Promise<void> {
        const ack = await this.client.patchJson(commentPath(commentId), body, commentAckSchema, {
            fields: COMMENT_ACK_FIELDS,
        });
        if (String(ack.id) !== commentId) {
            throw new RpcFailure(
                'host_unavailable',
                `Арканум подтвердил правку не того комментария: ${String(ack.id)} вместо ${commentId}.`,
            );
        }
    }

    /** Свои черновики: флаг `draft` Арканум шлёт только автору, чужих в этом списке не бывает. */
    private async myDrafts(): Promise<number[]> {
        const comments = await this.client.getJson(
            `/v1/review-requests/${String(this.prId)}/comments`,
            { fields: DRAFT_IDS_FIELDS },
            draftIdsSchema,
        );
        return comments
            .filter((comment) => comment.draft === true && comment.deleted_at === undefined)
            .map((comment) => comment.id);
    }

    /**
     * Выборочная публикация (`POST /review-requests/draft-comments`, без id PR в пути): id
     * разъезжаются по знаковым пространствам Арканума — инлайновые в `comment_for_diff_ids`,
     * уровня PR в `comment_for_review_ids`, знак не меняется.
     *
     * Живьём ответ приходил в конверте `{"data": {"published": […]}}`, но swagger его форму
     * не описывает вовсе — принимаем и конверт, и голый вид: ошибка в догадке рвала бы
     * `publishBatch` уже после того, как комментарии опубликованы.
     *
     * Непризнанное ответом сверяется с состоянием хоста, и только оставшееся едет в `failed`.
     */
    private async publishDrafts(drafts: readonly number[]): Promise<Omit<PublishResult, 'verdictApplied'>> {
        if (drafts.length === 0) {
            return { publishedCommentIds: [], failed: [] };
        }

        const response = await this.client.postJson(
            '/v1/review-requests/draft-comments',
            {
                comment_for_diff_ids: drafts.filter((id) => id > 0),
                comment_for_review_ids: drafts.filter((id) => id < 0),
            },
            publishedDraftsSchema,
            {},
            { envelope: 'optional' },
        );

        const published = new Set(response.published);
        const missing = drafts.filter((id) => !published.has(id));
        if (missing.length > 0) {
            for (const id of await this.publishedSilently(missing)) {
                published.add(id);
            }
        }

        return {
            publishedCommentIds: drafts.filter((id) => published.has(id)).map(String),
            failed: drafts
                .filter((id) => !published.has(id))
                .map((id) => ({ commentId: String(id), message: PUBLISH_REFUSED })),
        };
    }

    /**
     * Кто из непризнанных ответом черновиков опубликован на самом деле. Ручка публикации
     * неидемпотентна, но ретраится (429/5xx/обрыв): сработавшая первая попытка с потерянным
     * ответом не назовёт эти id в ответе повтора, и честно опубликованные комментарии уехали бы
     * в `failed`, а вердикт остался бы неприменённым. Поэтому спрашиваем состояние хоста:
     * черновик, переставший быть черновиком, опубликован.
     *
     * Стёртый в это же время из UI Арканума черновик тоже посчитается опубликованным — гонка
     * экзотическая, а цена ошибки в другую сторону выше. Само перечитывание — уточнение, не
     * условие успеха: не сложилось — верим ответу ручки.
     */
    private async publishedSilently(missing: readonly number[]): Promise<number[]> {
        let stillDrafts: Set<number>;
        try {
            stillDrafts = new Set(await this.myDrafts());
        } catch (error) {
            process.stderr.write(
                `sherpa-server: черновики Арканума после публикации не перечитались: ${messageOf(error)}\n`,
            );
            return [];
        }
        return missing.filter((id) => !stillDrafts.has(id));
    }

    /**
     * Вердикт на активной итерации: стики-шип — та же ручка с `?sticky=true`; ответы этих ручек
     * нам не нужны (204 у шипа, `{"data":"<статус>"}` у request-for-changes) — итоговое состояние
     * PR UI перечитывает через `getPr`. У `comment` вердикта нет — в Арканум ничего не уходит.
     */
    private async applyVerdict(verdict: Verdict): Promise<void> {
        const request = VERDICT_REQUESTS[verdict];
        if (request === null) {
            return;
        }
        const active = await this.activeDiff();
        const basePath = `/v1/review-requests/${String(this.prId)}/diff-sets/${String(active.diffSetId)}`;
        await this.client.sendVoid('POST', `${basePath}/${request.path}`, undefined, request.query);
    }

    /**
     * Отметка «просмотрено» в кэшированном диффе. Файлы пересобираются, а не правятся на месте:
     * ранее отданный наружу `PrDiff` мутировать нельзя. Деградировавший дифф не трогаем — его
     * выбросит читатель переименований, и подмена кэша сорвала бы ему это.
     */
    private async rememberViewed(fileId: HostId, viewed: boolean): Promise<void> {
        const cache = this.cache;
        if (cache?.diff === undefined) {
            return;
        }

        const pending = cache.diff;
        const current = await pending.catch(() => null);
        // Пока ждали, итерация могла смениться, а дифф — выпасть из кэша: чинить тогда нечего.
        if (current === null || current.degraded || cache.diff !== pending) {
            return;
        }

        const files = current.value.files.map((file) =>
            file.fileId === fileId ? { ...file, viewed } : file,
        );
        cache.diff = Promise.resolve({ ...current, value: { ...current.value, files } });
    }

    private async withActiveDiffLoaded(blobId: HostId): Promise<number | undefined> {
        await this.cachedDiff(await this.activeDiff());
        return this.imageBlobs.get(blobId);
    }

    /** Размеры сторон картинок из очередного changelist — гейт `getBlob`. */
    private rememberImageBlobs(entries: readonly ArcChangelistEntry[]): void {
        for (const entry of entries) {
            if (imageMimeOf(entry.path) === null) {
                continue;
            }
            this.rememberImageBlob(entry.blob_before, entry.meta_before?.size);
            this.rememberImageBlob(entry.blob_after, entry.meta_after?.size);
        }
    }

    /** Сторона без блоба или без размера в карту не идёт: её и в `FileDiff.image` не будет. */
    private rememberImageBlob(blobId: string | undefined, size: number | undefined): void {
        if (blobId !== undefined && size !== undefined) {
            this.imageBlobs.set(blobId, size);
        }
    }

    /**
     * Дифф итерации из кэша. Вместе с диффом отдаётся объект кэша, который его наполнил: звать
     * `iteration()` второй раз после await нельзя — если параллельный запрос успел сменить
     * итерацию, вызов выбросит уже сложенный им кэш и вернёт пустой.
     */
    private async cachedDiff(active: ActiveDiff): Promise<{ diff: PrDiff; cache: IterationCache }> {
        const cache = this.iteration(active.diffSetId);
        const pending = (cache.diff ??= this.loadDiff(active, cache).catch((error: unknown) => {
            this.forget(cache);
            throw error;
        }));

        const result = await pending;
        // Дифф с деградировавшими правилами в кэше не держим: иначе один моргнувший ответ
        // запер бы неверный `generated` до самой смены итерации.
        if (result.degraded && cache.diff === pending) {
            delete cache.diff;
        }
        return { diff: result.value, cache };
    }

    /**
     * Срез между двумя итерациями (интердифф). Состав файлов и `fileId` — из changelist Арканума
     * по xid `<base>-<head>`, текст — из `arc diff` между ревьюируемыми (merge) коммитами этих
     * итераций: своего патча у интердиффа Арканум не отдаёт вовсе.
     *
     * Кэша на процесс здесь нет намеренно: срез кэширует `IterationStore` (вызывающая сторона).
     */
    private async loadInterdiff(base: HostId, head: HostId): Promise<PrDiff> {
        const { iterations, headCommits } = await this.loadIterations();
        const byId = new Map(iterations.map((iteration) => [iteration.diffId, iteration]));
        const baseIteration = byId.get(base);
        const headIteration = byId.get(head);
        if (baseIteration === undefined || headIteration === undefined) {
            const unknown = baseIteration === undefined ? base : head;
            throw new RpcFailure(
                'bad_request',
                `Арканум: итерации ${unknown} нет среди диффсетов этого PR — срез не построить.`,
            );
        }

        const changelist = await this.client.getJson(
            `/v1/review-requests/${String(this.prId)}/diff-sets/${encodeURIComponent(`${base}-${head}`)}/changelist`,
            { fields: CHANGELIST_FIELDS },
            changelistSchema,
        );
        const entries = changelist.filter(
            (entry) => entry.node_type === 'file' && entry.change_type !== 'none',
        );
        this.rememberImageBlobs(entries);
        const chunks = await this.arcChunks(
            baseIteration.headCommit,
            headIteration.headCommit,
            entries,
        );

        const ref = await this.prRef();
        return {
            diffId: head,
            baseCommit: baseIteration.headCommit,
            headCommit: headIteration.headCommit,
            files: entries.map((entry) =>
                toInterdiffFile(entry, chunks, headIteration.headCommit, {
                    ...ref,
                    headCommit: headCommits.get(head),
                }),
            ),
        };
    }

    private async loadDiff(active: ActiveDiff, cache: IterationCache): Promise<Degradable<PrDiff>> {
        const changelist = await this.client.getJson(
            `/v1/review-requests/${String(this.prId)}/diff-sets/${String(active.diffSetId)}/changelist`,
            { fields: CHANGELIST_FIELDS },
            changelistSchema,
        );

        const entries = changelist.filter(
            (entry) => entry.node_type === 'file' && entry.change_type !== 'none',
        );
        // Элементы переживают дифф: `getFileContent` берёт из них хэши блобов сторон.
        cache.entries = new Map(entries.map((entry) => [entry.entry_id, entry]));
        this.rememberImageBlobs(entries);

        // Обе досборки независимы: текст диффа идёт из локального `arc`, правила — из Арканума.
        const [chunks, rules] = await Promise.all([
            this.arcChunks(active.baseCommit, active.mergeCommit, entries),
            this.loadRuleIndex(active, entries),
        ]);
        if (rules.value !== null) {
            cache.fileRules = rules.value;
        } else {
            delete cache.fileRules;
        }

        const ref = await this.prRef();
        const files = entries.map((entry) =>
            toFileDiff(entry, chunks, active.mergeCommit, rules.value?.get(entry.path), {
                ...ref,
                headCommit: active.headCommit,
            }),
        );

        const diff: PrDiff = {
            diffId: String(active.diffSetId),
            baseCommit: active.baseCommit,
            headCommit: active.mergeCommit,
            files,
        };
        return rules.degraded ? degraded(diff) : settled(diff);
    }

    /**
     * Текст диффа из локального `arc`, разрезанный по файлам. Состав файлов диктует changelist,
     * `arc` только наполняет их текстом: куски без элемента changelist отбрасываются намеренно —
     * переименование `arc` рисует парой «удалён старый путь + добавлен новый целиком», а changelist
     * держит один элемент на новом пути.
     *
     * Двоичные файлы не запрашиваются вовсе: патча у них в контракте нет, а «Binary files … differ»
     * ни на что не влияет.
     */
    private async arcChunks(
        base: string,
        head: string,
        entries: readonly ArcChangelistEntry[],
    ): Promise<Map<string, string>> {
        const paths = diffPathsOf(entries);
        const patch = await this.arc.diff(await this.tenant(), base, head, paths);
        return splitPatchByFile(patch, paths);
    }

    /**
     * Per-file вердикты правил ревью a.yaml: `generated`, зоны и кандидаты линзы «мои»
     * растут из одного расчёта, поэтому он делается один раз — здесь, вместе с диффом.
     *
     * Провал abc/preview — деградация: `generated` не ставится никому, а линза «мои» уходит на
     * каталожный путь. Фильтр фактически применённых правил загружается отдельно: его отказ
     * не должен сбрасывать дорогой кэш диффа и полного preview-индекса.
     */
    private async loadRuleIndex(
        active: ActiveDiff,
        entries: readonly ArcChangelistEntry[],
    ): Promise<Degradable<FileRuleIndex | null>> {
        try {
            const index = await loadFileReviewRules(this.client, {
                repo: await this.tenant(),
                commit: active.mergeCommit,
                paths: entries.map((entry) => entry.path),
            });
            return settled(index);
        } catch (error) {
            process.stderr.write(
                `sherpa-server: правила ревью a.yaml Арканума недоступны: ${messageOf(error)}\n`,
            );
            return degraded(null);
        }
    }

    /** Успешный applied-фильтр кэшируется на итерацию; деградация повторяет только эту ручку. */
    private async cachedAppliedReviewRules(
        cache: IterationCache,
    ): Promise<Degradable<AppliedReviewRules | null>> {
        const pending = (cache.appliedRules ??= this.loadAppliedReviewRules());
        const result = await pending;
        if (result.degraded && cache.appliedRules === pending) {
            delete cache.appliedRules;
        }
        return result;
    }

    /**
     * Фактически применённые правила PR, суженные до призвавших меня. Пустой ответ
     * ненадёжен и не сужает линзу, а вот «правила есть, но меня никто не призвал» — надёжный
     * ответ: линза остаётся пустой, а не раскрывается в надмножество preview.
     */
    private async loadAppliedReviewRules(): Promise<Degradable<AppliedReviewRules | null>> {
        const me = this.client.currentUser();
        try {
            const response = await this.client.getJson(
                `/v1/review-requests/${String(this.prId)}`,
                { fields: REVIEW_RULES_FIELDS },
                reviewRulesSchema,
            );
            const rules = response.review?.rules ?? [];
            if (isSummonedReviewer(rules, me)) {
                const summoning = summoningReviewRules(rules, me);
                const dropped = rules.length - summoning.length;
                if (dropped > 0) {
                    process.stderr.write(
                        `sherpa-server: правил ревью, которые вас не призывали, отброшено ${String(dropped)} из ${String(rules.length)}\n`,
                    );
                }
                // Правило a.yaml с явными `reviewers` приходит без ролей и в пары ничего не кладёт:
                // если меня призвало такое, безролевые preview-правила считаем применёнными —
                // иначе линза схлопнется в ноль. Все призвавшие ролевые — шум не пускаем.
                const matchRulesWithoutRoles = summoning.some(
                    (rule) => (rule.roles ?? []).length === 0,
                );
                return settled(appliedReviewRules(summoning, { matchRulesWithoutRoles }));
            }
            // Молчим, когда `reviewers_names` не пришло вовсе: это не «меня не призвали»,
            // а Арканум без полей призыва — прежнее поведение и без объяснений.
            if (rules.some((rule) => rule.reviewers_names !== undefined)) {
                process.stderr.write(
                    'sherpa-server: вы не в списке ревьюеров правил этого PR — линза «мои» считается по членству в ролях\n',
                );
            }
            const applied = appliedReviewRules(rules, { matchRulesWithoutRoles: true });
            if (applied.pairs.size > 0) {
                return settled(applied);
            }
            process.stderr.write(
                'sherpa-server: применённые правила ревью Арканума пусты; линза «мои» использует надмножество preview\n',
            );
        } catch (error) {
            process.stderr.write(
                `sherpa-server: применённые правила ревью Арканума недоступны: ${messageOf(error)}; линза «мои» использует надмножество preview\n`,
            );
        }
        return degraded(null);
    }

    private async loadThreads(): Promise<Thread[]> {
        const active = await this.activeDiff();
        const [all, activeComments, iterationCommits] = await Promise.all([
            this.client.getJson(
                `/v1/review-requests/${String(this.prId)}/comments`,
                { fields: COMMENT_FIELDS },
                commentsSchema,
            ),
            this.client.getJson(
                `/v1/review-requests/${String(this.prId)}/diff-sets/${String(active.diffSetId)}/comments`,
                { fields: COMMENT_FIELDS },
                commentsSchema,
            ),
            this.iterationCommits(active),
        ]);
        const threads = buildThreads({ all, active: activeComments, iterationCommits });
        this.lastThreads = threads;
        return threads;
    }

    /**
     * Комментарий с issue по последнему известному снапшоту тредов. Снапшот отстаёт от записей
     * ревьюера на тик опроса, поэтому и «комментария нет» (только что создали), и «есть, но без
     * issue» (только что включили свитчер) — повод перечитать треды один раз. Отказ — лишь по
     * свежему чтению, а не запись вслепую.
     */
    private async requireIssueComment(commentId: HostId): Promise<void> {
        let found = findComment(this.lastThreads ?? [], commentId);
        if (found?.issue !== true) {
            found = findComment(await this.loadThreads(), commentId);
        }
        if (found === null) {
            throw new RpcFailure('bad_request', `Комментария ${commentId} нет среди комментариев этого PR.`);
        }
        if (!found.issue) {
            throw new RpcFailure(
                'bad_request',
                `Комментарий ${commentId} не открывает issue — закрывать в нём нечего.`,
            );
        }
    }

    /**
     * Ревьюируемые коммиты итераций по их id — из них тред получает пин к итерации своего
     * исходного якоря. Список не сложился — треды всё равно нужнее пина: пустая карта.
     */
    private async iterationCommits(active: ActiveDiff): Promise<Map<string, string>> {
        const cache = this.iteration(active.diffSetId);
        try {
            // Кэш на итерацию: список меняется пушем, а пуш меняет id активного диффсета.
            // Провалившееся обещание не задерживается — следующий снапшот попробует снова.
            const pending = (cache.iterations ??= this.listIterations().catch((error: unknown) => {
                delete cache.iterations;
                throw error;
            }));
            const iterations = await pending;
            return new Map(iterations.map((iteration) => [iteration.diffId, iteration.headCommit]));
        } catch (error) {
            process.stderr.write(
                `sherpa-server: список итераций Арканума недоступен: ${messageOf(error)}; пины тредов пусты\n`,
            );
            return new Map();
        }
    }

    /**
     * Линза «мои файлы»: файл мой, если его покрывает хотя бы одно применённое правило
     * ревью, среди людей которого есть мой логин и которое призвало меня в этот PR.
     * Полный индекс приезжает вместе с диффом, а маленький applied-фильтр кэшируется отдельно
     * на итерацию.
     *
     * Не собрался per-file расчёт — деградируем до каталожной гранулярности (зона = каталог
     * владеющего a.yaml): линза грубее, но живая. Не сработал и он — линза выключается с
     * объяснением, продукт не падает.
     */
    private async loadOwnership(active: ActiveDiff): Promise<Degradable<Lens | null>> {
        const { diff, cache } = await this.cachedDiff(active);
        const me = this.client.currentUser();
        const index = cache.fileRules;
        if (me === null) {
            return degraded(
                lens(
                    'mine',
                    'My files',
                    [],
                    'Arcanum did not tell who you are — ownership is unavailable.',
                    null,
                ),
            );
        }
        if (index === undefined) {
            return this.loadOwnershipByConfigDir(active, diff, me);
        }

        const applied = await this.cachedAppliedReviewRules(cache);
        const paths = diff.files
            .filter((file) => isMine(index.get(file.path), me, applied.value))
            .map((file) => file.path);
        const zones = ownershipZones(diff.files, index, me, applied.value);
        const value =
            paths.length === 0
                ? lens('mine', 'My files', [], 'No files of this PR are in your review zones.', zones)
                : lens('mine', 'My files', paths, null, zones);
        return applied.degraded ? degraded(value) : settled(value);
    }

    /**
     * Запасной путь линзы «мои» — гранулярность каталога a.yaml: правила ревью PR → роли
     * → логины (роли берутся только из ответа API, сырые строки a.yaml резолвятся в пустоту) →
     * каталоги владеющих a.yaml → файлы диффа под ними. Результат всегда деградировавший: в кэше
     * он не задерживается, и следующий вызов снова пробует точный расчёт.
     *
     * Это уже запасной путь, поэтому наружу он не бросает: любая сорвавшаяся ручка гасит линзу
     * с объяснением — ревью без ownership живёт, без списка файлов не живёт.
     */
    private async loadOwnershipByConfigDir(
        active: ActiveDiff,
        diff: PrDiff,
        me: string,
    ): Promise<Degradable<Lens | null>> {
        let ruleList: readonly ArcReviewRule[];
        try {
            const rules = await this.client.getJson(
                `/v1/review-requests/${String(this.prId)}`,
                { fields: REVIEW_RULES_FIELDS },
                reviewRulesSchema,
            );
            // Тот же критерий призыва, что и в точном расчёте: каталожная гранулярность грубее,
            // но шум чужих правил в неё возвращаться не должен.
            ruleList = summoningReviewRules(rules.review?.rules ?? [], me);
        } catch {
            return degraded(lens('mine', 'My files', [], 'Arcanum could not resolve review rule members.'));
        }

        const roles = [...new Set(ruleList.flatMap((rule) => rule.roles ?? []))];
        if (roles.length === 0) {
            return degraded(lens('mine', 'My files', [], 'This PR has no review rules to derive ownership from.'));
        }

        let membersByRole: Record<string, { login: string }[]>;
        try {
            const resolved = await this.client.postJson(
                '/codenavigation/abc/resolve-members',
                { roles, diffSetId: active.diffSetId },
                resolveMembersSchema,
            );
            membersByRole = resolved.members_by_role;
        } catch {
            // Недокументированная ручка UI: сломалась — линза деградирует, продукт живёт.
            return degraded(lens('mine', 'My files', [], 'Arcanum could not resolve review rule members.'));
        }

        const zones = ruleList
            .filter((rule) => (rule.roles ?? []).some((role) => hasMember(membersByRole[role], me)))
            .flatMap((rule) => (rule.configs ?? []).map((config) => zoneOf(config.path)));
        const paths = diff.files.filter((file) => inZones(file.path, zones)).map((file) => file.path);

        // Всегда деградировавшая: точный расчёт должен получить ещё один шанс на следующем вызове.
        return degraded(
            paths.length === 0
                ? lens('mine', 'My files', [], 'No files of this PR are in your review zones.')
                : lens('mine', 'My files', paths, null),
        );
    }

    /** PCI DSS: готовое пересечение файлов ревьюируемого коммита со скоупом аудита. */
    private async loadPci(active: ActiveDiff): Promise<Degradable<Lens[]>> {
        const { diff } = await this.cachedDiff(active);

        let scope: string[];
        let published: boolean;
        try {
            const pci = await this.client.getJson(
                `/v1/pci-dss/commits/${active.mergeCommit}`,
                { fields: PCI_FIELDS },
                pciSchema,
            );
            scope = pci.files ?? [];
            published = pci.commit.state !== 'unknown';
        } catch {
            return degraded([lens('pci', 'PCI DSS', [], 'The PCI DSS scope is unavailable right now.')]);
        }

        const inScope = new Set(scope);
        const paths = diff.files.filter((file) => inScope.has(file.path)).map((file) => file.path);
        if (paths.length > 0) {
            return settled([lens('pci', 'PCI DSS', paths, null)]);
        }
        return settled([
            lens(
                'pci',
                'PCI DSS',
                [],
                published
                    ? 'No files of this PR are in the PCI DSS scope.'
                    : 'The PCI DSS scope is not published for this commit yet.',
            ),
        ]);
    }

    /**
     * Тенант и веб-ссылка PR. Мету умеет отдать `getPr`, но дифф, содержимое файлов и блобы
     * обязаны работать и без него — поэтому свой узкий запрос, мемоизированный на процесс.
     */
    private prRef(): Promise<PrRef> {
        const pending = (this.prRefCache ??= this.fetchPrRef().catch((error: unknown) => {
            // Отказ не мемоизируем: сеть моргнула — следующий вызов должен попробовать снова.
            this.prRefCache = null;
            throw error;
        }));
        return pending;
    }

    /** Репозиторий PR: им выбираются чекаут `arc`, ручки правил ревью и веб-ссылки. */
    private async tenant(): Promise<string> {
        return (await this.prRef()).tenant;
    }

    private async fetchPrRef(): Promise<PrRef> {
        const ref = await this.client.getJson(
            `/v1/review-requests/${String(this.prId)}`,
            { fields: PR_REF_FIELDS },
            prRefSchema,
        );
        return { tenant: ref.vcs.arc_repo_name, url: ref.url };
    }

    private activeDiff(): Promise<ActiveDiff> {
        const now = Date.now();
        const cached = this.activeDiffCache;
        if (cached !== null && this.pollTimer !== null && now - cached.confirmedAt < this.pollIntervalMs) {
            return cached.promise;
        }

        const entry: ActiveDiffCache = { promise: this.fetchActiveDiff(), diffSetId: null, confirmedAt: now };
        this.activeDiffCache = entry;
        entry.promise.then(
            (active) => {
                entry.diffSetId = active.diffSetId;
            },
            () => {
                if (this.activeDiffCache === entry) {
                    this.activeDiffCache = null;
                }
            },
        );
        return entry.promise;
    }

    /** Тик опроса назвал активный диффсет: тот же — кэш продлевается, другой — сбрасывается. */
    private confirmActiveDiff(poll: PollSnapshot): void {
        const cached = this.activeDiffCache;
        if (cached?.diffSetId == null) {
            return;
        }
        if (cached.diffSetId === poll.activeDiffSetId) {
            cached.confirmedAt = Date.now();
        } else {
            this.activeDiffCache = null;
        }
    }

    private async fetchActiveDiff(): Promise<ActiveDiff> {
        const active = await this.client.getJson(
            `/v1/pull-requests/${String(this.prId)}/active-diff`,
            { fields: ACTIVE_DIFF_FIELDS },
            activeDiffSchema,
        );
        return {
            diffSetId: active.id,
            baseCommit: active.commit_ids.base,
            mergeCommit: active.commit_ids.merge,
            headCommit: active.commit_ids.head,
        };
    }

    /**
     * Запасной путь `listIterations`: активная итерация, когда её диффсета нет в списке `/diffs`
     * (неопубликованный, ответ не той формы). Даты у DTO `active-diff` нет, поэтому моментом
     * итерации берётся `updated_at` PR — приблизительно, зато список не остаётся без активной.
     */
    private async activeIteration(): Promise<Iteration> {
        const [active, poll] = await Promise.all([
            this.activeDiff(),
            this.client.getJson(`/v1/review-requests/${String(this.prId)}`, { fields: POLL_FIELDS }, pollSchema),
        ]);
        return {
            diffId: String(active.diffSetId),
            baseCommit: active.baseCommit,
            headCommit: active.mergeCommit,
            createdAt: isoTime(poll.updated_at),
            status: 'active',
        };
    }

    /** Дешёвая ручка поллинга (90 байт на тик): по ней видно и правки, и смену итерации. */
    private async poll(): Promise<PollSnapshot> {
        const poll = await this.client.getJson(
            `/v1/review-requests/${String(this.prId)}`,
            { fields: POLL_FIELDS },
            pollSchema,
        );
        return {
            updatedAt: poll.updated_at,
            activeDiffSetId: poll.active_diff_set.id,
            commonStatus: poll.common_status ?? null,
        };
    }

    /** Опубликованные и черновые диффсеты PR — сырой список, порядок Арканума. */
    private diffSets(): Promise<ArcDiffSet[]> {
        return this.client.getJson(
            `/v1/pull-requests/${String(this.prId)}/diffs`,
            { fields: DIFF_SETS_FIELDS },
            diffSetsSchema,
        );
    }

    /**
     * Общий поллер: один таймер и один запрос дешёвой ручки на тик для всех подписчиков
     * (`watchThreads`, `watchIterations`). Поллинг стартует с первым подписчиком и гаснет
     * с последним; ошибка тика подписку не роняет.
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
        if (this.polling || this.pollSubscriptions.size === 0) {
            return;
        }
        this.polling = true;
        try {
            let poll: PollSnapshot | null = null;
            try {
                poll = await this.poll();
                this.confirmActiveDiff(poll);
            } catch (error) {
                // Следующий тик повторит: сеть моргнула — подписки не должны умирать.
                process.stderr.write(`sherpa-server: поллинг Арканума: ${messageOf(error)}\n`);
            }

            for (const subscription of [...this.pollSubscriptions]) {
                if (subscription.stopped) {
                    continue;
                }
                subscription.served = true;
                try {
                    await subscription.handler(poll, () => !subscription.stopped);
                } catch (error) {
                    process.stderr.write(`sherpa-server: поллинг Арканума: ${messageOf(error)}\n`);
                }
            }
        } finally {
            this.polling = false;
        }

        // Подписка, пришедшая во время тика, свой начальный снапшот ждать целый интервал не должна.
        if ([...this.pollSubscriptions].some((subscription) => !subscription.served)) {
            void this.pollTick();
        }
    }

    private iteration(diffSetId: number): IterationCache {
        if (this.cache?.diffSetId !== diffSetId) {
            this.cache = { diffSetId };
        }
        return this.cache;
    }

    /** Провалившееся обещание в кэше не оставляем: следующий вызов должен попробовать заново. */
    private forget(cache: IterationCache): void {
        if (this.cache === cache) {
            this.cache = null;
        }
    }
}

export function makeArcanumHost(options: ArcanumHostOptions): ArcanumHost {
    return new ArcanumHost(options);
}

/** Комментарий по id в снапшоте тредов; null — такого в снапшоте нет. */
function findComment(threads: readonly Thread[], commentId: HostId): Comment | null {
    const visit = (comment: Comment): Comment | null => {
        if (comment.id === commentId) {
            return comment;
        }
        for (const reply of comment.replies) {
            const found = visit(reply);
            if (found !== null) {
                return found;
            }
        }
        return null;
    };

    for (const thread of threads) {
        const found = visit(thread.root);
        if (found !== null) {
            return found;
        }
    }
    return null;
}

/** Ручки одного комментария живут вне пути PR; отрицательный id уходит в путь как есть. */
function commentPath(commentId: HostId): string {
    return `/v1/review-requests-comments/${encodeURIComponent(commentId)}`;
}

/**
 * Элемент changelist + кусок патча `arc` → файл контракта. `verdict` несёт признак `generated`
 * из правил ревью a.yaml.
 *
 * Числа строк считаются из того текста, который в итоге поехал в UI: пер-файловые `patch_stats`
 * changelist не отдаёт (проверено живьём, вопреки записи разведки). У move/copy `arc` показывает
 * весь новый файл добавлениями — эту дельту и берём: своей арифметики у адаптера нет.
 */
function toFileDiff(
    entry: ArcChangelistEntry,
    chunks: ReadonlyMap<string, string>,
    mergeCommit: string,
    verdict: FileRuleVerdict | undefined,
    web: WebFileRef,
): FileDiff {
    // Внутри переименованного каталога Арканум склеивает `path` удалённого файла из нового имени
    // каталога и старого имени файла (PR 15371420: `getGrpcFilter/getFiltersForGRPC.ts`) — такого
    // пути в репозитории не было, и в патче кусок лежит под настоящим старым путём из `source`.
    const chunk = chunks.get(entry.path) ?? sourceChunk(entry, chunks);
    const binary = isBinaryEntry(entry);
    if (chunk === null && !binary) {
        // Текстовому файлу changelist кусок патча положен всегда. Не нашли — это расхождение
        // Арканума с локальным чекаутом, а не файл без изменений: fail-closed, иначе UI молча
        // покажет пустой дифф.
        throw new RpcFailure(
            'host_unavailable',
            `В диффе arc нет куска для файла ${entry.path} — чекаут расходится с изменениями PR.`,
        );
    }
    const patch = chunk;
    const stats = patch === null || binary ? { additions: 0, deletions: 0 } : countPatchStats(patch);

    return {
        fileId: entry.entry_id,
        path: entry.path,
        oldPath: entry.source?.path ?? null,
        changeType: entry.change_type === 'none' ? 'modify' : entry.change_type,
        binary,
        // Правила ревью в иерархии a.yaml есть, а файл не покрыт ни одним — осознанное исключение
        // из ревью, то есть машинный файл. Остальные вердикты признака не дают: ни «ревью
        // не настроено», ни неизвестное покрытие под битым правилом, ни провал расчёта.
        generated: verdict?.kind === 'uncovered',
        additions: stats.additions,
        deletions: stats.deletions,
        patch: binary ? null : patch,
        viewed: entry.reviewed === true,
        blameUrl: blameUrlOf(entry, mergeCommit, web.tenant),
        hostFileUrl: hostFileUrlOf(entry, web),
        image: imageOf(entry),
    };
}

/**
 * Элемент changelist среза → файл контракта. Текст — из `arc diff` между merge-коммитами итераций,
 * `generated` не считается: правила ревью a.yaml — свойство итерации, а не среза.
 */
function toInterdiffFile(
    entry: ArcChangelistEntry,
    chunks: ReadonlyMap<string, string>,
    mergeCommit: string,
    web: WebFileRef,
): FileDiff {
    const binary = isBinaryEntry(entry);
    const patch = binary ? null : interdiffPatch(entry, chunks);
    const stats = patch === null ? { additions: 0, deletions: 0 } : countPatchStats(patch);

    return {
        fileId: entry.entry_id,
        path: entry.path,
        oldPath: entry.source?.path ?? null,
        changeType: entry.change_type === 'none' ? 'modify' : entry.change_type,
        binary,
        generated: false,
        additions: stats.additions,
        deletions: stats.deletions,
        patch,
        viewed: entry.reviewed === true,
        blameUrl: blameUrlOf(entry, mergeCommit, web.tenant),
        hostFileUrl: hostFileUrlOf(entry, web),
        image: imageOf(entry),
    };
}

/**
 * Кусок текстового файла среза. Куска нет — `arc` не показал между merge-коммитами итераций
 * изменения, о котором говорит changelist: fail-closed, как у `toFileDiff`. Молча отдать такой
 * файл нельзя — в «что нового» он выглядел бы нетронутым.
 */
function interdiffPatch(entry: ArcChangelistEntry, chunks: ReadonlyMap<string, string>): string {
    const chunk = chunks.get(entry.path) ?? sourceChunk(entry, chunks);
    if (chunk === null) {
        throw new RpcFailure(
            'host_unavailable',
            `В диффе arc нет куска для файла ${entry.path} — срез итераций не построить.`,
        );
    }
    return chunk;
}

/**
 * Кусок патча по старому пути элемента. Только для `delete`: у move/copy тот же путь ведёт на
 * кусок файла-источника, то есть на чужие изменения.
 */
function sourceChunk(entry: ArcChangelistEntry, chunks: ReadonlyMap<string, string>): string | null {
    if (entry.change_type !== 'delete') {
        return null;
    }
    const source = entry.source?.path;
    return source === undefined ? null : chunks.get(source) ?? null;
}

/**
 * Пути, за диффом которых идём в `arc`: у каждого элемента changelist — его собственный и, у
 * move/copy/delete, прежний. Двоичные файлы пропускаются: патча у них в контракте нет.
 */
function diffPathsOf(entries: readonly ArcChangelistEntry[]): string[] {
    const paths = new Set<string>();
    for (const entry of entries) {
        if (isBinaryEntry(entry)) {
            continue;
        }
        paths.add(entry.path);
        const source = entry.source?.path;
        if (source !== undefined) {
            paths.add(source);
        }
    }
    return [...paths];
}

/**
 * Blame файла в вебе репозитория PR по ревьюируемой ревизии. Удалённому файлу и бинарнику blame
 * показать нечего.
 */
function blameUrlOf(entry: ArcChangelistEntry, mergeCommit: string, tenant: string): string | null {
    if (isBinaryEntry(entry) || entry.change_type === 'delete') {
        return null;
    }
    return `${WEB_BASE_URL}/${tenant}/${encodeURI(entry.path)}?rev=${mergeCommit}&blame=true`;
}

/** Всё, чем ссылка на файл в вебе Арканума отличается от самого элемента changelist. */
interface WebFileRef extends PrRef {
    /** Вершина ветки итерации; `undefined` — ссылка ведёт в активную итерацию без версии. */
    readonly headCommit: string | undefined;
}

/**
 * Файл в вебе Арканума: список файлов PR на нужной версии, якорь — путь от корня репозитория
 * (проверено живьём: слэши и точки в якоре не кодируются). Версии нет — ссылка ведёт в
 * активную итерацию. Удалённый файл и бинарник в списке тоже есть, поэтому ссылка у них своя.
 */
function hostFileUrlOf(entry: ArcChangelistEntry, web: WebFileRef): string {
    const version = web.headCommit === undefined ? '' : `/${web.headCommit}`;
    return `${web.url}/files${version}#file-${entry.path}`;
}

/**
 * Файл двоичный: текстового патча у него нет. Флагу changelist верить нельзя — у png он приходит
 * `false` (проверено на девяти PR подряд), поэтому растровые расширения считаются двоичными по пути.
 * svg сюда не входит: это текст, и его патч ревьюер читает наравне с картинкой.
 */
function isBinaryEntry(entry: ArcChangelistEntry): boolean {
    const mime = imageMimeOf(entry.path);
    return entry.binary === true || (mime !== null && mime !== 'image/svg+xml');
}

/**
 * Картинка файла: тип по расширению, стороны — из блобов changelist. Стороны без блоба или без
 * размера нет вовсе (у add нет `before`, у delete — `after`); ни одной стороны — файл с картинкой
 * не связан, и UI покажет его обычным образом.
 */
function imageOf(entry: ArcChangelistEntry): FileImage | null {
    const mime = imageMimeOf(entry.path);
    if (mime === null) {
        return null;
    }
    const before = imageSideOf(entry.blob_before, entry.meta_before?.size);
    const after = imageSideOf(entry.blob_after, entry.meta_after?.size);
    return before === null && after === null ? null : { mime, before, after };
}

function imageSideOf(blobId: string | undefined, size: number | undefined): ImageSide | null {
    return blobId === undefined || size === undefined ? null : { blobId, size };
}

function tooBig(size: number | undefined): boolean {
    return size !== undefined && size > MAX_CONTENT_BYTES;
}

/**
 * Вердикты ревьюеров из `review.reviewers[].action`. Ревьюер без действия вердикта
 * не выносил и в список не попадает; незнакомое действие — тоже не вердикт: врать «отшипил»
 * из-за нового слова в API нельзя. Имя живьём приезжает вложенным (`user.name`).
 */
function verdictsOf(
    reviewers: readonly {
        readonly name?: string | null | undefined;
        readonly user?: { readonly name?: string | null | undefined } | null | undefined;
        readonly action?: string | null | undefined;
    }[],
): ReviewerVerdict[] {
    const verdicts: ReviewerVerdict[] = [];
    for (const reviewer of reviewers) {
        const login = reviewer.user?.name ?? reviewer.name ?? null;
        if (login === null) {
            continue;
        }
        const verdict =
            reviewer.action === 'ship'
                ? 'ship'
                : reviewer.action === 'sticky_ship'
                  ? 'sticky_ship'
                  : reviewer.action === 'waiting_for_changes'
                    ? 'request_changes'
                    : null;
        if (verdict !== null) {
            verdicts.push({ user: arcanumUser(login, null, isBotLogin(login)), verdict });
        }
    }
    return verdicts;
}

/**
 * Режимы публикации на этом PR: без вердикта, шип и запрос правок — всегда, стики-шип — пока его
 * не выключили настройки PR (поля нет — считаем выключенным).
 */
function publishVerdictsOf(disableStickyShips: boolean | undefined): Verdict[] {
    return disableStickyShips === false
        ? ['comment', 'ship', 'sticky_ship', 'request_changes']
        : ['comment', 'ship', 'request_changes'];
}

/** Ручка вердикта на diff-set; null — у режима вердикта нет. */
const VERDICT_REQUESTS: Readonly<Record<Verdict, { path: string; query: Record<string, string> } | null>> = {
    comment: null,
    ship: { path: 'ship', query: {} },
    sticky_ship: { path: 'ship', query: { sticky: 'true' } },
    request_changes: { path: 'request-for-changes', query: {} },
};

/** Личность ревьюера: логин владельца токена; null — Арканум его ещё не назвал. */
function viewerOf(login: string | null): ReviewUser | null {
    return login === null ? null : arcanumUser(login, null, false);
}

function prStateOf(state: string, commonStatus: string): PrState {
    if (commonStatus === 'merged') {
        return 'merged';
    }
    return state === 'open' ? 'open' : 'closed';
}

/** Ответ полный — свойство итерации: кэшируется до смены диффсета. */
function settled<T>(value: T): Degradable<T> {
    return { value, degraded: false };
}

/** Ответ неполон из-за сломавшейся ручки: значение отдаём, но кэшировать его нельзя. */
function degraded<T>(value: T): Degradable<T> {
    return { value, degraded: true };
}

function lens(
    id: string,
    label: string,
    paths: readonly string[],
    note: string | null,
    zones: readonly LensZone[] | null = null,
): Lens {
    // Пустая линза приходит выключенной с объяснением — так же, как в фикстурах (`docs/spec.md`).
    return {
        id,
        label,
        paths: [...paths],
        available: paths.length > 0,
        note,
        zones: zones?.map((zone) => ({ ...zone, paths: [...zone.paths] })) ?? null,
    };
}

/** Правила, делающие файл моим: покрывающее правило с моим логином, применённое к этому PR. */
function mineRules(
    verdict: FileRuleVerdict | undefined,
    login: string,
    applied: AppliedReviewRules | null,
): readonly ReviewRule[] {
    return verdict?.kind === 'covered'
        ? verdict.rules.filter(
              (rule) => rule.members.has(login) && isAppliedReviewRule(rule, applied),
          )
        : [];
}

/** Файл мой, если применённое покрывающее правило содержит мой логин. */
function isMine(
    verdict: FileRuleVerdict | undefined,
    login: string,
    applied: AppliedReviewRules | null,
): boolean {
    return mineRules(verdict, login, applied).length > 0;
}

/**
 * Каждый покрытый файл попадает в одну зону — к самой глубокой статической границе правила.
 *
 * Признак `mine` зоны считается тем же предикатом, что и `paths` линзы, а мой файл раскладывается
 * по глубочайшему из **моих** правил: иначе файл, который я ревьюирую по правилу предка, показался
 * бы в чужой зоне (глубочайшее правило — соседней команды), и сегмент «моя зона» рисовал бы серые
 * строки «вне вашей зоны» на своих же файлах.
 */
function ownershipZones(
    files: readonly FileDiff[],
    index: FileRuleIndex,
    login: string,
    applied: AppliedReviewRules | null,
): LensZone[] {
    const zones = new Map<string, LensZone>();
    for (const file of files) {
        const verdict = index.get(file.path);
        if (verdict?.kind !== 'covered') {
            continue;
        }
        const myRules = mineRules(verdict, login, applied);
        const mine = myRules.length > 0;
        const selected = deepestRule(file.path, mine ? myRules : verdict.rules);
        if (selected === null) {
            continue;
        }
        const key = JSON.stringify([selected.path, mine, selected.rule.alias]);
        const existing = zones.get(key);
        if (existing === undefined) {
            zones.set(key, {
                path: selected.path,
                mine,
                owner: selected.rule.alias,
                paths: [file.path],
            });
        } else {
            existing.paths.push(file.path);
        }
    }
    return [...zones.values()];
}

function deepestRule(path: string, rules: readonly ReviewRule[]): { rule: ReviewRule; path: string } | null {
    let selected: { rule: ReviewRule; path: string } | null = null;
    for (const rule of rules) {
        const zonePath = ruleZonePath(rule, path);
        if (selected === null || pathDepth(zonePath) >= pathDepth(selected.path)) {
            selected = { rule, path: zonePath };
        }
    }
    return selected;
}

function pathDepth(path: string): number {
    return path === '' ? 0 : path.split('/').length;
}

function hasMember(members: { login: string }[] | undefined, login: string): boolean {
    return members?.some((member) => member.login === login) ?? false;
}

/** Зона правила — каталог владеющего a.yaml; путь приходит от корня репозитория с ведущим `/`. */
function zoneOf(configPath: string): string {
    const withoutLeadingSlash = configPath.replace(/^\/+/, '');
    const lastSlash = withoutLeadingSlash.lastIndexOf('/');
    return lastSlash === -1 ? '' : withoutLeadingSlash.slice(0, lastSlash);
}

function inZones(path: string, zones: readonly string[]): boolean {
    return zones.some((zone) => zone === '' || path === zone || path.startsWith(`${zone}/`));
}

/** Отпечаток состояния PR: сдвинулся — что-то изменилось, треды пора перечитать. */
function stampOf(poll: PollSnapshot): string {
    return `${poll.updatedAt}#${String(poll.activeDiffSetId)}`;
}

function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

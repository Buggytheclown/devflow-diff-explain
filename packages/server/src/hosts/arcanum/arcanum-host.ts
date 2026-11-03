import type { ReviewSource } from '@sherpa/protocol';

import type {
    FileContent,
    FileDiff,
    FileImage,
    HostId,
    ImageSide,
    Iteration,
    PrDiff,
    PrMeta,
    PrState,
    ReviewerVerdict,
    ReviewUser,
} from '@sherpa/protocol';
import { IMAGE_BLOB_MAX_BYTES, imageMimeOf } from '@sherpa/protocol';

import { RpcFailure } from '../../errors.js';

import { ArcCli } from './arc-cli.js';
import type { ArcanumClientOptions, FetchLike } from './client.js';
import { ArcanumClient } from './client.js';
import { countPatchStats, splitPatchByFile } from './patch.js';
import type { ArcChangelistEntry, ArcDiffSet } from './schemas.js';
import {
    ACTIVE_DIFF_FIELDS,
    activeDiffSchema,
    CHANGELIST_FIELDS,
    changelistSchema,
    DIFF_SETS_FIELDS,
    diffSetsSchema,
    POLL_FIELDS,
    pollSchema,
    PR_REF_FIELDS,
    prRefSchema,
    REVIEW_REQUEST_FIELDS,
    reviewRequestSchema,
} from './schemas.js';
import type { TokenSource } from './token.js';
import { arcTokenSource } from './token.js';
import { arcanumUser, isBotLogin, isoTime } from './metadata.js';

    /** Read-only источник: метаданные, закреплённый код, версии и изображения. */

/** Интервал общего поллера: тик — один запрос дешёвой ручки на 90 байт, чаще не нужно. */
const POLL_INTERVAL_MS = 7_000;

/** Веб Аркадии и Cloudia: под ним живёт просмотр файла с blame; ссылку на сам PR даёт мета. */
const WEB_BASE_URL = 'https://a.yandex-team.ru';

    /**
 * Потолок содержимого для «Expand context»: на файлах такого размера расширение бессмысленно —
 * UI и так сворачивает дифф длиннее 2000 строк. Размер известен из changelist до запроса.
 */
const MAX_CONTENT_BYTES = 2_000_000;

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
    /** Список итераций: пины тредов перечитывают его на каждом снапшоте, а меняется он с пушем. */
    iterations?: Promise<Iteration[]>;
    /** Применённые правила PR, суженные до призвавших меня; деградация не сбрасывает дифф. */
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

export class ArcanumHost implements ReviewSource {

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
                publishVerdicts: [],
                fileViewedSync: false,
                fileContent: true,
                sourceAtRevision: true,
                commentIssues: false,
                commentResolve: false,
                // Без личности править своё опубликованное не с чем сверить — возможности нет.
                editPublished: false,
                iterations: true,
                blobs: true,
            },
            verdicts: verdictsOf(pr.review?.reviewers ?? []),
            viewer,
        };
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

        const chunks = await this.arcChunks(active.baseCommit, active.mergeCommit, entries);
        const ref = await this.prRef();
        const files = entries.map((entry) =>
            toFileDiff(entry, chunks, active.mergeCommit, {
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
        return settled(diff);
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
     * (`watchIterations`). Поллинг стартует с первым подписчиком и гаснет
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
        generated: false,
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

function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

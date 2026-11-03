import type { ReviewSource } from '@sherpa/protocol';
import { createHash } from 'node:crypto';

import type {
    FileContent,
    FileDiff,
    FileImage,
    HostCapabilities,
    HostId,
    ImageSide,
    Iteration,
    PrChecks,
    PrDiff,
    PrMeta,
    ReviewUser,
    ReviewerVerdict,
} from '@sherpa/protocol';
import {
    IMAGE_BLOB_MAX_BYTES,
    imageMimeOf,
} from '@sherpa/protocol';

import { RpcFailure } from '../../errors.js';

import type { FetchLike, GithubClientOptions } from './client.js';
import { GithubClient } from './client.js';
import {
    FILE_CONTENT_QUERY,
    FILES_QUERY,
    PR_QUERY,
    VIEWER_QUERY,
    blobBinaryQuery,
    blobSizesQuery,
} from './queries.js';
import type {
    GithubFilesResponse,
    GithubPrMeta,
    GithubRestFile,
} from './schemas.js';
import {
    blobAliasesResponseSchema,
    compact,
    compareSchema,
    fileContentResponseSchema,
    filesResponseSchema,
    prResponseSchema,
    restFilesSchema,
    viewerResponseSchema,
} from './schemas.js';
import {
    avatarOf,
    isoTime,
    userOf,
} from './metadata.js';

    /** Read-only источник: метаданные, закреплённый код, версии и изображения. */

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

const CAPABILITIES: Omit<HostCapabilities, 'publishVerdicts'> = {
    fileViewedSync: false,
    fileContent: true,
                sourceAtRevision: true,
    // Отдельного статуса «комментарий требует ответа» у GitHub нет — есть только resolve треда.
    commentIssues: false,
    // Закрывается тред целиком: резолвить по комментарию GitHub не умеет.
    commentResolve: false,
    // Флаг держится на личности ревьюера: шапка без `viewer` не отдаётся вовсе (`viewerUser`).
    editPublished: false,
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
    /** Ретраи и паузы клиента; тестам нужны нулевые задержки. */
    readonly transport?: Omit<GithubClientOptions, 'token' | 'fetch' | 'baseUrl'>;
}

/** Что живёт ровно одну итерацию: сменилась голова ветки — кэш выбрасывается целиком. */
interface IterationCache {
    readonly headRefOid: string;
    mergeBase?: Promise<string>;
    diff?: Promise<PrDiff>;
}

/** Запись кэша шапки; `headRefOid` известен после ответа. */
interface MetaCache {
    readonly promise: Promise<GithubPrMeta>;
    headRefOid: string | null;
    confirmedAt: number;
}

/** Результат тика: то, что отдаёт один GraphQL-запрос опроса. */
interface TickSnapshot {
    readonly meta: GithubPrMeta;
}

type PollHandler = (tick: TickSnapshot | null, alive: () => boolean) => Promise<void>;

interface PollSubscription {
    readonly handler: PollHandler;
    stopped: boolean;
    /** Начальный тик этой подписки уже отработал. */
    served: boolean;
}

export class GithubHost implements ReviewSource {

    private readonly owner: string;
    private readonly repo: string;
    private readonly number: number;
    private readonly client: GithubClient;
    private readonly pollIntervalMs: number;

    private readonly pollSubscriptions = new Set<PollSubscription>();
    private pollTimer: NodeJS.Timeout | null = null;
    private polling = false;
    private tickRequested = false;

    private metaCache: MetaCache | null = null;
    private cache: IterationCache | null = null;
    /** Владелец токена; промис нулевой — его ещё не спрашивали. */
    private viewer: Promise<ReviewUser> | null = null;

    /** Размеры сторон картинок по `ImageSide.blobId`: по ним стоит лимит `getBlob`. */
    private readonly imageBlobs = new Map<string, number>();

    constructor(options: GithubHostOptions) {
        this.owner = options.owner;
        this.repo = options.repo;
        this.number = options.number;
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

/**
     * Содержимое файла по обе стороны — топливо «Expand context» (`docs/spec.md`).
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
            capabilities: { ...CAPABILITIES, publishVerdicts: [] },
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

    /** Всё состояние PR одним запросом: шапка, треды диффа, ревью и комментарии уровня PR. */
    private async loadTick(): Promise<TickSnapshot> {
        return { meta: await this.fetchMeta() };
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

function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

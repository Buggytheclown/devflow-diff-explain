import path from 'node:path';

import type {
    AnchorPosition,
    Comment,
    CommentDraft,
    FileContent,
    HostCapabilities,
    HostId,
    Iteration,
    Lens,
    PrDiff,
    PrMeta,
    PublishResult,
    ReviewerVerdict,
    ReviewHost,
    ReviewUser,
    Thread,
    Verdict,
} from '@sherpa/protocol';
import { commentDraftSchema, verdictSchema } from '@sherpa/protocol';

import { RpcFailure } from '../../errors.js';
import type { PatchLine } from '../../route/diff-index.js';
import { walkPatch } from '../../route/diff-index.js';
import type {
    FeedbackComment,
    FeedbackHost,
    FeedbackReply,
    FeedbackRound,
    FeedbackRoundContext,
    FeedbackThread,
} from '../select.js';

import { localInterdiff } from './interdiff.js';
import type { LocalIterationRecord, LocalIterationsStore } from './iterations-store.js';
import { appendToHistory } from './iterations-store.js';
import type { LocalRepo, LocalSnapshot } from './snapshot.js';
import { buildLocalSnapshot, openLocalRepo, probeLocal, readSideBytes } from './snapshot.js';
import type { LocalComment, LocalReviewData, LocalThread, LocalThreadsStore } from './threads-store.js';
import type { LocalVcs } from './vcs.js';

/**
 * Хост-адаптер локального чекаута (arc или git): ревью рабочего дерева каталога проекта относительно
 * базового коммита. Одна итерация — текущее состояние дерева; новая появляется, когда дифф
 * действительно изменился (`diffId` — отпечаток его содержимого, он же `headCommit`).
 *
 * Опорные решения:
 * - прошлые итерации помнит сам адаптер: их состав и содержимое новых сторон лежат в истории
 *   (`iterations-store.ts`), из неё же считается срез между двумя итерациями;
 * - устаревание треда считается по его файлу, а не по всему диффу: правка в соседнем файле
 *   двигает итерацию, но тред с его строк не снимает;
 * - удалённого хоста у комментариев нет: они лежат рядом со стейтом PR, а `publishBatch`
 *   снимает с черновиков признак черновика, запоминает вердикт и открывает раунд — задачу
 *   агенту ставит по нему оркестратор (`feedback-orchestrator.ts`);
 * - правил ревью a.yaml локально не воспроизводим: `generated: false`, зона ревьюера — весь дифф;
 * - ветка чекаута — часть ключа ревью: сменилась — хост отказывает, а не молча ревьюит другое.
 */

/** Как часто опрашивается рабочее дерево. Дебаунса нет: правка видна на следующем тике. */
const POLL_INTERVAL_MS = 30_000;

/**
 * Режимы публикации. По умолчанию вердикт применять некому: замечания уходят агенту, он правит по
 * каждому. С `--verdicts` — как в PR, Ship и Request changes: вердикт ждёт агент, которому
 * пользователь поручил действие на одобрение, а замечания уезжают через Request changes.
 */
const COMMENT_ONLY: readonly Verdict[] = ['comment'];
const WITH_VERDICTS: readonly Verdict[] = ['request_changes', 'ship'];

const CAPABILITIES: Omit<HostCapabilities, 'publishVerdicts'> = {
    fileViewedSync: false,
    fileContent: true,
    commentIssues: false,
    // Issue локально нет — резолвить по комментарию нечего, resolve живёт на треде.
    commentResolve: false,
    editPublished: true,
    iterations: true,
    blobs: true,
};

export interface LocalHostOptions {
    /** Ключ ревью: он же `PrMeta.id`. */
    readonly prKey: string;
    readonly vcs: LocalVcs;
    /** Каталог проекта внутри чекаута; пути наружу считаются от него. */
    readonly projectDir: string;
    /** База сравнения; null — merge-base с базовой веткой по умолчанию на каждом опросе. */
    readonly base: string | null;
    /** Ветка, на которой построен ключ ревью; null — первый снимок её зафиксирует. */
    readonly branch: string | null;
    /**
     * Поручение пользователя на исход ревью (`--verdicts`): с ним Ship и Request changes вместо
     * Comment. Нет его — только Comment.
     */
    readonly verdicts?: string | null;
    readonly threads: LocalThreadsStore;
    /** История итераций: прошлых итераций у рабочего дерева нет больше нигде. */
    readonly iterations: LocalIterationsStore;
    readonly pollIntervalMs?: number;
    readonly now?: () => Date;
    /** Ветка зафиксирована первым снимком — её нужно сохранить рядом с каталогом и базой. */
    readonly onBranchResolved?: (branch: string) => void;
    /** Поручение сменилось на живом сервере — его нужно сохранить для перезапуска. */
    readonly onVerdictsChanged?: (verdicts: string | null) => void;
    /** Куда писать отказы истории итераций; по умолчанию stderr. */
    readonly log?: (message: string) => void;
}

/** Сколько строк патча вокруг якоря едет агенту фрагментом. */
const EXCERPT_CONTEXT_LINES = 3;

export class LocalHost implements ReviewHost, FeedbackHost {
    /** Зона ревьюера — весь дифф рабочего дерева. */
    readonly ownershipSource: string;

    private readonly options: LocalHostOptions;
    private readonly pollIntervalMs: number;
    private readonly now: () => Date;
    private readonly log: (message: string) => void;

    private readonly threadWatchers = new Set<(threads: Thread[]) => void>();
    private readonly iterationWatchers = new Set<(iterations: Iteration[]) => void>();
    private timer: NodeJS.Timeout | null = null;

    private repoPromise: Promise<LocalRepo> | null = null;
    private snapshotPromise: Promise<LocalSnapshot> | null = null;
    private current: LocalSnapshot | null = null;
    /** Чекаут ушёл из-под ревью (сменилась ветка): пока она не вернётся, хост отказывает. */
    private failure: Error | null = null;
    private expectedBranch: string | null;
    private verdicts: string | null;

    /** История итераций в памяти; null — с диска её ещё не читали. */
    private historyValue: LocalIterationRecord[] | null = null;
    private historyPromise: Promise<LocalIterationRecord[]> | null = null;

    private dataPromise: Promise<LocalReviewData> | null = null;
    /** Хвост очереди мутаций тредов: следующая правка ждёт, пока запишется предыдущая. */
    private mutations: Promise<void> = Promise.resolve();

    /** Байты сторон картинок живут дольше снимка: блоб адресуется содержимым. */
    private readonly blobs = new Map<string, Uint8Array>();

    constructor(options: LocalHostOptions) {
        this.options = options;
        this.ownershipSource = `${options.vcs.kind} diff`;
        this.pollIntervalMs = options.pollIntervalMs ?? POLL_INTERVAL_MS;
        this.now = options.now ?? ((): Date => new Date());
        this.log =
            options.log ??
            ((message: string): void => {
                process.stderr.write(`sherpa-server: ${message}\n`);
            });
        this.expectedBranch = options.branch;
        this.verdicts = options.verdicts ?? null;
    }

    /** Логин из последнего снимка; null — снимка ещё не было. */
    currentUser(): string | null {
        return this.current?.login ?? null;
    }

    /**
     * Поручение живого сервера: его называет каждый `up --local`, null — режим снят. Возвращает true,
     * если режим включился или выключился, — тогда мету PR с новым `publishVerdicts` пора перечитать.
     */
    setVerdicts(verdicts: string | null): boolean {
        if (verdicts === this.verdicts) {
            return false;
        }
        // Сначала запись: если она упала, поручение в памяти прежнее, и следующий `up` повторит её.
        this.options.onVerdictsChanged?.(verdicts);
        const toggled = (verdicts === null) !== (this.verdicts === null);
        this.verdicts = verdicts;
        return toggled;
    }

    /** Принудительный опрос рабочего дерева — мимо интервала таймера и мимо дешёвой проверки. */
    async refresh(): Promise<void> {
        await this.rebuild(true);
    }

    async getPr(): Promise<PrMeta> {
        const snapshot = await this.snapshot();
        const data = await this.reviewData();
        const verdict = data.verdict;

        return {
            id: this.options.prKey,
            url: `file://${this.options.projectDir}`,
            title: snapshot.branch,
            author: this.userOf(snapshot.login),
            fromBranch: snapshot.branch,
            toBranch: snapshot.baseRef,
            state: 'open',
            statusLabel: 'local',
            checks: null,
            updatedAt: snapshot.createdAt,
            capabilities: { ...CAPABILITIES, publishVerdicts: [...this.publishVerdicts()] },
            // Вердикт живёт внутри итерации: новый дифф — ревью снова не завершено.
            verdicts: verdict?.diffId === snapshot.diffId ? this.verdictsOf(verdict.verdict, snapshot.login) : [],
            // Локальное ревью читает тот, чьё это дерево.
            viewer: this.userOf(snapshot.login),
        };
    }

    /** Вся история рабочего дерева: последняя запись — активная итерация. */
    async listIterations(): Promise<Iteration[]> {
        await this.snapshot();
        await this.history();
        return this.iterationList();
    }

    async getDiff(slice?: { base: HostId; head: HostId }): Promise<PrDiff> {
        if (slice !== undefined) {
            return this.sliceOf(slice.base, slice.head);
        }

        const snapshot = await this.snapshot();
        return {
            diffId: snapshot.diffId,
            baseCommit: snapshot.baseCommit,
            headCommit: snapshot.headCommit,
            files: snapshot.files.map((file) => structuredClone(file)),
        };
    }

    watchIterations(onChange: (iterations: Iteration[]) => void): () => void {
        this.iterationWatchers.add(onChange);
        this.startPolling();
        void this.listIterations()
            .then((iterations) => {
                if (this.iterationWatchers.has(onChange)) {
                    onChange(iterations);
                }
            })
            .catch(() => {
                // Первый снимок не собрался: подписка молчит, ошибку человеку покажет ручка диффа.
            });

        return () => {
            this.iterationWatchers.delete(onChange);
            this.stopPollingIfIdle();
        };
    }

    async getThreads(): Promise<Thread[]> {
        return threadsOf(await this.snapshot(), await this.reviewData());
    }

    watchThreads(onChange: (threads: Thread[]) => void): () => void {
        this.threadWatchers.add(onChange);
        this.startPolling();
        void this.getThreads()
            .then((threads) => {
                if (this.threadWatchers.has(onChange)) {
                    onChange(threads);
                }
            })
            .catch(() => {
                // Как и у итераций: молчание подписки, а не падение сервера.
            });

        return () => {
            this.threadWatchers.delete(onChange);
            this.stopPollingIfIdle();
        };
    }

    /**
     * Черновик кладётся в локальное хранилище. Повтор с тем же `idempotencyKey` отдаёт
     * уже созданный комментарий: буфер черновиков повторяет запись после отказа хоста.
     */
    async saveDraft(draft: CommentDraft, options?: { idempotencyKey?: string }): Promise<Comment> {
        const parsed = commentDraftSchema.parse(draft);
        const key = options?.idempotencyKey;

        return this.mutate((data, snapshot) => {
            const repeated = key === undefined ? null : findByKey(data.threads, key);
            if (repeated !== null) {
                return commentOf(repeated);
            }

            const comment: LocalComment = {
                id: String(data.nextId),
                author: this.userOf(snapshot.login),
                body: parsed.body,
                draft: true,
                createdAt: this.now().toISOString(),
                editedAt: null,
                idempotencyKey: key ?? null,
                replies: [],
            };
            data.nextId += 1;

            if (parsed.parentId !== null) {
                const parent = locate(data.threads, parsed.parentId);
                if (parent === null) {
                    throw new Error(`parent comment ${parsed.parentId} is not found`);
                }
                parent.comment.replies.push(comment);
                return commentOf(comment);
            }

            data.threads.push({
                id: comment.id,
                anchor:
                    parsed.anchor === null
                        ? null
                        : { path: parsed.anchor.path, position: parsed.anchor.position },
                fileId: parsed.anchor?.fileId ?? null,
                fileHash:
                    parsed.anchor === null
                        ? null
                        : (snapshot.fileHashByPath.get(parsed.anchor.path) ?? null),
                resolved: false,
                resolvedBy: null,
                // Пин — итерация, на которой написан тред; у обсуждения уровня PR итерации нет.
                pinnedTo:
                    parsed.anchor === null
                        ? null
                        : { diffId: snapshot.diffId, commit: snapshot.headCommit },
                root: comment,
            });
            return commentOf(comment);
        });
    }

    async updateDraft(commentId: HostId, body: string, _issue?: boolean): Promise<void> {
        await this.mutate((data) => {
            const found = locate(data.threads, commentId);
            if (found === null) {
                throw new Error(`comment ${commentId} is not found`);
            }
            if (!found.comment.draft) {
                throw new Error(`comment ${commentId} is published and cannot be edited`);
            }
            found.comment.body = body;
            found.comment.editedAt = this.now().toISOString();
        });
    }

    async deleteDraft(commentId: HostId): Promise<void> {
        await this.mutate((data) => {
            const found = locate(data.threads, commentId);
            if (found === null) {
                throw new Error(`comment ${commentId} is not found`);
            }
            if (!found.comment.draft) {
                throw new Error(`comment ${commentId} is published and cannot be deleted`);
            }
            if (found.comment.replies.length > 0) {
                throw new Error(`draft ${commentId} has replies: delete them first`);
            }

            if (found.parent === null) {
                data.threads = data.threads.filter((thread) => thread !== found.thread);
            } else {
                found.parent.replies = found.parent.replies.filter((reply) => reply !== found.comment);
            }
        });
    }

    /**
     * Правка своего опубликованного комментария. Чужой (ответ агента) не правится: у локального
     * ревью один автор-человек, и подменять чужой текст ему нечем.
     */
    async updateComment(commentId: HostId, body: string, _issue?: boolean): Promise<void> {
        await this.mutate((data, snapshot) => {
            const found = this.requirePublishedOwn(data, snapshot, commentId);
            found.comment.body = body;
            found.comment.editedAt = this.now().toISOString();
        });
    }

    /** Удаление своего опубликованного комментария: локально оно физическое, прятать не за чем. */
    async deleteComment(commentId: HostId): Promise<void> {
        await this.mutate((data, snapshot) => {
            const found = this.requirePublishedOwn(data, snapshot, commentId);
            if (found.comment.replies.length > 0) {
                throw new Error(`comment ${commentId} has replies: delete them first`);
            }

            if (found.parent === null) {
                data.threads = data.threads.filter((thread) => thread !== found.thread);
            } else {
                found.parent.replies = found.parent.replies.filter((reply) => reply !== found.comment);
            }
        });
    }

    async setThreadResolved(threadId: HostId, resolved: boolean): Promise<void> {
        await this.mutate((data, snapshot) => {
            const thread = data.threads.find((candidate) => candidate.id === threadId);
            if (thread === undefined) {
                throw new Error(`thread ${threadId} is not found`);
            }
            thread.resolved = resolved;
            thread.resolvedBy = resolved ? snapshot.login : null;
        });
    }

    /**
     * Публикация локального ревью: черновики перестают быть черновиками, режим запоминается вместе
     * с итерацией, и открывается раунд — задача агенту. `comment` без комментариев раунда не заводит:
     * агенту делать нечего. Вердикт заводит его и пустым: сессия обязана узнать, что ревьюер решил.
     */
    async publishBatch(verdict: Verdict): Promise<PublishResult> {
        const parsed = verdictSchema.parse(verdict);
        if (!this.publishVerdicts().includes(parsed)) {
            throw new RpcFailure(
                'bad_request',
                this.verdicts !== null
                    ? 'Это локальное ревью завершается вердиктом: замечания уходят через Request changes.'
                    : 'Локальное ревью публикует только комментарии: одобрять и запрашивать изменения здесь некому.',
            );
        }

        const drafts = (await this.reviewData()).threads.some((thread) =>
            flatten(thread.root).some((comment) => comment.draft),
        );
        if (!drafts && parsed === 'comment') {
            return { publishedCommentIds: [], failed: [], verdictApplied: true };
        }

        return this.mutate((data, snapshot) => {
            const publishedCommentIds: HostId[] = [];
            const threadIds: string[] = [];
            for (const thread of data.threads) {
                let touched = false;
                for (const comment of flatten(thread.root)) {
                    if (comment.draft) {
                        comment.draft = false;
                        publishedCommentIds.push(comment.id);
                        touched = true;
                    }
                }
                if (touched) {
                    threadIds.push(thread.id);
                }
            }
            data.verdict = { verdict: parsed, diffId: snapshot.diffId };
            // Черновики могли уйти, пока публикация ждала очереди: пустой раунд без вердикта агенту не нужен.
            if (publishedCommentIds.length === 0 && parsed === 'comment') {
                return { publishedCommentIds, failed: [], verdictApplied: true };
            }
            data.rounds.push({
                id: String(data.nextId),
                verdict: parsed,
                diffId: snapshot.diffId,
                headCommit: snapshot.headCommit,
                createdAt: this.now().toISOString(),
                threadIds,
                status: 'pending',
                summary: null,
            });
            data.nextId += 1;
            return { publishedCommentIds, failed: [], verdictApplied: true };
        });
    }

    /** Раунды, которых агент ещё не видел, — в порядке публикации. */
    async pendingRounds(): Promise<FeedbackRound[]> {
        const data = await this.reviewData();
        return data.rounds
            .filter((round) => round.status === 'pending')
            .map((round) => ({
                id: round.id,
                verdict: round.verdict,
                createdAt: round.createdAt,
                threadIds: [...round.threadIds],
            }));
    }

    /** Контекст раунда для агента: пути в чекауте, якоря, фрагменты патча и переписка тредов. */
    async roundContext(roundId: string): Promise<FeedbackRoundContext> {
        const snapshot = await this.snapshot();
        const data = await this.reviewData();
        const round = data.rounds.find((candidate) => candidate.id === roundId);
        if (round === undefined) {
            throw new Error(`review round ${roundId} is not found`);
        }

        const threads = round.threadIds.map((threadId) =>
            this.feedbackThread(snapshot, data.threads.find((thread) => thread.id === threadId) ?? null, threadId),
        );
        return {
            roundId,
            verdict: round.verdict,
            // Поручение берётся текущее: в раунде оно не хранится.
            instruction: this.verdicts,
            projectDir: this.options.projectDir,
            threads,
        };
    }

    /**
     * Ответы агента в треды раунда, итог раунда — обсуждением уровня PR. Комментарии обычные,
     * не черновики: ревьюер видит их сразу. Рабочее дерево перечитывается тут же — правки агента
     * обязаны стать итерацией, не дожидаясь тика опроса.
     */
    async completeRound(
        roundId: string,
        result: { readonly replies: readonly FeedbackReply[]; readonly summary: string },
        author: ReviewUser,
    ): Promise<void> {
        await this.mutate((data) => {
            const round = data.rounds.find((candidate) => candidate.id === roundId);
            if (round === undefined) {
                throw new Error(`review round ${roundId} is not found`);
            }

            // Сначала все проверки, потом запись: отказ на полпути оставил бы часть ответов в памяти.
            const targets = result.replies.map((reply) => {
                if (!round.threadIds.includes(reply.threadId)) {
                    throw new Error(`thread ${reply.threadId} is not in review round ${roundId}`);
                }
                const thread = data.threads.find((candidate) => candidate.id === reply.threadId);
                if (thread === undefined) {
                    throw new Error(`thread ${reply.threadId} is not found`);
                }
                return { thread, body: reply.body };
            });

            const createdAt = this.now().toISOString();
            const nextComment = (body: string): LocalComment => {
                const comment: LocalComment = {
                    id: String(data.nextId),
                    author,
                    body,
                    draft: false,
                    createdAt,
                    editedAt: null,
                    idempotencyKey: null,
                    replies: [],
                };
                data.nextId += 1;
                return comment;
            };

            for (const target of targets) {
                target.thread.root.replies.push(nextComment(target.body));
            }
            // Итог раунда ревьюер читает там же, где остальное обсуждение уровня PR.
            const summary = nextComment(result.summary);
            data.threads.push({
                id: summary.id,
                anchor: null,
                fileId: null,
                fileHash: null,
                resolved: false,
                resolvedBy: null,
                pinnedTo: null,
                root: summary,
            });

            round.status = 'done';
            round.summary = result.summary;
        });

        // Опрос всё равно догонит дерево сам: сорвавшийся пересчёт раунд не отменяет.
        await this.rebuild(true).then(
            () => undefined,
            () => undefined,
        );
    }

    /**
     * Содержимое файла целиком по обе стороны; null — текста у файла нет (двоичный или больше
     * `MAX_FILE_BYTES`). Стороны читаются сейчас, а не лежат в снимке, поэтому снимок сперва
     * догоняется: иначе номера строк разошлись бы с патчем итерации, на которую ссылается `fileId`.
     */
    async getFileContent(fileId: HostId): Promise<FileContent | null> {
        const snapshot = await this.rebuild(false);
        const entry = snapshot.entries.get(fileId);
        if (entry === undefined) {
            throw new Error(
                fileId.startsWith(`${snapshot.diffId}:`)
                    ? `file ${fileId} is not in the diff`
                    : `file ${fileId} belongs to an older diff: the working tree has changed since`,
            );
        }
        if (entry.file.binary) {
            return null;
        }

        const repo = await this.repo();
        const [oldSide, newSide] = await Promise.all([
            readSideBytes(repo, snapshot.baseCommit, entry, 'old'),
            readSideBytes(repo, snapshot.baseCommit, entry, 'new'),
        ]);
        if (oldSide.kind === 'oversized' || newSide.kind === 'oversized') {
            return null;
        }
        return {
            oldText: oldSide.kind === 'bytes' ? oldSide.bytes.toString('utf8') : null,
            newText: newSide.kind === 'bytes' ? newSide.bytes.toString('utf8') : null,
        };
    }

    async getBlob(blobId: HostId): Promise<Uint8Array | null> {
        await this.snapshot();
        const bytes = this.blobs.get(blobId);
        return bytes === undefined ? null : bytes.slice();
    }

    /**
     * Все файлы диффа — зона ревьюера: правил владения локально нет, человек смотрит правки
     * своего рабочего дерева целиком.
     */
    async ownershipLens(): Promise<Lens> {
        const diff = await this.getDiff();
        return {
            id: 'mine',
            label: 'My files',
            paths: diff.files.map((file) => file.path),
            available: true,
            note: null,
            zones: null,
        };
    }

    extraLenses(): Promise<Lens[]> {
        return Promise.resolve([]);
    }

    private userOf(login: string): ReviewUser {
        return { login, displayName: null, bot: false, avatarUrl: null };
    }

    private publishVerdicts(): readonly Verdict[] {
        return this.verdicts === null ? COMMENT_ONLY : WITH_VERDICTS;
    }

    /** Сохранённый режим публикации в вердикты шапки. `comment` вердиктом не считается. */
    private verdictsOf(verdict: Verdict, login: string): ReviewerVerdict[] {
        switch (verdict) {
            case 'comment':
                return [];
            case 'ship':
            case 'sticky_ship':
            case 'request_changes':
                return [{ user: this.userOf(login), verdict }];
            default:
                return unreachableVerdict(verdict);
        }
    }

    /** Свой опубликованный комментарий; всё остальное — отказ с причиной. */
    private requirePublishedOwn(data: LocalReviewData, snapshot: LocalSnapshot, commentId: HostId): Located {
        const found = locate(data.threads, commentId);
        if (found === null) {
            throw new Error(`comment ${commentId} is not found`);
        }
        if (found.comment.draft) {
            throw new Error(`comment ${commentId} is a draft: use the draft handles`);
        }
        if (found.comment.author.login !== snapshot.login) {
            throw new Error(`comment ${commentId} belongs to ${found.comment.author.login} and cannot be changed`);
        }
        return found;
    }

    /** Один тред раунда для агента; треда нет в хранилище — честная пометка вместо контекста. */
    private feedbackThread(
        snapshot: LocalSnapshot,
        thread: LocalThread | null,
        threadId: string,
    ): FeedbackThread {
        if (thread === null) {
            return {
                threadId,
                path: null,
                file: null,
                position: null,
                excerpt: null,
                note: 'this thread is gone from the local review state',
                resolved: false,
                comments: [],
            };
        }

        const root = feedbackCommentOf(thread.root);
        if (root === null) {
            return {
                threadId,
                path: null,
                file: null,
                position: null,
                excerpt: null,
                note: 'this thread has no published comments yet',
                resolved: thread.resolved,
                comments: [],
            };
        }

        const anchor = thread.anchor;
        const comments = [root];
        if (anchor === null) {
            return {
                threadId,
                path: null,
                file: null,
                position: null,
                excerpt: null,
                note: null,
                resolved: thread.resolved,
                comments,
            };
        }

        const file = snapshot.files.find((candidate) => candidate.path === anchor.path) ?? null;
        const outdated = thread.fileHash === null || snapshot.fileHashByPath.get(anchor.path) !== thread.fileHash;
        const excerpt =
            file === null || outdated || anchor.position === null
                ? null
                : patchExcerpt(file.patch, anchor.position);
        return {
            threadId,
            path: anchor.path,
            file: path.join(this.options.projectDir, anchor.path),
            position: anchor.position,
            excerpt,
            note: excerptNote(file === null, outdated, anchor.position, excerpt),
            resolved: thread.resolved,
            comments,
        };
    }

    /**
     * Правка хранилища: запись на диск и свежий снапшот подписчикам — одним шагом. Мутации идут
     * очередью: состояние тредов общее, и параллельные «прочитать — поправить — записать» разошлись
     * бы между памятью и диском.
     */
    private mutate<T>(change: (data: LocalReviewData, snapshot: LocalSnapshot) => T): Promise<T> {
        const next = this.mutations.then(async () => {
            const snapshot = await this.snapshot();
            const data = await this.reviewData();

            const result = change(data, snapshot);
            await this.options.threads.write(data);
            this.emitThreads(snapshot, data);
            return result;
        });
        // Отказ одной мутации не должен ронять следующие: очередь помнит только очерёдность.
        this.mutations = next.then(
            () => undefined,
            () => undefined,
        );
        return next;
    }

    private emitThreads(snapshot: LocalSnapshot, data: LocalReviewData): void {
        for (const watcher of this.threadWatchers) {
            watcher(threadsOf(snapshot, data));
        }
    }

    private emitIterations(): void {
        for (const watcher of this.iterationWatchers) {
            watcher(this.iterationList());
        }
    }

    /** Итерации из истории: последняя активна, остальные — прошлые. */
    private iterationList(): Iteration[] {
        const history = this.historyValue ?? [];
        return history.map((record, index) => ({
            diffId: record.diffId,
            baseCommit: record.baseCommit,
            headCommit: record.headCommit,
            createdAt: record.createdAt,
            status: index === history.length - 1 ? 'active' : 'previous',
        }));
    }

    /**
     * Срез между двумя итерациями истории. Итерации, которой в истории нет, хост не знает
     * никогда — это окончательный отказ (`bad_request`), а не повод повторять запрос.
     */
    private async sliceOf(base: HostId, head: HostId): Promise<PrDiff> {
        await this.snapshot();
        const history = await this.history();
        const find = (diffId: HostId): LocalIterationRecord => {
            const found = history.find((record) => record.diffId === diffId);
            if (found === undefined) {
                throw new RpcFailure('bad_request', `iteration ${diffId} is unknown to the local host`);
            }
            return found;
        };
        return localInterdiff(this.options.iterations, find(base), find(head));
    }

    /** История итераций: с диска читается один раз, дальше её ведёт сам адаптер. */
    private history(): Promise<LocalIterationRecord[]> {
        const known = this.historyValue;
        if (known !== null) {
            return Promise.resolve(known);
        }
        this.historyPromise ??= this.options.iterations
            .read()
            .then((records) => {
                this.historyValue ??= records;
                return this.historyValue;
            })
            .catch((error: unknown) => {
                this.historyPromise = null;
                throw error;
            });
        return this.historyPromise;
    }

    /**
     * Снимок в истории: тот же дифф, что у последней записи, — та же итерация (её и поднимает
     * перезапуск сервера), иначе новая запись. Возвращает момент рождения итерации: у поднятой
     * из истории он свой, а не сегодняшний.
     *
     * История — производные данные: её потеря стоит переноса прогресса, но не всего экрана
     * ревью. Хранилище отказало — пишем в лог и живём тем, что от истории осталось в памяти,
     * а не роняем `getPr`, `getDiff` и `listIterations` вместе со снимком.
     */
    private async recordIteration(snapshot: LocalSnapshot): Promise<string> {
        const record: LocalIterationRecord = {
            diffId: snapshot.diffId,
            baseCommit: snapshot.baseCommit,
            headCommit: snapshot.headCommit,
            createdAt: snapshot.createdAt,
            files: snapshot.iterationFiles,
        };

        let known: LocalIterationRecord[];
        try {
            known = await this.history();
        } catch (error) {
            // Прошлых итераций хост не знает: срез по ним получит тот же окончательный отказ,
            // что и по итерации, которой не было.
            this.log(`история итераций не прочитана: ${messageOf(error)}`);
            known = [];
        }

        const last = known.at(-1);
        if (last?.diffId === snapshot.diffId) {
            return last.createdAt;
        }

        try {
            this.historyValue = await this.options.iterations.append(record, snapshot.textBlobs);
        } catch (error) {
            this.log(`итерация ${record.diffId} не записана в историю: ${messageOf(error)}`);
            // Итерация остаётся только в памяти: её блобов в хранилище нет, и срез покажет
            // файлы без патчей — прогресс не переедет, но ревью работает. Следующая запись
            // снова пойдёт в хранилище, поэтому починившийся диск подхватится сам.
            this.historyValue = appendToHistory(known, record);
            this.historyPromise = null;
        }
        return record.createdAt;
    }

    private reviewData(): Promise<LocalReviewData> {
        this.dataPromise ??= this.options.threads.read().catch((error: unknown) => {
            this.dataPromise = null;
            throw error;
        });
        return this.dataPromise;
    }

    private repo(): Promise<LocalRepo> {
        this.repoPromise ??= openLocalRepo(this.options.vcs, this.options.projectDir).catch(
            (error: unknown) => {
                this.repoPromise = null;
                throw error;
            },
        );
        return this.repoPromise;
    }

    /**
     * Снимок рабочего дерева. Первый считается лениво, при первом обращении: старт сервера
     * его не ждёт (`docs/architecture.md §6`).
     */
    private async snapshot(): Promise<LocalSnapshot> {
        if (this.failure !== null) {
            throw this.failure;
        }
        const current = this.current;
        if (current !== null) {
            return current;
        }
        return this.rebuild(true);
    }

    /**
     * Пересчёт снимка; параллельные вызовы делят один проход. Принудительный вызов проход не
     * делит, а встаёт за ним: идущий пересчёт начался до правки, ради которой зовут `force`.
     */
    private rebuild(force: boolean): Promise<LocalSnapshot> {
        const running = this.snapshotPromise;
        if (running !== null && !force) {
            return running;
        }

        const started =
            running === null
                ? this.recompute(force)
                : running.then(
                      () => this.recompute(force),
                      () => this.recompute(force),
                  );
        const tracked: Promise<LocalSnapshot> = started.finally(() => {
            // Хвост очереди мог уехать вперёд: обнуляет только последний проход.
            if (this.snapshotPromise === tracked) {
                this.snapshotPromise = null;
            }
        });
        this.snapshotPromise = tracked;
        return tracked;
    }

    private async recompute(force: boolean): Promise<LocalSnapshot> {
        const repo = await this.repo();
        const probe = await probeLocal(repo, this.options.base);
        this.checkBranch(probe.info.branch);

        const known = this.current;
        if (known !== null && !force && known.stamp === probe.stamp) {
            // Дешёвая проверка сошлась: дерево не трогали, читать дифф незачем.
            return known;
        }

        const built = await buildLocalSnapshot(repo, probe, this.now().toISOString());
        for (const [blobId, bytes] of built.blobs) {
            this.blobs.set(blobId, bytes);
        }

        const previous = this.current;
        if (previous !== null && previous.diffId === built.diffId) {
            // Дифф тот же — итерация не меняется; свежим берём только отпечаток опроса.
            this.current = { ...previous, stamp: built.stamp };
            return this.current;
        }

        // Момент рождения итерации — из истории: перезапуск сервера поднимает её, а не заводит новую.
        const createdAt = await this.recordIteration(built);
        const snapshot = createdAt === built.createdAt ? built : { ...built, createdAt };
        this.current = snapshot;
        if (previous !== null) {
            this.emitIterations();
            this.emitThreads(snapshot, await this.reviewData());
        }
        return snapshot;
    }

    /**
     * Ключ ревью держит каталог и ветку: на другой ветке это другое ревью, и отдавать под старым
     * ключом чужой дифф нельзя. Ветка вернулась — следующий опрос снимает отказ.
     */
    private checkBranch(branch: string): void {
        if (this.expectedBranch === null) {
            this.expectedBranch = branch;
            this.options.onBranchResolved?.(branch);
        }
        if (this.expectedBranch !== branch) {
            this.failure = new Error(
                `checkout switched to branch ${branch}; run \`devflow-diff-explain up --local ${this.options.projectDir}\` again`,
            );
            throw this.failure;
        }
        this.failure = null;
    }

    private startPolling(): void {
        if (this.timer !== null) {
            return;
        }
        this.timer = setInterval(() => {
            void this.rebuild(false).catch(() => {
                // Тик опроса не роняет подписки: причину покажет ближайший вызов ручки.
            });
        }, this.pollIntervalMs);
        this.timer.unref();
    }

    private stopPollingIfIdle(): void {
        if (this.timer === null || this.threadWatchers.size > 0 || this.iterationWatchers.size > 0) {
            return;
        }
        clearInterval(this.timer);
        this.timer = null;
    }
}

/**
 * Треды наружу: свежие копии, якоря переанкорены на активную итерацию по пути файла.
 * Устаревание считается по файлу, а не по всему диффу: пока файл треда байт в байт тот же,
 * тред переезжает пином на активную итерацию и остаётся на своих строках. Файл поменялся
 * или исчез из диффа — тред устарел и держит пин той итерации, на которой написан.
 */
function threadsOf(snapshot: LocalSnapshot, data: LocalReviewData): Thread[] {
    return data.threads.map((thread) => {
        const anchor = thread.anchor;
        const unchanged =
            thread.fileHash !== null &&
            anchor !== null &&
            snapshot.fileHashByPath.get(anchor.path) === thread.fileHash;

        return {
            id: thread.id,
            anchor:
                anchor === null
                    ? null
                    : {
                          fileId:
                              snapshot.fileIdByPath.get(anchor.path) ??
                              thread.fileId ??
                              `${snapshot.diffId}:${anchor.path}`,
                          path: anchor.path,
                          position: anchor.position,
                      },
            resolved: thread.resolved,
            resolvedBy: thread.resolvedBy,
            outdated: anchor !== null && !unchanged,
            pinnedTo:
                anchor === null
                    ? null
                    : unchanged
                      ? { diffId: snapshot.diffId, commit: snapshot.headCommit }
                      : thread.pinnedTo,
            root: commentOf(thread.root),
        };
    });
}

/**
 * Комментарий наружу; ни issue, ни резолва по комментарию у локального хоста нет
 * (`capabilities.commentIssues`, `capabilities.commentResolve`).
 */
function commentOf(comment: LocalComment): Comment {
    return {
        id: comment.id,
        author: comment.author,
        body: comment.body,
        draft: comment.draft,
        issue: null,
        resolved: null,
        createdAt: comment.createdAt,
        editedAt: comment.editedAt,
        replies: comment.replies.map(commentOf),
    };
}

/**
 * Комментарий треда агенту; null — это черновик. Контекст раунда читается в момент постановки
 * задачи, а не публикации, и черновик, написанный между ними, наружу уходить не имеет права.
 */
function feedbackCommentOf(comment: LocalComment): FeedbackComment | null {
    if (comment.draft) {
        return null;
    }
    return {
        author: comment.author,
        createdAt: comment.createdAt,
        body: comment.body,
        replies: comment.replies.flatMap((reply) => {
            const published = feedbackCommentOf(reply);
            return published === null ? [] : [published];
        }),
    };
}

/** Почему фрагмента патча нет; null — фрагмент на месте. */
function excerptNote(
    missingFile: boolean,
    outdated: boolean,
    position: AnchorPosition | null,
    excerpt: string | null,
): string | null {
    if (missingFile) {
        return 'the file is no longer in the diff of the working tree';
    }
    if (outdated) {
        return 'the thread is outdated: the file changed after the comment was written';
    }
    if (position === null) {
        return 'the comment is on the whole file, not on a line';
    }
    return excerpt === null ? 'the anchored lines are outside the patch of this file' : null;
}

/**
 * Фрагмент патча вокруг якоря: строки якоря плюс `EXCERPT_CONTEXT_LINES` с каждой стороны,
 * с тем же гаттером `old new | line`, что у контекста чата. null — якорь вне патча.
 */
function patchExcerpt(patch: string | null, position: AnchorPosition): string | null {
    if (patch === null) {
        return null;
    }

    const lines = [...walkPatch(patch)].filter((line) => line.old !== null || line.new !== null);
    const end = position.line + position.size - 1;
    const first = lines.findIndex((line) => inAnchor(line, position.side, position.line, end));
    if (first === -1) {
        return null;
    }
    let last = first;
    for (let index = lines.length - 1; index >= first; index -= 1) {
        const line = lines[index];
        if (line !== undefined && inAnchor(line, position.side, position.line, end)) {
            last = index;
            break;
        }
    }

    return lines
        .slice(Math.max(0, first - EXCERPT_CONTEXT_LINES), last + 1 + EXCERPT_CONTEXT_LINES)
        .map(formatExcerptLine)
        .join('\n');
}

function inAnchor(line: PatchLine, side: 'old' | 'new', start: number, end: number): boolean {
    const number = line[side];
    return number !== null && number >= start && number <= end;
}

function formatExcerptLine(line: PatchLine): string {
    return `${gutterCell(line.old)} ${gutterCell(line.new)} | ${line.raw}`;
}

function gutterCell(value: number | null): string {
    return (value === null ? '.' : String(value)).padStart(5, ' ');
}

interface Located {
    readonly thread: LocalThread;
    /** null — комментарий является корнем треда. */
    readonly parent: LocalComment | null;
    readonly comment: LocalComment;
}

function locate(threads: readonly LocalThread[], id: string): Located | null {
    for (const thread of threads) {
        const found = locateIn(thread, null, thread.root, id);
        if (found !== null) {
            return found;
        }
    }
    return null;
}

function locateIn(
    thread: LocalThread,
    parent: LocalComment | null,
    comment: LocalComment,
    id: string,
): Located | null {
    if (comment.id === id) {
        return { thread, parent, comment };
    }
    for (const reply of comment.replies) {
        const found = locateIn(thread, comment, reply, id);
        if (found !== null) {
            return found;
        }
    }
    return null;
}

function findByKey(threads: readonly LocalThread[], key: string): LocalComment | null {
    for (const thread of threads) {
        for (const comment of flatten(thread.root)) {
            if (comment.idempotencyKey === key) {
                return comment;
            }
        }
    }
    return null;
}

function flatten(comment: LocalComment): LocalComment[] {
    return [comment, ...comment.replies.flatMap(flatten)];
}

function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function unreachableVerdict(verdict: never): never {
    throw new Error(`unknown verdict ${String(verdict)}`);
}

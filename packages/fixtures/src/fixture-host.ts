import type {
    Comment,
    CommentDraft,
    FileContent,
    HostId,
    Iteration,
    Lens,
    PrDiff,
    PrMeta,
    PublishResult,
    ReviewHost,
    Thread,
    Verdict,
} from '@sherpa/protocol';
import { commentDraftSchema, IMAGE_BLOB_MAX_BYTES, verdictSchema } from '@sherpa/protocol';

import type { FixtureData, FixtureIteration, FixtureName } from './data/index.js';
import { fixtureData } from './data/index.js';
import { fileContentOf } from './file-content.js';
import { fixtureBlob } from './patch.js';

    /**
 * Реализация `ReviewHost` на детерминированных фикстурах. На ней живут
 * разработка UI без настоящего хоста, галерея состояний, контрактные тесты и e2e.
 *
 * Правила:
 * - никаких `Date.now()`/`Math.random()`: таймштампы мутаций считаются от `mutationEpoch`
 *   фикстуры фиксированным шагом, id черновиков — от счётчика мутаций;
 * - мутации живут в памяти до конца процесса и никуда не персистятся;
 * - наружу отдаются копии: потребитель не может испортить состояние хоста через отданный объект.
 */

/** Шаг между таймштампами мутаций: минута — чтобы порядок черновиков читался глазами. */
const MUTATION_STEP_MS = 60_000;

/** Базы id черновиков: у инлайновых id положительный, у PR-level — отрицательный. */
const INLINE_DRAFT_ID_BASE = 9_000_000;
const PR_LEVEL_DRAFT_ID_BASE = 70_000;

export interface FixtureHostOptions {
    /**
     * Комментарии, которые `publishBatch` уронит: фикстурный хук для проверки частичного провала
     * публикации — вердикт тогда не применяется (`docs/architecture.md`).
     */
    readonly failPublishFor?: readonly HostId[];
    /**
     * Записи черновиков падают: фикстурный хук под буфер черновиков — «хост отказал,
     * текст остаётся у сервера». Переключается на живом хосте через `setFailDraftWrites`.
     */
    readonly failDraftWrites?: boolean;
}

interface Located {
    thread: Thread;
    /** null — комментарий является корнем треда. */
    parent: Comment | null;
    comment: Comment;
}

function locateIn(thread: Thread, parent: Comment | null, comment: Comment, id: HostId): Located | null {
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

function locate(threads: readonly Thread[], id: HostId): Located | null {
    for (const thread of threads) {
        const found = locateIn(thread, null, thread.root, id);
        if (found !== null) {
            return found;
        }
    }
    return null;
}

function collectDrafts(comment: Comment, into: Comment[]): void {
    if (comment.draft) {
        into.push(comment);
    }
    for (const reply of comment.replies) {
        collectDrafts(reply, into);
    }
}

/**
 * Инвариант контракта: `Comment.issue`/`Comment.resolved` равны `null` только у хоста без
 * соответствующей возможности. Конструкторы фикстур статуса обычно не ставят — хост проставляет
 * свой на входе.
 */
function normalizeIssues(threads: readonly Thread[], issues: boolean, resolves: boolean): void {
    const walk = (comment: Comment): void => {
        comment.issue = issues ? (comment.issue ?? false) : null;
        comment.resolved = resolves ? (comment.resolved ?? false) : null;
        for (const reply of comment.replies) {
            walk(reply);
        }
    };
    for (const thread of threads) {
        walk(thread.root);
    }
}

function eachComment(comment: Comment, visit: (found: Comment) => void): void {
    visit(comment);
    for (const reply of comment.replies) {
        eachComment(reply, visit);
    }
}

/**
 * Правило хоста с резолвом по комментарию: тред закрыт, если в нём есть хотя бы один комментарий
 * с issue и все они закрыты. Тред без issue открыт всегда — закрывать в нём нечего.
 */
function resolvedByRule(thread: Thread): boolean {
    const issues: Comment[] = [];
    eachComment(thread.root, (comment) => {
        if (comment.issue === true) {
            issues.push(comment);
        }
    });
    return issues.length > 0 && issues.every((comment) => comment.resolved === true);
}

/**
 * Пересчёт `Thread.resolved` по правилу. `by` — кто последним трогал статус; null оставляет
 * прежнюю подпись (данные фикстуры называют её сами).
 */
function applyResolveRule(thread: Thread, by: string | null): void {
    thread.resolved = resolvedByRule(thread);
    if (!thread.resolved) {
        thread.resolvedBy = null;
    } else if (by !== null) {
        thread.resolvedBy = by;
    }
}

/**
 * Приведение объявленного в данных треда к правилу: тред, помеченный закрытым, но без единого
 * issue, закрывает свой корень — иначе правило открыло бы его и фикстура рассказывала бы
 * не о том состоянии, ради которого её писали.
 */
function normalizeThreadResolve(thread: Thread): void {
    if (thread.resolved && !resolvedByRule(thread)) {
        thread.root.issue = true;
        thread.root.resolved = true;
    }
    applyResolveRule(thread, null);
}

/**
 * Метка статуса после применённого вердикта — словами хоста, как он её показывает;
 * null — у режима вердикта нет, статус не меняется.
 */
const STATUS_LABELS: Readonly<Record<Verdict, string | null>> = {
    comment: null,
    ship: 'shipped',
    sticky_ship: 'shipped',
    request_changes: 'needs_work',
};

export class FixtureHost implements ReviewHost {
    readonly ownershipSource = 'CODEOWNERS';

    private readonly data: FixtureData;
    private readonly failPublishFor: ReadonlySet<HostId>;
    private readonly watchers = new Set<(threads: Thread[]) => void>();
    private readonly iterationWatchers = new Set<(iterations: Iteration[]) => void>();

    /** Указатель активной итерации: `advanceIteration` двигает его на одну вперёд. */
    private active = 0;

    /** Номер следующей мутации: из него растут и таймштампы, и id создаваемых черновиков. */
    private mutations = 0;

    /** Последний применённый вердикт — фикстурная наблюдаемость для тестов и галереи состояний. */
    private verdict: Verdict | null = null;

    /** Записи черновиков отказывают: дев-переключатель под буфер черновиков. */
    private failDraftWrites: boolean;

    /** Есть только когда хост фикстуры умеет viewed-отметки (`capabilities.fileViewedSync`). */
    setFileViewed?: (fileId: HostId, viewed: boolean) => Promise<void>;

    /** Есть только когда хост фикстуры умеет содержимое файлов (`capabilities.fileContent`). */
    getFileContent?: (fileId: HostId) => Promise<FileContent | null>;

    /** Есть только когда хост фикстуры умеет байты картинок (`capabilities.blobs`). */
    getBlob?: (blobId: HostId) => Promise<Uint8Array | null>;

    /** Есть только когда хост фикстуры резолвит по комментарию (`capabilities.commentResolve`). */
    setCommentResolved?: (commentId: HostId, resolved: boolean) => Promise<void>;

    /** Есть только когда хост фикстуры правит опубликованное (`capabilities.editPublished`). */
    updateComment?: (commentId: HostId, body: string, issue?: boolean) => Promise<void>;

    deleteComment?: (commentId: HostId) => Promise<void>;

    constructor(name: FixtureName, options: FixtureHostOptions = {}) {
        this.data = fixtureData(name);
        this.failPublishFor = new Set(options.failPublishFor ?? []);
        this.failDraftWrites = options.failDraftWrites ?? false;
        // Данные фикстур issue-статус обычно не задают; инвариант контракта чинится здесь, чтобы
        // каждый комментарий каждого файла данных не приходилось помечать вручную.
        const capabilities = this.data.pr.capabilities;
        for (const iteration of this.data.iterations) {
            normalizeIssues(iteration.threads, capabilities.commentIssues, capabilities.commentResolve);
            if (capabilities.commentResolve) {
                for (const thread of iteration.threads) {
                    normalizeThreadResolve(thread);
                }
            }
        }

        if (this.data.pr.capabilities.fileViewedSync) {
            this.setFileViewed = (fileId, viewed) => this.applyFileViewed(fileId, viewed);
        }
        if (this.data.pr.capabilities.fileContent) {
            this.getFileContent = (fileId) => this.loadFileContent(fileId);
        }
        if (this.data.pr.capabilities.blobs) {
            this.getBlob = (blobId) => this.loadBlob(blobId);
        }
        if (capabilities.commentResolve) {
            this.setCommentResolved = (commentId, resolved) => this.applyCommentResolved(commentId, resolved);
        }
        if (capabilities.editPublished) {
            this.updateComment = (commentId, body, issue) => this.applyUpdateComment(commentId, body, issue);
            this.deleteComment = (commentId) => this.applyDeleteComment(commentId);
        }
    }

    getPr(): Promise<PrMeta> {
        // «Я» фикстуры — и автор черновиков, и тот, кто смотрит PR.
        return Promise.resolve({ ...structuredClone(this.data.pr), viewer: structuredClone(this.data.currentUser) });
    }

    /** Итерации до активной включительно; переписанные force-push'ем не перечисляются вовсе. */
    listIterations(): Promise<Iteration[]> {
        return Promise.resolve(this.iterationsSnapshot());
    }

    /**
     * Дифф активной итерации, а со `slice` — объявленный в фикстуре срез между двумя
     * перечисляемыми итерациями. Всё, чего в данных нет, отклоняется понятной ошибкой:
     * молча отдать дифф не той итерации хуже, чем отказать.
     */
    getDiff(slice?: { base: HostId; head: HostId }): Promise<PrDiff> {
        if (slice === undefined) {
            return Promise.resolve(structuredClone(this.activeData().diff));
        }
        if (!this.data.pr.capabilities.iterations) {
            return Promise.reject(new Error('хост не поддерживает срезы между итерациями (capabilities.iterations)'));
        }

        const listed = new Set(this.listed().map((iteration) => iteration.iteration.diffId));
        for (const diffId of [slice.base, slice.head]) {
            if (!listed.has(diffId)) {
                return Promise.reject(new Error(`итерация ${diffId} неизвестна хосту`));
            }
        }

        const found = this.data.interdiffs.find(
            (interdiff) => interdiff.base === slice.base && interdiff.head === slice.head,
        );
        if (found === undefined) {
            return Promise.reject(new Error(`среза ${slice.base}→${slice.head} в фикстуре нет`));
        }
        return Promise.resolve(structuredClone(found.diff));
    }

    /** Подписка на итерации: снапшот сразу и после каждого `advanceIteration`. */
    watchIterations(onChange: (iterations: Iteration[]) => void): () => void {
        this.iterationWatchers.add(onChange);
        onChange(this.iterationsSnapshot());
        return () => {
            this.iterationWatchers.delete(onChange);
        };
    }

    /**
     * Фикстурный «пуш»: следующая объявленная итерация становится активной. Ею живут дев-ручка
     * сервера и галерея второго захода; на последней итерации двигаться уже некуда.
     */
    advanceIteration(): Iteration {
        if (this.active + 1 >= this.data.iterations.length) {
            throw new Error('итераций больше нет: фикстура закончилась');
        }
        this.active += 1;
        for (const watcher of this.iterationWatchers) {
            watcher(this.iterationsSnapshot());
        }
        this.emit();
        return this.activeIteration();
    }

    /** Дев-переключатель отказа записи черновиков: им e2e буфера роняет хост на живом сервере. */
    setFailDraftWrites(fail: boolean): void {
        this.failDraftWrites = fail;
    }

    getThreads(): Promise<Thread[]> {
        return Promise.resolve(this.threadsSnapshot());
    }

    watchThreads(onChange: (threads: Thread[]) => void): () => void {
        this.watchers.add(onChange);
        onChange(this.threadsSnapshot());
        return () => {
            this.watchers.delete(onChange);
        };
    }

    /**
     * Ключ идемпотентности фикстура игнорирует: дубли ей не страшны, а контракт обязан принимать
     * параметр — на нём стоит повтор записи из буфера черновиков.
     */
    saveDraft(draft: CommentDraft, _options?: { idempotencyKey?: string }): Promise<Comment> {
        if (this.failDraftWrites) {
            return Promise.reject(new Error('фикстурный хост отказывается принимать черновики'));
        }
        const parsed = commentDraftSchema.parse(draft);
        const createdAt = this.nextTimestamp();

        if (parsed.parentId !== null) {
            const found = locate(this.activeData().threads, parsed.parentId);
            if (found === null) {
                return Promise.reject(new Error(`родительский комментарий ${parsed.parentId} не найден`));
            }
            const reply = this.makeDraftComment(parsed.body, createdAt, found.thread.anchor === null);
            this.applyIssueFlag(reply, parsed.issue);
            found.comment.replies.push(reply);
            this.reapplyResolveRule(found.thread);
            this.emit();
            return Promise.resolve(structuredClone(reply));
        }

        const root = this.makeDraftComment(parsed.body, createdAt, parsed.anchor === null);
        this.applyIssueFlag(root, parsed.issue);
        this.activeData().threads.push({
            id: root.id,
            anchor: parsed.anchor,
            // Новый тред открыт по обоим правилам: закрытых issue в нём быть неоткуда.
            resolved: false,
            resolvedBy: null,
            outdated: false,
            pinnedTo:
                parsed.anchor === null
                    ? null
                    : {
                          diffId: this.activeData().diff.diffId,
                          commit: this.activeData().diff.headCommit,
                      },
            root,
        });
        this.emit();
        return Promise.resolve(structuredClone(root));
    }

    updateDraft(commentId: HostId, body: string, issue?: boolean): Promise<void> {
        if (this.failDraftWrites) {
            return Promise.reject(new Error('фикстурный хост отказывается принимать черновики'));
        }
        const found = locate(this.activeData().threads, commentId);
        if (found === null) {
            return Promise.reject(new Error(`комментарий ${commentId} не найден`));
        }
        if (!found.comment.draft) {
            return Promise.reject(new Error(`комментарий ${commentId} уже опубликован и не редактируется`));
        }
        found.comment.body = body;
        this.applyIssueFlag(found.comment, issue);
        found.comment.editedAt = this.nextTimestamp();
        this.reapplyResolveRule(found.thread);
        this.emit();
        return Promise.resolve();
    }

    /** Черновик стирается физически, а не помечается удалённым. */
    deleteDraft(commentId: HostId): Promise<void> {
        const found = locate(this.activeData().threads, commentId);
        if (found === null) {
            return Promise.reject(new Error(`комментарий ${commentId} не найден`));
        }
        if (!found.comment.draft) {
            return Promise.reject(new Error(`комментарий ${commentId} уже опубликован и не удаляется`));
        }
        if (found.comment.replies.length > 0) {
            // Иначе удаление корня молча унесло бы поддерево — лучше явная ошибка.
            return Promise.reject(new Error(`у черновика ${commentId} есть ответы: сначала удалите их`));
        }

        if (found.parent === null) {
            const active = this.activeData();
            active.threads = active.threads.filter((thread) => thread !== found.thread);
        } else {
            found.parent.replies = found.parent.replies.filter((reply) => reply !== found.comment);
            this.reapplyResolveRule(found.thread);
        }
        this.emit();
        return Promise.resolve();
    }

    /**
     * Resolve уровня треда. У хоста с резолвом по комментарию это статус
     * корневого комментария: он становится issue в нужном состоянии, а сам тред пересчитывается
     * по правилу — открытый issue в ответе оставит тред открытым.
     */
    setThreadResolved(threadId: HostId, resolved: boolean): Promise<void> {
        const thread = this.activeData().threads.find((candidate) => candidate.id === threadId);
        if (thread === undefined) {
            return Promise.reject(new Error(`тред ${threadId} не найден`));
        }
        if (this.data.pr.capabilities.commentResolve) {
            thread.root.issue = true;
            thread.root.resolved = resolved;
            applyResolveRule(thread, this.data.currentUser.login);
        } else {
            thread.resolved = resolved;
            thread.resolvedBy = resolved ? this.data.currentUser.login : null;
        }
        this.emit();
        return Promise.resolve();
    }

    /** Resolve одного issue-комментария; у комментария без issue закрывать нечего — отказ. */
    private applyCommentResolved(commentId: HostId, resolved: boolean): Promise<void> {
        const found = locate(this.activeData().threads, commentId);
        if (found === null) {
            return Promise.reject(new Error(`комментарий ${commentId} не найден`));
        }
        if (found.comment.issue !== true) {
            return Promise.reject(new Error(`комментарий ${commentId} не открывает issue: закрывать нечего`));
        }
        found.comment.resolved = resolved;
        applyResolveRule(found.thread, this.data.currentUser.login);
        this.emit();
        return Promise.resolve();
    }

    /** Правка своего опубликованного комментария; черновики ходят через `updateDraft`. */
    private applyUpdateComment(commentId: HostId, body: string, issue?: boolean): Promise<void> {
        const found = locate(this.activeData().threads, commentId);
        if (found === null) {
            return Promise.reject(new Error(`комментарий ${commentId} не найден`));
        }
        if (found.comment.draft) {
            return Promise.reject(new Error(`комментарий ${commentId} — черновик: правьте его через updateDraft`));
        }
        if (found.comment.author.login !== this.data.currentUser.login) {
            return Promise.reject(new Error(`комментарий ${commentId} чужой и не редактируется`));
        }
        found.comment.body = body;
        this.applyIssueFlag(found.comment, issue);
        found.comment.editedAt = this.nextTimestamp();
        this.reapplyResolveRule(found.thread);
        this.emit();
        return Promise.resolve();
    }

    /** Удаление своего опубликованного комментария; у фикстуры оно физическое. */
    private applyDeleteComment(commentId: HostId): Promise<void> {
        const found = locate(this.activeData().threads, commentId);
        if (found === null) {
            return Promise.reject(new Error(`комментарий ${commentId} не найден`));
        }
        if (found.comment.draft) {
            return Promise.reject(new Error(`комментарий ${commentId} — черновик: удаляйте его через deleteDraft`));
        }
        if (found.comment.author.login !== this.data.currentUser.login) {
            return Promise.reject(new Error(`комментарий ${commentId} чужой и не удаляется`));
        }
        if (found.comment.replies.length > 0) {
            return Promise.reject(new Error(`у комментария ${commentId} есть ответы: сначала удалите их`));
        }

        if (found.parent === null) {
            const active = this.activeData();
            active.threads = active.threads.filter((thread) => thread !== found.thread);
        } else {
            found.parent.replies = found.parent.replies.filter((reply) => reply !== found.comment);
            this.reapplyResolveRule(found.thread);
        }
        this.emit();
        return Promise.resolve();
    }

/**
     * Публикует все накопленные черновики. Вердикт вне `publishVerdicts` отклоняется, `comment`
     * без черновиков ничего не меняет. Вердикт применяется, только если опубликовались
     * все (`docs/architecture.md`); несдавшиеся остаются черновиками, и ревью не считается завершённым.
     */
    publishBatch(verdict: Verdict): Promise<PublishResult> {
        const parsed = verdictSchema.parse(verdict);
        if (!this.data.pr.capabilities.publishVerdicts.includes(parsed)) {
            return Promise.reject(new Error(`вердикт ${parsed} на этом PR недоступен (capabilities.publishVerdicts)`));
        }

        const drafts: Comment[] = [];
        for (const thread of this.activeData().threads) {
            collectDrafts(thread.root, drafts);
        }
        // Публиковать нечего и применять нечего: хост не меняется вовсе.
        if (parsed === 'comment' && drafts.length === 0) {
            return Promise.resolve({ publishedCommentIds: [], failed: [], verdictApplied: true });
        }

        const publishedCommentIds: HostId[] = [];
        const failed: { commentId: HostId; message: string }[] = [];
        for (const draft of drafts) {
            if (this.failPublishFor.has(draft.id)) {
                failed.push({ commentId: draft.id, message: 'фикстура: публикация этого комментария настроена падать' });
                continue;
            }
            draft.draft = false;
            publishedCommentIds.push(draft.id);
        }

        const verdictApplied = failed.length === 0;
        if (verdictApplied) {
            this.verdict = parsed;
            this.data.pr.statusLabel = STATUS_LABELS[parsed] ?? this.data.pr.statusLabel;
            this.data.pr.updatedAt = this.nextTimestamp();
        }

        this.emit();
        return Promise.resolve({ publishedCommentIds, failed, verdictApplied });
    }

    ownershipLens(): Promise<Lens | null> {
        return Promise.resolve(this.data.ownership === null ? null : structuredClone(this.data.ownership));
    }

    extraLenses(): Promise<Lens[]> {
        return Promise.resolve(structuredClone(this.data.extraLenses));
    }

    /** Фикстурная наблюдаемость: какой вердикт применился последним (null — ни одного). */
    appliedVerdict(): Verdict | null {
        return this.verdict;
    }

    /** Issue-статус комментария; `undefined` — такого комментария у хоста нет. */
    issueOf(commentId: HostId): boolean | null | undefined {
        return locate(this.activeData().threads, commentId)?.comment.issue;
    }

    /** Данные активной итерации; указатель всегда внутри массива — пустых фикстур не бывает. */
    private activeData(): FixtureIteration {
        const iteration = this.data.iterations[this.active];
        if (iteration === undefined) {
            throw new Error(`указатель итерации ${String(this.active)} вне фикстуры`);
        }
        return iteration;
    }

    /**
     * Итерации, которые хост сейчас перечисляет: всё до активной включительно, кроме
     * переписанных force-push'ем — их хост уже не видит, а `gone` ставит сервер.
     */
    private listed(): FixtureIteration[] {
        const seen = this.data.iterations.slice(0, this.active + 1);
        const replaced = new Set(seen.map((iteration) => iteration.replaces).filter((id) => id !== null));
        return seen.filter((iteration) => !replaced.has(iteration.iteration.diffId));
    }

    private iterationsSnapshot(): Iteration[] {
        const activeId = this.activeData().iteration.diffId;
        return this.listed().map((iteration) => ({
            ...structuredClone(iteration.iteration),
            status: iteration.iteration.diffId === activeId ? ('active' as const) : ('previous' as const),
        }));
    }

    private activeIteration(): Iteration {
        const activeId = this.activeData().iteration.diffId;
        const found = this.iterationsSnapshot().find((iteration) => iteration.diffId === activeId);
        if (found === undefined) {
            throw new Error('активная итерация не попала в список — такого быть не должно');
        }
        return found;
    }

    /** Неизвестный файл — ошибка хоста, известный без содержимого (binary, картинка) — честный null. */
    private loadFileContent(fileId: HostId): Promise<FileContent | null> {
        const file = this.activeData().diff.files.find((candidate) => candidate.fileId === fileId);
        if (file === undefined) {
            return Promise.reject(new Error(`файл ${fileId} не найден в диффе`));
        }
        return Promise.resolve(file.image === null ? fileContentOf(file) : null);
    }

    /**
     * Байты стороны картинки. Блобы содержательно адресуемы и живут вне итерации: id из среза и
     * из прошлой итерации работает так же, как из активной. Слишком большая сторона — `null`,
     * как у настоящего хоста (лимит контракта).
     */
    private loadBlob(blobId: HostId): Promise<Uint8Array | null> {
        const bytes = fixtureBlob(blobId);
        if (bytes === null || bytes.length > IMAGE_BLOB_MAX_BYTES) {
            return Promise.resolve(null);
        }
        return Promise.resolve(bytes.slice());
    }

    private applyFileViewed(fileId: HostId, viewed: boolean): Promise<void> {
        const file = this.activeData().diff.files.find((candidate) => candidate.fileId === fileId);
        if (file === undefined) {
            return Promise.reject(new Error(`файл ${fileId} не найден в диффе`));
        }
        file.viewed = viewed;
        return Promise.resolve();
    }

    private makeDraftComment(body: string, createdAt: string, prLevel: boolean): Comment {
        const suffix = this.mutations;
        const id = prLevel ? -(PR_LEVEL_DRAFT_ID_BASE + suffix) : INLINE_DRAFT_ID_BASE + suffix;
        return {
            id: String(id),
            author: structuredClone(this.data.currentUser),
            body,
            draft: true,
            issue: this.issueOfNewComment(),
            resolved: this.data.pr.capabilities.commentResolve ? false : null,
            createdAt,
            editedAt: null,
            replies: [],
        };
    }

    /**
     * Свитчер issue комментария; хост без `commentIssues` его не различает и молча пропускает.
     * Снятый issue сбрасывает и `resolved`: у комментария без issue закрывать нечего.
     */
    private applyIssueFlag(comment: Comment, issue: boolean | undefined): void {
        if (!this.data.pr.capabilities.commentIssues || issue === undefined) {
            return;
        }
        comment.issue = issue;
        if (!issue && comment.resolved !== null) {
            comment.resolved = false;
        }
    }

    /** Пересчёт треда по правилу — только у хоста с резолвом по комментарию. */
    private reapplyResolveRule(thread: Thread): void {
        if (this.data.pr.capabilities.commentResolve) {
            applyResolveRule(thread, null);
        }
    }

    /** Стартовый issue-статус комментария: `null` — хост фикстуры issue не различает вовсе. */
    private issueOfNewComment(): boolean | null {
        return this.data.pr.capabilities.commentIssues ? false : null;
    }

    private nextTimestamp(): string {
        this.mutations += 1;
        const epoch = new Date(this.data.mutationEpoch).getTime();
        return new Date(epoch + this.mutations * MUTATION_STEP_MS).toISOString();
    }

    private threadsSnapshot(): Thread[] {
        return structuredClone(this.activeData().threads);
    }

    private emit(): void {
        for (const watcher of this.watchers) {
            watcher(this.threadsSnapshot());
        }
    }
}

export function makeFixtureHost(name: FixtureName, options: FixtureHostOptions = {}): FixtureHost {
    return new FixtureHost(name, options);
}

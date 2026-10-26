import type { Comment, CommentDraft, DraftBufferEntry, HostId, ReviewHost, Thread } from '@sherpa/protocol';
import { commentDraftSchema } from '@sherpa/protocol';

import type { SherpaDatabase, SqlRow } from './db.js';
import type { ReviewFeed } from './review-feed.js';

/**
 * Буфер черновиков (docs/architecture.md §6 «драфты не теряются никогда»).
 *
 * Хранилище — таблица `draft_buffer` этого PR: запись появляется на каждый save/update и
 * исчезает, как только хост её принял. Провал шага «сервер → хост» больше не теряет текст:
 * строка остаётся в буфере, а `DraftBufferWriter` довозит её сам — по таймеру, по кнопке
 * «повторить» и при следующем старте сервера.
 *
 * Это сохранённое состояние композера, а не фантомный комментарий: в снапшот тредов буферные
 * записи не подмешиваются, локальных id комментариев не бывает, полл тредов их не вымывает.
 */

/** Пауза перед повтором по номеру попытки: 10 с → 30 с → минута и дальше каждую минуту. */
const RETRY_DELAYS_MS = [10_000, 30_000, 60_000] as const;

export function retryDelayMs(attempts: number): number {
    return RETRY_DELAYS_MS[attempts - 1] ?? RETRY_DELAYS_MS[RETRY_DELAYS_MS.length - 1] ?? 60_000;
}

interface BufferRow extends SqlRow {
    id: string;
    comment_id: string | null;
    draft_json: string;
    state: string;
    error: string | null;
    attempts: number;
    idempotency_key: string;
    created_at: string;
    updated_at: string;
}

/** Что записать в хост: `commentId === null` — создание, иначе правка своего черновика. */
export interface DraftBufferInput {
    /** `clientKey` композера: он же первичный ключ строки буфера. */
    readonly id: string;
    readonly draft: CommentDraft;
    readonly commentId: HostId | null;
}

export interface DraftBufferStoreOptions {
    readonly db: SherpaDatabase;
    /** Инжектируемые часы, как у остальных сторов: тестам не нужно реальное время. */
    readonly now?: () => Date;
    /**
     * Ключ идемпотентности записи; по умолчанию — её `clientKey`.
     *
     * Ключ выводится из id, а не берётся случайным: ответ на запись мог потеряться уже после
     * успеха хоста, и повтор того же `clientKey` заводит строку заново. Случайный ключ дал бы
     * тогда второй комментарий, а выведенный из id — тот же самый.
     */
    readonly newKey?: (id: string) => string;
}

/**
 * Строки буфера в SQLite этого PR. Ключ идемпотентности выдаётся один раз при вставке и
 * повторно не генерируется: попытки одной записи обязаны уходить в хост под одним ключом.
 */
export class DraftBufferStore {
    private readonly db: SherpaDatabase;
    private readonly now: () => Date;
    private readonly newKey: (id: string) => string;

    constructor(options: DraftBufferStoreOptions) {
        this.db = options.db;
        this.now = options.now ?? ((): Date => new Date());
        this.newKey = options.newKey ?? ((id: string): string => id);
    }

    list(): DraftBufferEntry[] {
        const rows = this.db
            .prepare('SELECT * FROM draft_buffer ORDER BY created_at, rowid')
            .all() as BufferRow[];
        return rows.flatMap((row) => {
            const entry = toEntry(row);
            return entry === null ? [] : [entry];
        });
    }

    get(id: string): DraftBufferEntry | null {
        const row = this.db.prepare('SELECT * FROM draft_buffer WHERE id = ?').get(id) as BufferRow | undefined;
        return row === undefined ? null : toEntry(row);
    }

    /** Ключ идемпотентности записи; `null` — записи нет. */
    idempotencyKeyOf(id: string): string | null {
        const row = this.db.prepare('SELECT idempotency_key FROM draft_buffer WHERE id = ?').get(id) as
            | { idempotency_key: string }
            | undefined;
        return row?.idempotency_key ?? null;
    }

    /**
     * Кладёт (или обновляет) запись композера и переводит её в `pending`.
     *
     * Запись, которая ещё не создана в хосте (`comment_id IS NULL`), остаётся созданием, даже
     * если пришла правкой: композер держит один `clientKey` до успеха создания, и правка его
     * текста — это правка ещё не отправленного черновика, а не `updateDraft` чужого id.
     */
    upsert(input: DraftBufferInput): DraftBufferEntry {
        const parsed = commentDraftSchema.parse(input.draft);
        const at = this.now().toISOString();
        const existing = this.get(input.id);
        // Правка без названного issue говорит «issue не менять», а запись помнит ещё не
        // записанное переключение: перезаписать её целиком значило бы потерять это переключение.
        const draft =
            existing !== null &&
            existing.commentId !== null &&
            parsed.issue === undefined &&
            existing.draft.issue !== undefined
                ? { ...parsed, issue: existing.draft.issue }
                : parsed;
        if (existing === null) {
            this.db
                .prepare(
                    `INSERT INTO draft_buffer (
                        id, comment_id, draft_json, state, error, attempts, idempotency_key, created_at, updated_at
                     ) VALUES (?, ?, ?, 'pending', NULL, 0, ?, ?, ?)`,
                )
                .run(input.id, input.commentId, JSON.stringify(draft), this.newKey(input.id), at, at);
        } else {
            this.db
                .prepare(
                    `UPDATE draft_buffer
                        SET comment_id = ?, draft_json = ?, state = 'pending', updated_at = ?
                      WHERE id = ?`,
                )
                .run(existing.commentId, JSON.stringify(draft), at, input.id);
        }
        const stored = this.get(input.id);
        if (stored === null) {
            throw new Error(`запись буфера ${input.id} не сохранилась`);
        }
        return stored;
    }

    /**
     * Запоминает черновик, созданный по этой записи. Пара переживает саму запись: без неё
     * повторная запись тем же ключом ушла бы в хост созданием, а хост по ключу идемпотентности
     * вернул бы первый комментарий со старым текстом — новый текст пропал бы молча.
     */
    markSaved(id: string, commentId: HostId): void {
        this.db
            .prepare(
                `INSERT INTO draft_buffer_saved (id, comment_id, created_at) VALUES (?, ?, ?)
                 ON CONFLICT(id) DO UPDATE SET comment_id = excluded.comment_id`,
            )
            .run(id, commentId, this.now().toISOString());
    }

    /**
     * Привязывает живую запись к уже созданному черновику: дальнейшие попытки правят его, а не
     * создают заново. Нужна, когда хост принял создание, а ответ до сервера не дошёл.
     */
    attachComment(id: string, commentId: HostId): void {
        this.db
            .prepare('UPDATE draft_buffer SET comment_id = ?, updated_at = ? WHERE id = ?')
            .run(commentId, this.now().toISOString(), id);
        this.markSaved(id, commentId);
    }

    /** Черновик, созданный по этому ключу; `null` — по нему ещё ничего не создавали. */
    savedCommentId(id: string): HostId | null {
        const row = this.db.prepare('SELECT comment_id FROM draft_buffer_saved WHERE id = ?').get(id) as
            | { comment_id: string }
            | undefined;
        return row?.comment_id ?? null;
    }

    /**
     * Забывает всё про удалённый черновик: его запись буфера и пару ключа. Иначе повтор бился бы
     * о «комментарий не найден» вечно, а ship по этому PR не нажать (запись держит гард).
     * Возвращает ключи снятых записей — по ним отменяются таймеры повторов.
     */
    forgetComment(commentId: HostId): string[] {
        const ids = (
            this.db.prepare('SELECT id FROM draft_buffer WHERE comment_id = ?').all(commentId) as { id: string }[]
        ).map((row) => row.id);
        this.db.prepare('DELETE FROM draft_buffer WHERE comment_id = ?').run(commentId);
        this.db.prepare('DELETE FROM draft_buffer_saved WHERE comment_id = ?').run(commentId);
        return ids;
    }

    /** Отмечает провал попытки: состояние `failed`, текст ошибки и +1 к счётчику попыток. */
    markFailed(id: string, error: string): DraftBufferEntry | null {
        this.db
            .prepare(
                `UPDATE draft_buffer
                    SET state = 'failed', error = ?, attempts = attempts + 1, updated_at = ?
                  WHERE id = ?`,
            )
            .run(error, this.now().toISOString(), id);
        return this.get(id);
    }

    /** `false` — записи уже не было (успела уехать в хост или её сбросили). */
    remove(id: string): boolean {
        return this.db.prepare('DELETE FROM draft_buffer WHERE id = ?').run(id).changes > 0;
    }
}

/** Итог записи черновика: `comment` есть только у успешного создания. */
export type DraftBufferWriteResult =
    | { readonly outcome: 'saved'; readonly comment: Comment | null }
    | { readonly outcome: 'buffered'; readonly entry: DraftBufferEntry };

export interface DraftBufferTimers {
    readonly setTimeout: (handler: () => void, ms: number) => ReturnType<typeof setTimeout>;
    readonly clearTimeout: (timer: ReturnType<typeof setTimeout>) => void;
}

export interface DraftBufferWriterOptions {
    /** null — у PR нет хост-адаптера: писать некуда, буфер остаётся пустым. */
    readonly host: ReviewHost | null;
    readonly store: DraftBufferStore;
    /** Каждое изменение буфера двигает ревизию тредов: вкладки перечитывают буфер по SSE. */
    readonly reviewFeed: Pick<ReviewFeed, 'bumpLocalWrite'> | null;
    /** Таймеры повторов; подменяются в тестах. */
    readonly timers?: DraftBufferTimers;
    readonly log?: (message: string) => void;
}

/**
 * Довозчик буфера: одна попытка на запись за раз, повторы с ростом паузы (`retryDelayMs`).
 *
 * Таймер повтора `unref()`-нутый: сервер гаснет по простою (см. `idle.ts`) и ради недовезённого
 * черновика живым не остаётся — оставшиеся записи подхватит `start()` следующего запуска.
 */
export class DraftBufferWriter {
    private readonly host: ReviewHost | null;
    private readonly store: DraftBufferStore;
    private readonly reviewFeed: Pick<ReviewFeed, 'bumpLocalWrite'> | null;
    private readonly timers: DraftBufferTimers;
    private readonly log: (message: string) => void;
    /** Записи одного адресата уходят в хост по очереди, даже если предыдущая сорвалась. */
    private readonly queues = new Map<string, Promise<unknown>>();
    private readonly retries = new Map<string, ReturnType<typeof setTimeout>>();
    /** Записи, от которых отказались: попытка в полёте узнаёт об этом по возвращении. */
    private readonly discarded = new Set<string>();
    private closed = false;

    constructor(options: DraftBufferWriterOptions) {
        this.host = options.host;
        this.store = options.store;
        this.reviewFeed = options.reviewFeed;
        this.timers = options.timers ?? {
            setTimeout: (handler, ms) => setTimeout(handler, ms),
            clearTimeout: (timer) => {
                clearTimeout(timer);
            },
        };
        this.log =
            options.log ??
            ((message: string): void => {
                process.stderr.write(`sherpa-server: ${message}\n`);
            });
    }

    list(): DraftBufferEntry[] {
        return this.store.list();
    }

    /**
     * Записывает черновик: апсёрт в буфер, попытка в хост, и либо строка исчезает (`saved`),
     * либо остаётся ждать повтора (`buffered`).
     *
     * Запись под ключом, по которому черновик уже создан, — правка этого черновика, а не второе
     * создание: хост по ключу идемпотентности вернул бы первый комментарий, и новый текст
     * пропал бы молча (композер держит `clientKey`, пока не узнает об успехе).
     */
    write(input: DraftBufferInput): Promise<DraftBufferWriteResult> {
        return this.enqueue(input.commentId ?? input.id, () => {
            // Адресат выясняется здесь, а не при постановке в очередь: пока запись ждала своей
            // очереди, летевшая впереди попытка могла довезти создание — тогда это правка
            // созданного черновика. Спросить раньше значило бы уйти в хост созданием и получить
            // по ключу идемпотентности прежний комментарий вместо нового текста.
            const commentId = input.commentId ?? this.store.savedCommentId(input.id);
            this.store.upsert({ ...input, commentId });
            return this.attempt(input.id, input.commentId === null && commentId !== null);
        });
    }

    /** Повтор прямо сейчас (кнопка «повторить»): пауза таймера при этом сбрасывается. */
    async retry(id: string): Promise<void> {
        const entry = this.store.get(id);
        if (entry === null) {
            return;
        }
        this.cancelRetry(id);
        await this.enqueue(entry.commentId ?? id, () => this.attempt(id));
    }

    /**
     * Отказ от записи: текст ревьюеру больше не нужен, довозить нечего. Идёт той же очередью,
     * что и попытки, — иначе сброс разошёлся бы с уже улетевшим в хост вызовом. Попытка,
     * заставшая отказ, подчищает за собой созданный черновик (см. `attempt`).
     */
    async discard(id: string): Promise<void> {
        this.discarded.add(id);
        this.cancelRetry(id);
        const entry = this.store.get(id);
        const key = entry?.commentId ?? this.store.savedCommentId(id) ?? id;
        await this.enqueue(key, () => {
            const removed = this.store.remove(id);
            this.discarded.delete(id);
            if (removed) {
                this.reviewFeed?.bumpLocalWrite();
            }
            return Promise.resolve();
        });
    }

    /**
     * Черновик удалён на хосте: его запись довозить некуда, а ключ больше ни к чему не ведёт.
     * Без этого недоставляемая запись висела бы вечно и не давала отшипить PR.
     */
    forgetComment(commentId: HostId): void {
        const ids = this.store.forgetComment(commentId);
        for (const id of ids) {
            this.cancelRetry(id);
        }
        if (ids.length > 0) {
            this.reviewFeed?.bumpLocalWrite();
        }
    }

    /**
     * Ставит в очередь повтора всё, что осталось в буфере с прошлого запуска. `pending`-строки
     * тоже: процесс могли убить между апсёртом и ответом хоста, и ждать их некому.
     */
    start(): void {
        for (const entry of this.store.list()) {
            this.scheduleRetry(entry.id, entry.attempts);
        }
    }

    /** Гасит таймеры повторов: после остановки сервера просыпаться над закрытой БД нечему. */
    close(): void {
        this.closed = true;
        for (const timer of this.retries.values()) {
            this.timers.clearTimeout(timer);
        }
        this.retries.clear();
    }

    /**
     * Одна попытка довезти запись до хоста. Записи уже нет — считаем, что довезли.
     * `wantComment` — вызывающему нужен сам комментарий, а запись оказалась правкой уже
     * созданного черновика: тогда он ищется в тредах хоста.
     */
    private async attempt(id: string, wantComment = false): Promise<DraftBufferWriteResult> {
        const entry = this.store.get(id);
        if (entry === null) {
            return { outcome: 'saved', comment: null };
        }
        // Пауза отсчитывается от этой попытки: следующий повтор планируется по её итогу.
        this.cancelRetry(id);
        const host = this.host;
        if (host === null) {
            const failed = this.store.markFailed(id, 'У этого PR нет хост-адаптера: черновик писать некуда.');
            this.reviewFeed?.bumpLocalWrite();
            return { outcome: 'buffered', entry: failed ?? entry };
        }

        try {
            const comment = await this.callHost(host, entry, id, wantComment);
            this.cancelRetry(id);
            this.store.remove(id);
            if (comment !== null && this.discarded.has(id)) {
                // От записи отказались, пока попытка была в пути: черновик на хосте уже есть,
                // и оставлять его нельзя — ревьюер от него отказался.
                await this.deleteCreated(host, comment.id);
                this.reviewFeed?.bumpLocalWrite();
                return { outcome: 'saved', comment: null };
            }
            if (comment !== null) {
                this.store.markSaved(id, comment.id);
            }
            this.reviewFeed?.bumpLocalWrite();
            return { outcome: 'saved', comment };
        } catch (error) {
            const message = messageOf(error);
            const failed = this.store.markFailed(id, message);
            this.reviewFeed?.bumpLocalWrite();
            this.log(`черновик ${id} остался в буфере: ${message}`);
            this.scheduleRetry(id, failed?.attempts ?? 1);
            return { outcome: 'buffered', entry: failed ?? entry };
        }
    }

    private async callHost(
        host: ReviewHost,
        entry: DraftBufferEntry,
        id: string,
        wantComment: boolean,
    ): Promise<Comment | null> {
        if (entry.commentId === null) {
            const idempotencyKey = this.store.idempotencyKeyOf(id);
            const created = await host.saveDraft(entry.draft, idempotencyKey === null ? {} : { idempotencyKey });
            return await this.converge(host, id, entry.draft, created);
        }
        await this.writeUpdate(host, entry.commentId, entry.draft);
        return wantComment ? await this.findComment(host, entry.commentId) : null;
    }

    /**
     * Доводит созданный черновик до текста записи.
     *
     * Хост, уже принявший создание, на повторе с тем же ключом идемпотентности возвращает
     * прежний комментарий и нового текста в него не кладёт. Если ответ первой попытки потерялся,
     * а ревьюер за это время дописал текст, вернувшийся комментарий пришёл бы со старым телом, и
     * сервер отчитался бы об успехе не того текста. Расхождение закрывается правкой; не прошла —
     * запись уже привязана к черновику, и следующая попытка идёт правкой, а не созданием.
     */
    private async converge(
        host: ReviewHost,
        id: string,
        draft: CommentDraft,
        created: Comment,
    ): Promise<Comment> {
        const staleIssue = draft.issue !== undefined && created.issue !== draft.issue;
        // Края текста сравниваются вольно: хост вправе обрезать хвостовой перенос, и гонять из-за
        // него лишнюю правку на каждом созданном черновике незачем.
        if (created.body.trim() === draft.body.trim() && !staleIssue) {
            return created;
        }
        this.store.attachComment(id, created.id);
        await this.writeUpdate(host, created.id, draft);
        return { ...created, body: draft.body, ...(draft.issue === undefined ? {} : { issue: draft.issue }) };
    }

    /** Правка черновика: `issue: undefined` значит «не трогать переключатель». */
    private async writeUpdate(host: ReviewHost, commentId: HostId, draft: CommentDraft): Promise<void> {
        if (draft.issue === undefined) {
            await host.updateDraft(commentId, draft.body);
        } else {
            await host.updateDraft(commentId, draft.body, draft.issue);
        }
    }

    /**
     * Комментарий по id из тредов хоста. Нужен на редком пути «сохранение тем же ключом после
     * того, как запись уже довезли»: ручке создания черновика нечем ответить без комментария.
     * Не нашли (или хост не ответил) — не беда: текст записан, а привязку композер получит
     * со следующим снапшотом тредов.
     */
    private async findComment(host: ReviewHost, commentId: HostId): Promise<Comment | null> {
        try {
            return findComment(await host.getThreads(), commentId);
        } catch {
            return null;
        }
    }

    /** Черновик, созданный попыткой, от которой уже отказались. Провал — не беда: он в логе. */
    private async deleteCreated(host: ReviewHost, commentId: HostId): Promise<void> {
        try {
            await host.deleteDraft(commentId);
        } catch (error) {
            this.log(`черновик ${commentId} создан после отказа и не удалён: ${messageOf(error)}`);
        }
    }

    private scheduleRetry(id: string, attempts: number): void {
        if (this.closed || this.retries.has(id)) {
            return;
        }
        const timer = this.timers.setTimeout(() => {
            this.retries.delete(id);
            void this.retry(id);
        }, retryDelayMs(Math.max(attempts, 1)));
        // Таймер повтора процесс живым не держит: самоостановка по простою идёт своим чередом.
        const unrefable: { unref?: () => void } = timer;
        unrefable.unref?.();
        this.retries.set(id, timer);
    }

    private cancelRetry(id: string): void {
        const timer = this.retries.get(id);
        if (timer !== undefined) {
            this.timers.clearTimeout(timer);
            this.retries.delete(id);
        }
    }

    private enqueue<T>(key: string, work: () => Promise<T>): Promise<T> {
        const request = (this.queues.get(key) ?? Promise.resolve()).then(work);
        const tail = request.then(
            () => undefined,
            () => undefined,
        );
        this.queues.set(key, tail);
        void tail.then(() => {
            if (this.queues.get(key) === tail) {
                this.queues.delete(key);
            }
        });
        return request;
    }
}

/** Строка буфера в контрактную запись; битый блоб черновика — не запись вовсе. */
function toEntry(row: BufferRow): DraftBufferEntry | null {
    let draft: CommentDraft;
    try {
        draft = commentDraftSchema.parse(JSON.parse(row.draft_json));
    } catch {
        return null;
    }
    return {
        id: row.id,
        draft,
        commentId: row.comment_id,
        state: row.state === 'failed' ? 'failed' : 'pending',
        error: row.error,
        attempts: row.attempts,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}

/** Комментарий с этим id в дереве тредов; `null` — его там нет. */
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

function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

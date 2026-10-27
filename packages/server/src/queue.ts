import type {
    Lease,
    PriorityClass,
    Task,
    TaskAckResponse,
    TaskCompleteResponse,
    TaskId,
    TaskStatus,
    TaskType,
} from '@sherpa/protocol';
import { LEASE_TTL_SECONDS, MAX_TASK_ATTEMPTS, RESULT_MAX_BYTES, taskSchema } from '@sherpa/protocol';

import type { SherpaDatabase, SqlRow } from './db.js';
import { transaction } from './db.js';
import { RpcFailure } from './errors.js';

const CLOSED_STATUSES: readonly TaskStatus[] = ['done', 'failed', 'cancelled'];

export interface EnqueueInput {
    readonly type: TaskType;
    readonly priority: PriorityClass;
    readonly instructions: string;
    readonly contextFiles: readonly string[];
    readonly resultSchemaFile?: string;
}

/** Постановка внутри чужой транзакции; эффект надо вызвать только после её коммита. */
export interface TransactionalEnqueue {
    readonly record: TaskRecord;
    readonly onCommitted: () => void;
}

/** Задача, выданная воркеру: контрактная пара из ответа `next`. */
export interface LeasedTask {
    readonly task: Task;
    readonly lease: Lease;
}

/** Задача в хранилище: контрактная часть плюс серверные поля жизненного цикла. */
export type LeaseReturnReason = 'expired' | 'displaced';

export interface TaskRecord extends Task {
    readonly status: TaskStatus;
    readonly workerId: string | null;
    readonly leaseExpiresAt: string | null;
    readonly lastLeaseReturnReason: LeaseReturnReason | null;
    readonly progressText: string | null;
    readonly result: string | null;
    readonly failReason: string | null;
    readonly createdAt: string;
    readonly updatedAt: string;
}

export interface TaskQueueOptions {
    readonly db: SherpaDatabase;
    /** Инжектируемые часы: тесты гоняют протухание аренд без реального ожидания. */
    readonly now?: () => Date;
}

/** Результат отмены со стороны UI. */
export type CancelOutcome = 'cancelled' | 'noop';

/**
 * Итог fail-closed приёмки результата (docs/protocol.md §3). `onCommitted` очередь зовёт уже после
 * коммита своей транзакции: применение принятого результата пишет в собственные таблицы,
 * а вложенных транзакций у `node:sqlite` нет.
 *
 * `deferred` — «проверить сейчас нечем» (сервер ещё не поднял контекст задачи): модель получает
 * тот же отказ, но виновата в нём не она, поэтому бюджет отклонений не тратится.
 */
export type TaskResultAcceptance =
    | { readonly kind: 'accepted'; readonly onCommitted?: () => void }
    | { readonly kind: 'rejected'; readonly errors: readonly string[] }
    | { readonly kind: 'deferred'; readonly errors: readonly string[] };

/**
 * Приёмщик результата типизированной задачи. Зовётся синхронно внутри транзакции `complete`,
 * поэтому обязан быть чистой проверкой: читать хранилище можно, писать — нет.
 * `null` — задача не его типа: её очередь закрывает по своим прежним правилам.
 */
export type TaskResultAcceptor = (task: TaskRecord, result: string) => TaskResultAcceptance | null;

/**
 * Сколько раз подряд модель может сдать непринятый приёмщиком результат по одной аренде. Отказ
 * аренду не снимает и попытку не тратит («исправь и вызови complete снова»), но петля должна
 * иметь дно: исчерпав отказы, задача закрывается ошибкой с последним сырым выводом.
 */
export const MAX_RESULT_REJECTIONS = 3;

/** Единственное требование к результату задачи без приёмщика (`echo`). */
const EMPTY_RESULT_ERROR = 'The result is empty. Return a non-empty text and call `complete` again.';

/**
 * Транзакции откатывают всё, что успела сделать операция, поэтому доменные ошибки возвращаются
 * значением и превращаются в исключение уже снаружи транзакции: иначе `result_too_large`
 * потерял бы перевод задачи в `failed`.
 */
type Outcome<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly failure: RpcFailure };

interface TaskRow extends SqlRow {
    id: number;
    type: string;
    priority: string;
    instructions: string;
    context_files: string;
    result_schema_file: string | null;
    status: string;
    attempt: number;
    worker_id: string | null;
    lease_expires_at: string | null;
    last_lease_return_reason: string | null;
    progress_text: string | null;
    result: string | null;
    fail_reason: string | null;
    rejections: number;
    created_at: string;
    updated_at: string;
}

/**
 * Очередь задач с арендой (docs/protocol.md §5): `next` не снимает задачу, а выдаёт её в lease с TTL;
 * молча умерший воркер не теряет задачу — аренда истекает, задача возвращается в очередь.
 * Протухание считается лениво, на входе в операции; таймеров внутри модуля нет.
 */
export class TaskQueue {
    private readonly db: SherpaDatabase;
    private readonly now: () => Date;
    private readonly changeListeners = new Set<() => void>();

    /**
     * Счётчик записей в хранилище и номер последней разосланной. Уведомление идёт после
     * коммита транзакции и только если что-то действительно изменилось: чистые чтения молчат.
     */
    private mutations = 0;
    private announcedMutations = 0;

    /** Приёмщик результата; пока его нет, у задач одно требование — результат непустой. */
    private acceptor: TaskResultAcceptor | null = null;

    /** Что сделать с принятым результатом после коммита транзакции `complete`. */
    private commitEffects: (() => void)[] = [];

    private readonly txEnqueue: (input: EnqueueInput) => TransactionalEnqueue;
    private readonly txNext: (workerId: string) => Outcome<LeasedTask | null>;
    private readonly txComplete: (workerId: string, taskId: TaskId, result: string) => Outcome<TaskCompleteResponse>;
    private readonly txFail: (workerId: string, taskId: TaskId, reason: string) => Outcome<TaskAckResponse>;
    private readonly txProgress: (workerId: string, taskId: TaskId, text: string) => Outcome<TaskAckResponse>;
    private readonly txCancel: (taskId: TaskId) => Outcome<CancelOutcome>;
    private readonly txReleaseLeasesOf: (workerId: string) => void;
    private readonly txReleaseCancelledHoldsOf: (workerId: string) => void;
    private readonly txListTasks: () => TaskRecord[];
    private readonly txGetTask: (taskId: TaskId) => TaskRecord | null;

    constructor(options: TaskQueueOptions) {
        this.db = options.db;
        this.now = options.now ?? ((): Date => new Date());

        this.txEnqueue = transaction(this.db, (input: EnqueueInput) => this.enqueueInTransaction(input));
        this.txNext = transaction(this.db, (workerId: string) => this.nextInTransaction(workerId));
        this.txComplete = transaction(this.db, (workerId: string, taskId: TaskId, result: string) =>
            this.completeInTransaction(workerId, taskId, result),
        );
        this.txFail = transaction(this.db, (workerId: string, taskId: TaskId, reason: string) =>
            this.failInTransaction(workerId, taskId, reason),
        );
        this.txProgress = transaction(this.db, (workerId: string, taskId: TaskId, text: string) =>
            this.progressInTransaction(workerId, taskId, text),
        );
        this.txCancel = transaction(this.db, (taskId: TaskId) => this.cancelInTransaction(taskId));
        this.txReleaseLeasesOf = transaction(this.db, (workerId: string) => {
            this.releaseLeasesInTransaction(workerId);
        });
        this.txReleaseCancelledHoldsOf = transaction(this.db, (workerId: string) => {
            this.releaseCancelledHoldsInTransaction(workerId);
        });
        this.txListTasks = transaction(this.db, () => {
            this.expireLeases();
            const rows = this.db.prepare('SELECT * FROM tasks ORDER BY id').all() as TaskRow[];
            return rows.map(toRecord);
        });
        this.txGetTask = transaction(this.db, (taskId: TaskId) => {
            this.expireLeases();
            const row = this.findRow(taskId);
            return row === null ? null : toRecord(row);
        });
    }

    /**
     * Подписка на любое изменение очереди — ею живут SSE-канал UI и long-poll ручки `next`:
     * постановка, выдача в аренду, `complete`/`fail`/`progress`/`cancel` и возврат задач по
     * истечении аренды, в том числе когда протухание случилось лениво внутри чужой операции.
     * Возвращает функцию отписки.
     */
    subscribeChanges(listener: () => void): () => void {
        this.changeListeners.add(listener);
        return () => {
            this.changeListeners.delete(listener);
        };
    }

    enqueue(input: EnqueueInput): TaskRecord {
        const enqueued = this.txEnqueue(input);
        enqueued.onCommitted();
        return enqueued.record;
    }

    /**
     * Вставка задачи внутри уже открытой транзакции. Нужна чату: обмен и его задача появляются
     * атомарно. `onCommitted` будит подписчиков только после успешного коммита внешней транзакции.
     */
    enqueueInTransaction(input: EnqueueInput): TransactionalEnqueue {
        const nowIso = this.nowIso();
        const info = this.db
            .prepare(
                `INSERT INTO tasks (
                    type, priority, instructions, context_files, result_schema_file,
                    status, attempt, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, 'queued', 1, ?, ?)`,
            )
            .run(
                input.type,
                input.priority,
                input.instructions,
                JSON.stringify([...input.contextFiles]),
                input.resultSchemaFile ?? null,
                nowIso,
                nowIso,
            );
        const record = this.requireRecord(Number(info.lastInsertRowid));
        let announced = false;
        return {
            record,
            onCommitted: () => {
                if (announced) {
                    return;
                }
                announced = true;
                this.markChanged();
                this.flushChanges();
            },
        };
    }

    /** Следующая задача в аренду; `null` — очередь пуста (ручка превратит это в long-poll). */
    next(workerId: string): LeasedTask | null {
        return this.settle(this.txNext(workerId));
    }

    /**
     * Подключает fail-closed приёмку результата: её ставит оркестратор маршрута.
     * Одна на очередь — приёмщик сам разбирается, что делать с типом задачи.
     */
    setResultAcceptor(acceptor: TaskResultAcceptor | null): void {
        this.acceptor = acceptor;
    }

    complete(workerId: string, taskId: TaskId, result: string): TaskCompleteResponse {
        try {
            return this.settle(this.txComplete(workerId, taskId, result));
        } catch (error) {
            // Транзакция откатилась целиком — применять принятое нечего.
            this.commitEffects = [];
            throw error;
        }
    }

    fail(workerId: string, taskId: TaskId, reason: string): TaskAckResponse {
        return this.settle(this.txFail(workerId, taskId, reason));
    }

    progress(workerId: string, taskId: TaskId, text: string): TaskAckResponse {
        return this.settle(this.txProgress(workerId, taskId, text));
    }

    /**
     * Отмена со стороны UI. Задача в аренде отменяется формально: прервать сессию нельзя,
     * воркер узнает об этом при следующем вызове по этой задаче (получит `noop`). До тех пор
     * держание сохраняется — `worker_id`/`lease_expires_at` остаются на отменённой задаче.
     */
    cancel(taskId: TaskId): CancelOutcome {
        return this.settle(this.txCancel(taskId));
    }

    /**
     * Немедленный возврат аренд вытесненного воркера при перехвате слота новой сессией
     * (docs/protocol.md §7): слот уже не его, ждать естественного истечения TTL незачем — иначе
     * после реконнекта задача лежала бы до конца TTL, а у фоновой это полчаса. Семантика та же,
     * что у протухания: инкремент попытки, исчерпание попыток — ошибка задачи. Держания
     * отменённых задач при этом просто снимаются: возвращать в очередь нечего.
     */
    releaseLeasesOf(workerId: string): void {
        this.txReleaseLeasesOf(workerId);
        this.flushChanges();
    }

    /**
     * Воркер уходит, не спрашивая новой работы (ответ `done` на `next`): отменённые задачи он
     * больше не крутит, держание надо снять здесь же — иначе оно провисит до истечения TTL, и UI
     * будет показывать «агент работает» у сессии, которой уже нет.
     */
    releaseCancelledHoldsOf(workerId: string): void {
        this.txReleaseCancelledHoldsOf(workerId);
        this.flushChanges();
    }

    /**
     * До какого момента у воркера есть аренда: позднейший срок среди его аренд, `null` — аренд нет.
     * Момент возвращается как есть, вместе с уже прошедшим: жизненный цикл воркера по нему считает
     * не только «работает ли сейчас», но и когда работа кончится, — иначе таймер смерти не на что
     * взвести. Чистое чтение без побочных эффектов: спрашивают часто, двигать очередь при этом
     * нельзя, поэтому протухшие аренды здесь не возвращаются в очередь.
     *
     * Статус не фильтруется: держание отменённой задачи тоже занимает воркера, и выдавать его
     * за отключившегося нельзя.
     */
    leaseExpiryOf(workerId: string): string | null {
        const row = this.db
            .prepare(
                `SELECT MAX(lease_expires_at) AS expires_at FROM tasks
                 WHERE worker_id = ? AND lease_expires_at IS NOT NULL`,
            )
            .get(workerId) as { expires_at: string | null } | undefined;
        return row?.expires_at ?? null;
    }

    /**
     * Чтение тоже протухает аренды: иначе молча умерший воркер, по задачам которого никто больше
     * не вызывает операций, навсегда оставил бы в UI живую с виду аренду.
     */
    listTasks(): TaskRecord[] {
        const records = this.txListTasks();
        this.flushChanges();
        return records;
    }

    getTask(taskId: TaskId): TaskRecord | null {
        const record = this.txGetTask(taskId);
        this.flushChanges();
        return record;
    }

    private nextInTransaction(workerId: string): Outcome<LeasedTask | null> {
        this.expireLeases();
        // Воркер пришёл за новой работой — значит, отменённые задачи он больше не крутит.
        this.releaseCancelledHoldsInTransaction(workerId);

        // Идемпотентность: живая аренда этого воркера возвращается как есть — «доделай начатое».
        const held = this.db
            .prepare("SELECT * FROM tasks WHERE status = 'leased' AND worker_id = ? ORDER BY id LIMIT 1")
            .get(workerId) as TaskRow | undefined;
        if (held !== undefined) {
            return ok(this.toLeasedTask(held));
        }

        const candidate = this.db
            .prepare(
                `SELECT * FROM tasks WHERE status = 'queued'
                 ORDER BY CASE priority WHEN 'interactive' THEN 0 ELSE 1 END, id
                 LIMIT 1`,
            )
            .get() as TaskRow | undefined;
        if (candidate === undefined) {
            return ok(null);
        }

        const ttlSeconds = LEASE_TTL_SECONDS[candidate.priority as PriorityClass];
        const nowIso = this.nowIso();
        const expiresAt = new Date(this.now().getTime() + ttlSeconds * 1000).toISOString();
        // Счётчик отказов приёмки — на аренду: новая выдача даёт модели полный набор попыток.
        // Причину прошлого возврата аренды тоже сбрасываем: задача снова живая, старое `expired`/
        // `displaced` не должно пережить re-lease и сбить с толку сверку состояния при рестарте.
        this.db
            .prepare(
                `UPDATE tasks SET status = 'leased', worker_id = ?, lease_expires_at = ?, rejections = 0,
                 last_lease_return_reason = NULL, updated_at = ? WHERE id = ?`,
            )
            .run(workerId, expiresAt, nowIso, candidate.id);
        this.markChanged();

        return ok(this.toLeasedTask(this.requireRow(candidate.id)));
    }

    private completeInTransaction(workerId: string, taskId: TaskId, result: string): Outcome<TaskCompleteResponse> {
        const owned = this.requireOwnedTask(workerId, taskId);
        if (!owned.ok) {
            return owned;
        }
        if (owned.value === null) {
            return ok(closedNoop(this.requireRow(taskId)));
        }

        const bytes = Buffer.byteLength(result, 'utf8');
        if (bytes > RESULT_MAX_BYTES) {
            // docs/architecture.md: превышение лимита — ошибка задачи, а не «попробуй ещё раз».
            // Причина в карточке — для ревьюера (русская), текст ошибки — для модели (английский).
            this.closeTask(taskId, 'failed', {
                failReason:
                    `Результат больше лимита: ${String(bytes)} байт при допустимых ` +
                    `${String(RESULT_MAX_BYTES)}. Задача завершена ошибкой.`,
            });
            return fail(
                new RpcFailure(
                    'result_too_large',
                    `The result exceeds the limit: ${String(bytes)} bytes against the allowed ` +
                        `${String(RESULT_MAX_BYTES)}. The task is closed with an error.`,
                ),
            );
        }

        // Fail-closed приёмка по схеме результата: типизированные задачи (`route.*`) проверяет
        // оркестратор маршрута, у `echo` приёмщика нет — там требование прежнее и единственное.
        const acceptance = this.acceptor?.(toRecord(owned.value), result) ?? null;
        if (acceptance === null && result.trim() === '') {
            // Отказ не от приёмщика: бюджет отклонений он не тратит, аренда живёт дальше.
            return ok({ kind: 'rejected', errors: [EMPTY_RESULT_ERROR] });
        }
        if (acceptance?.kind === 'deferred') {
            return ok(deferResult(taskId, acceptance.errors));
        }
        if (acceptance?.kind === 'rejected') {
            return ok(this.rejectResult(owned.value, result, acceptance.errors));
        }

        this.closeTask(taskId, 'done', { result });
        if (acceptance?.onCommitted !== undefined) {
            this.commitEffects.push(acceptance.onCommitted);
        }
        return ok({ kind: 'accepted', message: acceptedMessage(taskId) });
    }

    /**
     * Результат не принят: аренда остаётся у модели, попытка не тратится — она правит вывод
     * и зовёт `complete` снова (docs/protocol.md §3). Дно петли — `MAX_RESULT_REJECTIONS` отказов
     * на аренду: дальше задача закрывается ошибкой, а последний сырой вывод остаётся в `result`
     * (его показывает «Open raw output», docs/spec.md).
     */
    private rejectResult(row: TaskRow, result: string, errors: readonly string[]): TaskCompleteResponse {
        const rejections = row.rejections + 1;
        this.db
            .prepare('UPDATE tasks SET rejections = ?, updated_at = ? WHERE id = ?')
            .run(rejections, this.nowIso(), row.id);
        this.markChanged();

        const id = `sherpa/${String(row.id)}`;
        if (rejections >= MAX_RESULT_REJECTIONS) {
            this.closeTask(row.id, 'failed', {
                result,
                failReason:
                    `Агент ${String(MAX_RESULT_REJECTIONS)} раза подряд сдал результат, не прошедший ` +
                    'валидацию, — задача закрыта ошибкой.',
            });
            return {
                kind: 'rejected',
                errors: [
                    ...errors,
                    `This was rejection ${String(rejections)} of ${String(MAX_RESULT_REJECTIONS)}: task ${id} is ` +
                        'now closed with an error. Do not call `complete` for it again — call `worker next`.',
                ],
            };
        }

        return {
            kind: 'rejected',
            errors: [
                ...errors,
                `Rejection ${String(rejections)} of ${String(MAX_RESULT_REJECTIONS)} for task ${id}: fix the ` +
                    'result and call `complete` again — the task is still leased to you.',
            ],
        };
    }

    private failInTransaction(workerId: string, taskId: TaskId, reason: string): Outcome<TaskAckResponse> {
        const owned = this.requireOwnedTask(workerId, taskId);
        if (!owned.ok) {
            return owned;
        }
        if (owned.value === null) {
            return ok(closedAck(this.requireRow(taskId)));
        }

        this.closeTask(taskId, 'failed', { failReason: reason });
        return ok({ kind: 'accepted' });
    }

    private progressInTransaction(workerId: string, taskId: TaskId, text: string): Outcome<TaskAckResponse> {
        const owned = this.requireOwnedTask(workerId, taskId);
        if (!owned.ok) {
            return owned;
        }
        if (owned.value === null) {
            return ok(closedAck(this.requireRow(taskId)));
        }

        this.db
            .prepare('UPDATE tasks SET progress_text = ?, updated_at = ? WHERE id = ?')
            .run(text, this.nowIso(), taskId);
        this.markChanged();
        return ok({ kind: 'accepted' });
    }

    private cancelInTransaction(taskId: TaskId): Outcome<CancelOutcome> {
        this.expireLeases();

        const row = this.findRow(taskId);
        if (row === null) {
            return fail(unknownTask(taskId));
        }
        if (isClosed(row)) {
            return ok('noop');
        }

        if (row.status === 'leased') {
            // Сессию не прервать: задача уже закрыта, но держатель об этом ещё не знает
            // (docs/protocol.md §5). `worker_id`/`lease_expires_at` остаются — по ним UI показывает,
            // что агент всё ещё занят отменённым.
            this.db
                .prepare("UPDATE tasks SET status = 'cancelled', updated_at = ? WHERE id = ?")
                .run(this.nowIso(), taskId);
            this.markChanged();
            return ok('cancelled');
        }

        this.closeTask(taskId, 'cancelled', {});
        return ok('cancelled');
    }

    /**
     * Общая проверка воркерских ручек: задача существует, не закрыта и в аренде у этого воркера.
     * `value === null` — задача уже закрыта, вызывающему остаётся ответить `noop`.
     */
    private requireOwnedTask(workerId: string, taskId: TaskId): Outcome<TaskRow | null> {
        this.expireLeases();

        const row = this.findRow(taskId);
        if (row === null) {
            return fail(unknownTask(taskId));
        }
        if (isClosed(row)) {
            // Держатель отменённой задачи отозвался — узнал об отмене из ответа `noop`.
            if (row.worker_id === workerId) {
                this.releaseHold(taskId);
            }
            return ok(null);
        }
        if (row.status !== 'leased' || row.worker_id !== workerId) {
            return fail(
                new RpcFailure(
                    'lease_not_held',
                    `Task sherpa/${String(taskId)} is not leased to worker ${workerId}: the lease expired ` +
                        'or another session holds the task. Call `worker next` and work on the task it gives you.',
                ),
            );
        }
        return ok(row);
    }

    /**
     * Возврат задач с истёкшей арендой (воркер умер молча) в очередь с инкрементом попытки;
     * исчерпанные попытки — ошибка задачи, видимая в UI. У отменённых задач возвращать нечего:
     * истёкший срок означает только, что держатель больше не считается занятым.
     */
    private expireLeases(): void {
        const nowIso = this.nowIso();
        const expired = this.db
            .prepare(
                `SELECT id, attempt, status FROM tasks
                 WHERE status IN ('leased', 'cancelled')
                   AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?`,
            )
            .all(nowIso) as { id: number; attempt: number; status: string }[];

        for (const row of expired) {
            if (row.status === 'cancelled') {
                this.releaseHold(row.id);
                continue;
            }
            this.requeueLease(row, 'expired');
        }
    }

    /** Аренды вытесненного воркера: тот же путь, что у протухших, но без ожидания срока. */
    private releaseLeasesInTransaction(workerId: string): void {
        const held = this.db
            .prepare("SELECT id, attempt FROM tasks WHERE status = 'leased' AND worker_id = ?")
            .all(workerId) as { id: number; attempt: number }[];

        for (const row of held) {
            this.requeueLease(row, 'displaced');
        }
        this.releaseCancelledHoldsInTransaction(workerId);
    }

    /** Снимает все держания отменённых задач этого воркера: он их больше не крутит. */
    private releaseCancelledHoldsInTransaction(workerId: string): void {
        const held = this.db
            .prepare("SELECT id FROM tasks WHERE status = 'cancelled' AND worker_id = ?")
            .all(workerId) as { id: number }[];

        for (const row of held) {
            this.releaseHold(row.id);
        }
    }

    /** Снимает держание с закрытой задачи, не трогая её статус и попытку. */
    private releaseHold(taskId: TaskId): void {
        this.db
            .prepare('UPDATE tasks SET worker_id = NULL, lease_expires_at = NULL, updated_at = ? WHERE id = ?')
            .run(this.nowIso(), taskId);
        this.markChanged();
    }

    /** Возврат одной арендованной задачи в очередь с инкрементом попытки; исчерпание — ошибка. */
    private requeueLease(row: { id: number; attempt: number }, reason: LeaseReturnReason): void {
        const nowIso = this.nowIso();
        this.markChanged();

        const attempt = row.attempt + 1;
        if (attempt > MAX_TASK_ATTEMPTS) {
            this.db
                .prepare(
                    `UPDATE tasks SET status = 'failed', worker_id = NULL, lease_expires_at = NULL,
                     last_lease_return_reason = ?, fail_reason = ?, updated_at = ? WHERE id = ?`,
                )
                .run(
                    reason,
                    // Причина отказа видна только ревьюеру в UI — текст русский.
                    `Воркер ${String(MAX_TASK_ATTEMPTS)} раз брал задачу и ни разу не завершил её — ` +
                        'попытки исчерпаны.',
                    nowIso,
                    row.id,
                );
            return;
        }

        this.db
            .prepare(
                `UPDATE tasks SET status = 'queued', attempt = ?, worker_id = NULL, lease_expires_at = NULL,
                 last_lease_return_reason = ?, updated_at = ? WHERE id = ?`,
            )
            .run(attempt, reason, nowIso, row.id);
    }

    private closeTask(
        taskId: TaskId,
        status: Extract<TaskStatus, 'done' | 'failed' | 'cancelled'>,
        fields: { result?: string; failReason?: string },
    ): void {
        this.db
            .prepare(
                `UPDATE tasks SET status = ?, worker_id = NULL, lease_expires_at = NULL,
                 result = COALESCE(?, result), fail_reason = COALESCE(?, fail_reason), updated_at = ?
                 WHERE id = ?`,
            )
            .run(status, fields.result ?? null, fields.failReason ?? null, this.nowIso(), taskId);
        this.markChanged();
    }

    private toLeasedTask(row: TaskRow): LeasedTask {
        const record = toRecord(row);
        if (row.lease_expires_at === null) {
            throw new Error(`У задачи sherpa/${String(row.id)} статус leased без срока аренды.`);
        }

        // Наружу уходит только контрактная часть, и уже провалидированная: серверные поля zod срезает.
        return {
            task: taskSchema.parse(record),
            lease: {
                taskId: record.id,
                ttlSeconds: LEASE_TTL_SECONDS[record.priority],
                expiresAt: row.lease_expires_at,
            },
        };
    }

    private findRow(taskId: TaskId): TaskRow | null {
        const row = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as TaskRow | undefined;
        return row ?? null;
    }

    private requireRow(taskId: TaskId): TaskRow {
        const row = this.findRow(taskId);
        if (row === null) {
            throw new Error(`Задачи sherpa/${String(taskId)} нет в хранилище.`);
        }
        return row;
    }

    private requireRecord(taskId: TaskId): TaskRecord {
        return toRecord(this.requireRow(taskId));
    }

    /**
     * Завершение транзакционной операции: сначала применение принятого результата и рассылка
     * изменений (транзакция уже закоммичена), потом доменная ошибка исключением — иначе подписчики
     * не узнали бы о том, что успело записаться (например, о переводе задачи в `failed`
     * при `result_too_large`).
     */
    private settle<T>(outcome: Outcome<T>): T {
        this.runCommitEffects();
        this.flushChanges();
        return unwrap(outcome);
    }

    /**
     * Применение принятых результатов — вне транзакции очереди: приёмщик пишет в свои таблицы
     * своими транзакциями, а вложенный `BEGIN` у `node:sqlite` невозможен. Упавшее применение
     * не должно валить `complete`: результат уже принят и записан.
     */
    private runCommitEffects(): void {
        const effects = this.commitEffects;
        this.commitEffects = [];
        for (const effect of effects) {
            try {
                effect();
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                process.stderr.write(`sherpa-server: принятый результат не применился: ${message}\n`);
            }
        }
    }

    /** Отметка записи в хранилище; вызывается изнутри транзакций, рассылку делает `flushChanges`. */
    private markChanged(): void {
        this.mutations += 1;
    }

    private flushChanges(): void {
        if (this.mutations === this.announcedMutations) {
            return;
        }

        this.announcedMutations = this.mutations;
        for (const listener of [...this.changeListeners]) {
            listener();
        }
    }

    private nowIso(): string {
        return this.now().toISOString();
    }
}

function ok<T>(value: T): Outcome<T> {
    return { ok: true, value };
}

function fail<T>(failure: RpcFailure): Outcome<T> {
    return { ok: false, failure };
}

function unwrap<T>(outcome: Outcome<T>): T {
    if (!outcome.ok) {
        throw outcome.failure;
    }
    return outcome.value;
}

function acceptedMessage(taskId: TaskId): string {
    return `The result of task sherpa/${String(taskId)} is accepted.`;
}

/**
 * Приёмщик отказался проверять результат: серверу нечем это сделать прямо сейчас. В хранилище
 * не меняется ничего — ни попытка, ни счётчик отклонений, ни аренда, — модель просто повторяет
 * вызов позже. Иначе временный сбой сервера съедал бы бюджет отклонений и закрывал задачу ошибкой.
 */
function deferResult(taskId: TaskId, errors: readonly string[]): TaskCompleteResponse {
    return {
        kind: 'rejected',
        errors: [
            ...errors,
            `This is not a rejection of your work: task sherpa/${String(taskId)} is still leased to you and ` +
                'nothing has been spent on this attempt.',
        ],
    };
}

function unknownTask(taskId: TaskId): RpcFailure {
    return new RpcFailure(
        'unknown_task',
        `Task sherpa/${String(taskId)} does not exist. Check the task number in the output of \`worker next\`.`,
    );
}

function isClosed(row: TaskRow): boolean {
    return CLOSED_STATUSES.includes(row.status as TaskStatus);
}

function closedNoop(row: TaskRow): TaskCompleteResponse {
    return { kind: 'noop', message: closedMessage(row) };
}

function closedAck(row: TaskRow): TaskAckResponse {
    return { kind: 'noop', message: closedMessage(row) };
}

function closedMessage(row: TaskRow): string {
    const id = `sherpa/${String(row.id)}`;
    switch (row.status as TaskStatus) {
        case 'cancelled':
            return `Task ${id} has been cancelled — there is nothing to do.`;
        case 'done':
            return `Task ${id} is already finished, calling again changes nothing.`;
        default:
            return `Task ${id} is already closed with an error, calling again changes nothing.`;
    }
}

function toRecord(row: TaskRow): TaskRecord {
    return {
        id: row.id,
        type: row.type as TaskType,
        priority: row.priority as PriorityClass,
        attempt: row.attempt,
        instructions: row.instructions,
        contextFiles: parseContextFiles(row.context_files),
        ...(row.result_schema_file === null ? {} : { resultSchemaFile: row.result_schema_file }),
        status: row.status as TaskStatus,
        workerId: row.worker_id,
        leaseExpiresAt: row.lease_expires_at,
        lastLeaseReturnReason: row.last_lease_return_reason as LeaseReturnReason | null,
        progressText: row.progress_text,
        result: row.result,
        failReason: row.fail_reason,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}

function parseContextFiles(raw: string): string[] {
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        throw new Error(`Список контекстных файлов задачи повреждён: ${raw}`);
    }

    if (!Array.isArray(parsed)) {
        throw new Error(`Список контекстных файлов задачи повреждён: ${raw}`);
    }
    const items: unknown[] = parsed;
    const files = items.filter((item): item is string => typeof item === 'string');
    if (files.length !== items.length) {
        throw new Error(`Список контекстных файлов задачи повреждён: ${raw}`);
    }
    return files;
}

import type { Locale, WorkerStatus } from '@sherpa/protocol';
import { WORKER_DEAD_AFTER_SECONDS } from '@sherpa/protocol';

import type { SherpaDatabase, SqlRow } from './db.js';
import { transaction } from './db.js';
import { RpcFailure } from './errors.js';

export interface WorkerRegistryOptions {
    readonly db: SherpaDatabase;
    /** Инжектируемые часы: тесты гоняют смерть воркера без реального ожидания. */
    readonly now?: () => Date;
    /**
     * До какого момента у воркера есть аренда задачи (ISO) — read-only чтение очереди
     * (`TaskQueue.leaseExpiryOf`). По умолчанию считается, что аренд нет.
     */
    readonly leaseExpiryOf?: (workerId: string) => string | null;
    /** Грейс паузы между вызовами (`WORKER_GAP_GRACE_SECONDS`); в тестах сокращается. */
    readonly gapGraceSeconds?: number;
}

/** Слушатель изменений статуса воркера; его заберёт UI-канал. */
export type WorkerStatusListener = (status: WorkerStatus) => void;

    /**
 * Транзакции откатывают всё, что успела сделать операция, поэтому доменные ошибки возвращаются
 * значением и превращаются в исключение уже снаружи транзакции (тот же приём, что в `queue.ts`).
 */
type Outcome<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly failure: RpcFailure };

interface WorkerRow extends SqlRow {
    worker_id: string;
    harness: string | null;
    model: string | null;
    lang: Locale | null;
    registered_at: string;
    last_seen_at: string;
}

/** Единственная строка таблицы: воркер у PR один. */
const SLOT_ID = 1;

const DEAD_AFTER_MS = WORKER_DEAD_AFTER_SECONDS * 1000;

/**
 * Пауза без открытого соединения и без аренды, после которой сессия считается мёртвой.
 * Простаивающий воркер висит в long-poll `next`, поэтому без соединения он бывает только между
 * возвратом одного вызова и следующим — это секунды работы модели.
 * Внутренняя политика сервера, в контракт не входит.
 */
export const WORKER_GAP_GRACE_SECONDS = 60;

/**
 * Жизненный цикл воркера PR (docs/protocol.md §7): регистрация сессии, heartbeat на каждом вызове CLI,
 * переход в «агент отключён» — и по обрыву соединения, и по молчанию.
 *
 * Воркер жив, если выполнено хотя бы одно:
 * 1. открыто его воркерское соединение (висящий long-poll `next` или любой запрос в полёте) —
 *    убитую сессию ОС выдаёт закрытием сокета сразу, это сильный сигнал;
 * 2. он держит аренду задачи и с последнего вызова прошло меньше `WORKER_DEAD_AFTER_SECONDS` —
 *    во время работы над задачей модель молчит минутами, и это законно; протухшая аренда работой
 *    уже не считается;
 * 3. без соединения и без аренды — с последнего вызова или закрытия соединения прошло меньше
 *    `WORKER_GAP_GRACE_SECONDS`.
 *
 * Живость считается лениво при чтении, как протухание аренд в очереди; таймер здесь нужен только
 * затем, чтобы событие «агент отключён» родилось без входящих запросов — иначе его некому породить.
 */
export class WorkerRegistry {
    private readonly db: SherpaDatabase;
    private readonly now: () => Date;
    private readonly leaseExpiryOf: (workerId: string) => string | null;
    private readonly gapGraceMs: number;
    private readonly listeners = new Set<WorkerStatusListener>();

    /** Открытые воркерские соединения по workerId и момент закрытия последнего из них. */
    private readonly openConnections = new Map<string, number>();
    private readonly lastCloseMs = new Map<string, number>();

    private readonly txRegister: (
        workerId: string,
        harness: string | undefined,
        model: string | undefined,
        lang: Locale | undefined,
    ) => Outcome<string | null>;
    private readonly txTouch: (workerId: string) => Outcome<string | null>;

    private deathTimer: NodeJS.Timeout | null = null;
    /** Подпись последнего разосланного статуса: heartbeat'ы не должны порождать поток событий. */
    private announced: string | null = null;
    private closed = false;

    constructor(options: WorkerRegistryOptions) {
        this.db = options.db;
        this.now = options.now ?? ((): Date => new Date());
        this.leaseExpiryOf = options.leaseExpiryOf ?? ((): string | null => null);
        this.gapGraceMs = (options.gapGraceSeconds ?? WORKER_GAP_GRACE_SECONDS) * 1000;

        this.txRegister = transaction(
            this.db,
            (workerId: string, harness: string | undefined, model: string | undefined, lang: Locale | undefined) =>
                this.registerInTransaction(workerId, harness, model, lang),
        );
        this.txTouch = transaction(this.db, (workerId: string) => this.touchInTransaction(workerId));

        this.announced = signatureOf(this.status());
        this.scheduleDeathCheck();
    }

/**
     * Регистрация сессии воркером PR: `devflow-diff-explain worker register` при старте скилла.
     * Свежая регистрация всегда права (docs/architecture.md): слот свободен — занимаем,
     * занят другой сессией (в том числе живой) — перехватываем, тот же workerId — продление.
     * `worker_conflict` отсюда не приходит никогда; вытесненная сессия узнаёт о потере слота из
     * своего следующего вызова (`touch`/`assertOwner`).
     * Возвращает workerId вытесненной сессии — её аренды вызывающий возвращает в очередь.
     */
    register(workerId: string, harness?: string, model?: string, lang?: Locale): string | null {
        return this.claim(this.txRegister(workerId, harness, model, lang));
    }

    /**
     * Heartbeat: вызывается на каждом валидном воркерском запросе (docs/protocol.md §7).
     * Сессия без `register` (её workerId пришёл из файла стейта) занимает свободный слот сама,
     * но живого владельца не вытесняет — для этого есть `register`.
     * Возвращает workerId вытесненной мёртвой сессии, как `register`.
     */
    touch(workerId: string): string | null {
        return this.claim(this.txTouch(workerId));
    }

    /**
     * Проверка «слот всё ещё за нами» без записи: long-poll `next` висит минутами, и за это время
     * слот может уйти новой сессии — старый воркер не должен увести её задачу.
     */
    assertOwner(workerId: string): void {
        const row = this.readRow();
        if (row === null || row.worker_id === workerId || !this.isAlive(row)) {
            return;
        }
        throw conflict(row);
    }

    /**
     * Учёт открытого воркерского соединения: пока оно висит, сессия жива без heartbeat, а его
     * закрытие — сигнал о смерти сессии (docs/protocol.md §7). Возвращает функцию,
     * которую HTTP-слой зовёт при закрытии соединения; повторный вызов — no-op.
     */
    holdConnection(workerId: string): () => void {
        this.openConnections.set(workerId, (this.openConnections.get(workerId) ?? 0) + 1);
        this.lastCloseMs.delete(workerId);
        this.refresh();

        let released = false;
        return () => {
            if (released) {
                return;
            }
            released = true;
            this.releaseConnection(workerId);
            this.refresh();
        };
    }

    status(): WorkerStatus {
        const row = this.readRow();
        if (row === null) {
            return { kind: 'never' };
        }

        return {
            kind: this.isAlive(row) ? 'connected' : 'disconnected',
            workerId: row.worker_id,
            ...(row.harness === null ? {} : { harness: row.harness }),
            ...(row.model === null ? {} : { model: row.model }),
            ...(row.lang === null ? {} : { lang: row.lang }),
            registeredAt: row.registered_at,
            lastSeenAt: row.last_seen_at,
        };
    }

    /** Подписка на изменения статуса воркера; возвращает функцию отписки. */
    subscribe(listener: WorkerStatusListener): () => void {
        this.listeners.add(listener);
        return () => {
            this.listeners.delete(listener);
        };
    }

    /**
     * Немедленная переоценка живости. В проде её дёргает таймер смерти; в тестах со сдвинутыми
     * часами реального ожидания нет, и переход в `disconnected` вызывается отсюда.
     */
    checkNow(): void {
        this.refresh();
    }

    /** Гасит таймер смерти: после закрытия сервера будить некого. */
    close(): void {
        this.closed = true;
        this.clearDeathCheck();
        this.listeners.clear();
    }

    private registerInTransaction(
        workerId: string,
        harness: string | undefined,
        model: string | undefined,
        lang: Locale | undefined,
    ): Outcome<string | null> {
        const row = this.readRow();
        const nowIso = this.nowIso();

        if (row === null) {
            this.db
                .prepare(
                    `INSERT INTO worker (id, worker_id, harness, model, lang, registered_at, last_seen_at)
                     VALUES (?, ?, ?, ?, ?, ?, ?)`,
                )
                .run(SLOT_ID, workerId, harness ?? null, model ?? null, lang ?? null, nowIso, nowIso);
            return ok(null);
        }

        if (row.worker_id === workerId) {
            // Повторный register той же сессии — продление, а не новая регистрация:
            // `registered_at` держит время начала сессии, по нему UI считает uptime
            // (docs/spec.md).
            this.db
                .prepare('UPDATE worker SET harness = ?, model = ?, lang = ?, last_seen_at = ? WHERE id = ?')
                .run(harness ?? row.harness, model ?? row.model, lang ?? row.lang, nowIso, SLOT_ID);
            return ok(null);
        }

        // Живой прежний воркер вытесняется тоже: запуск новой сессии — сознательное действие
        // ревьюера, и она главнее. Иначе две параллельные сессии на одном PR
        // спорят за слот, а победитель определяется тем, кто раньше замолчал.
        this.takeOver(workerId, harness ?? null, model ?? null, lang ?? null, nowIso);
        return ok(row.worker_id);
    }

    private touchInTransaction(workerId: string): Outcome<string | null> {
        const row = this.readRow();
        const nowIso = this.nowIso();

        if (row === null) {
            this.db
                .prepare(
                    `INSERT INTO worker (id, worker_id, harness, model, lang, registered_at, last_seen_at)
                     VALUES (?, ?, NULL, NULL, NULL, ?, ?)`,
                )
                .run(SLOT_ID, workerId, nowIso, nowIso);
            return ok(null);
        }

        if (row.worker_id === workerId) {
            this.db.prepare('UPDATE worker SET last_seen_at = ? WHERE id = ?').run(nowIso, SLOT_ID);
            return ok(null);
        }

        if (this.isAlive(row)) {
            return fail(conflict(row));
        }

        // Метки прежней сессии к новой отношения не имеют; свои она объявит через `register`.
        this.takeOver(workerId, null, null, null, nowIso);
        return ok(row.worker_id);
    }

    /**
     * Общий хвост захвата слота: соединения вытесненной сессии забываем — её висящий long-poll и
     * момент его закрытия к живости нового владельца отношения не имеют.
     */
    private claim(outcome: Outcome<string | null>): string | null {
        const displaced = unwrap(outcome);
        if (displaced !== null) {
            this.openConnections.delete(displaced);
            this.lastCloseMs.delete(displaced);
        }
        this.refresh();
        return displaced;
    }

    private takeOver(
        workerId: string,
        harness: string | null,
        model: string | null,
        lang: Locale | null,
        nowIso: string,
    ): void {
        this.db
            .prepare(
                `UPDATE worker SET worker_id = ?, harness = ?, model = ?, lang = ?, registered_at = ?,
                        last_seen_at = ?
                 WHERE id = ?`,
            )
            .run(workerId, harness, model, lang, nowIso, nowIso, SLOT_ID);
    }

    /** Пересчёт статуса: перевзводит таймер смерти и рассылает событие, если статус изменился. */
    private refresh(): void {
        if (this.closed) {
            return;
        }

        this.scheduleDeathCheck();
        const status = this.status();
        const signature = signatureOf(status);
        if (signature === this.announced) {
            return;
        }

        this.announced = signature;
        for (const listener of [...this.listeners]) {
            listener(status);
        }
    }

    /**
     * Таймер на момент смерти воркера. Задержка считается по тем же часам, что и живость, поэтому
     * в тестах с фиктивными часами он просто не успевает сработать — переход туда вызывается через
     * `checkNow()`. Пока открыто воркерское соединение, будить некого: срок не идёт.
     */
    private scheduleDeathCheck(): void {
        this.clearDeathCheck();

        const row = this.readRow();
        if (row === null) {
            return;
        }

        const deadline = this.deadlineOf(row);
        if (deadline === null || deadline <= this.now().getTime()) {
            return;
        }

        const delay = deadline - this.now().getTime();
        const timer = setTimeout(() => {
            this.deathTimer = null;
            this.checkNow();
        }, Math.max(delay, 0));
        timer.unref();
        this.deathTimer = timer;
    }

    private clearDeathCheck(): void {
        if (this.deathTimer !== null) {
            clearTimeout(this.deathTimer);
            this.deathTimer = null;
        }
    }

    private isAlive(row: WorkerRow): boolean {
        const deadline = this.deadlineOf(row);
        return deadline === null || deadline > this.now().getTime();
    }

    /**
     * Момент, в который воркер считается мёртвым; `null` — его соединение открыто, и срок не идёт.
     * Отсчёт — от позднейшего из последнего вызова и закрытия последнего соединения: между ними
     * у long-poll минуты.
     *
     * Долгий срок молчания действует, только пока воркер работает над задачей, а работа кончается
     * не позже срока аренды: аренда протухает по времени взятия задачи, `progress` его не двигает,
     * поэтому она способна кончиться раньше `last_seen_at + WORKER_DEAD_AFTER_SECONDS`. После неё
     * остаётся грейс паузы между вызовами — как у воркера без аренды.
     */
    private deadlineOf(row: WorkerRow): number | null {
        if ((this.openConnections.get(row.worker_id) ?? 0) > 0) {
            return null;
        }

        const silentSince = Math.max(
            new Date(row.last_seen_at).getTime(),
            this.lastCloseMs.get(row.worker_id) ?? 0,
        );
        const gapDeadline = silentSince + this.gapGraceMs;

        const leaseExpiry = this.leaseExpiryOf(row.worker_id);
        if (leaseExpiry === null) {
            return gapDeadline;
        }

        const workingUntil = Math.min(new Date(leaseExpiry).getTime(), silentSince + DEAD_AFTER_MS);
        return Math.max(workingUntil, gapDeadline);
    }

    /** Закрытие соединения: отсчёт грейса идёт с этого момента, а не с последнего вызова. */
    private releaseConnection(workerId: string): void {
        const rest = (this.openConnections.get(workerId) ?? 1) - 1;
        if (rest > 0) {
            this.openConnections.set(workerId, rest);
            return;
        }

        this.openConnections.delete(workerId);
        const nowMs = this.now().getTime();
        // Идентичности прошлых сессий на живость уже не влияют — карту не копим.
        for (const [id, closedAt] of this.lastCloseMs) {
            if (nowMs - closedAt > DEAD_AFTER_MS) {
                this.lastCloseMs.delete(id);
            }
        }
        this.lastCloseMs.set(workerId, nowMs);
    }

    private readRow(): WorkerRow | null {
        const row = this.db.prepare('SELECT * FROM worker WHERE id = ?').get(SLOT_ID) as WorkerRow | undefined;
        return row ?? null;
    }

    private nowIso(): string {
        return this.now().toISOString();
    }
}

/**
 * Слот занят чужой живой сессией: вызов не-владельца (`touch`/`assertOwner`). Регистрация сюда уже
 * не попадает — свежая сессия слот перехватывает, поэтому советовать «подожди N минут» нечего:
 * получателю этой ошибки остаётся остановить свою петлю (терминальную приписку добавит CLI).
 * Две сессии на один PR не поддерживаются (docs/spec.md).
 */
function conflict(row: WorkerRow): RpcFailure {
    const owner = row.harness === null ? row.worker_id : `${row.worker_id}, harness ${row.harness}`;

    return new RpcFailure(
        'worker_conflict',
        `Another live session (${owner}) is the worker of this PR — two sessions per PR are not ` +
            'supported, and the slot belongs to the session that started last. This one is not it.',
    );
}

/** Подпись статуса для сравнения: время последнего вызова в неё не входит — это и есть heartbeat. */
function signatureOf(status: WorkerStatus): string {
    if (status.kind === 'never') {
        return status.kind;
    }
    return [
        status.kind,
        status.workerId,
        status.harness ?? '',
        status.model ?? '',
        status.lang ?? '',
        status.registeredAt,
    ].join('|');
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

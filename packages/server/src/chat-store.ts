import type {
    AgentNote,
    ChatAnchor,
    ChatExplanation,
    ChatExchange,
    ChatExchangeStatus,
    HostId,
    Locale,
    UiChatResponse,
} from '@sherpa/protocol';
import { agentNoteSchema, chatExplanationSchema, chatAnchorSchema, chatExchangeSchema, uiChatResponseSchema } from '@sherpa/protocol';

import type { SherpaDatabase, SqlRow } from './db.js';
import { transaction } from './db.js';
import type { IterationMap } from './iterations/index.js';
import { LEGACY_DIFF_ID } from './iterations/index.js';
import type { TransactionalEnqueue } from './queue.js';

/** Слушатель изменений чата; его забирает SSE-канал UI (`UI_CHAT_EVENT`). */
export type ChatListener = (revision: number) => void;

export interface ChatStoreOptions {
    readonly db: SherpaDatabase;
    readonly createNotes?: boolean;
    readonly now?: () => Date;
}

interface ExchangeRow extends SqlRow {
    id: number;
    question: string;
    anchor: string | null;
    status: string;
    answer: string | null;
    progress_text: string | null;
    error: string | null;
    task_id: number | null;
    head_commit: string | null;
    explanation: string | null;
    /** Язык ответа (миграция 020); NULL — обмен старше колонки, он русский. */
    locale: string | null;
    created_at: string;
    updated_at: string;
}

interface NoteRow extends SqlRow {
    id: number;
    exchange_id: number;
    /** Текущее место заметки: после пуша переезжает на активную итерацию. */
    anchor: string;
    text: string;
    /** Коммит текущего якоря; у исходного места свой — `origin_commit`. */
    commit_hash: string | null;
    lost_anchor: number;
    origin_anchor: string | null;
    origin_commit: string | null;
    created_at: string;
}

/** Итог переноса якорей одной пары итераций. */
export interface NoteMigration {
    readonly moved: number;
    readonly lost: number;
}

/** Обмен вместе с серверными полями, которых нет в контракте (`taskId` уже несёт сам обмен). */
export interface StoredChatExchange {
    readonly exchange: ChatExchange;
    readonly headCommit: string | null;
}

    /**
 * История вопросов и локальные ИИ-заметки одного PR. Все публичные данные проходят схемы
 * протокола; ревизия растёт на любое реальное изменение обмена или заметки.
 */
export class ChatStore {
    private readonly db: SherpaDatabase;
    private readonly now: () => Date;
    private readonly listeners = new Set<ChatListener>();
    private readonly txAsk: (
        question: string,
        anchor: ChatAnchor | null,
        headCommit: string | null,
        locale: Locale,
        enqueue: () => TransactionalEnqueue,
        explanation: ChatExplanation | null,
    ) => { exchange: ChatExchange; enqueued: TransactionalEnqueue };
    private readonly txRetry: (
        exchangeId: number,
        headCommit: string | null,
        enqueue: () => TransactionalEnqueue,
    ) => { exchange: ChatExchange; enqueued: TransactionalEnqueue } | null;
    private readonly createNotes: boolean;
    private readonly txComplete: (taskId: number, answer: string) => boolean;
    private readonly txAdoptLegacy: (activeDiffId: HostId) => number;
    private readonly txMigrateNotes: (
        fromDiffId: HostId,
        toDiffId: HostId,
        map: IterationMap,
        fileIdOf: (path: string) => string | null,
        toHeadCommit: string | null,
    ) => NoteMigration;

    private revisionValue = 0;
    private closed = false;

    constructor(options: ChatStoreOptions) {
        this.db = options.db;
        this.createNotes = options.createNotes ?? true;
        this.now = options.now ?? ((): Date => new Date());
        this.txAsk = transaction(this.db, (question, anchor, headCommit, locale, enqueue, explanation) =>
            this.askInTransaction(question, anchor, headCommit, locale, enqueue, explanation),
        );
        this.txRetry = transaction(this.db, (exchangeId, headCommit, enqueue) =>
            this.retryInTransaction(exchangeId, headCommit, enqueue),
        );
        this.txComplete = transaction(this.db, (taskId, answer) => this.completeInTransaction(taskId, answer));
        this.txAdoptLegacy = transaction(this.db, (activeDiffId: HostId) => this.adoptLegacyInTransaction(activeDiffId));
        this.txMigrateNotes = transaction(
            this.db,
            (
                fromDiffId: HostId,
                toDiffId: HostId,
                map: IterationMap,
                fileIdOf: (path: string) => string | null,
                toHeadCommit: string | null,
            ) => this.migrateNotesInTransaction(fromDiffId, toDiffId, map, fileIdOf, toHeadCommit),
        );
    }

    get revision(): number {
        return this.revisionValue;
    }

    read(): UiChatResponse {
        const exchanges = this.exchangeRows().map((row) => toStoredExchange(row).exchange);
        const notes = this.noteRows().map(toNote);
        return uiChatResponseSchema.parse({ exchanges, notes, chatRevision: this.revisionValue });
    }

    exchange(exchangeId: number): StoredChatExchange | null {
        const row = this.db.prepare('SELECT * FROM chat_exchanges WHERE id = ?').get(exchangeId) as
            | ExchangeRow
            | undefined;
        return row === undefined ? null : toStoredExchange(row);
    }

    exchangeForTask(taskId: number): StoredChatExchange | null {
        const row = this.db.prepare('SELECT * FROM chat_exchanges WHERE task_id = ?').get(taskId) as
            | ExchangeRow
            | undefined;
        return row === undefined ? null : toStoredExchange(row);
    }

    openExchanges(): StoredChatExchange[] {
        return this.exchangeRows()
            .filter((row) => row.status === 'queued' || row.status === 'running')
            .map(toStoredExchange);
    }

    ask(
        question: string,
        anchor: ChatAnchor | null,
        headCommit: string | null,
        locale: Locale,
        enqueue: () => TransactionalEnqueue,
        explanation: ChatExplanation | null = null,
    ): ChatExchange {
        const parsedAnchor = anchor === null ? null : chatAnchorSchema.parse(anchor);
        const result = this.txAsk(question, parsedAnchor, headCommit, locale, enqueue, explanation);
        this.bump();
        result.enqueued.onCommitted();
        return result.exchange;
    }

    retry(exchangeId: number, headCommit: string | null, enqueue: () => TransactionalEnqueue): boolean {
        const result = this.txRetry(exchangeId, headCommit, enqueue);
        if (result === null) {
            return false;
        }
        this.bump();
        result.enqueued.onCommitted();
        return true;
    }

    /** Состояние открытого обмена по текущей задаче; повтор того же значения ревизию не двигает. */
    syncTask(
        taskId: number,
        status: Extract<ChatExchangeStatus, 'queued' | 'running' | 'failed' | 'cancelled'>,
        progressText: string | null,
        error: string | null,
    ): void {
        const row = this.exchangeRowForTask(taskId);
        if (row === null || row.status === 'done' || row.status === 'failed' || row.status === 'cancelled') {
            return;
        }
        const nextProgress = status === 'running' ? progressText : null;
        const nextError = status === 'failed' ? error : null;
        if (row.status === status && row.progress_text === nextProgress && row.error === nextError) {
            return;
        }

        this.db
            .prepare(
                `UPDATE chat_exchanges SET status = ?, answer = NULL, progress_text = ?, error = ?, updated_at = ?
                 WHERE id = ?`,
            )
            .run(status, nextProgress, nextError, this.nowIso(), row.id);
        this.bump();
    }

    cancelExchange(exchangeId: number): void {
        const row = this.exchange(exchangeId);
        if (row === null || (row.exchange.status !== 'queued' && row.exchange.status !== 'running')) {
            return;
        }
        this.db
            .prepare(
                `UPDATE chat_exchanges SET status = 'cancelled', answer = NULL, progress_text = NULL,
                 error = NULL, updated_at = ? WHERE id = ?`,
            )
            .run(this.nowIso(), exchangeId);
        this.bump();
    }

    failExchange(exchangeId: number, error: string): void {
        const row = this.exchange(exchangeId);
        if (
            row === null ||
            row.exchange.status === 'done' ||
            row.exchange.status === 'failed' ||
            row.exchange.status === 'cancelled'
        ) {
            return;
        }
        this.db
            .prepare(
                `UPDATE chat_exchanges SET status = 'failed', answer = NULL, progress_text = NULL,
                 error = ?, updated_at = ? WHERE id = ?`,
            )
            .run(error, this.nowIso(), exchangeId);
        this.bump();
    }

    completeTask(taskId: number, answer: string): void {
        if (this.txComplete(taskId, answer)) {
            this.bump();
        }
    }

    /**
     * Якоря заметок старого формата итерацию не называют (`LEGACY_DIFF_ID`): сервер считает их сделанными в
     * активной. Строки не двигаются — меняется только `diffId`, у текущего якоря и у исходного.
     * Идемпотентно: после усыновления таких заметок больше нет.
     */
    adoptLegacyAnchors(activeDiffId: HostId): number {
        const adopted = this.txAdoptLegacy(activeDiffId);
        if (adopted > 0) {
            this.bump();
        }
        return adopted;
    }

/**
     * Перенос якорей заметок с итерации `fromDiffId` на `toDiffId` по карте строк
     * (docs/spec.md).
     * Диапазон, которого пуш не касался, переезжает целиком; всё остальное — файл ушёл, строки
     * переписаны, диапазон разъехался или файла нет в новом диффе — теряет якорь: `anchor` и его
     * коммит остаются последними удачными, заметка уходит из кода и живёт в чате с пометкой.
     *
     * `origin` не трогается никогда. Идемпотентно по построению: перенесённая заметка стоит уже
     * на `toDiffId`, а потерявшая якорь не мигрирует больше никогда.
     */
    migrateNotes(
        fromDiffId: HostId,
        toDiffId: HostId,
        map: IterationMap,
        /** Путь → id файла в новом диффе; null — файла там нет. */
        fileIdOf: (path: string) => string | null,
        /** Ревьюируемый коммит новой итерации: он же коммит перенесённого якоря. */
        toHeadCommit: string | null,
    ): NoteMigration {
        if (fromDiffId === toDiffId) {
            return { moved: 0, lost: 0 };
        }
        const result = this.txMigrateNotes(fromDiffId, toDiffId, map, fileIdOf, toHeadCommit);
        if (result.moved + result.lost > 0) {
            this.bump();
        }
        return result;
    }

    deleteNote(noteId: number): boolean {
        const info = this.db.prepare('DELETE FROM agent_notes WHERE id = ?').run(noteId);
        if (info.changes === 0) {
            return false;
        }
        this.bump();
        return true;
    }

    subscribe(listener: ChatListener): () => void {
        if (this.closed) {
            return () => undefined;
        }
        this.listeners.add(listener);
        let released = false;
        return () => {
            if (released) {
                return;
            }
            released = true;
            this.listeners.delete(listener);
        };
    }

    close(): void {
        this.closed = true;
        this.listeners.clear();
    }

    private askInTransaction(
        question: string,
        anchor: ChatAnchor | null,
        headCommit: string | null,
        locale: Locale,
        enqueue: () => TransactionalEnqueue,
        explanation: ChatExplanation | null,
    ): { exchange: ChatExchange; enqueued: TransactionalEnqueue } {
        const enqueued = enqueue();
        const now = this.nowIso();
        const info = this.db
            .prepare(
                `INSERT INTO chat_exchanges (
                    question, anchor, status, answer, progress_text, error, task_id, head_commit,
                    locale, created_at, updated_at, explanation
                 ) VALUES (?, ?, 'queued', NULL, NULL, NULL, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
                question,
                anchor === null ? null : JSON.stringify(anchor),
                enqueued.record.id,
                headCommit,
                locale,
                now,
                now,
                explanation === null ? null : JSON.stringify(chatExplanationSchema.parse(explanation)),
            );
        return { exchange: this.requireExchange(Number(info.lastInsertRowid)).exchange, enqueued };
    }

    private retryInTransaction(
        exchangeId: number,
        headCommit: string | null,
        enqueue: () => TransactionalEnqueue,
    ): { exchange: ChatExchange; enqueued: TransactionalEnqueue } | null {
        const current = this.exchange(exchangeId);
        if (current === null || (current.exchange.status !== 'failed' && current.exchange.status !== 'cancelled')) {
            return null;
        }

        const enqueued = enqueue();
        this.db
            .prepare(
                `UPDATE chat_exchanges SET status = 'queued', answer = NULL, progress_text = NULL,
                 error = NULL, task_id = ?, head_commit = ?, updated_at = ? WHERE id = ?`,
            )
            .run(enqueued.record.id, headCommit, this.nowIso(), exchangeId);
        return { exchange: this.requireExchange(exchangeId).exchange, enqueued };
    }

    /** Ответ и заметка для якорного вопроса коммитятся одной транзакцией. */
    private completeInTransaction(taskId: number, answer: string): boolean {
        const row = this.exchangeRowForTask(taskId);
        if (row === null || row.status === 'done' || row.status === 'failed' || row.status === 'cancelled') {
            return false;
        }

        const now = this.nowIso();
        this.db
            .prepare(
                `UPDATE chat_exchanges SET status = 'done', answer = ?, progress_text = NULL,
                 error = NULL, updated_at = ? WHERE id = ?`,
            )
            .run(answer, now, row.id);
        if (this.createNotes && row.anchor !== null) {
            const anchor = JSON.stringify(parseAnchor(row.anchor));
            this.db
                .prepare(
                    `INSERT INTO agent_notes (
                        exchange_id, anchor, text, commit_hash, lost_anchor, origin_anchor, origin_commit, created_at
                     ) VALUES (?, ?, ?, ?, 0, ?, ?, ?)`,
                )
                .run(row.id, anchor, answer, row.head_commit, anchor, row.head_commit, now);
        }
        return true;
    }

    private adoptLegacyInTransaction(activeDiffId: HostId): number {
        let adopted = 0;
        for (const row of this.noteRows()) {
            const anchor = parseAnchor(row.anchor);
            const origin = row.origin_anchor === null ? anchor : parseAnchor(row.origin_anchor);
            if (anchor.diffId !== LEGACY_DIFF_ID && origin.diffId !== LEGACY_DIFF_ID) {
                continue;
            }
            this.db
                .prepare('UPDATE agent_notes SET anchor = ?, origin_anchor = ? WHERE id = ?')
                .run(
                    JSON.stringify(withDiffId(anchor, activeDiffId)),
                    JSON.stringify(withDiffId(origin, activeDiffId)),
                    row.id,
                );
            adopted += 1;
        }
        return adopted;
    }

    private migrateNotesInTransaction(
        fromDiffId: HostId,
        toDiffId: HostId,
        map: IterationMap,
        fileIdOf: (path: string) => string | null,
        toHeadCommit: string | null,
    ): NoteMigration {
        let moved = 0;
        let lost = 0;
        for (const row of this.noteRows()) {
            if (row.lost_anchor !== 0) {
                continue;
            }
            const anchor = parseAnchor(row.anchor);
            if (anchor.diffId !== fromDiffId) {
                continue;
            }

            const carried = carryAnchor(anchor, toDiffId, map, fileIdOf);
            if (carried === null) {
                this.db.prepare('UPDATE agent_notes SET lost_anchor = 1 WHERE id = ?').run(row.id);
                lost += 1;
                continue;
            }
            this.db
                .prepare('UPDATE agent_notes SET anchor = ?, commit_hash = ? WHERE id = ?')
                .run(JSON.stringify(carried), toHeadCommit, row.id);
            moved += 1;
        }
        return { moved, lost };
    }

    private noteRows(): NoteRow[] {
        return this.db.prepare('SELECT * FROM agent_notes ORDER BY id').all() as NoteRow[];
    }

    private exchangeRows(): ExchangeRow[] {
        return this.db.prepare('SELECT * FROM chat_exchanges ORDER BY id').all() as ExchangeRow[];
    }

    private exchangeRowForTask(taskId: number): ExchangeRow | null {
        const row = this.db.prepare('SELECT * FROM chat_exchanges WHERE task_id = ?').get(taskId) as
            | ExchangeRow
            | undefined;
        return row ?? null;
    }

    private requireExchange(exchangeId: number): StoredChatExchange {
        const exchange = this.exchange(exchangeId);
        if (exchange === null) {
            throw new Error(`Обмена чата ${String(exchangeId)} нет в хранилище.`);
        }
        return exchange;
    }

    private bump(): void {
        this.revisionValue += 1;
        if (!this.closed) {
            for (const listener of [...this.listeners]) {
                listener(this.revisionValue);
            }
        }
    }

    private nowIso(): string {
        return this.now().toISOString();
    }
}

function toStoredExchange(row: ExchangeRow): StoredChatExchange {
    const exchange = chatExchangeSchema.parse({
        id: row.id,
        question: row.question,
        ...(row.explanation === null ? {} : { explanation: chatExplanationSchema.parse(JSON.parse(row.explanation)) }),
        anchor: row.anchor === null ? null : parseAnchor(row.anchor),
        status: row.status,
        taskId: row.task_id,
        answer: row.answer,
        progressText: row.progress_text,
        error: row.error,
        locale: row.locale,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    });
    return { exchange, headCommit: row.head_commit };
}

function toNote(row: NoteRow): AgentNote {
    const anchor = parseAnchor(row.anchor);
    return agentNoteSchema.parse({
        id: row.id,
        exchangeId: row.exchange_id,
        anchor,
        text: row.text,
        lostAnchor: row.lost_anchor !== 0,
        // Заметка, записанная до миграции 014, стоит там же, где её закрепили.
        origin: {
            commit: row.origin_commit ?? row.commit_hash,
            anchor: row.origin_anchor === null ? anchor : parseAnchor(row.origin_anchor),
        },
        createdAt: row.created_at,
    });
}

function withDiffId(anchor: ChatAnchor, diffId: HostId): ChatAnchor {
    return anchor.diffId === diffId ? anchor : { ...anchor, diffId };
}

/**
 * Якорь в координатах новой итерации; null — переносить некуда. Условия потери: файл из PR ушёл,
 * пуш задел хоть одну строку диапазона, диапазон разъехался на несколько кусков (переносить его
 * в один якорь нечестно) или пути нет в патче новой итерации.
 */
function carryAnchor(
    anchor: ChatAnchor,
    toDiffId: HostId,
    map: IterationMap,
    fileIdOf: (path: string) => string | null,
): ChatAnchor | null {
    if (map.fileStatus(anchor.path) === 'removed') {
        return null;
    }
    const mapped = map.mapRange(anchor.path, anchor.side, { start: anchor.start, end: anchor.end });
    const target = mapped.carried[0];
    if (mapped.touched.length > 0 || mapped.carried.length !== 1 || target === undefined) {
        return null;
    }
    const fileId = fileIdOf(anchor.path);
    return fileId === null
        ? null
        : { ...anchor, diffId: toDiffId, fileId, start: target.start, end: target.end };
}

function parseAnchor(raw: string): ChatAnchor {
    const value: unknown = JSON.parse(raw);
    const filled =
        typeof value === 'object' && value !== null && !('diffId' in value)
            ? { ...value, diffId: LEGACY_DIFF_ID }
            : value;
    return chatAnchorSchema.parse(filled);
}

import type {
    ChatAnchor,
    ChatExplanation,
    ChatExchange,
    ChatExchangeStatus,
    Locale,
    UiChatResponse,
} from '@sherpa/protocol';
import { chatExplanationSchema, chatAnchorSchema, chatExchangeSchema, uiChatResponseSchema } from '@sherpa/protocol';
import { z } from 'zod';

import type { SherpaDatabase, SqlRow } from './db.js';
import { afterDatabaseCommit, transaction } from './db.js';
import { LEGACY_DIFF_ID } from './legacy-identity.js';
import type { TransactionalEnqueue } from './queue.js';
import type { HistoryExchange } from './chat-payload.js';

/** Слушатель изменений чата; его забирает SSE-канал UI (`UI_CHAT_EVENT`). */
export type ChatListener = (revision: number) => void;

export interface ChatStoreOptions {
    readonly db: SherpaDatabase;
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
    question_input: string | null;
    /** Язык ответа (миграция 020); NULL — обмен старше колонки, он русский. */
    locale: string | null;
    created_at: string;
    updated_at: string;
}

/** Обмен вместе с серверными полями, которых нет в контракте (`taskId` уже несёт сам обмен). */
export interface StoredChatExchange {
    readonly exchange: ChatExchange;
    readonly headCommit: string | null;
    readonly questionInput: FrozenQuestionInput | null;
    readonly questionInputCorrupt: boolean;
}

export interface FrozenQuestionInput {
    readonly diffId: string | null;
    readonly codeSnapshotId?: string | undefined;
    readonly headCommit: string | null;
    /** Старые frozen inputs несли копию; новые используют неизменное explanation той же строки обмена. */
    readonly explanation?: ChatExplanation | null | undefined;
    /** Старые записи уже сохранили полные обмены; новые — ограниченный точный текст history.md. */
    readonly history?: readonly ChatExchange[] | undefined;
    readonly historyText?: string | undefined;
}

const frozenQuestionInputSchema = z.object({
    diffId: z.string().min(1).nullable(),
    codeSnapshotId: z.string().regex(/^[a-f0-9]{64}$/).optional(),
    headCommit: z.string().min(1).nullable(),
    explanation: chatExplanationSchema.nullable().optional(),
    history: z.array(chatExchangeSchema).optional(),
    historyText: z.string().optional(),
}).strict().refine((value) => (value.history === undefined) !== (value.historyText === undefined),
    'Frozen question needs exactly one history representation.');

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
        questionInput: FrozenQuestionInput | null,
    ) => { exchange: ChatExchange; enqueued: TransactionalEnqueue };
    private readonly txRetry: (
        exchangeId: number,
        headCommit: string | null,
        enqueue: () => TransactionalEnqueue,
    ) => { exchange: ChatExchange; enqueued: TransactionalEnqueue } | null;
    private readonly txComplete: (taskId: number, answer: string) => boolean;

    private revisionValue = 0;
    private closed = false;

    constructor(options: ChatStoreOptions) {
        this.db = options.db;
        this.now = options.now ?? ((): Date => new Date());
        this.txAsk = transaction(this.db, (question, anchor, headCommit, locale, enqueue, explanation, questionInput) =>
            this.askInTransaction(question, anchor, headCommit, locale, enqueue, explanation, questionInput),
        );
        this.txRetry = transaction(this.db, (exchangeId, headCommit, enqueue) =>
            this.retryInTransaction(exchangeId, headCommit, enqueue),
        );
        this.txComplete = transaction(this.db, (taskId, answer) => this.completeInTransaction(taskId, answer));

    }

    get revision(): number {
        return this.revisionValue;
    }

    read(): UiChatResponse {
        const exchanges = this.exchangeRows().map((row) => toStoredExchange(row).exchange);
        return uiChatResponseSchema.parse({ exchanges, notes: [], chatRevision: this.revisionValue });
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

    /** Компактная выборка только реально используемой истории без прошлых больших объяснений. */
    recentHistory(diffId: string | null): HistoryExchange[] {
        interface HistoryRow extends SqlRow { id: number; question: string; anchor: string | null; answer: string }
        const rows = (diffId === null
            ? this.db.prepare("SELECT id, question, anchor, answer FROM chat_exchanges WHERE status = 'done' AND answer IS NOT NULL ORDER BY id DESC LIMIT 8").all()
            : this.db.prepare(`SELECT id, question, anchor, answer FROM chat_exchanges
                WHERE status = 'done' AND answer IS NOT NULL AND
                    (json_extract(explanation, '$.diffId') = ? OR json_extract(anchor, '$.diffId') = ?)
                ORDER BY id DESC LIMIT 8`).all(diffId, diffId)) as HistoryRow[];
        return rows.reverse().map((row) => ({ id: row.id, question: row.question,
            anchor: row.anchor === null ? null : parseAnchor(row.anchor), answer: row.answer, status: 'done' }));
    }

    ask(
        question: string,
        anchor: ChatAnchor | null,
        headCommit: string | null,
        locale: Locale,
        enqueue: () => TransactionalEnqueue,
        explanation: ChatExplanation | null = null,
        questionInput: FrozenQuestionInput | null = null,
    ): ChatExchange {
        const parsedAnchor = anchor === null ? null : chatAnchorSchema.parse(anchor);
        const result = this.txAsk(question, parsedAnchor, headCommit, locale, enqueue, explanation, questionInput);
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
        questionInput: FrozenQuestionInput | null,
    ): { exchange: ChatExchange; enqueued: TransactionalEnqueue } {
        const enqueued = enqueue();
        const now = this.nowIso();
        const info = this.db
            .prepare(
                `INSERT INTO chat_exchanges (
                    question, anchor, status, answer, progress_text, error, task_id, head_commit,
                    locale, created_at, updated_at, explanation, question_input
                 ) VALUES (?, ?, 'queued', NULL, NULL, NULL, ?, ?, ?, ?, ?, ?, ?)`,
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
                questionInput === null ? null : JSON.stringify(frozenQuestionInputSchema.parse(questionInput)),
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
        return true;
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
        afterDatabaseCommit(this.db, () => {
            this.revisionValue += 1;
            if (!this.closed) for (const listener of this.listeners) afterDatabaseCommit(this.db, () => { listener(this.revisionValue); });
        });
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
    const frozen = parseFrozenQuestionInput(row.question_input);
    return { exchange, headCommit: row.head_commit, questionInput: frozen.input, questionInputCorrupt: frozen.corrupt };
}

function parseFrozenQuestionInput(raw: string | null): { input: FrozenQuestionInput | null; corrupt: boolean } {
    if (raw === null) return { input: null, corrupt: false };
    try {
        const parsed = frozenQuestionInputSchema.safeParse(JSON.parse(raw) as unknown);
        return parsed.success ? { input: parsed.data, corrupt: false } : { input: null, corrupt: true };
    } catch {
        return { input: null, corrupt: true };
    }
}

function parseAnchor(raw: string): ChatAnchor {
    const value: unknown = JSON.parse(raw);
    const filled =
        typeof value === 'object' && value !== null && !('diffId' in value)
            ? { ...value, diffId: LEGACY_DIFF_ID }
            : value;
    return chatAnchorSchema.parse(filled);
}

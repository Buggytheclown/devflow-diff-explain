import type { Locale } from '@sherpa/protocol';

import type { SherpaDatabase, SqlRow } from './db.js';

/**
 * Привязка раунда локального ревью к его задаче `review.feedback` (миграция 021). Раунды живут
 * в файле хоста, очередь — в SQLite; связь между ними обязана пережить рестарт, иначе сверка
 * поставила бы на тот же раунд вторую задачу.
 */

/** Судьба задачи раунда: открыта, принята или закрыта провалом (проваленную не ставят заново). */
export type FeedbackTaskState = 'open' | 'done' | 'failed';

export interface FeedbackBinding {
    readonly roundId: string;
    readonly taskId: number;
    readonly state: FeedbackTaskState;
    /** Язык, на котором задача просила отвечать: по нему проверяется сданный результат. */
    readonly locale: Locale;
}

interface BindingRow extends SqlRow {
    round_id: string;
    task_id: number;
    state: string;
    locale: string;
}

export interface FeedbackStoreOptions {
    readonly db: SherpaDatabase;
    readonly now?: () => Date;
}

export class FeedbackStore {
    private readonly db: SherpaDatabase;
    private readonly now: () => Date;

    constructor(options: FeedbackStoreOptions) {
        this.db = options.db;
        this.now = options.now ?? ((): Date => new Date());
    }

    /** Все известные привязки — по одной на раунд. */
    list(): FeedbackBinding[] {
        const rows = this.db
            .prepare('SELECT round_id, task_id, state, locale FROM feedback_tasks')
            .all() as BindingRow[];
        return rows.map(bindingOf);
    }

    /** Привязка раунда; null — задачи у раунда ещё не было. */
    ofRound(roundId: string): FeedbackBinding | null {
        const row = this.db
            .prepare('SELECT round_id, task_id, state, locale FROM feedback_tasks WHERE round_id = ?')
            .get(roundId) as BindingRow | undefined;
        return row === undefined ? null : bindingOf(row);
    }

    /** Раунд задачи; null — задача не наша. */
    ofTask(taskId: number): FeedbackBinding | null {
        const row = this.db
            .prepare('SELECT round_id, task_id, state, locale FROM feedback_tasks WHERE task_id = ?')
            .get(taskId) as BindingRow | undefined;
        return row === undefined ? null : bindingOf(row);
    }

    /** Новая задача раунда: повторная постановка перетирает прежнюю привязку. */
    bind(roundId: string, taskId: number, locale: Locale): void {
        const nowIso = this.now().toISOString();
        this.db
            .prepare(
                `INSERT INTO feedback_tasks (round_id, task_id, state, locale, created_at, updated_at)
                 VALUES (?, ?, 'open', ?, ?, ?)
                 ON CONFLICT(round_id) DO UPDATE SET task_id = excluded.task_id, state = 'open',
                     locale = excluded.locale, updated_at = excluded.updated_at`,
            )
            .run(roundId, taskId, locale, nowIso, nowIso);
    }

    setState(roundId: string, state: FeedbackTaskState): void {
        this.db
            .prepare('UPDATE feedback_tasks SET state = ?, updated_at = ? WHERE round_id = ?')
            .run(state, this.now().toISOString(), roundId);
    }
}

function bindingOf(row: BindingRow): FeedbackBinding {
    return {
        roundId: row.round_id,
        taskId: row.task_id,
        state: stateOf(row.state),
        locale: row.locale === 'en' ? 'en' : 'ru',
    };
}

function stateOf(value: string): FeedbackTaskState {
    return value === 'done' || value === 'failed' ? value : 'open';
}

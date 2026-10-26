import type { HostId, Iteration, PrDiff, ReviewSource } from '@sherpa/protocol';
import { iterationSchema, prDiffSchema } from '@sherpa/protocol';

import type { SherpaDatabase, SqlRow } from './db.js';
import { transaction } from './db.js';

/** Итерация вместе с её локально сохранённым патчем. */
export interface StoredIteration {
    readonly iteration: Iteration;
    readonly diff: PrDiff;
}

export interface IterationStoreOptions {
    readonly db: SherpaDatabase;
    /** Инжектируемые часы: момент загрузки патча в тестах не должен зависеть от системного времени. */
    readonly now?: () => Date;
}

interface IterationRow extends SqlRow {
    diff_id: string;
    base_commit: string;
    head_commit: string;
    created_at: string;
    status: string;
    diff_json: string;
}

interface InterdiffRow extends SqlRow {
    diff_json: string;
}

/**
 * Итерации PR и их патчи в SQLite этого PR (docs/product.md §4a).
 *
 * Зачем хранить патч у себя: после force-push хост прошлую итерацию не отдаёт вовсе, а старый
 * снапшот маршрута обязан остаться читаемым — значит, дифф, по которому он строился, должен
 * лежать локально. Срезы между итерациями кэшируются здесь же: у Арканума интердифф считается
 * 2.8–3.7 с, платить за него дважды незачем.
 *
 * Граница fail-closed, как в `route-store.ts`: на записи и на чтении всё проходит через схемы
 * протокола, а повреждённая строка не роняет сервер — предупреждение в stderr и пропуск.
 */
export class IterationStore {
    private readonly db: SherpaDatabase;
    private readonly now: () => Date;
    private readonly txSync: (statuses: ReadonlyMap<string, Iteration>, gone: readonly string[]) => void;

    constructor(options: IterationStoreOptions) {
        this.db = options.db;
        this.now = options.now ?? ((): Date => new Date());
        this.txSync = transaction(this.db, (statuses: ReadonlyMap<string, Iteration>, gone: readonly string[]) => {
            for (const [diffId, iteration] of statuses) {
                this.db
                    .prepare(
                        `UPDATE iterations
                            SET status = ?, base_commit = ?, head_commit = ?, created_at = ?
                          WHERE diff_id = ?`,
                    )
                    .run(iteration.status, iteration.baseCommit, iteration.headCommit, iteration.createdAt, diffId);
            }
            for (const diffId of gone) {
                this.db.prepare('UPDATE iterations SET status = ? WHERE diff_id = ?').run('gone', diffId);
            }
        });
    }

    /** Сохраняет патч итерации и её мету; повторная загрузка той же итерации перезаписывает строку. */
    upsert(diff: PrDiff, iteration: Iteration): void {
        const parsedDiff = prDiffSchema.parse(diff);
        const parsedIteration = iterationSchema.parse(iteration);
        if (parsedIteration.diffId !== parsedDiff.diffId) {
            throw new Error(
                `итерация ${parsedIteration.diffId} и дифф ${parsedDiff.diffId} — разные итерации`,
            );
        }

        this.db
            .prepare(
                `INSERT INTO iterations (
                    diff_id, base_commit, head_commit, created_at, status, diff_json, fetched_at
                 ) VALUES (?, ?, ?, ?, ?, ?, ?)
                 ON CONFLICT(diff_id) DO UPDATE SET
                    base_commit = excluded.base_commit, head_commit = excluded.head_commit,
                    created_at = excluded.created_at, status = excluded.status,
                    diff_json = excluded.diff_json, fetched_at = excluded.fetched_at`,
            )
            .run(
                parsedIteration.diffId,
                parsedIteration.baseCommit,
                parsedIteration.headCommit,
                parsedIteration.createdAt,
                parsedIteration.status,
                JSON.stringify(parsedDiff),
                this.now().toISOString(),
            );
    }

    /** Итерация с её патчем; null — патча этой итерации локально нет (или строка повреждена). */
    get(diffId: HostId): StoredIteration | null {
        const row = this.db.prepare('SELECT * FROM iterations WHERE diff_id = ?').get(diffId) as
            | IterationRow
            | undefined;
        return row === undefined ? null : this.parseRow(row);
    }

    /** Сохранённые итерации в порядке появления. */
    list(): Iteration[] {
        return this.rows().map((stored) => stored.iteration);
    }

    /**
     * Сводит список хоста со своим хранилищем: статусы перечисленных берутся у хоста, а
     * сохранённая и не перечисленная итерация становится `gone` — этот статус ставит только
     * сервер (контракт `iterationStatusSchema`). Результат — объединённый список по времени.
     */
    sync(hostIterations: readonly Iteration[]): Iteration[] {
        const listed = hostIterations.map((iteration) => iterationSchema.parse(iteration));
        const byId = new Map(listed.map((iteration) => [iteration.diffId, iteration]));

        const stored = this.rows().map((row) => row.iteration);
        const known = new Map(stored.map((iteration) => [iteration.diffId, iteration]));
        const statuses = new Map<string, Iteration>();
        for (const iteration of listed) {
            if (known.has(iteration.diffId)) {
                statuses.set(iteration.diffId, iteration);
            }
        }
        const gone = stored
            .filter((iteration) => !byId.has(iteration.diffId))
            .map((iteration) => iteration.diffId);

        this.txSync(statuses, gone);

        const merged = [
            ...listed,
            ...stored
                .filter((iteration) => !byId.has(iteration.diffId))
                .map((iteration) => ({ ...iteration, status: 'gone' as const })),
        ];
        return merged.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    }

    /**
     * Срез между итерациями из кэша, а на промахе — через `load` с записью. Считает срез
     * вызывающая сторона (хост-адаптер), стор только помнит результат.
     */
    async getInterdiff(base: HostId, head: HostId, load: () => Promise<PrDiff>): Promise<PrDiff> {
        const cached = this.readInterdiff(base, head);
        if (cached !== null) {
            return cached;
        }

        const diff = prDiffSchema.parse(await load());
        this.db
            .prepare(
                `INSERT INTO interdiffs (base_id, head_id, diff_json, fetched_at) VALUES (?, ?, ?, ?)
                 ON CONFLICT(base_id, head_id) DO UPDATE SET
                    diff_json = excluded.diff_json, fetched_at = excluded.fetched_at`,
            )
            .run(base, head, JSON.stringify(diff), this.now().toISOString());
        return diff;
    }

    /**
     * Срез из кэша без похода в хост: приёмка результата генерации синхронна, а сеть в ней
     * недопустима — не добыли заранее, значит переносить нечего.
     */
    peekInterdiff(base: HostId, head: HostId): PrDiff | null {
        return this.readInterdiff(base, head);
    }

    private readInterdiff(base: HostId, head: HostId): PrDiff | null {
        const row = this.db
            .prepare('SELECT diff_json FROM interdiffs WHERE base_id = ? AND head_id = ?')
            .get(base, head) as InterdiffRow | undefined;
        if (row === undefined) {
            return null;
        }

        try {
            return prDiffSchema.parse(JSON.parse(row.diff_json) as unknown);
        } catch (error) {
            process.stderr.write(
                `sherpa-server: кэш среза ${base}→${head} повреждён (${messageOf(error)}) — пересчитываем\n`,
            );
            return null;
        }
    }

    private rows(): StoredIteration[] {
        const rows = this.db
            .prepare('SELECT * FROM iterations ORDER BY created_at, rowid')
            .all() as IterationRow[];
        return rows.flatMap((row) => {
            const stored = this.parseRow(row);
            return stored === null ? [] : [stored];
        });
    }

    private parseRow(row: IterationRow): StoredIteration | null {
        try {
            return {
                iteration: iterationSchema.parse({
                    diffId: row.diff_id,
                    baseCommit: row.base_commit,
                    headCommit: row.head_commit,
                    createdAt: row.created_at,
                    status: row.status,
                }),
                diff: prDiffSchema.parse(JSON.parse(row.diff_json) as unknown),
            };
        } catch (error) {
            process.stderr.write(
                `sherpa-server: итерация ${row.diff_id} в хранилище повреждена (${messageOf(error)}) — пропущена\n`,
            );
            return null;
        }
    }
}

/**
 * Кладёт только что загруженный с хоста дифф в локальное хранилище патчей. Зовётся отовсюду,
 * где сервер берёт активный дифф (ручка читалки, генерация маршрута, чат): так хранилище
 * наполняется само, без отдельного обхода итераций.
 *
 * Ничего не бросает и никого не ждёт: ответ ручки не должен зависеть ни от списка итераций,
 * ни от записи в SQLite — не сложилось, значит в следующий раз.
 */
export async function rememberIterationDiff(
    store: IterationStore,
    host: ReviewSource,
    diff: PrDiff,
): Promise<void> {
    try {
        const iterations = await host.listIterations();
        const iteration = iterations.find((candidate) => candidate.diffId === diff.diffId);
        if (iteration === undefined) {
            // Пока грузился дифф, автор запушил новый: мету этой итерации хост уже не называет.
            process.stderr.write(
                `sherpa-server: итерации ${diff.diffId} нет в списке хоста — патч не сохранён\n`,
            );
            return;
        }
        store.upsert(diff, iteration);
    } catch (error) {
        process.stderr.write(`sherpa-server: патч итерации не сохранён: ${messageOf(error)}\n`);
    }
}

function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

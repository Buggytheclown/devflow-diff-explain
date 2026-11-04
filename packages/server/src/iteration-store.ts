import type { HostId, Iteration, PrDiff } from '@sherpa/protocol';
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
    code_snapshot_id: string | null;
}

/**
 * Каталог итераций. Старые строки хранят патч; новые ссылаются на канонический CodeSnapshot.
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

        const existing = this.get(parsedDiff.diffId);
        if (existing?.diff.codeSnapshotId !== undefined && JSON.stringify(existing.diff) !== JSON.stringify(parsedDiff)) {
            throw new Error(`Canonical snapshot for ${parsedDiff.diffId} cannot be overwritten.`);
        }

        this.db
            .prepare(
                `INSERT INTO iterations (
                    diff_id, base_commit, head_commit, created_at, status, diff_json, fetched_at
                 ) VALUES (?, ?, ?, ?, ?, ?, ?)
                 ON CONFLICT(diff_id) DO UPDATE SET
                    base_commit = excluded.base_commit, head_commit = excluded.head_commit,
                    created_at = excluded.created_at, status = excluded.status,
                    diff_json = CASE WHEN iterations.code_snapshot_id IS NULL THEN excluded.diff_json ELSE iterations.diff_json END,
                    fetched_at = excluded.fetched_at`,
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

    /** Новая итерация хранит только ссылку; legacy JSON при дополнении остаётся нетронутым. */
    registerSnapshot(diff: PrDiff, codeSnapshotId: string, iteration: Iteration): void {
        const parsedDiff = prDiffSchema.parse(diff);
        const parsedIteration = iterationSchema.parse(iteration);
        if (parsedDiff.diffId !== parsedIteration.diffId || parsedDiff.codeSnapshotId !== codeSnapshotId) {
            throw new Error('Iteration and canonical code snapshot do not match.');
        }
        const row = this.db.prepare('SELECT data FROM code_snapshots WHERE id = ? AND diff_id = ?').get(codeSnapshotId, parsedDiff.diffId) as { data: string } | undefined;
        if (row === undefined || JSON.stringify(prDiffSchema.parse((JSON.parse(row.data) as { diff: unknown }).diff)) !== JSON.stringify(parsedDiff)) {
            throw new Error('Canonical code snapshot is unavailable or different.');
        }
        this.db.prepare(`INSERT INTO iterations (diff_id, base_commit, head_commit, created_at, status, diff_json, fetched_at, code_snapshot_id)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(diff_id) DO UPDATE SET
                base_commit = excluded.base_commit, head_commit = excluded.head_commit,
                created_at = excluded.created_at, status = excluded.status,
                code_snapshot_id = excluded.code_snapshot_id, fetched_at = excluded.fetched_at`)
            .run(parsedIteration.diffId, parsedIteration.baseCommit, parsedIteration.headCommit, parsedIteration.createdAt,
                parsedIteration.status, JSON.stringify({ kind: 'code-snapshot-ref', codeSnapshotId }), this.now().toISOString(), codeSnapshotId);
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
            const referenced = row.code_snapshot_id === null ? null : this.db.prepare('SELECT data FROM code_snapshots WHERE id = ? AND diff_id = ?')
                .get(row.code_snapshot_id, row.diff_id) as { data: string } | undefined;
            const diff = referenced === null ? JSON.parse(row.diff_json) as unknown
                : referenced === undefined ? null : (JSON.parse(referenced.data) as { diff: unknown }).diff;
            return {
                iteration: iterationSchema.parse({
                    diffId: row.diff_id,
                    baseCommit: row.base_commit,
                    headCommit: row.head_commit,
                    createdAt: row.created_at,
                    status: row.status,
                }),
                diff: prDiffSchema.parse(diff),
            };
        } catch (error) {
            process.stderr.write(
                `sherpa-server: итерация ${row.diff_id} в хранилище повреждена (${messageOf(error)}) — пропущена\n`,
            );
            return null;
        }
    }
}

function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

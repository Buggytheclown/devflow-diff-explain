import { createRequire } from 'node:module';
import type * as NodeSqlite from 'node:sqlite';

import type { Migration } from './migrations.js';
import { MIGRATIONS, SCHEMA_VERSION_KEY } from './migrations.js';

export type SherpaDatabase = NodeSqlite.DatabaseSync;

/**
 * `node:sqlite` грузится по требованию, а не статическим импортом: до Node 22.13 такого модуля нет,
 * и статический импорт убил бы процесс сырой ошибкой Node ещё на линковке — до того, как
 * `checkNodeVersion` (см. `runtime.ts`) успеет объяснить человеку, что делать. Импорт выше —
 * только за типами, он стирается при сборке.
 */
function loadSqlite(): typeof NodeSqlite {
    return createRequire(import.meta.url)('node:sqlite') as typeof NodeSqlite;
}

/**
 * Строка выборки как её отдаёт node:sqlite — безымянная запись колонок. Форму таблицы описывает
 * вызывающий: интерфейс строки наследует этот тип, иначе приведение результата выборки к нему
 * TS не пропускает.
 */
export type SqlRow = Record<string, NodeSqlite.SQLOutputValue>;

/**
 * Открывает (или создаёт) хранилище PR и доводит схему до актуальной.
 * WAL — потому что UI-читатели и воркерские записи идут одновременно (docs/architecture.md §1).
 */
export function openDatabase(file: string, migrations: readonly Migration[] = MIGRATIONS): SherpaDatabase {
    const db = new (loadSqlite().DatabaseSync)(file);
    try {
        assertKnownSchema(db, migrations);
        db.exec('PRAGMA journal_mode = WAL;');
        db.exec('PRAGMA foreign_keys = ON;');
        applyMigrations(db, migrations);
    } catch (error) {
        db.close();
        throw error;
    }
    return db;
}

/**
 * Транзакция вокруг функции: у встроенного `node:sqlite` своего хелпера нет.
 * `BEGIN IMMEDIATE` — писать собираются все транзакции сервера, блокировка берётся сразу,
 * а не в середине операции. Возвращённое значение коммитится, исключение откатывает —
 * на этом стоит паттерн `Outcome` в очереди и регистре воркера: доменная ошибка едет значением
 * (и остаётся в хранилище), исключение отменяет всё.
 *
 * Вложенный вызов участвует в общей транзакции; исключение откатывает внешнюю операцию.
 */
const activeTransactions = new WeakMap<SherpaDatabase, { effects: (() => void)[]; failed: boolean }>();

/** Публикация памяти и событий только после внешнего commit. */
export function afterDatabaseCommit(db: SherpaDatabase, effect: () => void): void {
    const pending = activeTransactions.get(db);
    if (pending === undefined) runCommitEffect(effect);
    else pending.effects.push(effect);
}

export function transaction<A extends unknown[], R>(db: SherpaDatabase, body: (...args: A) => R): (...args: A) => R {
    return (...args: A): R => {
        const active = activeTransactions.get(db);
        if (active !== undefined) {
            try { return body(...args); }
            catch (error) { active.failed = true; throw error; }
        }
        db.exec('BEGIN IMMEDIATE;');
        const effects: (() => void)[] = [];
        const context = { effects, failed: false };
        activeTransactions.set(db, context);
        let result: R;
        try {
            result = body(...args);
            if (context.failed) throw new Error('Transaction aborted by a nested failure.');
            db.exec('COMMIT;');
        } catch (error) {
            try { db.exec('ROLLBACK;'); } catch { /* SQLite мог откатить сам. */ }
            activeTransactions.delete(db);
            throw error;
        }
        activeTransactions.delete(db);
        for (const effect of effects) runCommitEffect(effect);
        return result;
    };
}

function runCommitEffect(effect: () => void): void {
    try { effect(); }
    catch (error) { process.stderr.write(`sherpa-server: ошибка уведомления после commit: ${error instanceof Error ? error.message : String(error)}\n`); }
}

/** Последовательно применяет неприменённые миграции; каждая — в своей транзакции. */
export function applyMigrations(db: SherpaDatabase, migrations: readonly Migration[] = MIGRATIONS): void {
    assertKnownSchema(db, migrations);
    db.exec(`
        CREATE TABLE IF NOT EXISTS migrations (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL UNIQUE,
            applied_at TEXT NOT NULL
        );
    `);

    const appliedRows = db.prepare('SELECT name FROM migrations').all() as { name: string }[];
    const applied = new Set(appliedRows.map((row) => row.name));

    for (const migration of migrations) {
        if (applied.has(migration.name)) {
            continue;
        }

        const run = transaction(db, () => {
            db.exec(migration.sql);
            db.prepare('INSERT INTO migrations (name, applied_at) VALUES (?, ?)').run(
                migration.name,
                new Date().toISOString(),
            );
        });
        run();
    }

    db.prepare(
        `INSERT INTO meta (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    ).run(SCHEMA_VERSION_KEY, String(migrations.length));
}

/** Отказ до первой записи: старая сборка не должна открывать БД с неизвестными миграциями. */
function assertKnownSchema(db: SherpaDatabase, migrations: readonly Migration[]): void {
    const hasTable = (name: string): boolean => db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined;
    if (hasTable('migrations')) {
        const applied = (db.prepare('SELECT name FROM migrations ORDER BY id').all() as { name: string }[]).map((row) => row.name);
        if (applied.some((name, index) => migrations[index]?.name !== name)) {
            throw new Error('Database schema is newer or incompatible with this server. Open it with a compatible version.');
        }
    }
    if (!hasTable('meta')) return;
    const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(SCHEMA_VERSION_KEY) as { value: string } | undefined;
    if (row !== undefined && (!/^\d+$/.test(row.value) || Number(row.value) > migrations.length)) {
        throw new Error('Database schema is newer or incompatible with this server. Open it with a compatible version.');
    }
}

/** Версия схемы из `meta`; `null`, если хранилище ещё не мигрировано. */
export function readSchemaVersion(db: SherpaDatabase): string | null {
    const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(SCHEMA_VERSION_KEY) as
        | { value: string }
        | undefined;
    return row?.value ?? null;
}

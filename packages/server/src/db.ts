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
    db.exec('PRAGMA journal_mode = WAL;');
    db.exec('PRAGMA foreign_keys = ON;');

    try {
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
 * Вложенные вызовы не поддерживаются (savepoint'ов нет) — второй `BEGIN` упадёт.
 */
export function transaction<A extends unknown[], R>(db: SherpaDatabase, body: (...args: A) => R): (...args: A) => R {
    return (...args: A): R => {
        db.exec('BEGIN IMMEDIATE;');

        try {
            const result = body(...args);
            // Коммит внутри try: упавший COMMIT (I/O, кончилось место) обязан оставить соединение
            // вне транзакции, иначе каждая следующая операция сервера падает «transaction within a transaction».
            db.exec('COMMIT;');
            return result;
        } catch (error) {
            try {
                db.exec('ROLLBACK;');
            } catch {
                // SQLite мог откатить транзакцию сам — тогда откатывать уже нечего.
            }
            throw error;
        }
    };
}

/** Последовательно применяет неприменённые миграции; каждая — в своей транзакции. */
export function applyMigrations(db: SherpaDatabase, migrations: readonly Migration[] = MIGRATIONS): void {
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

/** Версия схемы из `meta`; `null`, если хранилище ещё не мигрировано. */
export function readSchemaVersion(db: SherpaDatabase): string | null {
    const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(SCHEMA_VERSION_KEY) as
        | { value: string }
        | undefined;
    return row?.value ?? null;
}

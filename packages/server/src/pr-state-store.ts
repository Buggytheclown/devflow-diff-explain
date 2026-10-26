import type { UiPrState, UiPrStatePatch } from '@sherpa/protocol';
import { uiPrStateSchema } from '@sherpa/protocol';

import type { SherpaDatabase, SqlRow } from './db.js';
import { transaction } from './db.js';

export interface PrStateStoreOptions {
    readonly db: SherpaDatabase;
    /** Инжектируемые часы: тестам удобно проверять `updated_at` без реального времени. */
    readonly now?: () => Date;
}

interface StateRow extends SqlRow {
    key: string;
    value_json: string;
}

type PrStateField = keyof UiPrState;

/**
 * Состояние UI одного PR: свёрнутые каталоги дерева и карточки диффа, недавние команды
 * палитры. Живёт в per-PR SQLite, а не в браузере: origin вкладки меняется вместе с портом
 * сервера, и `localStorage` до следующего запуска не доживает.
 *
 * Таблица — KV по именам полей схемы: битое значение одного поля деградирует в дефолт только
 * этого поля, соседние ревьюер не теряет. Патч заменяет названное поле целиком — иначе
 * «вернул каталог к умолчанию» (удаление ключа карты) было бы непредставимо.
 */
export class PrStateStore {
    private readonly db: SherpaDatabase;
    private readonly now: () => Date;
    private readonly txPatch: (partial: UiPrStatePatch) => UiPrState;

    constructor(options: PrStateStoreOptions) {
        this.db = options.db;
        this.now = options.now ?? ((): Date => new Date());
        this.txPatch = transaction(this.db, (partial: UiPrStatePatch) => this.patchInTransaction(partial));
    }

    read(): UiPrState {
        const rows = this.db.prepare('SELECT key, value_json FROM ui_pr_state').all() as StateRow[];
        const source: Record<string, unknown> = {};
        for (const row of rows) {
            // Чужой ключ в таблице (ручная правка, откат версии) — не наше поле, молча мимо.
            if (!isPrStateField(row.key)) {
                continue;
            }
            const value = parseField(row.key, row.value_json);
            if (value !== undefined) {
                source[row.key] = value;
            }
        }
        // Отсутствующие и отброшенные поля добирают дефолты схемы: состояние UI не повод отказать вкладке.
        return uiPrStateSchema.parse(source);
    }

    /** Заменяет названные поля целиком и отдаёт состояние целиком; `undefined` — поле не трогать. */
    patch(partial: UiPrStatePatch): UiPrState {
        return this.txPatch(partial);
    }

    private patchInTransaction(partial: UiPrStatePatch): UiPrState {
        const updatedAt = this.now().toISOString();
        const upsert = this.db.prepare(
            `INSERT INTO ui_pr_state (key, value_json, updated_at) VALUES (?, ?, ?)
             ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
        );
        for (const field of Object.keys(uiPrStateSchema.shape) as PrStateField[]) {
            const value = partial[field];
            if (value !== undefined) {
                upsert.run(field, JSON.stringify(value), updatedAt);
            }
        }
        return this.read();
    }
}

function isPrStateField(key: string): key is PrStateField {
    return Object.hasOwn(uiPrStateSchema.shape, key);
}

/** Значение поля из хранилища; `undefined` — не разобралось, поле уедет в свой дефолт. */
function parseField(field: PrStateField, raw: string): unknown {
    let value: unknown;
    try {
        value = JSON.parse(raw);
    } catch (error) {
        process.stderr.write(
            `Поле ${field} состояния PR не разобралось как JSON (${messageOf(error)}) — беру дефолт.\n`,
        );
        return undefined;
    }

    if (!uiPrStateSchema.shape[field].safeParse(value).success) {
        process.stderr.write(`Поле ${field} состояния PR не сошлось со схемой — беру дефолт.\n`);
        return undefined;
    }
    return value;
}

function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

import fs from 'node:fs';
import path from 'node:path';

import { z } from 'zod';

/**
 * Карта «ключ идемпотентности → id комментария». GitHub ключей повтора не понимает, а буфер
 * черновиков Шерпы повторяет запись через минуты и переживает перезапуск сервера — поэтому
 * соответствие держит сам адаптер.
 *
 * Хранилище — производные данные: не прочиталось, не записалось — повтор в худшем случае заведёт
 * второй комментарий, ревью от этого не падает.
 */

const FILE_MODE = 0o600;
const DIR_MODE = 0o700;

/** Потолок записей: буфер черновиков живёт одним PR, старые ключи повторять уже некому. */
const MAX_ENTRIES = 500;

const storeSchema = z.record(z.string(), z.string());

export interface IdempotencyStore {
    get(key: string): string | null;
    set(key: string, commentId: string): void;
}

/** Хранилище в памяти: тесты и любой хост без каталога стейта. */
export function memoryIdempotencyStore(): IdempotencyStore {
    const entries = new Map<string, string>();
    return {
        get: (key) => entries.get(key) ?? null,
        set: (key, commentId) => {
            entries.set(key, commentId);
        },
    };
}

/** Хранилище файлом `~/.sherpa/prs/<key>/github-drafts.json` (0600, атомарная запись). */
export function fileIdempotencyStore(filePath: string): IdempotencyStore {
    let entries: Map<string, string> | null = null;

    const load = (): Map<string, string> => {
        entries ??= new Map(Object.entries(read(filePath)));
        return entries;
    };

    return {
        get: (key) => load().get(key) ?? null,
        set: (key, commentId) => {
            const loaded = load();
            loaded.delete(key);
            loaded.set(key, commentId);
            while (loaded.size > MAX_ENTRIES) {
                const oldest = loaded.keys().next();
                if (oldest.done === true) {
                    break;
                }
                loaded.delete(oldest.value);
            }
            write(filePath, loaded);
        },
    };
}

function read(filePath: string): Record<string, string> {
    let raw: string;
    try {
        raw = fs.readFileSync(filePath, 'utf8');
    } catch {
        return {};
    }

    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return {};
    }
    const store = storeSchema.safeParse(parsed);
    return store.success ? store.data : {};
}

function write(filePath: string, entries: ReadonlyMap<string, string>): void {
    const temporary = `${filePath}.${String(process.pid)}.tmp`;
    try {
        fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: DIR_MODE });
        fs.writeFileSync(temporary, `${JSON.stringify(Object.fromEntries(entries), null, 2)}\n`, {
            mode: FILE_MODE,
        });
        // writeFileSync применяет mode с оглядкой на umask и только при создании — доводим явно.
        fs.chmodSync(temporary, FILE_MODE);
        fs.renameSync(temporary, filePath);
    } catch (error) {
        fs.rmSync(temporary, { force: true });
        process.stderr.write(
            `sherpa-server: карта повторов черновиков GitHub не записалась: ${messageOf(error)}\n`,
        );
    }
}

function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

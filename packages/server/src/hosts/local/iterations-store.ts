import fs from 'node:fs/promises';
import path from 'node:path';

import type { FileChangeType } from '@sherpa/protocol';
import { fileChangeTypeSchema } from '@sherpa/protocol';
import { z } from 'zod';

/**
 * История итераций локального ревью. Прошлых итераций у рабочего дерева нет нигде, кроме нашей
 * записи: каждый новый снимок дописывается сюда, и по этой истории считается срез между двумя
 * итерациями (перенос прогресса, якорей заметок и затронутых остановок).
 *
 * Раскладка на диске — `~/.sherpa/prs/<key>/local-iterations/`: `index.json` со списком итераций
 * и `blobs/<sha256>` с содержимым новых сторон текстовых файлов. Блоб адресуется содержимым,
 * поэтому одинаковые версии файла не дублируются, а неизменившийся файл между итерациями
 * хранится один раз.
 */

/** Права файлов и каталогов истории: как у остального стейта (`docs/architecture.md §6`). */
const FILE_MODE = 0o600;
const DIR_MODE = 0o700;

/**
 * Потолок истории: столько итераций хранится, остальные выпадают из индекса, а их блобы
 * удаляются. Ревью рабочего дерева живёт часы, итерация появляется на каждую правку — без
 * потолка каталог рос бы всё ревью, а срез со стотысячной итерацией никому не нужен.
 */
export const MAX_LOCAL_ITERATIONS = 100;

/** Счётчик записей процесса: им разводятся имена временных файлов. */
let writeSequence = 0;

/** Чем представлена новая сторона файла: текстом, двоичным содержимым или размером за лимитом. */
export type LocalIterationFileKind = 'text' | 'binary' | 'oversized';

export interface LocalIterationFile {
    readonly path: string;
    readonly changeType: FileChangeType;
    readonly kind: LocalIterationFileKind;
    /** Отпечаток файла в диффе (`fileHash` снимка): по нему видно, менялся ли именно он. */
    readonly hash: string;
    /** sha256 содержимого новой стороны — адрес блоба; null — новой стороны нет или она не текст. */
    readonly blob: string | null;
}

/** Одна итерация рабочего дерева: мета плюс состав файлов, которого хватает на срез. */
export interface LocalIterationRecord {
    readonly diffId: string;
    readonly baseCommit: string;
    readonly headCommit: string;
    readonly createdAt: string;
    readonly files: readonly LocalIterationFile[];
}

/** Доступ к истории итераций одного локального ревью; в тестах подменяется хранилищем в памяти. */
export interface LocalIterationsStore {
    /** История в порядке появления; последняя запись — активная итерация. */
    read(): Promise<LocalIterationRecord[]>;
    /** Дописывает итерацию и отдаёт историю после записи: с потолком и без лишних блобов. */
    append(record: LocalIterationRecord, blobs: ReadonlyMap<string, Uint8Array>): Promise<LocalIterationRecord[]>;
    /** Текст новой стороны по адресу блоба; null — такого блоба в истории нет. */
    blob(hash: string): Promise<string | null>;
}

const fileSchema = z.object({
    path: z.string().min(1),
    changeType: fileChangeTypeSchema,
    kind: z.enum(['text', 'binary', 'oversized']),
    hash: z.string().min(1),
    blob: z.string().min(1).nullable(),
});

const indexSchema = z.array(
    z.object({
        diffId: z.string().min(1),
        baseCommit: z.string().min(1),
        headCommit: z.string().min(1),
        createdAt: z.iso.datetime(),
        files: z.array(fileSchema),
    }),
);

/**
 * История после дописывания итерации: тот же `diffId` уже был (правку откатили) — старая запись
 * уезжает, новая встаёт в конец. Иначе в списке оказались бы две итерации с одним id, а сервер
 * ключует ими всё: прогресс, снапшоты и якоря заметок.
 */
export function appendToHistory(
    history: readonly LocalIterationRecord[],
    record: LocalIterationRecord,
): LocalIterationRecord[] {
    const kept = history.filter((known) => known.diffId !== record.diffId);
    return [...kept, record].slice(-MAX_LOCAL_ITERATIONS);
}

/** Адреса блобов, на которые ссылается история: всё остальное в `blobs/` — мусор. */
function referencedBlobs(history: readonly LocalIterationRecord[]): Set<string> {
    const referenced = new Set<string>();
    for (const record of history) {
        for (const file of record.files) {
            if (file.blob !== null) {
                referenced.add(file.blob);
            }
        }
    }
    return referenced;
}

/**
 * История файлами. Индекс пишется атомарно (временный файл и `rename`), блобы — раньше индекса:
 * осиротевший блоб переживёт чистка, а запись индекса, ссылающаяся на ненаписанный блоб, стоила
 * бы среза. Индекс не прочитался или не прошёл схему — ошибка с путём, а не тихий чистый лист:
 * пустой список на его месте стёр бы историю первой же записью.
 */
export function fileIterationsStore(dir: string): LocalIterationsStore {
    const indexPath = path.join(dir, 'index.json');
    const blobsDir = path.join(dir, 'blobs');
    const blobPath = (hash: string): string => path.join(blobsDir, hash);

    const read = async (): Promise<LocalIterationRecord[]> => {
        let raw: string;
        try {
            raw = await fs.readFile(indexPath, 'utf8');
        } catch (error) {
            // Индекса ещё нет — истории нет. Любой другой отказ чтения пробрасывается: `append`
            // начинает с `read`, и пустой список на месте нечитаемого индекса стёр бы историю.
            if (!isMissing(error)) {
                throw error;
            }
            return [];
        }

        let parsed: unknown;
        try {
            parsed = JSON.parse(raw);
        } catch {
            throw new Error(`${indexPath} is not valid JSON — move the directory aside to start over`);
        }
        const index = indexSchema.safeParse(parsed);
        if (!index.success) {
            throw new Error(`${indexPath} does not match the local iteration history format`);
        }
        return index.data;
    };

    return {
        read,
        append: async (record, blobs) => {
            const next = appendToHistory(await read(), record);
            await fs.mkdir(blobsDir, { recursive: true, mode: DIR_MODE });

            for (const file of record.files) {
                const bytes = file.blob === null ? undefined : blobs.get(file.blob);
                if (file.blob === null || bytes === undefined) {
                    continue;
                }
                await writeAtomic(blobPath(file.blob), Buffer.from(bytes));
            }
            await writeAtomic(indexPath, Buffer.from(`${JSON.stringify(next, null, 2)}\n`));

            // Чистка после индекса: блоб, на который уже никто не ссылается, не нужен никому.
            const referenced = referencedBlobs(next);
            let stored: string[];
            try {
                stored = await fs.readdir(blobsDir);
            } catch {
                stored = [];
            }
            for (const name of stored) {
                if (!referenced.has(name)) {
                    await fs.rm(path.join(blobsDir, name), { force: true });
                }
            }
            return next;
        },
        blob: async (hash) => {
            try {
                return await fs.readFile(blobPath(hash), 'utf8');
            } catch {
                return null;
            }
        },
    };
}

/** Отказ чтения означает «файла нет», а не «прочитать не удалось». */
function isMissing(error: unknown): boolean {
    const code = (error as NodeJS.ErrnoException).code;
    return code === 'ENOENT' || code === 'ENOTDIR';
}

/** Запись файла целиком: временный файл рядом и `rename`, права выставляются явно. */
async function writeAtomic(filePath: string, content: Buffer): Promise<void> {
    await fs.mkdir(path.dirname(filePath), { recursive: true, mode: DIR_MODE });
    writeSequence += 1;
    const temporary = `${filePath}.${String(process.pid)}.${String(writeSequence)}.tmp`;
    try {
        await fs.writeFile(temporary, content, { mode: FILE_MODE });
        // writeFile применяет mode с оглядкой на umask — досоздаём права явно.
        await fs.chmod(temporary, FILE_MODE);
        await fs.rename(temporary, filePath);
    } catch (error) {
        await fs.rm(temporary, { force: true });
        throw error;
    }
}

/** Хранилище в памяти: тесты переживают пересоздание хоста на той же истории. */
export function memoryIterationsStore(initial: readonly LocalIterationRecord[] = []): LocalIterationsStore {
    let history = [...initial];
    const blobs = new Map<string, string>();

    return {
        read: () => Promise.resolve(history.map((record) => structuredClone(record))),
        append: (record, incoming) => {
            history = appendToHistory(history, structuredClone(record));
            for (const file of record.files) {
                const bytes = file.blob === null ? undefined : incoming.get(file.blob);
                if (file.blob !== null && bytes !== undefined) {
                    blobs.set(file.blob, Buffer.from(bytes).toString('utf8'));
                }
            }
            const referenced = referencedBlobs(history);
            for (const hash of [...blobs.keys()]) {
                if (!referenced.has(hash)) {
                    blobs.delete(hash);
                }
            }
            return Promise.resolve(history.map((known) => structuredClone(known)));
        },
        blob: (hash) => Promise.resolve(blobs.get(hash) ?? null),
    };
}

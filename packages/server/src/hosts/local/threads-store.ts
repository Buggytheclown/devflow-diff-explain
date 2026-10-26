import fs from 'node:fs/promises';
import path from 'node:path';

import type { AnchorPosition, ReviewUser, ThreadPin, Verdict } from '@sherpa/protocol';
import { anchorPositionSchema, reviewUserSchema, threadPinSchema, verdictSchema } from '@sherpa/protocol';
import { z } from 'zod';

/**
 * Хранилище комментариев локального ревью. Никакого удалённого хоста у него нет: треды живут
 * файлом в стейте PR (`~/.sherpa/prs/<key>/local-review.json`), а в тестах — в памяти.
 */

/** Права файла с тредами: как у остального стейта (`docs/architecture.md §6`). */
const FILE_MODE = 0o600;
const DIR_MODE = 0o700;

/** Счётчик записей процесса: им разводятся имена временных файлов. */
let writeSequence = 0;

export interface LocalComment {
    id: string;
    /** Автор: ревьюер — пользователь чекаута, ответ агента — бот с моделью в подписи. */
    author: ReviewUser;
    body: string;
    draft: boolean;
    createdAt: string;
    editedAt: string | null;
    /** Ключ повтора записи из буфера черновиков; null — запись пришла без него. */
    idempotencyKey: string | null;
    replies: LocalComment[];
}

export interface LocalAnchor {
    path: string;
    position: AnchorPosition | null;
}

export interface LocalThread {
    id: string;
    /** Якорь помнит путь и позицию: `fileId` живёт одну итерацию и пересчитывается при отдаче. */
    anchor: LocalAnchor | null;
    /** `fileId` на момент написания — им тред отдаётся, когда пути уже нет в активном диффе. */
    fileId: string | null;
    /** Отпечаток файла на момент написания; null — у обсуждения уровня PR файла нет. */
    fileHash: string | null;
    resolved: boolean;
    resolvedBy: string | null;
    pinnedTo: ThreadPin | null;
    root: LocalComment;
}

/** Вердикт последней публикации вместе с итерацией, на которой он поставлен. */
export interface LocalVerdict {
    verdict: Verdict;
    diffId: string;
}

/**
 * Раунд публикации: вердикт и треды, в которых этой публикацией появились комментарии.
 * `pending` ждёт агента, `done` — агент ответил и оставил итог раунда в `summary`.
 */
export interface LocalRound {
    id: string;
    verdict: Verdict;
    diffId: string;
    headCommit: string;
    createdAt: string;
    threadIds: string[];
    status: 'pending' | 'done';
    summary: string | null;
}

export interface LocalReviewData {
    /** Счётчик id комментариев и раундов: монотонный, переживает перезапуск вместе с файлом. */
    nextId: number;
    verdict: LocalVerdict | null;
    threads: LocalThread[];
    rounds: LocalRound[];
}

/** Доступ к тредам одного локального ревью; в тестах подменяется хранилищем в памяти. */
export interface LocalThreadsStore {
    read(): Promise<LocalReviewData>;
    write(data: LocalReviewData): Promise<void>;
}

/** В файлах, записанных до появления `avatarUrl`, ключа нет: без `default` схема их отвергла бы. */
const localAuthorSchema = reviewUserSchema.extend({ avatarUrl: reviewUserSchema.shape.avatarUrl.default(null) });

const commentSchema: z.ZodType<LocalComment> = z.object({
    id: z.string().min(1),
    author: localAuthorSchema,
    body: z.string(),
    draft: z.boolean(),
    createdAt: z.iso.datetime(),
    editedAt: z.iso.datetime().nullable(),
    idempotencyKey: z.string().nullable(),
    get replies() {
        return z.array(commentSchema);
    },
});

const reviewDataSchema = z.object({
    nextId: z.number().int().min(1),
    verdict: z.object({ verdict: verdictSchema, diffId: z.string().min(1) }).nullable(),
    threads: z.array(
        z.object({
            id: z.string().min(1),
            anchor: z
                .object({ path: z.string().min(1), position: anchorPositionSchema.nullable() })
                .nullable(),
            fileId: z.string().min(1).nullable(),
            fileHash: z.string().min(1).nullable(),
            resolved: z.boolean(),
            resolvedBy: z.string().nullable(),
            pinnedTo: threadPinSchema.nullable(),
            root: commentSchema,
        }),
    ),
    rounds: z.array(
        z.object({
            id: z.string().min(1),
            verdict: verdictSchema,
            diffId: z.string().min(1),
            headCommit: z.string().min(1),
            createdAt: z.iso.datetime(),
            threadIds: z.array(z.string().min(1)),
            status: z.enum(['pending', 'done']),
            summary: z.string().nullable(),
        }),
    ),
});

export function emptyReviewData(): LocalReviewData {
    return { nextId: 1, verdict: null, threads: [], rounds: [] };
}

/**
 * Треды файлом. Запись атомарна — временный файл рядом и `rename`: половина JSON на диске
 * стоила бы ревьюеру всех комментариев. Файл не прошёл схему — ошибка с путём, а не чистый лист:
 * молча затирать чужой текст хуже, чем отказать.
 */
export function fileThreadsStore(filePath: string): LocalThreadsStore {
    return {
        read: async () => {
            let raw: string;
            try {
                raw = await fs.readFile(filePath, 'utf8');
            } catch {
                return emptyReviewData();
            }

            let parsed: unknown;
            try {
                parsed = JSON.parse(raw);
            } catch {
                throw new Error(`${filePath} is not valid JSON — move it aside to start the review over`);
            }
            const data = reviewDataSchema.safeParse(parsed);
            if (!data.success) {
                throw new Error(`${filePath} does not match the local review format`);
            }
            return data.data;
        },
        write: async (data) => {
            await fs.mkdir(path.dirname(filePath), { recursive: true, mode: DIR_MODE });
            // Имя временного файла уникально на каждую запись: общее имя две параллельные записи
            // отобрали бы друг у друга, и вторая упала бы на `rename` уже унесённого файла.
            writeSequence += 1;
            const temporary = `${filePath}.${String(process.pid)}.${String(writeSequence)}.tmp`;
            try {
                await fs.writeFile(temporary, `${JSON.stringify(data, null, 2)}\n`, { mode: FILE_MODE });
                // writeFile применяет mode с оглядкой на umask — досоздаём права явно.
                await fs.chmod(temporary, FILE_MODE);
                await fs.rename(temporary, filePath);
            } catch (error) {
                await fs.rm(temporary, { force: true });
                throw error;
            }
        },
    };
}

/** Хранилище в памяти: тесты переживают пересоздание хоста на том же состоянии. */
export function memoryThreadsStore(initial: LocalReviewData = emptyReviewData()): LocalThreadsStore {
    let data = initial;
    return {
        read: () => Promise.resolve(structuredClone(data)),
        write: (next) => {
            data = structuredClone(next);
            return Promise.resolve();
        },
    };
}

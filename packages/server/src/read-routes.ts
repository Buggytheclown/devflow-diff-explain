import { createHash } from 'node:crypto';
import type { ServerResponse } from 'node:http';
import type { PrDiff, CodeReader, FileContent } from '@sherpa/protocol';
import { UI_ENDPOINTS, uiReviewBlobRequestSchema, uiReviewDiffRequestSchema, uiReviewDiffResponseSchema, uiReviewFileContentRequestSchema, uiReviewFileContentResponseSchema } from '@sherpa/protocol';
import type { BlobCache } from './blob-cache.js';
import { RpcFailure } from './errors.js';
import type { Route, StreamContext } from './http.js';
import { handlingRpcFailures, rpcFailureResponse, sendJson } from './http.js';
import type { IterationFeed } from './iteration-feed.js';
import type { IterationStore } from './iteration-store.js';
import type { PrMetaCache } from './pr-meta.js';
import { SnapshotReader } from './snapshot-reader.js';
import { call, hostOf, messageOf, optionalParam, parseQuery, respond } from './host-http.js';

export interface ReadRoutesOptions {
    host: CodeReader | null;
    /** Прямая адресация импортированного кода работает до первого пояснения. */
    codeSnapshot?: (id: string) => PrDiff | null;
    pinnedContent?: (diff: PrDiff, file: PrDiff['files'][number]) => Promise<FileContent | null>;
    iterations?: IterationStore | null;
    iterationFeed?: Pick<IterationFeed, 'active'> | null;
    prMeta: Pick<PrMetaCache, 'get'>;
    blobs?: BlobCache | null;
}

/** Читалка не регистрирует публикацию, комментарии и отметки ревью. */
export function createReadRoutes(options: ReadRoutesOptions): Route[] {
    return [
        {
            method: 'GET',
            path: UI_ENDPOINTS.reviewDiff,
            handle: handlingRpcFailures(async (ctx) => {
                const request = parseQuery(
                    uiReviewDiffRequestSchema,
                    {
                        ...optionalParam(ctx, 'diffId'),
                        ...optionalParam(ctx, 'codeSnapshotId'),
                    },
                    'диффа',
                );
                const diff = request.codeSnapshotId === undefined
                    ? await diffOfIteration(options, request.diffId)
                    : options.codeSnapshot?.(request.codeSnapshotId) ?? null;
                if (diff === null) throw new RpcFailure('not_found', 'Эта версия кода не импортирована.');
                if (request.diffId !== undefined && diff.diffId !== request.diffId) {
                    throw new RpcFailure('bad_request', 'Версия кода и дифф относятся к разным снимкам.');
                }
                return respond(uiReviewDiffResponseSchema, { diff });
            }),
        },
        {
            method: 'GET',
            path: UI_ENDPOINTS.reviewFileContent,
            handle: handlingRpcFailures(async (ctx) => {
                const request = uiReviewFileContentRequestSchema.safeParse({
                    fileId: ctx.url.searchParams.get('fileId') ?? '',
                    ...(ctx.url.searchParams.has('diffId') ? { diffId: ctx.url.searchParams.get('diffId') } : {}),
                });
                if (!request.success) {
                    throw new RpcFailure('bad_request', 'В запросе содержимого файла нет параметра fileId.');
                }

                const diff = await diffOfIteration(options, request.data.diffId);
                const file = diff.files.find((entry) => entry.fileId === request.data.fileId);
                if (file === undefined) throw new RpcFailure('not_found', 'Файл отсутствует в этом снимке.');
                const pinnedContent = options.pinnedContent;
                const content = pinnedContent === undefined
                    ? await options.host?.getFileContent?.(file.fileId) ?? null
                    : await call(() => pinnedContent(diff, file));
                return respond(uiReviewFileContentResponseSchema, { content });
            }),
        },
        {
            // Байты картинки — не JSON: ручка пишет в ответ сама (тип по магическим байтам,
            // вечный immutable-кэш, 304 по `If-None-Match`).
            method: 'GET',
            path: UI_ENDPOINTS.reviewBlob,
            stream: (ctx) => serveBlob(options, ctx),
        },
    ];
}

async function serveBlob(options: ReadRoutesOptions, ctx: StreamContext): Promise<void> {
    try {
        await writeBlob(options, ctx);
    } catch (error) {
        const failure =
            error instanceof RpcFailure
                ? error
                : new RpcFailure('internal', `Байты картинки не отдались: ${messageOf(error)}`);
        sendJson(ctx.res, rpcFailureResponse(failure));
    }
}

async function writeBlob(options: ReadRoutesOptions, ctx: StreamContext): Promise<void> {
    const request = uiReviewBlobRequestSchema.safeParse({
        blobId: ctx.url.searchParams.get('blobId') ?? '',
    });
    if (!request.success) {
        throw new RpcFailure('bad_request', 'В запросе байтов картинки нет параметра blobId.');
    }
    const blobId = request.data.blobId;
    const etag = etagOf(blobId);

    if (ctx.req.headers['if-none-match'] === etag) {
        // Содержимое по этому id измениться не может — тела не нужно.
        ctx.res.writeHead(304, cacheHeaders(etag));
        ctx.res.end();
        return;
    }

    // Зарегистрированный локальный адрес всегда идёт через проверенный SHA-256 в БД.
    // До импорта старый opaque blobId может жить только в сохранённом BlobCache.
    if (options.host instanceof SnapshotReader) {
        if (options.host.hasRegisteredBlob(blobId)) {
            const bytes = await options.host.getBlob(blobId);
            if (bytes === null) throw new RpcFailure('not_found', 'Сохранённые байты картинки недоступны.');
            sendBytes(ctx.res, bytes, etag);
            return;
        }
        const legacy = (await options.blobs?.read(blobId)) ?? null;
        if (legacy === null || (/^[a-fA-F0-9]{64}$/.test(blobId) &&
            createHash('sha256').update(legacy).digest('hex') !== blobId.toLowerCase())) {
            throw new RpcFailure('not_found', 'Сохранённые байты картинки недоступны.');
        }
        sendBytes(ctx.res, legacy, etag);
        return;
    }

    const cached = (await options.blobs?.read(blobId)) ?? null;
    if (cached !== null) {
        sendBytes(ctx.res, cached, etag);
        return;
    }

    const host = hostOf(options);
    const getBlob = host.getBlob?.bind(host);
    if (getBlob === undefined) {
        // Байты недоступны в локальном хранилище.
        throw new RpcFailure(
            'bad_request',
            'Этот хост не умеет отдавать байты файлов — картинки в диффе для него недоступны.',
        );
    }

    const bytes = await call(() => getBlob(blobId));
    if (bytes === null) {
        throw new RpcFailure('not_found', 'Хост не знает такого блоба или сторона слишком велика.');
    }
    await options.blobs?.write(blobId, bytes);
    sendBytes(ctx.res, bytes, etag);
}

function sendBytes(res: ServerResponse, bytes: Uint8Array, etag: string): void {
    res.writeHead(200, {
        'content-type': sniffImageMime(bytes),
        'content-length': String(bytes.byteLength),
        ...cacheHeaders(etag),
    });
    res.end(bytes);
}

function cacheHeaders(etag: string): Record<string, string> {
    return {
        // Блоб адресован содержимым: перепроверять его нечем и незачем.
        'cache-control': 'private, max-age=31536000, immutable',
        etag,
        'x-content-type-options': 'nosniff',
    };
}

/** ETag из непрозрачного id: кавычки и обратные слэши внутри значения экранируются. */
function etagOf(blobId: string): string {
    return `"${blobId.replace(/["\\]/g, '\\$&')}"`;
}

/**
 * Тип картинки по магическим байтам. Расширению пути здесь не верим: тип уезжает в браузер, и
 * содержимое обязано отвечать за себя само. Не опознанное — `application/octet-stream`.
 */
export function sniffImageMime(bytes: Uint8Array): string {
    if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47])) {
        return 'image/png';
    }
    if (startsWith(bytes, [0xff, 0xd8, 0xff])) {
        return 'image/jpeg';
    }
    if (startsWith(bytes, [0x47, 0x49, 0x46, 0x38])) {
        return 'image/gif';
    }
    if (startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes.subarray(8), [0x57, 0x45, 0x42, 0x50])) {
        return 'image/webp';
    }
    if (startsWith(bytes, [0x42, 0x4d])) {
        return 'image/bmp';
    }
    if (startsWith(bytes, [0x00, 0x00, 0x01, 0x00])) {
        return 'image/x-icon';
    }
    return looksLikeSvg(bytes) ? 'image/svg+xml' : 'application/octet-stream';
}

function startsWith(bytes: Uint8Array, prefix: readonly number[]): boolean {
    return prefix.every((byte, index) => bytes[index] === byte);
}

/** Пролог XML и комментарии перед корневым тегом: столько текста хватает, чтобы найти `<svg`. */
const SVG_PROLOG_MAX_CHARS = 4096;

/** Текст, у которого первый тег — `<svg`: пролог, комментарии и BOM до него пропускаются. */
function looksLikeSvg(bytes: Uint8Array): boolean {
    let text: string;
    try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, SVG_PROLOG_MAX_CHARS));
    } catch {
        return false;
    }

    let rest = text.replace(/^\ufeff/, '').trimStart();
    while (rest.startsWith('<?') || rest.startsWith('<!')) {
        const end = rest.startsWith('<!--') ? rest.indexOf('-->') + 3 : rest.indexOf('>') + 1;
        if (end <= 0) {
            return false;
        }
        rest = rest.slice(end).trimStart();
    }
    return /^<svg[\s>/]/i.test(rest);
}

/** Зафиксированная версия читается локально, без обращения к текущему состоянию PR. */
async function diffOfIteration(options: ReadRoutesOptions, diffId: string | undefined): Promise<PrDiff> {
    if (diffId !== undefined) {
        const stored = options.iterations?.get(diffId);
        if (stored != null) return stored.diff;
        throw new RpcFailure('not_found', `Дифф версии ${diffId} не импортирован.`);
    }
    return call(() => hostOf(options).getDiff());
}

import type { ServerResponse } from 'node:http';
import type { PrDiff, ReviewSource } from '@sherpa/protocol';
import { UI_ENDPOINTS, uiReviewBlobRequestSchema, uiReviewDiffRequestSchema, uiReviewDiffResponseSchema, uiReviewFileContentRequestSchema, uiReviewFileContentResponseSchema } from '@sherpa/protocol';
import type { BlobCache } from './blob-cache.js';
import { RpcFailure } from './errors.js';
import type { Route, StreamContext } from './http.js';
import { handlingRpcFailures, rpcFailureResponse, sendJson } from './http.js';
import type { IterationFeed } from './iteration-feed.js';
import type { IterationStore } from './iteration-store.js';
import { rememberIterationDiff } from './iteration-store.js';
import type { PrMetaCache } from './pr-meta.js';
import { call, hostOf, messageOf, optionalParam, parseQuery, respond } from './host-http.js';

export interface ReadRoutesOptions {
    host: ReviewSource | null;
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
                const host = hostOf(options);
                const request = parseQuery(
                    uiReviewDiffRequestSchema,
                    {
                        ...optionalParam(ctx, 'diffId'),
                        ...optionalParam(ctx, 'base'),
                        ...optionalParam(ctx, 'head'),
                    },
                    'диффа',
                );
                const diff =
                    request.base !== undefined && request.head !== undefined
                        ? await interdiffOf(options, host, request.base, request.head)
                        : await diffOfIteration(options, host, request.diffId);
                return respond(uiReviewDiffResponseSchema, { diff });
            }),
        },
        {
            method: 'GET',
            path: UI_ENDPOINTS.reviewFileContent,
            handle: handlingRpcFailures(async (ctx) => {
                const host = hostOf(options);
                const request = uiReviewFileContentRequestSchema.safeParse({
                    fileId: ctx.url.searchParams.get('fileId') ?? '',
                    ...(ctx.url.searchParams.has('diffId') ? { diffId: ctx.url.searchParams.get('diffId') } : {}),
                });
                if (!request.success) {
                    throw new RpcFailure('bad_request', 'В запросе содержимого файла нет параметра fileId.');
                }

                const getContent = host.getFileContent?.bind(host);
                if (getContent === undefined) {
                    // UI при `capabilities.fileContent: false` сюда не ходит; если пришёл — это
                    // рассинхрон версий, и сказать об этом надо человеческим текстом.
                    throw new RpcFailure(
                        'bad_request',
                        'Этот хост не умеет отдавать содержимое файлов — «Expand context» для него недоступен.',
                    );
                }

                const pinned = request.data.diffId;
                const ensureVersion = async (): Promise<void> => {
                    if (pinned !== undefined && (await call(() => host.getDiff())).diffId !== pinned) {
                        throw new RpcFailure('bad_request', 'ПР обновился. Контекст этой версии недоступен; откройте актуальный дифф.');
                    }
                };
                await ensureVersion();
                const content = await call(() => getContent(request.data.fileId));
                await ensureVersion();
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

    const cached = (await options.blobs?.read(blobId)) ?? null;
    if (cached !== null) {
        sendBytes(ctx.res, cached, etag);
        return;
    }

    const host = hostOf(options);
    const getBlob = host.getBlob?.bind(host);
    if (getBlob === undefined) {
        // UI при `capabilities.blobs: false` сюда не ходит; пришёл — это рассинхрон версий.
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

/**
 * Дифф одной итерации. Активная (или та, про которую фид ещё ничего не знает) берётся у хоста —
 * только он знает свежие отметки `viewed`; прошлая — из локального хранилища патчей, потому что
 * `getDiff` принимает лишь срез, а не «дифф итерации N».
 */
async function diffOfIteration(
    options: ReadRoutesOptions,
    host: ReviewSource,
    diffId: string | undefined,
): Promise<PrDiff> {
    const active = options.iterationFeed?.active() ?? null;
    if (diffId === undefined || active === null || active.diffId === diffId) {
        const diff = await call(() => host.getDiff());
        // Патч активной итерации оседает в хранилище (docs/spec.md); ответ ручки этого не ждёт.
        const iterations = options.iterations;
        if (iterations != null) {
            void rememberIterationDiff(iterations, host, diff);
        }
        if (diffId === undefined || diff.diffId === diffId) {
            return diff;
        }
    }

    const stored = options.iterations?.get(diffId) ?? null;
    if (stored === null) {
        throw new RpcFailure('bad_request', `Дифф итерации ${diffId} не сохранён — показать его нечем.`);
    }
    return stored.diff;
}

/** Срез между итерациями: считает его хост, помнит — локальный кэш (у Арканума это 2.8–3.7 с). */
async function interdiffOf(
    options: ReadRoutesOptions,
    host: ReviewSource,
    base: string,
    head: string,
): Promise<PrDiff> {
    if (options.prMeta.get()?.capabilities.iterations === false) {
        throw new RpcFailure(
            'bad_request',
            'Этот хост не умеет срезы между итерациями — «что нового» для него недоступно.',
        );
    }
    const iterations = options.iterations;
    if (iterations == null) {
        return call(() => host.getDiff({ base, head }));
    }
    return call(() => iterations.getInterdiff(base, head, () => host.getDiff({ base, head })));
}

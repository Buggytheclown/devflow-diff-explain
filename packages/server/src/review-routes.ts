import type { z } from 'zod';
import { call, hostOf, messageOf, optionalParam, parseQuery, readRequest, respond } from './host-http.js';
import { createReadRoutes } from './read-routes.js';
export { optionalParam, parseQuery, readRequest, respond } from './host-http.js';
export { sniffImageMime } from './read-routes.js';

import type { ReviewHost, UiStopSeenRange } from '@sherpa/protocol';
import {
    UI_ENDPOINTS,
    uiDeleteDraftRequestSchema,
    uiDraftBufferEntryRequestSchema,
    uiDraftBufferResponseSchema,
    uiReviewProgressRequestSchema,
    uiReviewLensesResponseSchema,
    uiReviewProgressResponseSchema,
    uiReviewThreadsResponseSchema,
    uiReviewWriteAckSchema,
    uiPublishRequestSchema,
    uiPublishResponseSchema,
    uiSaveDraftRequestSchema,
    uiSaveDraftResponseSchema,
    uiSetFileViewedRequestSchema,
    uiSetFileViewedResponseSchema,
    uiSetStopFileViewedRequestSchema,
    uiSetStopFileViewedResponseSchema,
    uiSetStopViewedRequestSchema,
    uiSetStopViewedResponseSchema,
    uiSetThreadResolvedRequestSchema,
    uiSetCommentResolvedRequestSchema,
    uiUpdateCommentRequestSchema,
    uiDeleteCommentRequestSchema,
    uiViewedMirrorRequestSchema,
    uiUpdateDraftRequestSchema,
    uiUpdateDraftResponseSchema,
} from '@sherpa/protocol';

import type { BlobCache } from './blob-cache.js';
import type { DraftBufferWriter } from './draft-buffer.js';
import { RpcFailure } from './errors.js';
import type { Route } from './http.js';
import { handlingRpcFailures } from './http.js';
import type { IterationFeed } from './iteration-feed.js';
import type { IterationStore } from './iteration-store.js';
import { LEGACY_DIFF_ID } from './iterations/index.js';
import type { PrMetaCache } from './pr-meta.js';
import type { ProgressStore } from './progress-store.js';
import type { ReviewFeed } from './review-feed.js';
import type { RouteStore } from './route-store.js';

/**
 * Ревью-ручки UI: дифф активной итерации, треды, линзы, содержимое файла.
 * Мета PR своей ручки не имеет — она едет в снапшоте `uiState`.
 *
 * Граница fail-closed в обе стороны: адаптер валидирует ответы хоста своими схемами, а сервер —
 * то, что отдаёт UI, схемами контракта. Хоста нет (prKey ни на что не отобразился) — `no_review_host`;
 * хост не смог (сеть, токен, ответ не сошёлся) — `host_unavailable` с человеческой причиной.
 *
 * Исключение — прогресс чтения: он локальный, живёт в SQLite этого PR и работает без хоста;
 * `no_review_host` его ручки не отдают никогда.
 */

export interface ReviewRoutesOptions {
    readonly host: ReviewHost | null;
    /** Ревизия тредов: успешная локальная запись будит SSE-клиентов сразу. */
    readonly reviewFeed: ReviewFeed | null;
    /** Прогресс чтения этого PR: локальная истина отметок «просмотрено». */
    readonly progress: ProgressStore;
    /** Снапшоты маршрута: опоздавшие отметки отбрасываются, прогресс итерации ищет свой снапшот. */
    readonly route: Pick<RouteStore, 'read' | 'listSnapshots'>;
    /** Кеш меты PR: публикация вердикта меняет статус, а капабилити решают, бывает ли срез. */
    readonly prMeta: Pick<PrMetaCache, 'refresh' | 'get'>;
    /** Буфер черновиков: через него идут все записи черновиков — и создание, и правка. */
    readonly draftBuffer: DraftBufferWriter;
    /** Локальное хранилище патчей итераций; отсутствует — сохранять дифф некуда (тесты без БД). */
    readonly iterations?: IterationStore | null;
    /** Итерации PR: по ним ручки понимают, активную итерацию у них спрашивают или прошлую. */
    readonly iterationFeed?: IterationFeed | null;
    /** Кэш байтов картинок на диске; отсутствует — каждый запрос идёт в хост (тесты без стейта). */
    readonly blobs?: BlobCache | null;
    /**
     * Публикация состоялась. Регистрируется только там, где публикация чем-то оборачивается:
     * у локального хоста по ней ставится задача агенту.
     */
    readonly onPublished?: () => void;
}

export function createReviewRoutes(options: ReviewRoutesOptions): Route[] {
    const mirrorFileViewed = createViewedMirror(options.host);
    // Одна очередь на id: resolve треда, resolve комментария и правка опубликованного метят в один
    // и тот же объект хоста (у Арканума тред и есть его корень) и обязаны лечь в порядке приёма.
    const queueWrite = createKeyedWriteQueue((_id: string, write: (host: ReviewHost) => Promise<void>) =>
        call(() => write(hostOf(options))),
    );
    return [
        ...createReadRoutes(options),
        {
            method: 'GET',
            path: UI_ENDPOINTS.reviewThreads,
            handle: handlingRpcFailures(async () => {
                const host = hostOf(options);
                return respond(uiReviewThreadsResponseSchema, { threads: await call(() => host.getThreads()) });
            }),
        },
        {
            method: 'POST',
            path: UI_ENDPOINTS.reviewSaveDraft,
            handle: handlingRpcFailures(async (ctx) => {
                hostOf(options);
                const request = await readRequest(ctx, uiSaveDraftRequestSchema, 'сохранения черновика');
                const result = await options.draftBuffer.write({
                    id: request.clientKey,
                    draft: request.draft,
                    commentId: null,
                });
                if (result.outcome === 'buffered') {
                    return respond(uiSaveDraftResponseSchema, result, 'local');
                }
                if (result.comment === null) {
                    // Записи не стало между апсёртом и попыткой (сброс буфера параллельным запросом).
                    throw new RpcFailure('internal', 'Черновик исчез из буфера до записи в хост.');
                }
                return respond(uiSaveDraftResponseSchema, { outcome: 'saved', comment: result.comment });
            }),
        },
        {
            method: 'POST',
            path: UI_ENDPOINTS.reviewUpdateDraft,
            handle: handlingRpcFailures(async (ctx) => {
                hostOf(options);
                const request = await readRequest(ctx, uiUpdateDraftRequestSchema, 'изменения черновика');
                const result = await options.draftBuffer.write({
                    id: request.clientKey,
                    // Правка знает только текст и issue: место композера после перезагрузки
                    // задаёт сам комментарий, который правится (композер правки якоря не носит).
                    draft: {
                        body: request.body,
                        parentId: null,
                        anchor: null,
                        ...(request.issue === undefined ? {} : { issue: request.issue }),
                    },
                    commentId: request.commentId,
                });
                return respond(
                    uiUpdateDraftResponseSchema,
                    result.outcome === 'buffered' ? result : { outcome: 'saved' },
                    'local',
                );
            }),
        },
        {
            method: 'GET',
            path: UI_ENDPOINTS.reviewDraftBuffer,
            handle: handlingRpcFailures(() =>
                respond(uiDraftBufferResponseSchema, { entries: options.draftBuffer.list() }, 'local'),
            ),
        },
        {
            method: 'POST',
            path: UI_ENDPOINTS.reviewDraftBufferRetry,
            handle: handlingRpcFailures(async (ctx) => {
                hostOf(options);
                const request = await readRequest(ctx, uiDraftBufferEntryRequestSchema, 'повтора черновика');
                await options.draftBuffer.retry(request.id);
                return respond(uiDraftBufferResponseSchema, { entries: options.draftBuffer.list() }, 'local');
            }),
        },
        {
            method: 'POST',
            path: UI_ENDPOINTS.reviewDraftBufferDiscard,
            handle: handlingRpcFailures(async (ctx) => {
                const request = await readRequest(ctx, uiDraftBufferEntryRequestSchema, 'сброса черновика');
                await options.draftBuffer.discard(request.id);
                return respond(uiDraftBufferResponseSchema, { entries: options.draftBuffer.list() }, 'local');
            }),
        },
        {
            method: 'POST',
            path: UI_ENDPOINTS.reviewDeleteDraft,
            handle: handlingRpcFailures(async (ctx) => {
                const host = hostOf(options);
                const request = await readRequest(ctx, uiDeleteDraftRequestSchema, 'удаления черновика');
                await deleteDraftConvergently(host, request.commentId);
                // Черновика больше нет: недовезённую правку довозить некуда, и держать ею ship
                // было бы навсегда — записи этого комментария снимаются вместе с ним.
                options.draftBuffer.forgetComment(request.commentId);
                options.reviewFeed?.bumpLocalWrite();
                return respond(uiReviewWriteAckSchema, { acknowledged: true }, 'local');
            }),
        },
        {
            method: 'POST',
            path: UI_ENDPOINTS.reviewThreadResolved,
            handle: handlingRpcFailures(async (ctx) => {
                const request = await readRequest(ctx, uiSetThreadResolvedRequestSchema, 'изменения статуса треда');
                await queueWrite(request.threadId, (host) =>
                    host.setThreadResolved(request.threadId, request.resolved),
                );
                options.reviewFeed?.bumpLocalWrite();
                return respond(uiReviewWriteAckSchema, { acknowledged: true }, 'local');
            }),
        },
        {
            method: 'POST',
            path: UI_ENDPOINTS.reviewCommentResolved,
            handle: handlingRpcFailures(async (ctx) => {
                const request = await readRequest(
                    ctx,
                    uiSetCommentResolvedRequestSchema,
                    'изменения статуса комментария',
                );
                await queueWrite(request.commentId, (host) =>
                    hostMethod(
                        host.setCommentResolved?.bind(host),
                        'Этот хост не ведёт resolved на комментариях — статус ставится на треде целиком.',
                    )(request.commentId, request.resolved),
                );
                options.reviewFeed?.bumpLocalWrite();
                return respond(uiReviewWriteAckSchema, { acknowledged: true }, 'local');
            }),
        },
        {
            method: 'POST',
            path: UI_ENDPOINTS.reviewUpdateComment,
            handle: handlingRpcFailures(async (ctx) => {
                const request = await readRequest(ctx, uiUpdateCommentRequestSchema, 'правки комментария');
                await queueWrite(request.commentId, (host) =>
                    hostMethod(
                        host.updateComment?.bind(host),
                        'Этот хост не умеет править опубликованные комментарии.',
                    )(request.commentId, request.body, request.issue),
                );
                options.reviewFeed?.bumpLocalWrite();
                return respond(uiReviewWriteAckSchema, { acknowledged: true }, 'local');
            }),
        },
        {
            method: 'POST',
            path: UI_ENDPOINTS.reviewDeleteComment,
            handle: handlingRpcFailures(async (ctx) => {
                const request = await readRequest(ctx, uiDeleteCommentRequestSchema, 'удаления комментария');
                await queueWrite(request.commentId, (host) =>
                    hostMethod(
                        host.deleteComment?.bind(host),
                        'Этот хост не умеет удалять опубликованные комментарии.',
                    )(request.commentId),
                );
                options.reviewFeed?.bumpLocalWrite();
                return respond(uiReviewWriteAckSchema, { acknowledged: true }, 'local');
            }),
        },
        {
            method: 'POST',
            path: UI_ENDPOINTS.reviewPublish,
            handle: handlingRpcFailures(async (ctx) => {
                const host = hostOf(options);
                const request = await readRequest(ctx, uiPublishRequestSchema, 'публикации ревью');
                const result = await call(() => host.publishBatch(request.verdict));
                // Даже частичный провал меняет треды: опубликованная часть уже перестала быть черновиками.
                options.reviewFeed?.bumpLocalWrite();
                // Вердикт меняет статус PR: перечитываем мету, обновлённый снапшот уедет по SSE.
                // Ответ ручки этого не ждёт: публикация уже состоялась, а `getPr()` у хоста может
                // висеть на ретраях с таймаутами десятки секунд. Ошибки `refresh` глотает сам.
                void options.prMeta.refresh();
                // Постановка задачи по раунду тоже не держит ответ: ревьюер уже опубликовал.
                options.onPublished?.();
                return respond(uiPublishResponseSchema, { result });
            }),
        },
        {
            // Прогресс измерен итерацией: активная (без параметра или названная явно) отвечает
            // вместе с текущим снапшотом, прошлая — как есть (старый снапшот читается, не правится).
            method: 'GET',
            path: UI_ENDPOINTS.reviewProgress,
            handle: handlingRpcFailures(async (ctx) => {
                const request = parseQuery(
                    uiReviewProgressRequestSchema,
                    { ...optionalParam(ctx, 'diffId') },
                    'прогресса чтения',
                );
                const active = await activeDiffId(options);
                // Итераций у сервера нет вовсе: весь прогресс лежит под `LEGACY_DIFF_ID`, как бы
                // вкладка ни называла единственный дифф, и любой её `diffId` — про него.
                const single = withoutIterations(options, active);
                const asActive = single || request.diffId === undefined || request.diffId === active;
                const diffId = asActive ? active : (request.diffId ?? active);
                const snapshotId = asActive
                    ? (options.route.read().snapshot?.snapshotId ?? null)
                    : lastSnapshotOf(options, diffId);
                return respond(
                    uiReviewProgressResponseSchema,
                    {
                        // Итерация, из которой прочитан ответ: по ней вкладка и сверяет, её ли
                        // `fileId` получила. Единственную итерацию сервер зовёт своим внутренним
                        // именем, вкладка — тем, что пришло в диффе: отвечаем её именем.
                        diffId: single ? (request.diffId ?? diffId) : diffId,
                        files: options.progress.read(diffId),
                        stops: snapshotId === null ? [] : options.progress.readStops(snapshotId),
                        progressRevision: options.progress.revision,
                    },
                    'local',
                );
            }),
        },
        {
            method: 'POST',
            path: UI_ENDPOINTS.reviewFileViewed,
            handle: handlingRpcFailures(async (ctx) => {
                const request = await readRequest(ctx, uiSetFileViewedRequestSchema, 'отметки «просмотрено»');
                // Истина — локальная запись; хост о ней узнаёт следом и только если умеет.
                const active = await activeDiffId(options);
                const diffId = writtenIteration(options, active, [request.fileId]);
                let progressRevision = options.progress.setFileViewed(
                    diffId,
                    request.fileId,
                    request.viewed,
                    options.route.read().snapshot?.snapshotId ?? null,
                );
                if (diffId !== active) {
                    progressRevision = carryFileViewed(
                        options,
                        diffId,
                        active,
                        request.fileId,
                        request.viewed,
                        progressRevision,
                    );
                }
                mirrorFileViewed(request.fileId, request.viewed);
                return respond(uiSetFileViewedResponseSchema, { progressRevision }, 'local');
            }),
        },
        {
            method: 'POST',
            path: UI_ENDPOINTS.reviewStopViewed,
            handle: handlingRpcFailures(async (ctx) => {
                const request = await readRequest(
                    ctx,
                    uiSetStopViewedRequestSchema,
                    'отметки «просмотрено» на остановке',
                );
                // Сама отметка стопа остаётся локальной. Переходы файлов в read от её диапазонов
                // UI сообщает отдельно через reviewViewedMirror, когда пересчитает покрытие диффа.
                const activeSnapshotId = options.route.read().snapshot?.snapshotId ?? null;
                const stale = request.snapshotId !== undefined && request.snapshotId !== activeSnapshotId;
                // Отметки остановок ключуются снапшотом: без маршрута их некуда записать.
                if (stale || activeSnapshotId === null) {
                    return respond(
                        uiSetStopViewedResponseSchema,
                        { progressRevision: options.progress.revision },
                        'local',
                    );
                }
                const active = await activeDiffId(options);
                let progressRevision = options.progress.revision;
                for (const write of stopWrites(options, active, request)) {
                    progressRevision = options.progress.setStopViewed(
                        activeSnapshotId,
                        write.diffId,
                        request.stopId,
                        request.viewed,
                        write.ranges,
                    );
                }
                return respond(uiSetStopViewedResponseSchema, { progressRevision }, 'local');
            }),
        },
        {
            method: 'POST',
            path: UI_ENDPOINTS.reviewStopFileViewed,
            handle: handlingRpcFailures(async (ctx) => {
                const request = await readRequest(
                    ctx,
                    uiSetStopFileViewedRequestSchema,
                    'отметки «просмотрено» файла в остановке',
                );
                const activeSnapshotId = options.route.read().snapshot?.snapshotId ?? null;
                const stale = request.snapshotId !== undefined && request.snapshotId !== activeSnapshotId;
                if (stale || activeSnapshotId === null) {
                    return respond(
                        uiSetStopFileViewedResponseSchema,
                        { progressRevision: options.progress.revision },
                        'local',
                    );
                }
                const active = await activeDiffId(options);
                let progressRevision = options.progress.revision;
                for (const target of writeTargets(options, active, [request.fileId])) {
                    const fileId = target.fileIdOf(request.fileId);
                    if (fileId === undefined) {
                        continue;
                    }
                    progressRevision = options.progress.setStopFileViewed(
                        activeSnapshotId,
                        target.diffId,
                        request.stopId,
                        fileId,
                        request.viewed,
                        request.ranges,
                    );
                }
                return respond(uiSetStopFileViewedResponseSchema, { progressRevision }, 'local');
            }),
        },
        {
            method: 'POST',
            path: UI_ENDPOINTS.reviewViewedMirror,
            handle: handlingRpcFailures(async (ctx) => {
                const request = await readRequest(
                    ctx,
                    uiViewedMirrorRequestSchema,
                    'зеркалирования переходов файлов в «просмотрено»',
                );
                for (const entry of request.entries) {
                    mirrorFileViewed(entry.fileId, entry.viewed);
                }
                return respond(uiReviewWriteAckSchema, { acknowledged: true }, 'local');
            }),
        },
        {
            method: 'GET',
            path: UI_ENDPOINTS.reviewLenses,
            handle: handlingRpcFailures(async () => {
                const host = hostOf(options);
                const [ownership, extra] = await call(() =>
                    Promise.all([host.ownershipLens(), host.extraLenses()]),
                );
                return respond(uiReviewLensesResponseSchema, {
                    ownership,
                    extra,
                    ownershipSource: host.ownershipSource,
                });
            }),
        },
    ];
}

/**
 * Байты стороны картинки по `ImageSide.blobId`. Порядок — кэш, хост, запись в кэш: блоб адресует
 * содержимое, поэтому второй заход и срез в хост не ходят. Промах хоста (`null`) не кэшируется:
 * это ответ про сегодняшнее состояние хоста, а не свойство содержимого.
 */

/**
 * Итерация, в которую пишет прогресс. Фид мог ещё не стартовать (SSE не открыт) — тогда список
 * спрашивается по требованию; хоста нет — сервер живёт на одной «итерации» `LEGACY_DIFF_ID`.
 */
async function activeDiffId(options: ReviewRoutesOptions): Promise<string> {
    const active = (await options.iterationFeed?.resolveActive()) ?? null;
    return active?.diffId ?? LEGACY_DIFF_ID;
}

/** Последний снапшот итерации: его отметки остановок и показывает прогресс этой итерации. */
function lastSnapshotOf(options: ReviewRoutesOptions, diffId: string): string | null {
    const own = options.route.listSnapshots().filter((snapshot) => snapshot.diffId === diffId);
    return own.at(-1)?.snapshotId ?? null;
}

/**
 * Живёт ли сервер на единственной итерации: хоста нет либо хост итераций не знает. Тогда весь
 * прогресс лежит под `LEGACY_DIFF_ID` и любой `diffId` вкладки — про него.
 *
 * Хост с итерациями, чей список ещё не приехал (`listIterations` отказал), сюда не попадает:
 * назвать его прошлую итерацию активной значило бы отдать на неё чужой прогресс.
 */
function withoutIterations(options: ReviewRoutesOptions, active: string): boolean {
    return (
        active === LEGACY_DIFF_ID &&
        (options.iterationFeed == null || options.prMeta.get()?.capabilities.iterations === false)
    );
}

/**
 * Итерация текущего снапшота, когда она отличается от активной и её дифф сохранён: это окно
 * устаревания — пуш уже пришёл, а вкладка ещё рисует дифф снапшота. `null` — такого окна нет.
 */
function snapshotIteration(options: ReviewRoutesOptions, active: string): string | null {
    const snapshotDiffId = options.route.read().snapshot?.diffId ?? null;
    if (snapshotDiffId === null || snapshotDiffId === active || withoutIterations(options, active)) {
        return null;
    }
    return options.iterations?.get(snapshotDiffId) == null ? null : snapshotDiffId;
}

/**
 * Итерация, под которой записывается отметка: обычно активная, но в окне устаревания вкладка
 * ещё рисует дифф итерации снапшота, и отметка обязана лечь под ним — иначе она не вернётся
 * из перечитки прогресса того же диффа.
 *
 * Кандидата два: активная итерация и итерация текущего снапшота. Больше вкладка с включёнными
 * отметками показать не может — прошлый снапшот идёт в режиме чтения.
 */
function writtenIteration(options: ReviewRoutesOptions, active: string, fileIds: readonly string[]): string {
    const snapshotDiffId = snapshotIteration(options, active);
    if (snapshotDiffId === null || fileIds.length === 0) {
        return active;
    }
    const own = new Set((options.iterations?.get(snapshotDiffId)?.diff.files ?? []).map((file) => file.fileId));
    return fileIds.every((fileId) => own.has(fileId)) ? snapshotDiffId : active;
}

/** Куда ложатся диапазоны одной отметки остановки: итерация и её `fileId` в переводе. */
interface StopWrite {
    readonly diffId: string;
    readonly ranges: readonly UiStopSeenRange[];
}

/** Итерация, под которую ложится отметка, и перевод `fileId` в неё; `undefined` — файл не переводится. */
interface WriteTarget {
    readonly diffId: string;
    readonly fileIdOf: (fileId: string) => string | undefined;
}

/**
 * Итерации одной отметки с диапазонами. В обычном случае она одна — активная.
 * В окне устаревания их две: итерация, которую вкладка нарисовала, и активная —
 * перенос пары одноразовый и к этому моменту уже прошёл, а без второй записи диапазоны
 * исчезли бы с перестройкой маршрута. В активную переводятся только файлы, не тронутые срезом.
 */
function writeTargets(options: ReviewRoutesOptions, active: string, fileIds: readonly string[]): readonly WriteTarget[] {
    const drawn = writtenIteration(options, active, fileIds);
    if (drawn === active) {
        return [{ diffId: active, fileIdOf: sameFileId }];
    }
    const carried = carriedFileIds(options, drawn, active);
    return [
        { diffId: drawn, fileIdOf: sameFileId },
        { diffId: active, fileIdOf: (fileId) => carried?.get(fileId) },
    ];
}

function sameFileId(fileId: string): string {
    return fileId;
}

/**
 * Записи одной отметки остановки по `writeTargets`: стоп без переводимых файлов всё равно
 * пишется в активную — с пустым набором.
 *
 * Снятие диапазонов не присылает, и по ним не узнать, какую итерацию вкладка рисовала:
 * чистятся обе, что она могла показывать.
 */
function stopWrites(
    options: ReviewRoutesOptions,
    active: string,
    request: z.infer<typeof uiSetStopViewedRequestSchema>,
): readonly StopWrite[] {
    if (!request.viewed) {
        const drawn = snapshotIteration(options, active);
        const wiped = drawn === null ? [active] : [drawn, active];
        return wiped.map((diffId) => ({ diffId, ranges: [] }));
    }
    const targets = writeTargets(
        options,
        active,
        request.ranges.map((range) => range.fileId),
    );
    return targets.map((target) => ({
        diffId: target.diffId,
        ranges: request.ranges.flatMap((range) => {
            const fileId = target.fileIdOf(range.fileId);
            return fileId === undefined ? [] : [{ ...range, fileId }];
        }),
    }));
}

/**
 * Отметка, поставленная в окне устаревания, повторяется на активной итерации: перенос пары
 * одноразовый и к этому моменту уже прошёл, а без второй записи отметка исчезла бы с
 * перестройкой маршрута.
 */
function carryFileViewed(
    options: ReviewRoutesOptions,
    from: string,
    active: string,
    fileId: string,
    viewed: boolean,
    revision: number,
): number {
    const target = carriedFileIds(options, from, active)?.get(fileId) ?? null;
    return target === null ? revision : options.progress.setFileViewed(active, target, viewed, null);
}

/**
 * Перевод `fileId` из итерации `from` в активную по пути файла. Переводится только файл,
 * которого не коснулся срез: его содержимое в обеих итерациях одинаково, и отметка про него
 * честна. Среза под рукой нет (хост их не умеет или его ещё не посчитали) — перевода нет:
 * соврать про изменившийся файл хуже, чем потерять отметку.
 */
function carriedFileIds(
    options: ReviewRoutesOptions,
    from: string,
    active: string,
): ReadonlyMap<string, string> | null {
    const iterations = options.iterations;
    if (iterations == null) {
        return null;
    }
    const source = iterations.get(from)?.diff.files ?? null;
    const target = iterations.get(active)?.diff.files ?? null;
    const interdiff = iterations.peekInterdiff(from, active);
    if (source === null || target === null || interdiff === null) {
        return null;
    }
    const touched = new Set<string>();
    for (const file of interdiff.files) {
        touched.add(file.path);
        if (file.oldPath != null) {
            touched.add(file.oldPath);
        }
    }
    const idOfPath = new Map<string, string>();
    for (const file of target) {
        // Первый файл с таким путём выигрывает — как в `indexDiff`.
        if (!idOfPath.has(file.path)) {
            idOfPath.set(file.path, file.fileId);
        }
    }
    const carried = new Map<string, string>();
    for (const file of source) {
        const id = touched.has(file.path) ? undefined : idOfPath.get(file.path);
        if (id !== undefined) {
            carried.set(file.fileId, id);
        }
    }
    return carried;
}

/** Параметр query, если он есть: отсутствие ключа в объекте разбора значит «не задан». */


/** Разбор query по схеме контракта; `what` попадает в текст отказа как «запрос чего». */


/** Тело запроса под схемой контракта; `what` попадает в текст отказа как «запрос чего». */


/** Неопределённый ответ delete считается успехом, если свежий снапшот уже не содержит комментарий. */
async function deleteDraftConvergently(host: ReviewHost, commentId: string): Promise<void> {
    try {
        await call(() => host.deleteDraft(commentId));
    } catch (deleteError) {
        let threads: Awaited<ReturnType<ReviewHost['getThreads']>>;
        try {
            threads = await call(() => host.getThreads());
        } catch {
            throw deleteError;
        }
        const contains = threads.some((thread) => {
            const visit = (comment: typeof thread.root): boolean =>
                comment.id === commentId || comment.replies.some(visit);
            return visit(thread.root);
        });
        if (contains) {
            throw deleteError;
        }
    }
}

/** Записи одного ключа уходят в хост в порядке приёма сервером, даже если предыдущая сорвалась. */
function createKeyedWriteQueue<T>(write: (key: string, value: T) => Promise<void>): (key: string, value: T) => Promise<void> {
    const queues = new Map<string, Promise<void>>();

    return (key, value) => {
        const request = (queues.get(key) ?? Promise.resolve()).then(() => write(key, value));
        const tail = request.then(
            () => undefined,
            () => undefined,
        );
        queues.set(key, tail);
        void tail.then(() => {
            if (queues.get(key) === tail) {
                queues.delete(key);
            }
        });
        return request;
    };
}

/**
 * Зеркалирование отметки в хост (`capabilities.fileViewedSync`) — best-effort после локальной
 * записи: провал не откатывает её и не является ошибкой ручки. Наличие метода совпадает
 * с капабилити по контракту (это проверяет контрактный набор хостов), поэтому лишнего `getPr`
 * ради флага здесь нет.
 *
 * Очередь на файл: сетевые вызовы хоста (с ретраями внутри адаптера) могут завершиться в порядке,
 * обратном порядку отметок, и хост остался бы со значением, которое ревьюер уже отменил. Значение,
 * устаревшее к моменту своей очереди, не зеркалится вовсе — его перекрывает следующая запись.
 */
function createViewedMirror(host: ReviewHost | null): (fileId: string, viewed: boolean) => void {
    const setFileViewed = host?.setFileViewed?.bind(host);
    if (setFileViewed === undefined) {
        return () => undefined;
    }

    const queues = new Map<string, Promise<void>>();
    const latest = new Map<string, number>();
    let seq = 0;

    return (fileId, viewed) => {
        const mine = (seq += 1);
        latest.set(fileId, mine);
        const queued = (queues.get(fileId) ?? Promise.resolve())
            .then(async () => {
                if (latest.get(fileId) === mine) {
                    await setFileViewed(fileId, viewed);
                }
            })
            .catch((error: unknown) => {
                process.stderr.write(
                    `sherpa-server: хост не принял отметку «просмотрено» для ${fileId}: ${messageOf(error)}\n`,
                );
            });
        queues.set(fileId, queued);
        void queued.then(() => {
            // Очередь файла опустела — забываем её, иначе карта росла бы весь сеанс.
            if (queues.get(fileId) === queued) {
                queues.delete(fileId);
                latest.delete(fileId);
            }
        });
    };
}

/**
 * Необязательный метод хоста. UI при снятом флаге возможностей сюда не ходит; если пришёл —
 * это рассинхрон версий, и сказать об этом надо человеческим текстом, а не падением.
 */
function hostMethod<T extends (...args: never[]) => Promise<void>>(method: T | undefined, why: string): T {
    if (method === undefined) {
        throw new RpcFailure('bad_request', why);
    }
    return method;
}



/** Ошибка адаптера без кода контракта — это отказ хоста, а не наша внутренняя поломка. */


/**
 * Тело ответа проверяется схемой контракта: невалидное наружу не уходит (docs/testing.md).
 * `local` — ответ собран самим сервером (прогресс чтения), и виноват в расхождении он сам.
 */

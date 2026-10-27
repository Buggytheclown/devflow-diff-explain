import type {
    Iteration,
    RouteSnapshot,
    UiRouteFillStopResponse,
    UiRouteGenerateResponse,
    UiReviewRouteResponse,
    UiReviewSnapshotsResponse,
    UiSnapshotStatus,
} from '@sherpa/protocol';
import {
    UI_ENDPOINTS,
    uiReviewRouteRequestSchema,
    uiReviewRouteResponseSchema,
    uiReviewSnapshotsResponseSchema,
    uiRouteFillStopRequestSchema,
    uiRouteFillStopResponseSchema,
    uiRouteGenerateRequestSchema,
    uiRouteGenerateResponseSchema,
    uiRouteRetryDiagramRequestSchema,
    uiRouteCancelGenerationRequestSchema,
    uiReviewWriteAckSchema,
} from '@sherpa/protocol';
import type { z } from 'zod';

import { RpcFailure } from './errors.js';
import type { JsonResponse, RequestContext, Route } from './http.js';
import { handlingRpcFailures, readJsonBody, readOptionalJsonBody } from './http.js';
import type { IterationFeed } from './iteration-feed.js';
import { routeRevisionOf, withStale } from './iteration-feed.js';
import { optionalParam, parseQuery, respond } from './host-http.js';
import type { RouteOrchestrator } from './route-orchestrator.js';
import type { RouteStore } from './route-store.js';

/**
 * Ручки маршрута: чтение состояния и истории снапшотов, запуск генерации и дозаполнение
 * одного стопа.
 *
 * `GET reviewRoute` и `GET reviewSnapshots` читают SQLite и доступны без ревью-хоста (без него
 * маршрут просто не покидает фазу `none`). Обе POST-ручки перед мутацией загружают дифф: без
 * хоста отвечают `no_review_host`, при отказе хоста — `host_unavailable`.
 *
 * `stale` в хранилище не живёт: он считается здесь, на границе чтения, по списку итераций
 * (`withStale`), поэтому и ревизия маршрута для UI составная (`routeRevisionOf`).
 */

export interface RouteRoutesOptions {
    readonly store: RouteStore;
    readonly orchestrator: RouteOrchestrator;
    /** Итерации PR; null — хоста нет, снапшот устареть не может. */
    readonly iterationFeed: IterationFeed | null;
}

export function createRouteRoutes(options: RouteRoutesOptions): Route[] {
    return [
        {
            method: 'POST', path: UI_ENDPOINTS.reviewRouteRetryDiagram,
            handle: handlingRpcFailures(async (ctx) => {
                const request = await readRouteRequest(ctx, uiRouteRetryDiagramRequestSchema);
                options.orchestrator.retryDiagram(request.snapshotId);
                return respond(uiReviewWriteAckSchema, { acknowledged: true }, 'local');
            }),
        },
        {
            method: 'POST', path: UI_ENDPOINTS.reviewRouteCancelGeneration,
            handle: handlingRpcFailures(async (ctx) => {
                const request = await readRouteRequest(ctx, uiRouteCancelGenerationRequestSchema);
                options.orchestrator.cancelGeneration(request.generationId);
                return respond(uiReviewWriteAckSchema, { acknowledged: true }, 'local');
            }),
        },
        {
            method: 'GET',
            path: UI_ENDPOINTS.reviewRoute,
            handle: handlingRpcFailures(
                (ctx): JsonResponse => {
                    const request = parseQuery(
                        uiReviewRouteRequestSchema,
                        { ...optionalParam(ctx, 'snapshot') },
                        'маршрута',
                    );
                    const body: UiReviewRouteResponse = {
                        route:
                            request.snapshot === undefined
                                ? withStale(options.store.read(), options.iterationFeed)
                                : pastRouteState(options, request.snapshot),
                        routeRevision: routeRevisionOf(options.store, options.iterationFeed),
                    };
                    return respond(uiReviewRouteResponseSchema, body, 'local');
                },
            ),
        },
        {
            method: 'GET',
            path: UI_ENDPOINTS.reviewSnapshots,
            handle: handlingRpcFailures(
                (): JsonResponse => {
                    const body: UiReviewSnapshotsResponse = { snapshots: summarize(options) };
                    return respond(uiReviewSnapshotsResponseSchema, body, 'local');
                },
            ),
        },
        {
            method: 'POST',
            path: UI_ENDPOINTS.reviewRouteGenerate,
            handle: handlingRpcFailures(async (ctx) => {
                // Тело может отсутствовать вовсе: автозапуск и старый клиент языка не называют.
                const request = await readOptionalRouteRequest(ctx, uiRouteGenerateRequestSchema);
                const body: UiRouteGenerateResponse = {
                    outcome: await options.orchestrator.generate(request.locale),
                };
                return respond(uiRouteGenerateResponseSchema, body, 'local');
            }),
        },
        {
            method: 'POST',
            path: UI_ENDPOINTS.reviewRouteFillStop,
            handle: handlingRpcFailures(async (ctx) => {
                const request = await readRouteRequest(ctx, uiRouteFillStopRequestSchema);
                const body: UiRouteFillStopResponse = {
                    outcome: await options.orchestrator.fillStop(request.snapshotId, request.planIndex),
                };
                return respond(uiRouteFillStopResponseSchema, body, 'local');
            }),
        },
    ];
}

/**
 * Прошлый снапшот как состояние маршрута: он неизменяем, поэтому фаза у него всегда `ready`,
 * а провала и порога малого PR у него быть не может. `stale` считается от него же — старый
 * снапшот почти всегда устарел, и UI открывает его в режиме чтения.
 */
function pastRouteState(options: RouteRoutesOptions, snapshotId: string): UiReviewRouteResponse['route'] {
    const snapshot = options.store.getSnapshot(snapshotId);
    if (snapshot === null) {
        throw new RpcFailure('bad_request', `Снапшота маршрута ${snapshotId} у этого PR нет.`);
    }
    return withStale(
        { phase: 'ready', smallPr: false, snapshot, failure: null, stale: null },
        options.iterationFeed,
    );
}

function summarize(options: RouteRoutesOptions): UiReviewSnapshotsResponse['snapshots'] {
    const currentId = options.store.current()?.snapshotId ?? null;
    const iterations = options.iterationFeed?.iterations() ?? [];
    return options.store.listSnapshots().map((snapshot) => ({
        snapshotId: snapshot.snapshotId,
        diffId: snapshot.diffId,
        commit: snapshot.commit,
        baseCommit: snapshot.baseCommit,
        createdAt: snapshot.createdAt,
        provenance: snapshot.provenance,
        previousSnapshotId: snapshot.previousSnapshotId,
        status: statusOf(snapshot, currentId, iterations),
    }));
}

/**
 * Статус снапшота для пикера. Список итераций пуст, пока никто не подписан на фид: сказать
 * «коммита больше нет в PR» в этот момент нельзя — снапшот честнее показать просто устаревшим.
 */
function statusOf(
    snapshot: RouteSnapshot,
    currentId: string | null,
    iterations: readonly Iteration[],
): UiSnapshotStatus {
    if (snapshot.snapshotId === currentId) {
        return 'current';
    }
    if (iterations.length === 0) {
        return 'stale';
    }
    const iteration = iterations.find((candidate) => candidate.diffId === snapshot.diffId);
    return iteration === undefined || iteration.status === 'gone' ? 'gone' : 'stale';
}

/**
 * Тело запроса, которого может не быть: пустое тело — это пустой объект, а не ошибка
 * (POST `route/generate` без полей — законный вызов старого клиента).
 */
async function readOptionalRouteRequest<T>(ctx: RequestContext, schema: z.ZodType<T>): Promise<T> {
    const raw = await readOptionalJsonBody(ctx.req);
    const parsed = schema.safeParse(raw ?? {});
    if (!parsed.success) {
        throw new RpcFailure(
            'bad_request',
            'Запрос маршрута не прошёл валидацию контракта.',
            parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
        );
    }
    return parsed.data;
}

/** Тело запроса маршрута: невалидный ввод наружу не проходит. */
async function readRouteRequest<T>(ctx: RequestContext, schema: z.ZodType<T>): Promise<T> {
    const parsed = schema.safeParse(await readJsonBody(ctx.req));
    if (!parsed.success) {
        throw new RpcFailure(
            'bad_request',
            'Запрос маршрута не прошёл валидацию контракта.',
            parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
        );
    }
    return parsed.data;
}

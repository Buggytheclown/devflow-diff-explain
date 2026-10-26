import type { ServerResponse } from 'node:http';

import type {
    PrMeta,
    UiCancelResponse,
    UiChatEvent,
    UiFeedbackAvailability,
    UiEnqueueResponse,
    UiProgressEvent,
    UiReviewEvent,
    UiRouteEvent,
    UiState,
    UiTask,
    UiUpdate,
} from '@sherpa/protocol';
import {
    UI_CHAT_EVENT,
    UI_ENDPOINTS,
    UI_PROGRESS_EVENT,
    UI_REVIEW_EVENT,
    UI_ROUTE_EVENT,
    UI_STATE_EVENT,
    uiCancelRequestSchema,
    uiEnqueueRequestSchema,
    uiTaskSchema,
    uiUpdateCheckResponseSchema,
} from '@sherpa/protocol';
import type { z } from 'zod';

import type { ChatStore } from './chat-store.js';
import { RpcFailure } from './errors.js';
import type { RequestContext, Route, StreamContext } from './http.js';
import { abortOnDisconnect, handlingRpcFailures, readJsonBody } from './http.js';
import type { IterationFeed } from './iteration-feed.js';
import { routeRevisionOf } from './iteration-feed.js';
import type { ProgressStore } from './progress-store.js';
import type { TaskQueue, TaskRecord } from './queue.js';
import type { ReviewFeed } from './review-feed.js';
import type { RouteStore } from './route-store.js';
import type { UiPresence } from './ui-presence.js';
import type { UpdateForceResult } from './update-check.js';
import type { WorkerRegistry } from './worker-registry.js';

/**
 * Синхронный источник меты PR: снапшот собирается из таймера и микрозадачи, ждать там
 * сетевой `getPr()` нельзя. Реализация — `PrMetaCache`.
 */
export interface PrMetaSource {
    /** null — хоста нет или мета ещё не загрузилась. */
    get: () => PrMeta | null;
    subscribe: (listener: () => void) => () => void;
}

/**
 * Синхронный источник «доступна новая версия»: та же причина, что у меты PR — снапшот собирается
 * без сети. Реализация — `UpdateChecker`.
 */
export interface UpdateSource {
    /** null — проверки не было, она провалилась, версия свежая или отклонена. */
    get: () => UiUpdate | null;
    subscribe: (listener: () => void) => () => void;
    /** Перепроверка мимо TTL — команда палитры «Проверить обновления». */
    force: () => Promise<UpdateForceResult>;
}

export interface UiRoutesOptions {
    readonly prKey: string;
    readonly queue: TaskQueue;
    readonly registry: WorkerRegistry;
    /** Имя хост-адаптера этого PR; null — хоста нет, ревью-ручки закрыты. */
    readonly reviewHost: string | null;
    /** Мета PR для снапшота: её обновление тоже будит SSE-клиентов. */
    readonly prMeta: PrMetaSource;
    /** Новая версия в trunk: её появление тоже будит SSE-клиентов. */
    readonly update: UpdateSource;
    /** Доступность канала фидбека зависит только от OAuth-токена в окружении. */
    readonly feedback: UiFeedbackAvailability;
    /** Ревизия тредов для SSE; null — ревью-событий у этого сервера не бывает. */
    readonly reviewFeed: ReviewFeed | null;
    /** Итерации PR: их список едет в снапшоте, а смена активной делает маршрут устаревшим. */
    readonly iterationFeed: IterationFeed | null;
    /** Прогресс чтения: его ревизия едет в канал, чтобы вторая вкладка сошлась. */
    readonly progress: ProgressStore;
    /** Состояние маршрута: его ревизия едет в канал тем же способом, что и прогресс. */
    readonly route: RouteStore;
    /** История чата и заметки: событие несёт только ревизию, данные перечитываются отдельной ручкой. */
    readonly chat: ChatStore;
    /** Присутствие ревьюера считается только по живым SSE-соединениям этого канала. */
    readonly presence: UiPresence;
    /** Остановка сервера: закрывает висящие SSE-соединения, чтобы close() их не ждал. */
    readonly shutdownSignal: AbortSignal;
}

/**
 * Тик SSE-канала без изменений. Он же лениво протухает аренды через `listTasks`, когда на сервер
 * никто не ходит: иначе UI застрял бы на вечном `leased` после молча умершей сессии.
 */
const KEEPALIVE_INTERVAL_MS = 30_000;

/**
 * Ручки UI (docs/protocol.md §2): REST для действий, SSE для реактивности. Наружу выходит только
 * снапшот `UiState` — серверные внутренности (пути файлов, workerId аренды) в него не попадают.
 */
export function createUiRoutes(options: UiRoutesOptions): Route[] {
    return [
        {
            method: 'GET',
            path: UI_ENDPOINTS.state,
            handle: handlingRpcFailures(() => ({ status: 200, body: buildState(options) })),
        },
        {
            method: 'POST',
            path: UI_ENDPOINTS.enqueue,
            handle: handlingRpcFailures(async (ctx) => {
                const request = await readUiRequest(ctx, uiEnqueueRequestSchema);
                const record = options.queue.enqueue({
                    type: request.type,
                    priority: request.priority ?? 'interactive',
                    instructions: echoInstructions(request.text),
                    contextFiles: [],
                });
                const body: UiEnqueueResponse = { task: toUiTask(record) };
                return { status: 200, body };
            }),
        },
        {
            method: 'POST',
            path: UI_ENDPOINTS.cancel,
            handle: handlingRpcFailures(async (ctx) => {
                const request = await readUiRequest(ctx, uiCancelRequestSchema);
                const body: UiCancelResponse = { outcome: options.queue.cancel(request.taskId) };
                return { status: 200, body };
            }),
        },
        {
            method: 'POST',
            path: UI_ENDPOINTS.updateCheck,
            handle: handlingRpcFailures(async () => {
                const result = await options.update.force();
                // Провал проверки нельзя выдать за «обновлений нет»: палитра различает их
                // только по коду ответа, а `{update: null}` она читает как «версия свежая».
                if (result.failure !== null) {
                    throw new RpcFailure('host_unavailable', `Не удалось проверить обновления: ${result.failure}`);
                }
                return { status: 200, body: uiUpdateCheckResponseSchema.parse({ update: result.update }) };
            }),
        },
        {
            method: 'GET',
            path: UI_ENDPOINTS.events,
            // EventSource не умеет заголовки — токен приходит параметром `?token=`.
            auth: 'bearer-or-query',
            stream: (ctx) => {
                streamState(options, ctx);
            },
        },
    ];
}

/**
 * SSE-канал: снапшот сразу и дальше на каждое изменение очереди или статуса воркера.
 * Пачка синхронных изменений схлопывается в одно событие — цена снапшота выше цены задержки.
 */
function streamState(options: UiRoutesOptions, ctx: StreamContext): void {
    const { res } = ctx;
    res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store',
        connection: 'keep-alive',
    });

    const abort = abortOnDisconnect(ctx.req, options.shutdownSignal);
    const disconnectPresence = options.presence.connect();
    let scheduled = false;

    const push = (): void => {
        if (abort.signal.aborted || res.writableEnded || res.destroyed) {
            return;
        }

        let payload: string;
        try {
            payload = JSON.stringify(buildState(options));
        } catch (error) {
            // Снапшот не собрался — сработала fail-closed граница на повреждённых данных
            // (`uiTaskSchema`, разбор контекстных файлов). Из таймера и микрозадачи это исключение
            // некому поймать, поэтому канал закрываем: UI покажет «переподключаюсь».
            const message = error instanceof Error ? error.message : String(error);
            process.stderr.write(`sherpa-server: снапшот UI не собрался: ${message}\n`);
            stop();
            return;
        }
        sendEvent(res, UI_STATE_EVENT, payload);
    };

    const schedule = (): void => {
        if (scheduled) {
            return;
        }
        scheduled = true;
        queueMicrotask(() => {
            scheduled = false;
            push();
        });
    };

    const pushReview = (revision: number): void => {
        if (abort.signal.aborted || res.writableEnded || res.destroyed) {
            return;
        }
        const event: UiReviewEvent = { threadsRevision: revision };
        sendEvent(res, UI_REVIEW_EVENT, JSON.stringify(event));
    };

    const pushProgress = (revision: number): void => {
        if (abort.signal.aborted || res.writableEnded || res.destroyed) {
            return;
        }
        const event: UiProgressEvent = { progressRevision: revision };
        sendEvent(res, UI_PROGRESS_EVENT, JSON.stringify(event));
    };

    // Ревизия составная: `stale` живёт не в `RouteStore`, а считается по итерациям (`withStale`),
    // и без учёта фида пуш не заставил бы UI перечитать маршрут.
    const pushRoute = (): void => {
        if (abort.signal.aborted || res.writableEnded || res.destroyed) {
            return;
        }
        const event: UiRouteEvent = { routeRevision: routeRevisionOf(options.route, options.iterationFeed) };
        sendEvent(res, UI_ROUTE_EVENT, JSON.stringify(event));
    };

    const pushChat = (revision: number): void => {
        if (abort.signal.aborted || res.writableEnded || res.destroyed) {
            return;
        }
        const event: UiChatEvent = { chatRevision: revision };
        sendEvent(res, UI_CHAT_EVENT, JSON.stringify(event));
    };

    const keepalive = setInterval(push, KEEPALIVE_INTERVAL_MS);
    keepalive.unref();

    const unsubscribeQueue = options.queue.subscribeChanges(schedule);
    const unsubscribeWorker = options.registry.subscribe(schedule);
    const unsubscribePrMeta = options.prMeta.subscribe(schedule);
    const unsubscribeUpdate = options.update.subscribe(schedule);
    // Подписка на треды поднимается первым SSE-клиентом и гаснет с последним (см. ReviewFeed);
    // заводится после первого снапшота состояния, чтобы канал начинался с `state`.
    let unsubscribeReview: (() => void) | null = null;
    let unsubscribeIterations: (() => void) | null = null;
    let unsubscribeProgress: (() => void) | null = null;
    let unsubscribeRoute: (() => void) | null = null;
    let unsubscribeChat: (() => void) | null = null;

    const stop = (): void => {
        clearInterval(keepalive);
        unsubscribeQueue();
        unsubscribeWorker();
        unsubscribePrMeta();
        unsubscribeUpdate();
        unsubscribeReview?.();
        unsubscribeIterations?.();
        unsubscribeProgress?.();
        unsubscribeRoute?.();
        unsubscribeChat?.();
        disconnectPresence();
        abort.dispose();
        if (!res.writableEnded && !res.destroyed) {
            res.end();
        }
    };
    abort.signal.addEventListener('abort', stop);
    // Соединение могло оборваться (или сервер — начать остановку) ещё до подписки.
    if (abort.signal.aborted) {
        stop();
        return;
    }

    // Подписка на итерации поднимается до первого снапшота: их список — часть состояния, а
    // `stale` маршрута — часть его ревизии. Свои события она даёт только после начальных пушей,
    // иначе канал начинался бы с двух одинаковых `route`.
    let iterationsReady = false;
    if (options.iterationFeed !== null) {
        unsubscribeIterations = options.iterationFeed.subscribe(() => {
            if (!iterationsReady) {
                return;
            }
            schedule();
            pushRoute();
        });
    }

    push();
    // Текущая ревизия — сразу: клиент после реконнекта должен узнать, что треды успели уехать.
    // Канал мог закрыться прямо в `push` (снапшот не собрался) — тогда подписываться уже не на кого.
    if (options.reviewFeed !== null && !res.writableEnded && !res.destroyed) {
        pushReview(options.reviewFeed.revision);
        unsubscribeReview = options.reviewFeed.subscribe(pushReview);
    }
    // Прогресс чтения локальный и от хоста не зависит: событие есть всегда, даже без ревью-хоста.
    if (!res.writableEnded && !res.destroyed) {
        pushProgress(options.progress.revision);
        unsubscribeProgress = options.progress.subscribe(pushProgress);
    }
    // Маршрут — тоже локальное состояние: без хоста он просто никогда не покидает фазу `none`.
    if (!res.writableEnded && !res.destroyed) {
        pushRoute();
        unsubscribeRoute = options.route.subscribe(pushRoute);
    }
    if (!res.writableEnded && !res.destroyed) {
        pushChat(options.chat.revision);
        unsubscribeChat = options.chat.subscribe(pushChat);
    }
    iterationsReady = true;
}

function sendEvent(res: ServerResponse, event: string, data: string): void {
    // Перевод строки внутри данных ломает формат SSE — каждая строка идёт своим `data:`.
    const payload = data.split('\n').map((line) => `data: ${line}`);
    res.write(`event: ${event}\n${payload.join('\n')}\n\n`);
}

function buildState(options: UiRoutesOptions): UiState {
    return {
        prKey: options.prKey,
        worker: options.registry.status(),
        tasks: options.queue.listTasks().map(toUiTask),
        reviewHost: options.reviewHost,
        pr: options.prMeta.get(),
        feedback: options.feedback,
        iterations: options.iterationFeed?.iterations() ?? [],
        update: options.update.get(),
        generationCap: options.route.currentGenerationCap(),
    };
}

/** Срез задачи для UI; `parse` — та же fail-closed граница, что в `toLeasedTask`. */
function toUiTask(record: TaskRecord): UiTask {
    return uiTaskSchema.parse({
        id: record.id,
        type: record.type,
        priority: record.priority,
        status: record.status,
        heldByWorker: record.status === 'leased' || (record.status === 'cancelled' && record.workerId !== null),
        attempt: record.attempt,
        instructions: record.instructions,
        progressText: record.progressText,
        result: record.result,
        failReason: record.failReason,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
    });
}

/**
 * Инструкция echo-задачи строится на сервере: UI шлёт только текст, а промпт — часть контракта.
 * Текст задачи читает модель, поэтому он английский; команду сдачи CLI подсказывает сам
 * (`formatTask`), здесь её дублировать незачем.
 */
function echoInstructions(text: string): string {
    return [
        'This is a check echo task of the Sherpa loop.',
        'Save exactly this text to a file (no quotes, no comments) and submit it as the result:',
        '',
        text,
    ].join('\n');
}

/** Тело UI-запроса: ошибки валидации уходят списком, как в воркерских ручках. */
async function readUiRequest<T>(ctx: RequestContext, schema: z.ZodType<T>): Promise<T> {
    const body = await readJsonBody(ctx.req);
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
        throw new RpcFailure(
            'bad_request',
            'Запрос не прошёл валидацию контракта.',
            parsed.error.issues.map((issue) => {
                const path = issue.path.join('.');
                return path === '' ? issue.message : `${path}: ${issue.message}`;
            }),
        );
    }
    return parsed.data;
}

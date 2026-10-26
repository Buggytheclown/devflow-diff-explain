import type { IncomingMessage, RequestListener, ServerResponse } from 'node:http';

import type { RpcError, RpcErrorCode } from '@sherpa/protocol';

import { extractBearerToken, tokenMatches } from './auth.js';
import { RpcFailure } from './errors.js';
import type { ActivityTracker } from './idle.js';
import type { StaticAssets } from './static.js';
import { isStaticPath, serveStatic } from './static.js';

/**
 * Потолок тела запроса. Взят с запасом над лимитом результата (`RESULT_MAX_BYTES`), чтобы
 * умеренный перебор доходил до очереди и завершал задачу ошибкой, а не отбивался как кривой запрос.
 */
export const REQUEST_BODY_MAX_BYTES = 1024 * 1024;

/** HTTP-статус по коду ошибки контракта — единственное место, где они связаны. */
const HTTP_STATUS_BY_CODE: Record<RpcErrorCode, number> = {
    unauthorized: 401,
    version_incompatible: 409,
    bad_request: 400,
    unknown_task: 404,
    not_found: 404,
    lease_not_held: 409,
    worker_conflict: 409,
    result_too_large: 413,
    no_review_host: 404,
    host_unavailable: 502,
    internal: 500,
};

export interface JsonResponse {
    readonly status: number;
    readonly body: unknown;
}

export interface RequestContext {
    readonly req: IncomingMessage;
    readonly url: URL;
    /**
     * Подписка на закрытие соединения этого ответа: у обычного запроса это мгновение после отправки,
     * у SSE и long-poll — обрыв или конец стрима. Ею ручки учитывают открытые соединения.
     * Если соединение уже закрыто, слушатель зовётся сразу.
     */
    readonly onClose: (listener: () => void) => void;
}

export type RouteHandler = (ctx: RequestContext) => JsonResponse | Promise<JsonResponse>;

/** Ручка, пишущая в ответ сама (SSE): роутер после неё ничего не отправляет. */
export type StreamHandler = (ctx: StreamContext) => void | Promise<void>;

export interface StreamContext extends RequestContext {
    readonly res: ServerResponse;
}

/**
 * Политика аутентификации ручки. Токен обязателен на всех API-ручках (docs/protocol.md §8);
 * `bearer-or-query` — послабление для SSE: EventSource не умеет заголовки, и токен
 * приезжает параметром `?token=` (сервер слушает только localhost).
 */
export type RouteAuth = 'bearer' | 'bearer-or-query';

interface RouteBase {
    readonly method: string;
    readonly path: string;
    /** По умолчанию `bearer`. */
    readonly auth?: RouteAuth;
}

export interface JsonRoute extends RouteBase {
    readonly handle: RouteHandler;
}

export interface StreamRoute extends RouteBase {
    readonly stream: StreamHandler;
}

export type Route = JsonRoute | StreamRoute;

/** Тело ошибки в формате контракта (`rpcErrorSchema`): его читают и CLI, и UI. */
export function rpcError(code: RpcErrorCode, message: string, details?: readonly string[]): RpcError {
    return { error: details === undefined ? { code, message } : { code, message, details: [...details] } };
}

/** Ответ по доменной ошибке: тело контракта плюс статус, соответствующий коду. */
export function rpcFailureResponse(failure: RpcFailure): JsonResponse {
    return {
        status: HTTP_STATUS_BY_CODE[failure.code],
        body: rpcError(failure.code, failure.message, failure.details),
    };
}

/** Оборачивает ручку: доменные `RpcFailure` уходят наружу телом контракта, остальное — 500. */
export function handlingRpcFailures(handle: RouteHandler): RouteHandler {
    return async (ctx) => {
        try {
            return await handle(ctx);
        } catch (error) {
            if (error instanceof RpcFailure) {
                return rpcFailureResponse(error);
            }
            throw error;
        }
    };
}

/**
 * Читает JSON-тело запроса с лимитом размера. Кривой JSON, пустое тело и перебор лимита —
 * `bad_request` с человеческим текстом: его увидит модель в выводе CLI.
 */
export async function readJsonBody(req: IncomingMessage, maxBytes = REQUEST_BODY_MAX_BYTES): Promise<unknown> {
    const raw = await readBody(req, maxBytes);
    if (raw.trim() === '') {
        throw new RpcFailure('bad_request', 'Empty request body: a JSON object is expected.');
    }

    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch (error) {
        const message = error instanceof Error ? error.message : 'cannot be parsed';
        throw new RpcFailure('bad_request', `The request body is not JSON: ${message}`);
    }
    return parsed;
}

/**
 * То же, но пустое тело — законный ввод: `null` вместо отказа. Нужно ручкам, у которых все поля
 * необязательны (`route/generate`: старый клиент шлёт POST вообще без тела).
 */
export async function readOptionalJsonBody(
    req: IncomingMessage,
    maxBytes = REQUEST_BODY_MAX_BYTES,
): Promise<unknown> {
    const raw = await readBody(req, maxBytes);
    if (raw.trim() === '') {
        return null;
    }

    try {
        return JSON.parse(raw);
    } catch (error) {
        const message = error instanceof Error ? error.message : 'cannot be parsed';
        throw new RpcFailure('bad_request', `The request body is not JSON: ${message}`);
    }
}

function readBody(req: IncomingMessage, maxBytes: number): Promise<string> {
    return new Promise<string>((resolve, reject) => {
        const chunks: Buffer[] = [];
        let size = 0;

        const onData = (chunk: Buffer): void => {
            size += chunk.byteLength;
            if (size <= maxBytes) {
                chunks.push(chunk);
                return;
            }

            // Сокет не рвём: клиенту нужен внятный 400, а не EPIPE посреди отправки тела.
            // Остаток дочитываем в никуда, чтобы соединение доехало до ответа.
            req.off('data', onData);
            req.resume();
            reject(
                new RpcFailure(
                    'bad_request',
                    `The request body is larger than ${String(maxBytes)} bytes — the server does not accept that much.`,
                ),
            );
        };

        req.on('data', onData);
        req.once('end', () => {
            resolve(Buffer.concat(chunks).toString('utf8'));
        });
        req.once('error', reject);
    });
}

export interface RequestListenerOptions {
    readonly token: string;
    readonly routes: readonly Route[];
    /** Источник статики UI; задан — сервер раздаёт её без токена (см. `serveStatic`). */
    readonly assets?: StaticAssets;
    /** Учёт занятости для самоостановки по простою: единственная точка отметок на весь HTTP-слой. */
    readonly activity?: ActivityTracker;
    /**
     * Момент, когда `routes` собран целиком. До него в наборе только `/healthz`, поэтому запрос,
     * не совпавший ни с одним роутом, ждёт этот момент и ищет роут ещё раз: манифест публикуется
     * раньше остальных ручек, и вызов сразу после его появления иначе получал бы 404 на живую ручку.
     * Ждать не должен `/healthz` — он есть с самого начала и им конкурент проверяет нашу живость.
     */
    readonly ready?: Promise<void>;
}

/**
 * Мини-роутер поверх node:http: точное совпадение метода и пути, дальше — политика
 * аутентификации найденного роута (токен обязателен на всех API-ручках, docs/protocol.md §8).
 * Что не совпало ни с одним роутом — статика UI (без токена: секретов в ней нет,
 * токен приезжает в браузер фрагментом URL и до сервера не доходит).
 */
export function createRequestListener(options: RequestListenerOptions): RequestListener {
    return (req, res) => {
        // Соединение считается открытым, пока не закрыт ответ: у обычного запроса это мгновение,
        // у SSE и long-poll — всё время, пока висит стрим.
        const connectionClosed = options.activity?.open();
        if (connectionClosed !== undefined) {
            res.once('close', connectionClosed);
        }

        void handle(req, res, options).catch((error: unknown) => {
            const message = error instanceof Error ? error.message : 'unknown error';
            sendJson(res, {
                status: 500,
                body: rpcError('internal', `Internal server error: ${message}`),
            });
        });
    };
}

async function handle(
    req: IncomingMessage,
    res: ServerResponse,
    options: RequestListenerOptions,
): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    let route = findRoute(options.routes, req.method, url.pathname);

    if (route === undefined && options.ready !== undefined) {
        await options.ready;
        route = findRoute(options.routes, req.method, url.pathname);
    }

    if (route === undefined) {
        if (options.assets !== undefined && req.method === 'GET' && isStaticPath(url.pathname)) {
            if (!(await serveStatic(res, options.assets, url.pathname))) {
                sendJson(res, {
                    status: 404,
                    body: rpcError('bad_request', `Файла UI ${url.pathname} нет в сборке.`),
                });
            }
            return;
        }
        // Порядок сохранён намеренно: чужой процесс без токена не должен по кодам ответа
        // выяснять, какие ручки у сервера есть.
        if (!authorized(options.token, req, url, 'bearer')) {
            sendJson(res, unauthorizedResponse());
            return;
        }
        sendJson(res, {
            status: 404,
            body: rpcError('bad_request', `Unknown endpoint: ${req.method ?? 'GET'} ${url.pathname}.`),
        });
        return;
    }

    if (!authorized(options.token, req, url, route.auth ?? 'bearer')) {
        sendJson(res, unauthorizedResponse());
        return;
    }

    const onClose = (listener: () => void): void => {
        if (res.closed || res.destroyed) {
            listener();
            return;
        }
        res.once('close', listener);
    };

    if ('stream' in route) {
        await route.stream({ req, url, res, onClose });
        return;
    }
    sendJson(res, await route.handle({ req, url, onClose }));
}

function findRoute(routes: readonly Route[], method: string | undefined, pathname: string): Route | undefined {
    return routes.find((item) => item.method === method && item.path === pathname);
}

function authorized(expected: string, req: IncomingMessage, url: URL, auth: RouteAuth): boolean {
    const provided = [extractBearerToken(req.headers.authorization)];
    if (auth === 'bearer-or-query') {
        provided.push(url.searchParams.get('token'));
    }
    return provided.some((token) => tokenMatches(expected, token));
}

function unauthorizedResponse(): JsonResponse {
    return {
        status: 401,
        body: rpcError(
            'unauthorized',
            'An `Authorization: Bearer <token>` header with the token from the manifest is required.',
        ),
    };
}

/**
 * Сигнал «ждать больше некого»: клиент отвалился или сервер останавливается. Им живут
 * долгие ручки — long-poll `next` и SSE-канал UI.
 * Обрыв ловится на сокете, а не на `req`: тело запроса к моменту ожидания уже дочитано,
 * и `close` на самом `IncomingMessage` при разрыве соединения больше не приходит.
 */
export function abortOnDisconnect(
    req: IncomingMessage,
    shutdownSignal: AbortSignal,
): { signal: AbortSignal; dispose: () => void } {
    const controller = new AbortController();
    const abort = (): void => {
        controller.abort();
    };

    const socket = req.socket;
    if (shutdownSignal.aborted || socket.destroyed) {
        abort();
    }
    shutdownSignal.addEventListener('abort', abort);
    socket.on('close', abort);

    return {
        signal: controller.signal,
        dispose: () => {
            shutdownSignal.removeEventListener('abort', abort);
            socket.off('close', abort);
        },
    };
}

export function sendJson(res: ServerResponse, response: JsonResponse): void {
    // Long-poll мог отвиснуть уже после того, как соединение закрыли (в том числе при остановке сервера).
    if (res.writableEnded || res.destroyed) {
        return;
    }

    // Заголовки уже ушли — это потоковая ручка, у которой что-то сломалось посреди ответа.
    // Второй writeHead бросил бы ERR_HTTP_HEADERS_SENT прямо в обработчике ошибок роутера,
    // так что остаётся только закрыть соединение.
    if (res.headersSent) {
        res.end();
        return;
    }

    const payload = JSON.stringify(response.body);
    res.writeHead(response.status, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': String(Buffer.byteLength(payload)),
        'cache-control': 'no-store',
    });
    res.end(payload);
}

import http from 'node:http';

import type {
    Locale,
    RpcError,
    TaskAckResponse,
    TaskCompleteRequest,
    TaskCompleteResponse,
    TaskFailRequest,
    TaskProgressRequest,
    WorkerNextRequest,
    WorkerNextResponse,
    WorkerRegisterRequest,
    WorkerRegisterResponse,
} from '@sherpa/protocol';
import {
    LONG_POLL_DEFAULT_SECONDS,
    PROTOCOL_VERSION,
    rpcErrorSchema,
    taskAckResponseSchema,
    taskCompleteRequestSchema,
    taskCompleteResponseSchema,
    taskFailRequestSchema,
    taskProgressRequestSchema,
    WORKER_ENDPOINTS,
    workerNextRequestSchema,
    workerNextResponseSchema,
    workerRegisterRequestSchema,
    workerRegisterResponseSchema,
} from '@sherpa/protocol';
import type { ZodType } from 'zod';

import type { ServerConnection } from './discovery.js';
import { serverUnavailable } from './discovery.js';
import { CliError, RpcCallError } from './errors.js';
import type { CallRole } from './format.js';
import { formatRpcError } from './format.js';
import { CLI_VERSION } from './version.js';

/** Запас над серверным окном long-poll: обрывать вызов раньше сервера нельзя, ответ уже в пути. */
const LONG_POLL_SLACK_SECONDS = 30;

/** Таймаут клиента на один запрос `next`: окно в запросе не передаётся, его назначает сервер. */
export const NEXT_TIMEOUT_MS = (LONG_POLL_DEFAULT_SECONDS + LONG_POLL_SLACK_SECONDS) * 1000;

/** Остальные ручки отвечают сразу — ждать долго нечего. */
const DEFAULT_TIMEOUT_MS = 30_000;

/** Метки сессии для статуса воркера в UI: все необязательны, их называет сама модель. */
export interface WorkerLabels {
    readonly harness: string | undefined;
    readonly model: string | undefined;
    /** Язык общения агента с ревьюером — подсказка для локали UI, не приказ. */
    readonly lang: Locale | undefined;
}

/** Регистрация сессии воркером PR (`docs/protocol.md §7`): первый вызов скилла и каждое переподключение. */
export async function requestRegister(
    connection: ServerConnection,
    labels: WorkerLabels,
): Promise<WorkerRegisterResponse> {
    return callWorker<WorkerRegisterRequest, WorkerRegisterResponse>(connection, {
        endpoint: WORKER_ENDPOINTS.register,
        payload: {
            ...(labels.harness === undefined ? {} : { harness: labels.harness }),
            ...(labels.model === undefined ? {} : { model: labels.model }),
            ...(labels.lang === undefined ? {} : { lang: labels.lang }),
        },
        requestSchema: workerRegisterRequestSchema,
        responseSchema: workerRegisterResponseSchema,
        timeoutMs: DEFAULT_TIMEOUT_MS,
        role: 'register',
    });
}

/**
 * Один long-poll за следующей задачей на серверном окне. Транспорт — `node:http`, а не `fetch`:
 * см. `sendViaHttp`.
 */
export async function requestNext(connection: ServerConnection): Promise<WorkerNextResponse> {
    return callWorker<WorkerNextRequest, WorkerNextResponse>(connection, {
        endpoint: WORKER_ENDPOINTS.next,
        payload: {},
        requestSchema: workerNextRequestSchema,
        responseSchema: workerNextResponseSchema,
        timeoutMs: NEXT_TIMEOUT_MS,
        role: 'worker',
        send: sendViaHttp,
    });
}

export async function requestComplete(
    connection: ServerConnection,
    taskId: number,
    result: string,
): Promise<TaskCompleteResponse> {
    return callWorker<TaskCompleteRequest, TaskCompleteResponse>(connection, {
        endpoint: WORKER_ENDPOINTS.complete,
        payload: { taskId, result },
        requestSchema: taskCompleteRequestSchema,
        responseSchema: taskCompleteResponseSchema,
        timeoutMs: DEFAULT_TIMEOUT_MS,
        role: 'worker',
    });
}

export async function requestProgress(
    connection: ServerConnection,
    taskId: number,
    text: string,
): Promise<TaskAckResponse> {
    return callWorker<TaskProgressRequest, TaskAckResponse>(connection, {
        endpoint: WORKER_ENDPOINTS.progress,
        payload: { taskId, text },
        requestSchema: taskProgressRequestSchema,
        responseSchema: taskAckResponseSchema,
        timeoutMs: DEFAULT_TIMEOUT_MS,
        role: 'worker',
    });
}

export async function requestFail(
    connection: ServerConnection,
    taskId: number,
    reason: string,
): Promise<TaskAckResponse> {
    return callWorker<TaskFailRequest, TaskAckResponse>(connection, {
        endpoint: WORKER_ENDPOINTS.fail,
        payload: { taskId, reason },
        requestSchema: taskFailRequestSchema,
        responseSchema: taskAckResponseSchema,
        timeoutMs: DEFAULT_TIMEOUT_MS,
        role: 'worker',
    });
}

/** Общая часть тела, одинаковая для всех воркерских запросов (`docs/protocol.md §9`). */
type WorkerRequestBase = Pick<WorkerNextRequest, 'protocolVersion' | 'cliVersion' | 'workerId'>;

/** Что остаётся от запроса на долю вызывающего: рукопожатие и идентичность добавляет `callWorker`. */
type WorkerPayload<TRequest extends WorkerRequestBase> = Omit<TRequest, keyof WorkerRequestBase>;

interface WorkerCall<TRequest extends WorkerRequestBase, TResponse> {
    readonly endpoint: string;
    readonly payload: WorkerPayload<TRequest>;
    readonly requestSchema: ZodType<TRequest>;
    readonly responseSchema: ZodType<TResponse>;
    readonly timeoutMs: number;
    /** Роль вызова: от неё зависит текст следующего шага при конфликте воркеров. */
    readonly role: CallRole;
    /** Транспорт вызова; по умолчанию `fetch`. Разбор ответа от него не зависит. */
    readonly send?: Transport;
}

/** Сырой ответ сервера в терминах разбора: успех по коду и тело строкой. */
interface RawResponse {
    readonly ok: boolean;
    readonly text: string;
}

/** Сетевая беда любой природы — `CliError(serverUnavailable)`; остальное решает разбор ответа. */
type Transport = (
    connection: ServerConnection,
    endpoint: string,
    body: string,
    timeoutMs: number,
) => Promise<RawResponse>;

/**
 * Один воркерский вызов: рукопожатие версий в теле каждого запроса (`docs/protocol.md §9`),
 * bearer-токен из манифеста. Тело проверяется схемой контракта до отправки, ответ — после,
 * fail-closed в обе стороны.
 */
async function callWorker<TRequest extends WorkerRequestBase, TResponse>(
    connection: ServerConnection,
    call: WorkerCall<TRequest, TResponse>,
): Promise<TResponse> {
    const request = call.requestSchema.safeParse({
        protocolVersion: PROTOCOL_VERSION,
        cliVersion: CLI_VERSION,
        workerId: connection.workerId,
        ...call.payload,
    });
    if (!request.success) {
        throw new CliError(invalidRequest(request.error.issues.map((issue) => issue.message)));
    }

    const send = call.send ?? sendViaFetch;
    const response = await send(connection, call.endpoint, JSON.stringify(request.data), call.timeoutMs);

    if (!response.ok) {
        const failure = parseRpcError(response.text);
        throw new RpcCallError(failure.code, formatRpcError(failure, call.role));
    }

    const parsed = call.responseSchema.safeParse(parseJson(response.text));
    if (!parsed.success) {
        throw new CliError(contractMismatch());
    }
    return parsed.data;
}

/** Транспорт всех ручек, кроме `next`: они отвечают сразу, и `fetch` для них уместен. */
const sendViaFetch: Transport = async (connection, endpoint, body, timeoutMs) => {
    let response: Response;
    try {
        response = await fetch(`http://127.0.0.1:${String(connection.port)}${endpoint}`, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                authorization: `Bearer ${connection.token}`,
            },
            body,
            signal: AbortSignal.timeout(timeoutMs),
        });
    } catch {
        throw new CliError(serverUnavailable(connection.prKey));
    }

    try {
        return { ok: response.ok, text: await response.text() };
    } catch {
        throw new CliError(serverUnavailable(connection.prKey));
    }
};

/**
 * Транспорт `next` на `node:http`. `fetch` в Node — это undici с `headersTimeout` в 5 минут:
 * ответ, чьи заголовки не пришли за этот срок, обрывается `UND_ERR_HEADERS_TIMEOUT` независимо
 * от `AbortSignal.timeout` (проверено: ожидание 400 с рвётся на 301-й). Нынешнее окно короче, но
 * запас до чужого скрытого потолка мал; здесь срок держит свой таймер.
 */
const sendViaHttp: Transport = (connection, endpoint, body, timeoutMs) =>
    new Promise<RawResponse>((resolve, reject) => {
        let request: http.ClientRequest;
        try {
            request = http.request({
                host: '127.0.0.1',
                port: connection.port,
                path: endpoint,
                method: 'POST',
                headers: {
                    'content-type': 'application/json',
                    'content-length': Buffer.byteLength(body),
                    authorization: `Bearer ${connection.token}`,
                },
                // Без пула соединений: свободный сокет агента держал бы процесс живым после выхода из петли.
                agent: false,
            });
        } catch {
            // Запрос не собрался (битый токен в манифесте — запрещённый символ в заголовке и подобное):
            // для вызывающего это такая же недоступность сервера, как отказ сокета.
            reject(new CliError(serverUnavailable(connection.prKey)));
            return;
        }

        const fail = (): void => {
            clearTimeout(timer);
            request.destroy();
            reject(new CliError(serverUnavailable(connection.prKey)));
        };
        const timer = setTimeout(fail, timeoutMs);

        request.on('error', fail);
        request.on('response', (response) => {
            const chunks: Buffer[] = [];
            response.on('data', (chunk: Buffer) => chunks.push(chunk));
            response.on('error', fail);
            response.on('end', () => {
                clearTimeout(timer);
                const status = response.statusCode ?? 0;
                resolve({ ok: status >= 200 && status < 300, text: Buffer.concat(chunks).toString('utf8') });
            });
        });
        request.end(body);
    });

/** Тело ошибки не по контракту — считаем разъездом версий: сервер должен отвечать `rpcErrorSchema`. */
function parseRpcError(text: string): RpcError['error'] {
    const parsed = rpcErrorSchema.safeParse(parseJson(text));
    if (!parsed.success) {
        throw new CliError(contractMismatch());
    }
    return parsed.data.error;
}

function parseJson(text: string): unknown {
    try {
        return JSON.parse(text);
    } catch {
        return null;
    }
}

/** Запрос не прошёл контракт локально: длинный `--text`, кривой `SHERPA_WORKER_ID` и подобное. */
function invalidRequest(details: readonly string[]): string {
    return [
        'devflow-diff-explain: the command does not pass the contract, the server would reject it:',
        ...details.map((detail) => `  - ${detail}`),
        'Fix the command arguments (and `SHERPA_WORKER_ID`, if it is set) and call it again.',
    ].join('\n');
}

function contractMismatch(): string {
    return (
        'devflow-diff-explain: the server replied off-contract — most likely the CLI and the server versions diverged.\n' +
        'Update the Devflow Diff Explain skill together with the CLI and restart the server.'
    );
}

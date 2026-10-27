import type { IncomingMessage } from 'node:http';

import type {
    TaskAckResponse,
    TaskCompleteResponse,
    WorkerNextResponse,
    WorkerRegisterResponse,
    WorkerStatus,
} from '@sherpa/protocol';
import {
    PROTOCOL_VERSION,
    protocolVersionsCompatible,
    semverSchema,
    taskFailRequestSchema,
    taskIdSchema,
    taskProgressRequestSchema,
    WORKER_ENDPOINTS,
    workerIdSchema,
    workerNextRequestSchema,
    workerRegisterRequestSchema,
} from '@sherpa/protocol';
import { z } from 'zod';

import { RpcFailure } from './errors.js';
import type { RequestContext, Route } from './http.js';
import { abortOnDisconnect, handlingRpcFailures, readJsonBody } from './http.js';
import type { TaskQueue } from './queue.js';
import type { UiPresence } from './ui-presence.js';
import type { WorkerRegistry } from './worker-registry.js';

export interface WorkerRoutesOptions {
    readonly queue: TaskQueue;
    readonly registry: WorkerRegistry;
    /** Присутствие UI: его уход завершает воркера, когда открытых задач не осталось. */
    readonly presence: UiPresence;
    /** Окно long-poll `next`; в тестах сокращается. */
    readonly longPollSeconds: number;
    /** Остановка сервера: обрывает висящие long-poll'ы, чтобы close() их не ждал. */
    readonly shutdownSignal: AbortSignal;
    /**
     * Запись владельца слота в файл стейта PR (`writeWorkerIdFile`) — синхронная и в том же такте,
     * что и захват слота: только так порядок записей совпадает с порядком регистраций.
     */
    readonly publishWorkerId: (workerId: string) => void;
}

/**
 * Страховочный опрос очереди в long-poll: подписка ловит только постановку задач,
 * а задача может вернуться в очередь ещё и по истечении чужой аренды.
 */
const SAFETY_POLL_INTERVAL_MS = 1000;

/**
 * Тело `complete` без контрактного refine по размеру: превышение лимита — ошибка задачи
 * (docs/architecture.md §7.5), и её надо довести до очереди, а не отбить как невалидный запрос.
 */
const completeBodySchema = z.object({
    protocolVersion: semverSchema,
    cliVersion: semverSchema,
    workerId: workerIdSchema,
    taskId: taskIdSchema,
    result: z.string(),
});

/**
 * Воркерские ручки (docs/protocol.md §3): pull-канал сессии, все — POST с JSON-телом контракта.
 * Каждый валидный вызов — heartbeat воркера (docs/protocol.md §7): вызов не-владельца отбивается
 * `worker_conflict` до того, как запрос дойдёт до очереди. Исключение — `register`: свежая сессия
 * перехватывает слот даже у живой.
 */
export function createWorkerRoutes(options: WorkerRoutesOptions): Route[] {
    const subscribeSlotChange = watchSlotOwner(options.registry);

    // Слот сменил хозяина: аренды прежнего воркера возвращаются в очередь сразу, не дожидаясь TTL.
    const reclaimLeases = (displaced: string | null): void => {
        if (displaced !== null) {
            options.queue.releaseLeasesOf(displaced);
        }
    };

    /**
     * Heartbeat вызова плюс учёт его соединения: пока запрос в полёте (у `next` — все минуты
     * long-poll), сессия жива, а обрыв соединения сервер видит сразу и признаёт смерть быстро.
     * Соединение считается только за сессией, прошедшей проверку владения слотом.
     */
    const heartbeat = (ctx: RequestContext, workerId: string, claim: () => string | null): void => {
        reclaimLeases(claim());
        ctx.onClose(options.registry.holdConnection(workerId));
    };

    return [
        {
            method: 'POST',
            path: WORKER_ENDPOINTS.register,
            handle: handlingRpcFailures(async (ctx) => {
                const request = await readWorkerRequest(ctx, workerRegisterRequestSchema);
                heartbeat(ctx, request.workerId, () =>
                    options.registry.register(request.workerId, request.harness, request.model, request.lang),
                );
                // Ровно за захватом слота, без единого await между ними: файл идентичности обязан
                // меняться в том же порядке, что и владелец слота.
                options.publishWorkerId(request.workerId);
                const body: WorkerRegisterResponse = {
                    kind: 'registered',
                    message:
                        'This session is registered as the worker of this PR. Run `devflow-diff-explain worker next` ' +
                        'and follow the instructions in its output.',
                };
                return { status: 200, body };
            }),
        },
        {
            method: 'POST',
            path: WORKER_ENDPOINTS.next,
            handle: handlingRpcFailures(async (ctx) => {
                const request = await readWorkerRequest(ctx, workerNextRequestSchema);
                heartbeat(ctx, request.workerId, () => options.registry.touch(request.workerId));
                const body: WorkerNextResponse = await pollForTask(
                    options,
                    subscribeSlotChange,
                    ctx.req,
                    request.workerId,
                    options.longPollSeconds,
                );
                return { status: 200, body };
            }),
        },
        {
            method: 'POST',
            path: WORKER_ENDPOINTS.complete,
            handle: handlingRpcFailures(async (ctx) => {
                const request = await readWorkerRequest(ctx, completeBodySchema);
                heartbeat(ctx, request.workerId, () => options.registry.touch(request.workerId));
                const body: TaskCompleteResponse = options.queue.complete(
                    request.workerId,
                    request.taskId,
                    request.result,
                );
                return { status: 200, body };
            }),
        },
        {
            method: 'POST',
            path: WORKER_ENDPOINTS.progress,
            handle: handlingRpcFailures(async (ctx) => {
                const request = await readWorkerRequest(ctx, taskProgressRequestSchema);
                heartbeat(ctx, request.workerId, () => options.registry.touch(request.workerId));
                const body: TaskAckResponse = options.queue.progress(request.workerId, request.taskId, request.text);
                return { status: 200, body };
            }),
        },
        {
            method: 'POST',
            path: WORKER_ENDPOINTS.fail,
            handle: handlingRpcFailures(async (ctx) => {
                const request = await readWorkerRequest(ctx, taskFailRequestSchema);
                heartbeat(ctx, request.workerId, () => options.registry.touch(request.workerId));
                const body: TaskAckResponse = options.queue.fail(request.workerId, request.taskId, request.reason);
                return { status: 200, body };
            }),
        },
    ];
}

/** Тело запроса + рукопожатие версий (docs/protocol.md §9): проверяется на каждом воркерском вызове. */
async function readWorkerRequest<T extends { protocolVersion: string }>(
    ctx: RequestContext,
    schema: z.ZodType<T>,
): Promise<T> {
    const body = await readJsonBody(ctx.req);
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
        throw new RpcFailure(
            'bad_request',
            'The request failed contract validation — fix the fields and call the command again.',
            parsed.error.issues.map((issue) => {
                const path = issue.path.join('.');
                return path === '' ? issue.message : `${path}: ${issue.message}`;
            }),
        );
    }

    if (!protocolVersionsCompatible(parsed.data.protocolVersion, PROTOCOL_VERSION)) {
        throw new RpcFailure(
            'version_incompatible',
            `The CLI protocol version ${parsed.data.protocolVersion} is incompatible with the server one ` +
                `${PROTOCOL_VERSION}. Update the skill together with the CLI and restart the Sherpa server — ` +
                'they ship together.',
        );
    }
    return parsed.data;
}

/**
 * Long-poll `next`: задача отдаётся сразу, как только появилась; ушедший UI завершает воркера,
 * когда открытых задач нет; по исчерпании окна — `idle`, и CLI перезапрашивает сам. Живость на окно
 * не завязана — пока вызов висит, воркер жив по открытому соединению.
 */
async function pollForTask(
    options: WorkerRoutesOptions,
    subscribeSlotChange: SubscribeSlotChange,
    req: IncomingMessage,
    workerId: string,
    windowSeconds: number,
): Promise<WorkerNextResponse> {
    const deadline = Date.now() + windowSeconds * 1000;
    const abort = abortOnDisconnect(req, options.shutdownSignal);

    try {
        for (;;) {
            // Проверка до `next`: иначе отвалившемуся (или пойманному остановкой сервера) воркеру
            // достанется аренда, о которой он никогда не узнает.
            if (abort.signal.aborted) {
                break;
            }

            // Пока вызов висел, слот мог уйти новой сессии — она перехватывает его регистрацией,
            // не дожидаясь смерти прежней: иначе старый воркер увёл бы у неё задачу.
            options.registry.assertOwner(workerId);

            if (shouldFinishWorker(options)) {
                // Сессия сейчас закончится — держания отменённых задач уходят вместе с ней,
                // иначе UI до истечения TTL считал бы мёртвого воркера занятым.
                options.queue.releaseCancelledHoldsOf(workerId);
                return { kind: 'done', message: 'Ревьюер закрыл вкладку — работа окончена.' };
            }

            const leased = options.queue.next(workerId);
            if (leased !== null) {
                return { kind: 'task', task: leased.task, lease: leased.lease };
            }

            const remaining = deadline - Date.now();
            if (remaining <= 0) {
                break;
            }
            await waitForWork(
                options.queue,
                options.presence,
                subscribeSlotChange,
                abort.signal,
                Math.min(remaining, SAFETY_POLL_INTERVAL_MS),
            );
        }
    } finally {
        abort.dispose();
    }

    // CLI глотает `idle` и перезапрашивает сам — модель этот текст не видит.
    return { kind: 'idle', message: 'No tasks yet. Call `devflow-diff-explain worker next` again.' };
}

/** UI ушёл и ни одна задача не ждёт выдачи или завершения. */
function shouldFinishWorker(options: WorkerRoutesOptions): boolean {
    return (
        options.presence.uiGone &&
        !options.queue.listTasks().some((task) => task.status === 'queued' || task.status === 'leased')
    );
}

/** Ждёт изменения очереди, ухода UI, смены слота, страховочного тика или обрыва. */
function waitForWork(
    queue: TaskQueue,
    presence: UiPresence,
    subscribeSlotChange: SubscribeSlotChange,
    signal: AbortSignal,
    timeoutMs: number,
): Promise<void> {
    return new Promise<void>((resolve) => {
        if (signal.aborted) {
            resolve();
            return;
        }

        let timer: NodeJS.Timeout | null = null;
        let unsubscribeQueue = (): void => undefined;
        let unsubscribePresence = (): void => undefined;
        let unsubscribeSlot = (): void => undefined;
        let finished = false;

        const finish = (): void => {
            if (finished) {
                return;
            }
            finished = true;
            if (timer !== null) {
                clearTimeout(timer);
            }
            unsubscribeQueue();
            unsubscribePresence();
            unsubscribeSlot();
            signal.removeEventListener('abort', finish);
            resolve();
        };

        timer = setTimeout(finish, timeoutMs);
        timer.unref();
        unsubscribeQueue = queue.subscribeChanges(finish);
        unsubscribePresence = presence.subscribe(finish);
        unsubscribeSlot = subscribeSlotChange(finish);
        signal.addEventListener('abort', finish);

        // Переход мог попасть между проверкой в `pollForTask` и установкой подписки.
        if (presence.uiGone) {
            finish();
        }
    });
}

/** Подписка на смену владельца слота: возвращает отписку, как остальные подписки сервера. */
type SubscribeSlotChange = (listener: () => void) => () => void;

/**
 * Слежение за владельцем слота ради висящих long-poll: перехват вытесняет сессию мгновенно, и её
 * `next` должен вернуться с `worker_conflict` в ту же секунду, а не досидеть до конца окна.
 * Отписка от регистра не нужна: ручки живут ровно столько же, `WorkerRegistry.close()` гасит
 * слушателей сам.
 */
function watchSlotOwner(registry: WorkerRegistry): SubscribeSlotChange {
    const waiters = new Set<() => void>();
    let owner = ownerOf(registry.status());

    registry.subscribe((status) => {
        const next = ownerOf(status);
        if (next === owner) {
            return;
        }

        owner = next;
        for (const wake of [...waiters]) {
            wake();
        }
    });

    return (listener) => {
        waiters.add(listener);
        return () => {
            waiters.delete(listener);
        };
    };
}

function ownerOf(status: WorkerStatus): string | null {
    return status.kind === 'never' ? null : status.workerId;
}


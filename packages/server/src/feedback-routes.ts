import type { UiFeedbackAvailability, UiFeedbackResponse, WorkerStatus } from '@sherpa/protocol';
import {
    PROTOCOL_VERSION,
    UI_ENDPOINTS,
    uiFeedbackRequestSchema,
    uiFeedbackResponseSchema,
} from '@sherpa/protocol';
import type { z } from 'zod';

import { RpcFailure } from './errors.js';
import type { JsonResponse, RequestContext, Route } from './http.js';
import { handlingRpcFailures, readJsonBody } from './http.js';
import { FEEDBACK_QUEUE, TrackerClient } from './tracker-client.js';
import type { TrackerFetchLike } from './tracker-client.js';
import { trackerTokenAvailable, trackerTokenSource } from './tracker-token.js';
import type { RunYa, TrackerTokenOptions, TrackerTokenSource } from './tracker-token.js';
import { SERVER_VERSION } from './version.js';

/** Почему токена нет, когда его не из чего добыть; провал самой добычи описывает `tracker-token.ts`. */
export const NO_TRACKER_TOKEN_REASON =
    'Нет OAuth-токена Трекера: в окружении сервера он не задан, а `ya` для его получения не найден.';

/** Текст деградации: причина, затем куда нести фидбек руками. Ссылку на чат показывает UI. */
export function feedbackUnavailableMessage(reason: string = NO_TRACKER_TOKEN_REASON): string {
    return `${reason} Фидбек можно отправить напрямую в очередь ${FEEDBACK_QUEUE} или в чат Шерпы.`;
}

const SUMMARY_MAX_CHARS = 100;
const DEFAULT_CURRENT_USER_TIMEOUT_MS = 500;

export interface FeedbackIntegrationOptions {
    readonly env?: NodeJS.ProcessEnv;
    /** Путь к `ya` для добычи токена, когда его нет в окружении (`locateYa`); не задан — только окружение. */
    readonly ya?: string | null;
    readonly runYa?: RunYa;
    readonly fetch?: TrackerFetchLike;
    readonly baseUrl?: string;
    readonly retryAttempts?: number;
    readonly retryBaseMs?: number;
    readonly timeoutMs?: number;
    readonly sleep?: (ms: number) => Promise<void>;
    readonly random?: () => number;
    readonly currentUserTimeoutMs?: number;
}

export interface FeedbackRoutesOptions extends FeedbackIntegrationOptions {
    readonly prKey: string;
    readonly workerStatus: () => WorkerStatus;
    /** Хост-специфичный whoami. Нет метода или он сорвался — в контексте останется «неизвестен». */
    readonly currentUser?: () => string | null | Promise<string | null>;
}

/** Доступность канала для UI-снапшота: окружение и наличие `ya`, без запуска процессов. */
export function feedbackAvailability(options: FeedbackIntegrationOptions = {}): UiFeedbackAvailability {
    return trackerTokenAvailable(tokenOptions(options))
        ? { available: true, reason: null }
        : { available: false, reason: feedbackUnavailableMessage() };
}

/** POST-ручка фидбека не зависит от ревью-хоста и живого воркера. */
export function createFeedbackRoutes(options: FeedbackRoutesOptions): Route[] {
    const availability = feedbackAvailability(options);
    const token = trackerTokenSource(tokenOptions(options));
    const tracker = new TrackerClient({
        token,
        ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
        ...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }),
        ...(options.retryAttempts === undefined ? {} : { retryAttempts: options.retryAttempts }),
        ...(options.retryBaseMs === undefined ? {} : { retryBaseMs: options.retryBaseMs }),
        ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
        ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
        ...(options.random === undefined ? {} : { random: options.random }),
    });

    return [
        {
            method: 'POST',
            path: UI_ENDPOINTS.feedback,
            handle: handlingRpcFailures(async (ctx) => {
                const request = await readRequest(ctx, uiFeedbackRequestSchema);
                if (!availability.available) {
                    return respond({
                        outcome: 'unavailable',
                        issueKey: null,
                        issueUrl: null,
                        message: availability.reason ?? feedbackUnavailableMessage(),
                    });
                }
                const tokenProblem = await tokenUnavailableReason(token);
                if (tokenProblem !== null) {
                    process.stderr.write(`sherpa-server: канал фидбека недоступен: ${tokenProblem}\n`);
                    return respond({
                        outcome: 'unavailable',
                        issueKey: null,
                        issueUrl: null,
                        message: feedbackUnavailableMessage(tokenProblem),
                    });
                }

                const description = request.includeContext
                    ? descriptionWithContext(
                          request.text,
                          {
                              prKey: options.prKey,
                              view: request.context?.view ?? 'неизвестно',
                              routePhase: request.context?.routePhase ?? 'неизвестно',
                              uiVersion: request.context?.uiVersion ?? 'неизвестна',
                              worker: options.workerStatus(),
                              user: await bestEffortCurrentUser(
                                  options.currentUser,
                                  options.currentUserTimeoutMs ?? DEFAULT_CURRENT_USER_TIMEOUT_MS,
                              ),
                          },
                      )
                    : request.text;
                const issue = await tracker.createIssue({
                    summary: feedbackSummary(request.text),
                    description,
                });
                return respond({
                    outcome: 'created',
                    issueKey: issue.key,
                    issueUrl: issue.url,
                    message: null,
                });
            }),
        },
    ];
}

interface FeedbackContext {
    readonly prKey: string;
    readonly view: string;
    readonly routePhase: string;
    readonly uiVersion: string;
    readonly worker: WorkerStatus;
    readonly user: string | null;
}

function descriptionWithContext(text: string, context: FeedbackContext): string {
    return [
        text,
        '',
        '---',
        '## Контекст Шерпы',
        '',
        `- Версия: UI ${context.uiVersion}, сервер ${SERVER_VERSION}, протокол ${PROTOCOL_VERSION}`,
        `- PR: ${context.prKey}`,
        `- Вью: ${context.view}`,
        `- Фаза маршрута: ${context.routePhase}`,
        `- Воркер: ${workerDescription(context.worker)}`,
        `- Пользователь: ${context.user ?? 'неизвестен'}`,
    ].join('\n');
}

function workerDescription(worker: WorkerStatus): string {
    if (worker.kind === 'never') {
        return 'не зарегистрирован';
    }
    const status = worker.kind === 'connected' ? 'подключён' : 'отключён';
    return `${worker.harness ?? 'харнес неизвестен'} · ${worker.model ?? 'модель неизвестна'} · ${status}`;
}

function feedbackSummary(text: string): string {
    const [rawFirstLine = ''] = text.split(/\r?\n/, 1);
    const firstLine = rawFirstLine.trim();
    return (firstLine === '' ? 'Feedback' : firstLine).slice(0, SUMMARY_MAX_CHARS);
}

async function bestEffortCurrentUser(
    source: FeedbackRoutesOptions['currentUser'],
    timeoutMs: number,
): Promise<string | null> {
    if (source === undefined) {
        return null;
    }

    let timer!: ReturnType<typeof setTimeout>;
    const timeout = new Promise<null>((resolve) => {
        timer = setTimeout(() => {
            resolve(null);
        }, Math.max(0, timeoutMs));
        timer.unref();
    });
    try {
        const value = await Promise.race([
            Promise.resolve()
                .then(source)
                .catch(() => null),
            timeout,
        ]);
        return nonEmpty(value);
    } finally {
        clearTimeout(timer);
    }
}

async function readRequest<T>(ctx: RequestContext, schema: z.ZodType<T>): Promise<T> {
    const parsed = schema.safeParse(await readJsonBody(ctx.req));
    if (!parsed.success) {
        throw new RpcFailure(
            'bad_request',
            'Запрос отправки фидбека не прошёл валидацию контракта.',
            parsed.error.issues.map((issue) => {
                const path = issue.path.join('.');
                return path === '' ? issue.message : `${path}: ${issue.message}`;
            }),
        );
    }
    return parsed.data;
}

function respond(body: UiFeedbackResponse): JsonResponse {
    const parsed = uiFeedbackResponseSchema.safeParse(body);
    if (!parsed.success) {
        throw new RpcFailure(
            'internal',
            'Ответ сервера не сошёлся с контрактом фидбека.',
            parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
        );
    }
    return { status: 200, body: parsed.data };
}

function nonEmpty(value: string | null | undefined): string | null {
    const trimmed = value?.trim() ?? '';
    return trimmed === '' ? null : trimmed;
}

function tokenOptions(options: FeedbackIntegrationOptions): TrackerTokenOptions {
    return {
        ...(options.env === undefined ? {} : { env: options.env }),
        ...(options.ya === undefined ? {} : { ya: options.ya }),
        ...(options.runYa === undefined ? {} : { runYa: options.runYa }),
    };
}

/**
 * Токен добывается лениво, при первой отправке: провал `ya tool fetch-token` — деградация
 * канала (HTTP 200, текст остаётся у формы), а не ошибка ручки. Возвращает причину или null.
 */
async function tokenUnavailableReason(source: TrackerTokenSource): Promise<string | null> {
    try {
        return (await source()) === null ? NO_TRACKER_TOKEN_REASON : null;
    } catch (error) {
        if (error instanceof RpcFailure) {
            return [error.message, ...(error.details ?? [])].join(' ');
        }
        throw error;
    }
}

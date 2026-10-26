import { z } from 'zod';

import { RpcFailure, describeFetchError } from './errors.js';
import type { TrackerTokenSource } from './tracker-token.js';

export const TRACKER_API_BASE = 'https://st-api.yandex-team.ru/v2';
/** Очередь фидбека Шерпы; тикет уходит в её корень, без родителя. */
export const FEEDBACK_QUEUE = 'SHERPA';

export type TrackerFetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface TrackerClientOptions {
    readonly token: TrackerTokenSource;
    readonly fetch?: TrackerFetchLike;
    readonly baseUrl?: string;
    readonly retryAttempts?: number;
    readonly retryBaseMs?: number;
    readonly timeoutMs?: number;
    readonly sleep?: (ms: number) => Promise<void>;
    readonly random?: () => number;
}

export interface TrackerIssueInput {
    readonly summary: string;
    readonly description: string;
}

export interface TrackerIssue {
    readonly key: string;
    readonly url: string;
}

const issueResponseSchema = z.object({ key: z.string().min(1) });
const DEFAULT_RETRY_ATTEMPTS = 3;
const DEFAULT_RETRY_BASE_MS = 300;
const DEFAULT_TIMEOUT_MS = 15_000;

/** Маленький fail-closed клиент создания тикетов фидбека. */
export class TrackerClient {
    private readonly token: TrackerTokenSource;
    private readonly fetchImpl: TrackerFetchLike;
    private readonly baseUrl: string;
    private readonly retryAttempts: number;
    private readonly retryBaseMs: number;
    private readonly timeoutMs: number;
    private readonly sleep: (ms: number) => Promise<void>;
    private readonly random: () => number;

    constructor(options: TrackerClientOptions) {
        this.token = options.token;
        this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
        this.baseUrl = (options.baseUrl ?? TRACKER_API_BASE).replace(/\/+$/, '');
        this.retryAttempts = options.retryAttempts ?? DEFAULT_RETRY_ATTEMPTS;
        this.retryBaseMs = options.retryBaseMs ?? DEFAULT_RETRY_BASE_MS;
        this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
        this.sleep = options.sleep ?? defaultSleep;
        this.random = options.random ?? Math.random;
    }

    async createIssue(input: TrackerIssueInput): Promise<TrackerIssue> {
        const token = await this.token();
        if (token === null) {
            throw this.failure('OAuth-токен не задан');
        }

        const path = '/issues';
        const attempts = Math.max(1, this.retryAttempts);
        let lastError: RpcFailure | null = null;

        for (let attempt = 1; attempt <= attempts; attempt += 1) {
            let response: Response;
            try {
                response = await this.fetchImpl(`${this.baseUrl}${path}`, {
                    method: 'POST',
                    headers: {
                        accept: 'application/json',
                        'content-type': 'application/json',
                        authorization: `OAuth ${token}`,
                    },
                    body: JSON.stringify({
                        queue: FEEDBACK_QUEUE,
                        summary: input.summary,
                        description: input.description,
                    }),
                    signal: AbortSignal.timeout(this.timeoutMs),
                });
            } catch (error) {
                throw this.failure(`сеть недоступна (${describeFetchError(error)})`);
            }

            if (response.status === 201) {
                return this.parseIssue(await this.readText(response));
            }
            const reason = `${String(response.status)} ${response.statusText}`.trim();
            if (!retriable(response.status)) {
                throw this.failure(reason);
            }
            lastError = this.failure(reason);
            await this.backoff(attempt, attempts);
        }

        throw lastError ?? this.failure('запрос не выполнен');
    }

    private parseIssue(raw: string): TrackerIssue {
        let payload: unknown;
        try {
            payload = JSON.parse(raw);
        } catch {
            throw this.failure('ответ не является JSON');
        }
        const parsed = issueResponseSchema.safeParse(payload);
        if (!parsed.success) {
            throw this.failure(
                'ответ не сошёлся со схемой',
                parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
            );
        }
        return {
            key: parsed.data.key,
            url: `https://st.yandex-team.ru/${encodeURIComponent(parsed.data.key)}`,
        };
    }

    private async readText(response: Response): Promise<string> {
        try {
            return await response.text();
        } catch (error) {
            throw this.failure(`ответ не дочитался (${describeFetchError(error)})`);
        }
    }

    private async backoff(attempt: number, attempts: number): Promise<void> {
        if (attempt >= attempts) {
            return;
        }
        const window = this.retryBaseMs * 2 ** (attempt - 1);
        await this.sleep(window + Math.floor(this.random() * window));
    }

    private failure(reason: string, details?: readonly string[]): RpcFailure {
        return new RpcFailure(
            'host_unavailable',
            `Не удалось отправить фидбек в Яндекс Трекер: ${reason}. Введённый текст сохранён, повтори отправку.`,
            details,
        );
    }
}

function retriable(status: number): boolean {
    return status === 429 || status >= 500;
}

function defaultSleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
        const timer = setTimeout(resolve, ms);
        timer.unref();
    });
}

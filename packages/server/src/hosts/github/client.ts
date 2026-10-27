import type { z } from 'zod';

import { RpcFailure, describeFetchError } from '../../errors.js';

import type { TokenSource } from './token.js';

/**
 * HTTP-клиент GitHub: GraphQL — основной API, REST — три ручки, которых в GraphQL нет
 * (`docs/architecture.md`). Каждый ответ проходит zod fail-closed: GraphQL отдаёт
 * `null` вместо отсутствующего узла, и без схемы вместо ошибки приезжала бы дырка.
 *
 * Транспорт инжектируется — тесты гоняют адаптер на записанном API без сети. Токен живёт только
 * в заголовке запроса: ни в логах, ни в текстах ошибок его нет (`docs/architecture.md`).
 */

export const GITHUB_API_BASE = 'https://api.github.com';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export type Query = Record<string, string | number | undefined>;

export interface GithubClientOptions {
    readonly token: TokenSource;
    readonly fetch?: FetchLike;
    /** Только для тестов: живой хост один — `https://api.github.com`. */
    readonly baseUrl?: string;
    /** Сколько раз всего пробуем запрос (5xx/сеть); `1` — без ретраев. */
    readonly retryAttempts?: number;
    readonly retryBaseMs?: number;
    readonly timeoutMs?: number;
    /** Потолок ожидания сброса лимита запросов; дольше — `host_unavailable`. */
    readonly rateLimitWaitMs?: number;
    readonly sleep?: (ms: number) => Promise<void>;
    readonly random?: () => number;
    readonly now?: () => number;
}

/** Пер-вызовные отступления: заголовки ручки и потолок попыток. */
export interface RestOptions {
    readonly query?: Query;
    readonly headers?: Readonly<Record<string, string>>;
    /** Потолок попыток именно для этого вызова, не меньше одной. */
    readonly retryAttempts?: number;
}

const DEFAULT_RETRY_ATTEMPTS = 3;
const DEFAULT_RETRY_BASE_MS = 300;
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_RATE_LIMIT_WAIT_MS = 5 * 60_000;

/**
 * Запас очков GraphQL, ниже которого клиент ждёт сброса окна: у GitHub 5000 очков в час,
 * и упереться в ноль посреди публикации хуже, чем подождать.
 */
const RATE_LIMIT_RESERVE = 200;

/** Сколько страниц REST-списка готовы дочитать: по 100 записей это заведомо больше любого PR. */
const MAX_PAGES = 50;

/**
 * Сколько раз подряд готовы переждать окно лимита. Попытку такой ответ не тратит, но GitHub может
 * и не назвать момент сброса — тогда ожидание нулевое, и без потолка это был бы холостой цикл.
 */
const MAX_RATE_LIMIT_WAITS = 2;

export class GithubClient {
    private readonly token: TokenSource;
    private readonly fetchImpl: FetchLike;
    private readonly baseUrl: string;
    private readonly retryAttempts: number;
    private readonly retryBaseMs: number;
    private readonly timeoutMs: number;
    private readonly rateLimitWaitMs: number;
    private readonly sleep: (ms: number) => Promise<void>;
    private readonly random: () => number;
    private readonly now: () => number;

    /** Момент сброса окна лимита; null — ждать нечего. */
    private rateLimitResetAt: number | null = null;

    constructor(options: GithubClientOptions) {
        this.token = options.token;
        this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
        this.baseUrl = (options.baseUrl ?? GITHUB_API_BASE).replace(/\/+$/, '');
        this.retryAttempts = options.retryAttempts ?? DEFAULT_RETRY_ATTEMPTS;
        this.retryBaseMs = options.retryBaseMs ?? DEFAULT_RETRY_BASE_MS;
        this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
        this.rateLimitWaitMs = options.rateLimitWaitMs ?? DEFAULT_RATE_LIMIT_WAIT_MS;
        this.sleep = options.sleep ?? defaultSleep;
        this.random = options.random ?? Math.random;
        this.now = options.now ?? Date.now;
    }

    /**
     * Один GraphQL-вызов. Ошибки GitHub приезжают в `errors[]` с кодом 200 — конверт разбирается
     * до схемы, иначе `data: null` выглядел бы расхождением схемы, а не отказом хоста.
     */
    async graphql<T>(
        query: string,
        variables: Record<string, unknown>,
        schema: z.ZodType<T>,
        attempts?: number,
    ): Promise<T> {
        const label = operationNameOf(query);
        const response = await this.perform(
            'POST',
            this.urlOf('/graphql', {}),
            {
                body: JSON.stringify({ query, variables }),
                headers: { 'content-type': 'application/json' },
            },
            label,
            Math.max(1, attempts ?? this.retryAttempts),
        );

        const parsed = this.parseJson(label, await this.readText(label, response));
        if (typeof parsed !== 'object' || parsed === null) {
            throw this.failure(label, 'ответ не является объектом');
        }
        const envelope = parsed as { data?: unknown; errors?: unknown };
        if (Array.isArray(envelope.errors) && envelope.errors.length > 0) {
            throw this.failure(label, `ошибка GitHub: ${describeApiErrors(envelope.errors)}`);
        }
        if (envelope.data === undefined || envelope.data === null) {
            throw this.failure(label, 'в ответе нет поля `data`');
        }

        this.rememberRateLimit(envelope.data);
        return this.validate(label, envelope.data, schema);
    }

    /** REST-вызов с разбором тела схемой. */
    async rest<T>(path: string, schema: z.ZodType<T>, options: RestOptions = {}): Promise<T> {
        const response = await this.perform('GET', this.urlOf(path, options.query ?? {}), initOf(options), path, this.attemptsOf(options));
        return this.validate(path, this.parseJson(path, await this.readText(path, response)), schema);
    }

    /**
     * REST-список со всеми страницами: пагинация у GitHub живёт в заголовке `Link`, а не в теле.
     * Страницы склеиваются в один массив — вызывающей стороне о них знать незачем.
     */
    async restList<T>(path: string, schema: z.ZodType<T[]>, options: RestOptions = {}): Promise<T[]> {
        const items: T[] = [];
        let url: string | null = this.urlOf(path, options.query ?? {});

        for (let page = 0; page < MAX_PAGES && url !== null; page += 1) {
            const response: Response = await this.perform('GET', url, initOf(options), path, this.attemptsOf(options));
            items.push(...this.validate(path, this.parseJson(path, await this.readText(path, response)), schema));
            url = nextPageUrl(response.headers.get('link'));
        }
        return items;
    }

    /** Сырые байты ручки; `null` — GitHub ответил 404 (такого пути на этой ревизии нет). */
    async restBytes(path: string, options: RestOptions = {}): Promise<Uint8Array | null> {
        const response = await this.perform(
            'GET',
            this.urlOf(path, options.query ?? {}),
            initOf(options),
            path,
            this.attemptsOf(options),
            (status) => status === 404,
        );
        if (response.status === 404) {
            return null;
        }

        try {
            return new Uint8Array(await response.arrayBuffer());
        } catch (error) {
            throw this.failure(path, `ответ не дочитался (${describeFetchError(error)})`);
        }
    }

    private attemptsOf(options: RestOptions): number {
        return Math.max(1, options.retryAttempts ?? this.retryAttempts);
    }

    /**
     * Запрос с ретраями и ожиданием окна лимита. `accepted` пропускает наружу статусы, которые
     * для вызывающей стороны не ошибка (404 у байтов файла).
     */
    private async perform(
        method: string,
        url: string,
        init: RequestInit,
        label: string,
        attempts: number,
        accepted: (status: number) => boolean = () => false,
    ): Promise<Response> {
        const token = await this.token();
        let lastError: RpcFailure | null = null;
        let attempt = 1;
        let rateLimitWaits = 0;

        while (attempt <= attempts) {
            await this.awaitRateLimitWindow(label);

            let response: Response;
            try {
                response = await this.fetchImpl(url, {
                    ...init,
                    method,
                    headers: {
                        accept: 'application/vnd.github+json',
                        'x-github-api-version': '2022-11-28',
                        ...(init.headers as Record<string, string> | undefined),
                        authorization: `Bearer ${token}`,
                    },
                    signal: AbortSignal.timeout(this.timeoutMs),
                });
            } catch (error) {
                lastError = this.failure(label, `сеть недоступна (${describeFetchError(error)})`);
                await this.backoff(attempt, attempts);
                attempt += 1;
                continue;
            }

            if (response.ok || accepted(response.status)) {
                return response;
            }
            // Исчерпанный лимит лечится ожиданием окна, а не экспонентой, и попытку не тратит:
            // такой ответ означает, что запрос не выполнялся, — повтор безопасен даже для записи.
            // Иначе мутация, которой положена ровно одна попытка, окна не дождалась бы вовсе.
            if (this.isRateLimited(response)) {
                lastError = this.failure(label, 'лимит запросов GitHub исчерпан');
                rateLimitWaits += 1;
                if (rateLimitWaits > MAX_RATE_LIMIT_WAITS) {
                    break;
                }
                continue;
            }
            const reason = `${String(response.status)} ${response.statusText}`.trim();
            if (!retriable(response.status)) {
                throw this.failure(label, reason);
            }
            lastError = this.failure(label, reason);
            await this.backoff(attempt, attempts);
            attempt += 1;
        }

        throw lastError ?? this.failure(label, 'запрос не выполнен');
    }

    /**
     * 403/429 с нулевым остатком лимита: запоминаем момент сброса из `x-ratelimit-reset`.
     * Ожидание случится перед следующей попыткой — там же, где и плановое.
     */
    private isRateLimited(response: Response): boolean {
        if (response.status !== 403 && response.status !== 429) {
            return false;
        }
        if ((response.headers.get('x-ratelimit-remaining') ?? '') !== '0') {
            return false;
        }
        const reset = Number(response.headers.get('x-ratelimit-reset') ?? '');
        if (Number.isFinite(reset) && reset > 0) {
            this.rateLimitResetAt = Math.max(this.rateLimitResetAt ?? 0, reset * 1000);
        }
        return true;
    }

    /** Остаток очков GraphQL ниже запаса — ждём сброса окна, не долбим API до нуля. */
    private rememberRateLimit(data: unknown): void {
        if (typeof data !== 'object' || data === null) {
            return;
        }
        const limit = (data as { rateLimit?: unknown }).rateLimit;
        if (typeof limit !== 'object' || limit === null) {
            return;
        }
        const { remaining, resetAt } = limit as { remaining?: unknown; resetAt?: unknown };
        if (typeof remaining !== 'number' || remaining >= RATE_LIMIT_RESERVE || typeof resetAt !== 'string') {
            return;
        }
        const reset = Date.parse(resetAt);
        if (!Number.isNaN(reset)) {
            this.rateLimitResetAt = reset;
        }
    }

    private async awaitRateLimitWindow(label: string): Promise<void> {
        const resetAt = this.rateLimitResetAt;
        if (resetAt === null) {
            return;
        }

        const wait = resetAt - this.now();
        if (wait <= 0) {
            this.rateLimitResetAt = null;
            return;
        }
        if (wait > this.rateLimitWaitMs) {
            this.rateLimitResetAt = null;
            throw this.failure(
                label,
                `лимит запросов исчерпан, окно сбросится через ${String(Math.ceil(wait / 1000))} с — дольше, чем разумно ждать`,
            );
        }
        await this.sleep(wait);
        this.rateLimitResetAt = null;
    }

    /** Экспоненциальная пауза с джиттером; после последней попытки не ждём. */
    private async backoff(attempt: number, attempts: number): Promise<void> {
        if (attempt >= attempts) {
            return;
        }
        const window = this.retryBaseMs * 2 ** (attempt - 1);
        await this.sleep(window + Math.floor(this.random() * window));
    }

    private async readText(label: string, response: Response): Promise<string> {
        try {
            return await response.text();
        } catch (error) {
            throw this.failure(label, `ответ не дочитался (${describeFetchError(error)})`);
        }
    }

    private parseJson(label: string, raw: string): unknown {
        try {
            return JSON.parse(raw);
        } catch {
            throw this.failure(label, 'ответ не является JSON');
        }
    }

    private validate<T>(label: string, payload: unknown, schema: z.ZodType<T>): T {
        const result = schema.safeParse(payload);
        if (!result.success) {
            throw this.failure(
                label,
                'ответ не сошёлся со схемой адаптера',
                result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
            );
        }
        return result.data;
    }

    private urlOf(path: string, query: Query): string {
        const url = new URL(`${this.baseUrl}${path}`);
        for (const [key, value] of Object.entries(query)) {
            if (value !== undefined) {
                url.searchParams.set(key, String(value));
            }
        }
        return url.toString();
    }

    private failure(label: string, reason: string, details?: readonly string[]): RpcFailure {
        return new RpcFailure('host_unavailable', `GitHub, ${label}: ${reason}.`, details);
    }
}

function initOf(options: RestOptions): RequestInit {
    return options.headers === undefined ? {} : { headers: { ...options.headers } };
}

/** Имя операции из текста запроса: оно же — метка ручки в текстах ошибок. */
function operationNameOf(query: string): string {
    return /\b(?:query|mutation)\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(query)?.[1] ?? 'graphql';
}

/** 5xx лечатся повтором, 4xx — нет (кроме исчерпанного лимита, у него своя ветка). */
function retriable(status: number): boolean {
    return status >= 500;
}

/** Следующая страница из заголовка `Link`; null — она последняя. */
function nextPageUrl(link: string | null): string | null {
    if (link === null) {
        return null;
    }
    for (const part of link.split(',')) {
        const found = /<([^>]+)>\s*;\s*rel="next"/.exec(part.trim());
        if (found?.[1] !== undefined) {
            return found[1];
        }
    }
    return null;
}

function describeApiErrors(errors: readonly unknown[]): string {
    const messages = errors.slice(0, 3).map((error) => {
        if (typeof error === 'object' && error !== null && 'message' in error) {
            return typeof error.message === 'string' ? error.message : JSON.stringify(error);
        }
        return JSON.stringify(error);
    });
    return messages.join('; ');
}

function defaultSleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
        const timer = setTimeout(resolve, ms);
        // Пауза между попытками не должна держать процесс живым.
        timer.unref();
    });
}

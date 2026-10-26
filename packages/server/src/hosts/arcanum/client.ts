import type { z } from 'zod';

import { RpcFailure, describeFetchError } from '../../errors.js';

import type { TokenSource } from './token.js';

/**
 * HTTP-клиент Арканума: обёртка `{data}`/`{errors}`, строгие `fields`-проекции на вызывающей
 * стороне и fail-closed валидация каждого ответа: неизвестные имена полей Арканум молча
 * выбрасывает, и вместо ошибки приезжает дырка.
 *
 * Транспорт инжектируется — тесты гоняют адаптер на записанных ответах без сети.
 * Токен живёт только в заголовке запроса: ни в логах, ни в текстах ошибок его нет
 * (`docs/architecture.md §6`).
 */

export const ARCANUM_API_BASE = 'https://arcanum.yandex.net/api';

/** Заголовок ответа с логином владельца токена — бесплатный whoami. */
const USER_HEADER = 'x-arcanum-user';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface ArcanumClientOptions {
    readonly token: TokenSource;
    readonly fetch?: FetchLike;
    readonly baseUrl?: string;
    /** Сколько раз всего пробуем запрос (429/5xx/сеть); `1` — без ретраев. */
    readonly retryAttempts?: number;
    readonly retryBaseMs?: number;
    readonly timeoutMs?: number;
    readonly sleep?: (ms: number) => Promise<void>;
    readonly random?: () => number;
}

export type Query = Record<string, string | number | undefined>;

/** Пер-вызовные отступления от настроек клиента. */
export interface RequestOptions {
    /**
     * Потолок попыток именно для этого вызова, не меньше одной. Нужен ручкам, у которых 5xx
     * не разовый, а ответ на кривой параметр.
     */
    readonly retryAttempts?: number;
    /** Дополнительные заголовки запроса: `Idempotency-Key` на создании комментария. */
    readonly headers?: Readonly<Record<string, string>>;
    /**
     * `optional` — полезное тело принимается и без обёртки `{data}`, тогда оно лежит в корне
     * ответа. Нужен ручкам, чья форма живьём не зафиксирована (`publishDrafts`), и тем, кто
     * конверта не шлёт вовсе (`repos/preview/a-yaml`); конверт `{errors}` проверяется в обоих случаях.
     */
    readonly envelope?: 'required' | 'optional';
}

const DEFAULT_RETRY_ATTEMPTS = 3;
const DEFAULT_RETRY_BASE_MS = 300;
const DEFAULT_TIMEOUT_MS = 30_000;

export class ArcanumClient {
    private readonly token: TokenSource;
    private readonly fetchImpl: FetchLike;
    private readonly baseUrl: string;
    private readonly retryAttempts: number;
    private readonly retryBaseMs: number;
    private readonly timeoutMs: number;
    private readonly sleep: (ms: number) => Promise<void>;
    private readonly random: () => number;

    /** Логин владельца токена из последнего ответа; null — ни один ответ ещё не пришёл. */
    private user: string | null = null;

    constructor(options: ArcanumClientOptions) {
        this.token = options.token;
        this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
        this.baseUrl = (options.baseUrl ?? ARCANUM_API_BASE).replace(/\/+$/, '');
        this.retryAttempts = options.retryAttempts ?? DEFAULT_RETRY_ATTEMPTS;
        this.retryBaseMs = options.retryBaseMs ?? DEFAULT_RETRY_BASE_MS;
        this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
        this.sleep = options.sleep ?? defaultSleep;
        this.random = options.random ?? Math.random;
    }

    /** Логин владельца токена (`X-Arcanum-User`); null — пока ни одного ответа не было. */
    currentUser(): string | null {
        return this.user;
    }

    async getJson<T>(
        path: string,
        query: Query,
        schema: z.ZodType<T>,
        options: RequestOptions = {},
    ): Promise<T> {
        const response = await this.request(path, query, { method: 'GET' }, options);
        return this.unwrap(path, await this.readText(path, response), schema, options);
    }

    async postJson<T>(
        path: string,
        body: unknown,
        schema: z.ZodType<T>,
        query: Query = {},
        options: RequestOptions = {},
    ): Promise<T> {
        const response = await this.request(path, query, jsonInit('POST', body), options);
        return this.unwrap(path, await this.readText(path, response), schema, options);
    }

    async patchJson<T>(
        path: string,
        body: unknown,
        schema: z.ZodType<T>,
        query: Query = {},
        options: RequestOptions = {},
    ): Promise<T> {
        const response = await this.request(path, query, jsonInit('PATCH', body), options);
        return this.unwrap(path, await this.readText(path, response), schema, options);
    }

    /**
     * Ручки записи, у которых полезного тела нет: 204 у `ship` и `reviewed-files`, `{}` у удаления
     * черновика, `{"data": "<статус>"}` у `request-for-changes`. Важен только факт успеха, но
     * конверт `{errors}` с кодом 200 наружу всё равно не пропускаем.
     */
    async sendVoid(
        method: 'POST' | 'PUT' | 'DELETE',
        path: string,
        body?: unknown,
        query: Query = {},
        options: RequestOptions = {},
    ): Promise<void> {
        const init = body === undefined ? { method } : jsonInit(method, body);
        const response = await this.request(path, query, init, options);
        const raw = (await this.readText(path, response)).trim();
        if (raw === '') {
            return;
        }

        let parsed: unknown;
        try {
            parsed = JSON.parse(raw);
        } catch {
            // Тело нам не нужно, а не-JSON у этих ручек — не ошибка сама по себе.
            return;
        }
        if (typeof parsed === 'object' && parsed !== null) {
            const errors = (parsed as { errors?: unknown }).errors;
            if (Array.isArray(errors) && errors.length > 0) {
                throw this.failure(path, `ошибка Арканума: ${describeApiErrors(errors)}`);
            }
        }
    }

    private async request(
        path: string,
        query: Query,
        init: RequestInit,
        options: RequestOptions = {},
    ): Promise<Response> {
        const url = this.urlOf(path, query);
        const token = await this.token();
        const attempts = Math.max(1, options.retryAttempts ?? this.retryAttempts);
        let lastError: RpcFailure | null = null;

        for (let attempt = 1; attempt <= attempts; attempt += 1) {
            let response: Response;
            try {
                response = await this.fetchImpl(url, {
                    ...init,
                    headers: {
                        accept: 'application/json',
                        ...(init.headers as Record<string, string> | undefined),
                        ...options.headers,
                        authorization: `OAuth ${token}`,
                    },
                    signal: AbortSignal.timeout(this.timeoutMs),
                });
            } catch (error) {
                lastError = this.failure(path, `сеть недоступна (${describeFetchError(error)})`);
                await this.backoff(attempt, attempts);
                continue;
            }

            this.rememberUser(response);
            if (response.ok) {
                return response;
            }
            if (!retriable(response.status)) {
                throw this.failure(path, `${String(response.status)} ${response.statusText}`.trim());
            }
            lastError = this.failure(path, `${String(response.status)} ${response.statusText}`.trim());
            await this.backoff(attempt, attempts);
        }

        throw lastError ?? this.failure(path, 'запрос не выполнен');
    }

    /** Экспоненциальная пауза с джиттером; после последней попытки не ждём. */
    private async backoff(attempt: number, attempts: number): Promise<void> {
        if (attempt >= attempts) {
            return;
        }
        const window = this.retryBaseMs * 2 ** (attempt - 1);
        await this.sleep(window + Math.floor(this.random() * window));
    }

    private rememberUser(response: Response): void {
        const login = response.headers.get(USER_HEADER);
        if (login !== null && login.trim() !== '') {
            this.user = login.trim();
        }
    }

    private async readText(path: string, response: Response): Promise<string> {
        try {
            return await response.text();
        } catch (error) {
            throw this.failure(path, `ответ не дочитался (${describeFetchError(error)})`);
        }
    }

    /** Разбирает обёртку `{data}`/`{errors}` и проверяет полезное тело схемой — fail-closed. */
    private unwrap<T>(path: string, raw: string, schema: z.ZodType<T>, options: RequestOptions): T {
        let parsed: unknown;
        try {
            parsed = JSON.parse(raw);
        } catch {
            throw this.failure(path, 'ответ не является JSON');
        }

        if (typeof parsed !== 'object' || parsed === null) {
            throw this.failure(path, 'ответ не является объектом');
        }
        const envelope = parsed as { data?: unknown; errors?: unknown };
        if (Array.isArray(envelope.errors) && envelope.errors.length > 0) {
            throw this.failure(path, `ошибка Арканума: ${describeApiErrors(envelope.errors)}`);
        }
        let payload: unknown;
        if ('data' in envelope) {
            payload = envelope.data;
        } else if (options.envelope === 'optional') {
            payload = parsed;
        } else {
            throw this.failure(path, 'в ответе нет поля `data`');
        }

        const result = schema.safeParse(payload);
        if (!result.success) {
            // Проекция `fields` могла молча выбросить поле — дырку наружу не пускаем.
            throw this.failure(
                path,
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

    private failure(path: string, reason: string, details?: readonly string[]): RpcFailure {
        return new RpcFailure('host_unavailable', `Арканум, ${path}: ${reason}.`, details);
    }
}

function jsonInit(method: string, body: unknown): RequestInit {
    return { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
}

/** 429 и 5xx лечатся повтором, остальные 4xx — нет (`docs/research/arcanum-api.md` §Лимиты). */
function retriable(status: number): boolean {
    return status === 429 || status >= 500;
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
        // Пауза между ретраями не должна держать процесс живым.
        timer.unref();
    });
}

import type { ReviewSource } from '@sherpa/protocol';
import type { z } from 'zod';
import { RpcFailure } from './errors.js';
import type { JsonResponse, RequestContext } from './http.js';
import { readJsonBody } from './http.js';

export function optionalParam(ctx: RequestContext, name: string): Record<string, string> {
    const value = ctx.url.searchParams.get(name);
    return value === null ? {} : { [name]: value };
}

export function parseQuery<T>(schema: z.ZodType<T>, query: unknown, what: string): T {
    const parsed = schema.safeParse(query);
    if (!parsed.success) {
        throw new RpcFailure(
            'bad_request',
            `Параметры запроса ${what} не прошли валидацию контракта.`,
            parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
        );
    }
    return parsed.data;
}

export async function readRequest<T>(ctx: RequestContext, schema: z.ZodType<T>, what: string): Promise<T> {
    const parsed = schema.safeParse(await readJsonBody(ctx.req));
    if (!parsed.success) {
        throw new RpcFailure(
            'bad_request',
            `Запрос ${what} не прошёл валидацию контракта.`,
            parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
        );
    }
    return parsed.data;
}

export function hostOf<T extends ReviewSource>(options: { host: T | null }): T {
    if (options.host === null) {
        throw new RpcFailure(
            'no_review_host',
            'У этого ревью нет хост-адаптера: ключ не опознан как арканумный, локальный или фикстурный.',
        );
    }
    return options.host;
}

export async function call<T>(operation: () => Promise<T>): Promise<T> {
    try {
        return await operation();
    } catch (error) {
        if (error instanceof RpcFailure) {
            throw error;
        }
        throw new RpcFailure('host_unavailable', `Хост-адаптер не смог: ${messageOf(error)}`);
    }
}

export function respond<T>(schema: z.ZodType<T>, body: unknown, source: 'host' | 'local' = 'host'): JsonResponse {
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
        throw new RpcFailure(
            source === 'host' ? 'host_unavailable' : 'internal',
            source === 'host'
                ? 'Ответ хоста не сошёлся с контрактом ревью.'
                : 'Ответ сервера не сошёлся с контрактом ревью.',
            parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
        );
    }
    return { status: 200, body: parsed.data };
}

export function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}


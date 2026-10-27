import type {
    UiChatAskResponse,
    UiChatCancelResponse,
    UiChatRetryResponse,
} from '@sherpa/protocol';
import {
    UI_ENDPOINTS,
    uiChatAskRequestSchema,
    uiChatAskResponseSchema,
    uiChatCancelRequestSchema,
    uiChatCancelResponseSchema,
    uiChatResponseSchema,
    uiChatRetryRequestSchema,
    uiChatRetryResponseSchema,
} from '@sherpa/protocol';
import type { z } from 'zod';

import type { ChatOrchestrator } from './chat-orchestrator.js';
import type { ChatStore } from './chat-store.js';
import { RpcFailure } from './errors.js';
import type { RequestContext, Route } from './http.js';
import { handlingRpcFailures, readJsonBody } from './http.js';
import { respond } from './host-http.js';

export interface ChatRoutesOptions {
    readonly store: ChatStore;
    readonly orchestrator: ChatOrchestrator;
}

/** История объяснения и управление явно заданными вопросами. */
export function createChatRoutes(options: ChatRoutesOptions): Route[] {
    return [
        {
            method: 'GET',
            path: UI_ENDPOINTS.reviewChat,
            handle: handlingRpcFailures(() => respond(uiChatResponseSchema, { ...options.store.read(), notes: [] }, 'local')),
        },
        {
            method: 'POST',
            path: UI_ENDPOINTS.reviewChatAsk,
            handle: handlingRpcFailures(async (ctx) => {
                const request = await readChatRequest(ctx, uiChatAskRequestSchema);
                const body: UiChatAskResponse = {
                    exchange: await options.orchestrator.ask(
                        request.text,
                        request.anchor ?? null,
                        request.locale,
                        request.explanation,
                    ),
                };
                return respond(uiChatAskResponseSchema, body, 'local');
            }),
        },
        {
            method: 'POST',
            path: UI_ENDPOINTS.reviewChatCancel,
            handle: handlingRpcFailures(async (ctx) => {
                const request = await readChatRequest(ctx, uiChatCancelRequestSchema);
                const body: UiChatCancelResponse = { outcome: options.orchestrator.cancel(request.exchangeId) };
                return respond(uiChatCancelResponseSchema, body, 'local');
            }),
        },
        {
            method: 'POST',
            path: UI_ENDPOINTS.reviewChatRetry,
            handle: handlingRpcFailures(async (ctx) => {
                const request = await readChatRequest(ctx, uiChatRetryRequestSchema);
                const body: UiChatRetryResponse = { outcome: await options.orchestrator.retry(request.exchangeId) };
                return respond(uiChatRetryResponseSchema, body, 'local');
            }),
        },
    ];
}

async function readChatRequest<T>(ctx: RequestContext, schema: z.ZodType<T>): Promise<T> {
    const parsed = schema.safeParse(await readJsonBody(ctx.req));
    if (!parsed.success) {
        throw new RpcFailure(
            'bad_request',
            'Запрос чата не прошёл валидацию контракта.',
            parsed.error.issues.map((issue) => {
                const path = issue.path.join('.');
                return path === '' ? issue.message : `${path}: ${issue.message}`;
            }),
        );
    }
    return parsed.data;
}

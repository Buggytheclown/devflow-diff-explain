import { UI_ENDPOINTS, uiPrStatePatchSchema, uiPrStateResponseSchema } from '@sherpa/protocol';

import type { Route } from './http.js';
import { handlingRpcFailures } from './http.js';
import type { PrStateStore } from './pr-state-store.js';
import { readRequest, respond } from './review-routes.js';

export interface PrStateRoutesOptions {
    readonly prState: PrStateStore;
}

/**
 * Ручки состояния UI этого PR. Ревью-хост им не нужен: свёртки и история палитры —
 * локальные данные вкладки. SSE нет, как и у настроек: вторая вкладка того же PR сойдётся,
 * когда перечитает ручку, а до тех пор побеждает последняя запись.
 */
export function createPrStateRoutes(options: PrStateRoutesOptions): Route[] {
    return [
        {
            method: 'GET',
            path: UI_ENDPOINTS.prState,
            handle: handlingRpcFailures(() =>
                respond(uiPrStateResponseSchema, { prState: options.prState.read() }, 'local'),
            ),
        },
        {
            method: 'PATCH',
            path: UI_ENDPOINTS.prState,
            handle: handlingRpcFailures(async (ctx) => {
                const patch = await readRequest(ctx, uiPrStatePatchSchema, 'смены состояния UI');
                const prState = options.prState.patch(patch);
                return respond(uiPrStateResponseSchema, { prState }, 'local');
            }),
        },
    ];
}

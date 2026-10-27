import type { Iteration } from '@sherpa/protocol';
import { UI_DEV_ENDPOINTS, uiReviewWriteAckSchema } from '@sherpa/protocol';

import { RpcFailure } from './errors.js';
import { respond } from './host-http.js';
import type { Route } from './http.js';
import { handlingRpcFailures } from './http.js';

/** Только фикстурный push: реальные PR этот маршрут не регистрируют. */
export interface DevRoutesOptions {
    readonly advanceIteration: () => Iteration;
}

export function createDevRoutes(options: DevRoutesOptions): Route[] {
    return [{
        method: 'POST',
        path: UI_DEV_ENDPOINTS.fixtureAdvanceIteration,
        handle: handlingRpcFailures(() => {
            try {
                options.advanceIteration();
            } catch (error) {
                throw new RpcFailure('bad_request', error instanceof Error ? error.message : String(error));
            }
            return respond(uiReviewWriteAckSchema, { acknowledged: true }, 'local');
        }),
    }];
}

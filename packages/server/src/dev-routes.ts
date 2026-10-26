import type { Iteration } from '@sherpa/protocol';
import {
    UI_DEV_ENDPOINTS,
    uiDevFixtureFailDraftWritesRequestSchema,
    uiDevUpdateAvailableRequestSchema,
    uiReviewWriteAckSchema,
    uiUpdateCheckResponseSchema,
} from '@sherpa/protocol';

import { RpcFailure } from './errors.js';
import type { Route } from './http.js';
import { handlingRpcFailures } from './http.js';
import { readRequest, respond } from './review-routes.js';
import type { UpdateChecker } from './update-check.js';

/**
 * Дев-ручки сервера (`UI_DEV_ENDPOINTS`): механика, которой у настоящего хоста нет и быть не
 * может, — «пуш» в фикстурный PR. Без неё второй заход нечем показать ни глазами, ни в e2e.
 *
 * Регистрируются только когда выбран фикстурный хост (`hosts/select.ts` отдаёт `advanceIteration`);
 * у арканумного prKey этих маршрутов не существует вовсе, а не «существует и отказывает».
 * Аутентификация — тот же bearer-токен, что у UI-ручек: отдельного режима у дев-ручек нет.
 */

export interface DevRoutesOptions {
    /** Фикстурный «пуш»: следующая объявленная итерация становится активной. */
    readonly advanceIteration: () => Iteration;
    /** Фикстурный отказ записи черновиков: им e2e проверяет буфер. */
    readonly setFailDraftWrites?: (fail: boolean) => void;
    /** Проверка версии этого сервера: на фикстуре её результат подставляет дев-ручка. */
    readonly update: UpdateChecker;
}

export function createDevRoutes(options: DevRoutesOptions): Route[] {
    return [
        {
            method: 'POST',
            path: UI_DEV_ENDPOINTS.fixtureAdvanceIteration,
            handle: handlingRpcFailures(() => {
                try {
                    options.advanceIteration();
                } catch (error) {
                    // «Итераций больше нет» — не поломка сервера, а исчерпанная фикстура.
                    throw new RpcFailure('bad_request', error instanceof Error ? error.message : String(error));
                }
                return respond(uiReviewWriteAckSchema, { acknowledged: true }, 'local');
            }),
        },
        ...(options.setFailDraftWrites === undefined
            ? []
            : [
                  {
                      method: 'POST' as const,
                      path: UI_DEV_ENDPOINTS.fixtureFailDraftWrites,
                      handle: handlingRpcFailures(async (ctx) => {
                          const request = await readRequest(
                              ctx,
                              uiDevFixtureFailDraftWritesRequestSchema,
                              'дев-отказа записи черновиков',
                          );
                          options.setFailDraftWrites?.(request.fail);
                          return respond(uiReviewWriteAckSchema, { acknowledged: true }, 'local');
                      }),
                  },
              ]),
        {
            method: 'POST',
            path: UI_DEV_ENDPOINTS.updateAvailable,
            handle: handlingRpcFailures(async (ctx) => {
                const request = await readRequest(ctx, uiDevUpdateAvailableRequestSchema, 'новой версии');
                // Кэш на диске не трогается: подставленная версия не должна пережить перезапуск.
                const update = options.update.setLatest({
                    version: request.version,
                    builtFrom: null,
                    releasedAt: request.releasedAt,
                    whatsNew: request.whatsNew,
                });
                return respond(uiUpdateCheckResponseSchema, { update }, 'local');
            }),
        },
    ];
}

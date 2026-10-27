import { UI_ENDPOINTS, uiSettingsPatchSchema, uiSettingsResponseSchema } from '@sherpa/protocol';

import type { Route } from './http.js';
import { handlingRpcFailures } from './http.js';
import { readRequest, respond } from './host-http.js';
import type { SettingsStore } from './settings-store.js';

export interface SettingsRoutesOptions {
    readonly settings: SettingsStore;
    /** Подписчик изменений общих настроек. */
    readonly onChange?: () => void;
}

/**
 * Ручки глобальных настроек UI. Ревью-хост им не нужен: настройки локальные и общие
 * для всех PR. PATCH возвращает результат слияния целиком — вторая вкладка сойдётся с первой,
 * когда перечитает ручку.
 */
export function createSettingsRoutes(options: SettingsRoutesOptions): Route[] {
    return [
        {
            method: 'GET',
            path: UI_ENDPOINTS.settings,
            handle: handlingRpcFailures(() =>
                respond(uiSettingsResponseSchema, { settings: options.settings.read() }, 'local'),
            ),
        },
        {
            method: 'PATCH',
            path: UI_ENDPOINTS.settings,
            handle: handlingRpcFailures(async (ctx) => {
                const patch = await readRequest(ctx, uiSettingsPatchSchema, 'смены настроек');
                const settings = options.settings.patch(patch);
                options.onChange?.();
                return respond(uiSettingsResponseSchema, { settings }, 'local');
            }),
        },
    ];
}

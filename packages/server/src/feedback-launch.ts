import type { FeedbackIntegrationOptions } from './feedback-routes.js';
import { locateYa } from './tracker-token.js';

/**
 * Опции канала фидбека для точек входа сервера: `ya` ищется в PATH, от cwd процесса и от каталога
 * дистрибутива — при установке из чекаута он лежит внутри Аркадии. `startServer` сам `ya` не ищет,
 * чтобы тесты не запускали настоящий `ya tool fetch-token`.
 */
export function feedbackOptionsFor(installDir: string | null): FeedbackIntegrationOptions {
    return { ya: locateYa({ startDirs: installDir === null ? [process.cwd()] : [process.cwd(), installDir] }) };
}

declare const __SHERPA_VERSION__: string | undefined;

/**
 * Версия сервера — попадает в манифест discovery и в ответ `/healthz`. Подставляется esbuild'ом
 * при сборке сервер-бандла из корневого `package.json` (тот же приём, что у CLI и UI).
 * Вне сборки (тесты, `tsx src/dev.ts`) — нулевая: контракт принимает только `X.Y.Z`,
 * и суффикс вроде `-dev` отбился бы `semverSchema` протокола.
 */
export const SERVER_VERSION = typeof __SHERPA_VERSION__ === 'string' ? __SHERPA_VERSION__ : '0.0.0';

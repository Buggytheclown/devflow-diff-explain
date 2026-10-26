declare const __SHERPA_VERSION__: string | undefined;

/**
 * Версия CLI: подставляется esbuild'ом при сборке. Вне сборки (тесты, tsx) — нулевая:
 * контракт принимает только `X.Y.Z`, и суффикс вроде `-dev` отбился бы валидацией запроса.
 */
export const CLI_VERSION = typeof __SHERPA_VERSION__ === 'string' ? __SHERPA_VERSION__ : '0.0.0';

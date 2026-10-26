declare const __SHERPA_VERSION__: string | undefined;

/**
 * Версия поставки в верхней панели: подставляется vite при сборке из корневого `package.json`
 * (тот же приём, что у CLI и сервера). Вне сборки — нулевая.
 */
export const UI_VERSION = typeof __SHERPA_VERSION__ === 'string' ? __SHERPA_VERSION__ : '0.0.0';

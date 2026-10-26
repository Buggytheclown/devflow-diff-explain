/**
 * Адрес слушающего сокета из `SHERPA_LISTEN_HOST` и имя машины для ссылки UI.
 * По умолчанию сервер виден только с самой машины; внешний слушатель открывают через окружение
 * точки входа (docs/protocol.md §8).
 */

/** Локальный loopback остаётся безопасным значением, когда адрес сервера не настроен. */
export const DEFAULT_LISTEN_HOST = '127.0.0.1';

/** Адрес слушающего сокета из окружения точки входа; пробелы считаются отсутствующей настройкой. */
export function readListenHost(env: NodeJS.ProcessEnv): string {
    const host = env.SHERPA_LISTEN_HOST?.trim();
    return host === undefined || host === '' ? DEFAULT_LISTEN_HOST : host;
}

/** Внешний слушатель получает имя машины в UI-ссылке, loopback остаётся точным. */
export function uiHostForListenHost(listenHost: string, machineHost: string): string {
    return ['127.0.0.1', '::1', 'localhost'].includes(listenHost) ? listenHost : machineHost;
}

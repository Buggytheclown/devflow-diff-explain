import { activeT } from '../i18n/index.js';
import type { DiffFileModel, DiffParseRequest } from './model.js';

/**
 * Клиентская обёртка над дифф-воркером: запрос «распарси файл» → модель.
 *
 * Воркер один, не пул: пул по `hardwareConcurrency` — оптимизация, которую заводим,
 * когда перф-прогон покажет в ней нужду. Транспорт абстрагирован (как `connect` в `store.ts`):
 * в браузере это `postMessage`, в тестах — прямой вызов парсера.
 */

export interface DiffParseMessage {
    /** Номер запроса: ответы воркера приходят в произвольном порядке. */
    id: number;
    file: DiffParseRequest;
}

export type DiffParseReply =
    | { id: number; ok: true; model: DiffFileModel }
    | { id: number; ok: false; error: string };

export interface DiffWorkerHandlers {
    readonly onMessage: (reply: DiffParseReply) => void;
    /** Воркер отвалился целиком: не загрузился, упал, не смог склонировать ответ. */
    readonly onError: (error: Error) => void;
}

export interface DiffWorkerConnection {
    readonly post: (message: DiffParseMessage) => void;
    readonly close: () => void;
}

export interface DiffClientOptions {
    /** Подключение к воркеру; в тестах подменяется, в браузере — `Worker`. */
    readonly connect?: (handlers: DiffWorkerHandlers) => DiffWorkerConnection;
}

export interface DiffClient {
    /**
     * Модель файла из кэша или от воркера. Кэш держится по паре `diffId` + `fileId`:
     * итерация PR неизменна, значит и её дифф разбирается один раз.
     */
    readonly parseFile: (diffId: string, file: DiffParseRequest) => Promise<DiffFileModel>;
    readonly close: () => void;
}

/** Имя замера круга «запрос в воркер → ответ»: по нему перф-спека собирает статистику парсинга. */
const PARSE_MEASURE = 'devflow-diff-explain:diff-parse';

/**
 * Замер одного разбора. `performance.measure` есть не везде (jsdom-тесты, старые окружения),
 * поэтому инструментирование целиком необязательное: без него клиент работает как раньше.
 * Попадания в кэш не меряются — они не доходят до воркера.
 */
function measureParse(file: DiffParseRequest, startMark: string): void {
    if (typeof performance === 'undefined' || typeof performance.measure !== 'function') {
        return;
    }
    try {
        performance.measure(PARSE_MEASURE, {
            start: startMark,
            detail: { fileId: file.fileId, lines: file.patch === null ? 0 : file.patch.split('\n').length },
        });
    } catch {
        // Метка могла не пережить очистку буфера — замер не повод ронять разбор.
    }
    performance.clearMarks(startMark);
}

export function createDiffClient(options: DiffClientOptions = {}): DiffClient {
    const connect = options.connect ?? connectWorker;
    const cache = new Map<string, Promise<DiffFileModel>>();
    const pending = new Map<number, { resolve: (model: DiffFileModel) => void; reject: (error: Error) => void }>();

    let connection: DiffWorkerConnection | null = null;
    let closed = false;
    let nextId = 1;

    const handlers: DiffWorkerHandlers = {
        onMessage: (reply) => {
            const waiter = pending.get(reply.id);
            if (waiter === undefined) {
                return;
            }
            pending.delete(reply.id);
            if (reply.ok) {
                waiter.resolve(reply.model);
            } else {
                waiter.reject(new Error(reply.error));
            }
        },
        onError: (error) => {
            // Ответов от этого воркера уже не будет: отпускаем висящие запросы и роняем
            // подключение — следующий parseFile поднимет воркер заново.
            for (const waiter of pending.values()) {
                waiter.reject(error);
            }
            pending.clear();
            connection?.close();
            connection = null;
        },
    };

    return {
        parseFile: (diffId, file) => {
            if (closed) {
                return Promise.reject(new Error(activeT()('diff.worker.closed')));
            }

            // Разделитель — нулевой символ, а не пробел: id хоста непрозрачны, и на пробеле
            // пары ('a b', 'c') и ('a', 'b c') дали бы один ключ.
            const key = `${diffId}\u0000${file.fileId}`;
            const cached = cache.get(key);
            if (cached !== undefined) {
                return cached;
            }

            connection ??= connect(handlers);
            const id = nextId;
            nextId += 1;

            const startMark = `${PARSE_MEASURE}:${String(id)}`;
            if (typeof performance !== 'undefined' && typeof performance.measure === 'function') {
                performance.mark(startMark);
            }

            const request = new Promise<DiffFileModel>((resolve, reject) => {
                pending.set(id, { resolve, reject });
                connection?.post({ id, file });
            })
                .finally(() => {
                    measureParse(file, startMark);
                })
                .catch((error: unknown) => {
                    // Провал не кэшируем: следующий запрос того же файла должен дойти до воркера.
                    cache.delete(key);
                    throw error instanceof Error ? error : new Error(String(error));
                });

            cache.set(key, request);
            return request;
        },
        close: () => {
            closed = true;
            for (const waiter of pending.values()) {
                waiter.reject(new Error(activeT()('diff.worker.closed')));
            }
            pending.clear();
            cache.clear();
            connection?.close();
            connection = null;
        },
    };
}

/** Настоящий воркер: путь резолвит сборщик, поэтому URL написан литералом. */
function connectWorker(handlers: DiffWorkerHandlers): DiffWorkerConnection {
    const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
    worker.addEventListener('message', (event: MessageEvent<DiffParseReply>) => {
        handlers.onMessage(event.data);
    });
    // Воркер может не загрузиться или упасть между post и ответом — это событие, а не исключение.
    worker.addEventListener('error', (event: ErrorEvent) => {
        handlers.onError(new Error(event.message.length > 0 ? event.message : activeT()('diff.worker.crashed')));
    });
    worker.addEventListener('messageerror', () => {
        handlers.onError(new Error(activeT()('diff.worker.cloneFailed')));
    });

    return {
        post: (message) => {
            worker.postMessage(message);
        },
        close: () => {
            worker.terminate();
        },
    };
}

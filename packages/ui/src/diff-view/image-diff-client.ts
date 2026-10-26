import { activeT } from '../i18n/index.js';
import type { DiffPixelsOptions, ImageDiffResult, PixelSurface } from './image-diff.js';

/**
 * Клиентская обёртка над воркером попиксельной разницы. Устроена как `diff/client.ts`:
 * транспорт инжектируется (в браузере `postMessage`, в тестах — прямой вызов `diffPixels`),
 * буферы растров ездят transfer-ом, а не копией.
 *
 * Воркер один на вкладку и ленивый: пока ревьюер не выбрал режим Diff, его не существует.
 */

export interface ImageDiffMessage {
    /** Номер запроса: ответы приходят в произвольном порядке, а карточек на экране много. */
    id: number;
    before: PixelSurface;
    after: PixelSurface;
    options: DiffPixelsOptions;
}

export type ImageDiffReply =
    | { id: number; ok: true; result: ImageDiffResult }
    | { id: number; ok: false; error: string };

export interface ImageDiffHandlers {
    readonly onMessage: (reply: ImageDiffReply) => void;
    /** Воркер отвалился целиком: не загрузился, упал, не смог склонировать ответ. */
    readonly onError: (error: Error) => void;
}

export interface ImageDiffConnection {
    readonly post: (message: ImageDiffMessage, transfer: readonly ArrayBuffer[]) => void;
    readonly close: () => void;
}

export interface ImageDiffClientOptions {
    readonly connect?: (handlers: ImageDiffHandlers) => ImageDiffConnection;
}

export interface ImageDiffClient {
    /** Растры уезжают в воркер transfer-ом: после вызова их буферы у вызывающего пусты. */
    readonly compute: (
        before: PixelSurface,
        after: PixelSurface,
        options: DiffPixelsOptions,
    ) => Promise<ImageDiffResult>;
    readonly close: () => void;
}

export function createImageDiffClient(options: ImageDiffClientOptions = {}): ImageDiffClient {
    const connect = options.connect ?? connectWorker;
    const pending = new Map<number, { resolve: (result: ImageDiffResult) => void; reject: (error: Error) => void }>();

    let connection: ImageDiffConnection | null = null;
    let closed = false;
    let nextId = 1;

    const handlers: ImageDiffHandlers = {
        onMessage: (reply) => {
            const waiter = pending.get(reply.id);
            if (waiter === undefined) {
                return;
            }
            pending.delete(reply.id);
            if (reply.ok) {
                waiter.resolve(reply.result);
            } else {
                waiter.reject(new Error(reply.error));
            }
        },
        onError: (error) => {
            // Ответов от этого воркера уже не будет: отпускаем висящие запросы и роняем
            // подключение — следующий счёт поднимет воркер заново.
            for (const waiter of pending.values()) {
                waiter.reject(error);
            }
            pending.clear();
            connection?.close();
            connection = null;
        },
    };

    return {
        compute: (before, after, diffOptions) => {
            if (closed) {
                return Promise.reject(new Error(activeT()('diff.worker.closed')));
            }

            connection ??= connect(handlers);
            const id = nextId;
            nextId += 1;

            return new Promise<ImageDiffResult>((resolve, reject) => {
                pending.set(id, { resolve, reject });
                connection?.post({ id, before, after, options: diffOptions }, [
                    before.data.buffer as ArrayBuffer,
                    after.data.buffer as ArrayBuffer,
                ]);
            });
        },
        close: () => {
            closed = true;
            for (const waiter of pending.values()) {
                waiter.reject(new Error(activeT()('diff.worker.closed')));
            }
            pending.clear();
            connection?.close();
            connection = null;
        },
    };
}

let shared: ImageDiffClient | null = null;

/** Клиент на вкладку: воркер поднимается при первом запросе, то есть при первом выборе Diff. */
export function sharedImageDiffClient(): ImageDiffClient {
    shared ??= createImageDiffClient();
    return shared;
}

/** Настоящий воркер: путь резолвит сборщик, поэтому URL написан литералом. */
function connectWorker(handlers: ImageDiffHandlers): ImageDiffConnection {
    const worker = new Worker(new URL('./image-diff.worker.ts', import.meta.url), { type: 'module' });
    worker.addEventListener('message', (event: MessageEvent<ImageDiffReply>) => {
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
        post: (message, transfer) => {
            worker.postMessage(message, [...transfer]);
        },
        close: () => {
            worker.terminate();
        },
    };
}

import type { ImageDiffMessage, ImageDiffReply } from './image-diff-client.js';
import { diffPixels } from './image-diff.js';

/**
 * Входная точка воркера попиксельной разницы: проход по нескольким миллионам пикселей
 * не должен держать главный поток. Здесь только транспорт — вся логика в `image-diff.ts`.
 */

/** Типы `DedicatedWorkerGlobalScope` живут в lib `webworker`, а бандл UI собирается с lib `dom`. */
interface WorkerScope {
    addEventListener: (type: 'message', listener: (event: MessageEvent<ImageDiffMessage>) => void) => void;
    postMessage: (message: ImageDiffReply, transfer?: readonly ArrayBuffer[]) => void;
}

const scope = globalThis as unknown as WorkerScope;

scope.addEventListener('message', (event) => {
    const { id, before, after, options } = event.data;
    try {
        const result = diffPixels(before, after, options);
        scope.postMessage({ id, ok: true, result }, [result.data.buffer as ArrayBuffer]);
    } catch (error) {
        // Считалка не бросает по построению; если она всё же упала, воркер обязан ответить,
        // иначе запрос в клиенте зависнет навсегда.
        scope.postMessage({ id, ok: false, error: error instanceof Error ? error.message : String(error) });
    }
});

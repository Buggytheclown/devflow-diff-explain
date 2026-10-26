import type { DiffParseMessage, DiffParseReply } from './client.js';
import { parseFileDiff } from './parse.js';

/**
 * Входная точка дифф-воркера: разбор патчей уезжает с главного потока (docs/architecture.md §1).
 * Здесь только транспорт — вся логика в `parse.ts`, чтобы её можно было тестировать без воркера.
 */

/** Типы `DedicatedWorkerGlobalScope` живут в lib `webworker`, а бандл UI собирается с lib `dom`. */
interface WorkerScope {
    addEventListener: (type: 'message', listener: (event: MessageEvent<DiffParseMessage>) => void) => void;
    postMessage: (message: DiffParseReply) => void;
}

const scope = globalThis as unknown as WorkerScope;

scope.addEventListener('message', (event) => {
    const { id, file } = event.data;
    try {
        scope.postMessage({ id, ok: true, model: parseFileDiff(file) });
    } catch (error) {
        // Парсер не бросает по построению; если он всё же упал, воркер обязан ответить,
        // иначе запрос в клиенте зависнет навсегда.
        scope.postMessage({ id, ok: false, error: error instanceof Error ? error.message : String(error) });
    }
});

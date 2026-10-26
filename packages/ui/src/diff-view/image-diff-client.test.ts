import { describe, expect, it } from 'vitest';

import type { ImageDiffConnection, ImageDiffHandlers, ImageDiffMessage } from './image-diff-client.js';
import { createImageDiffClient } from './image-diff-client.js';
import type { PixelSurface } from './image-diff.js';
import { diffPixels } from './image-diff.js';

/**
 * Клиент воркера разницы: круг «запрос → ответ», провал счёта, падение воркера целиком.
 * Транспорт инжектируется, поэтому ни `Worker`, ни canvas здесь не нужны.
 */

const ACCENT: readonly [number, number, number] = [255, 0, 128];

function surface(width: number, height: number, value: number): PixelSurface {
    return { width, height, data: new Uint8ClampedArray(width * height * 4).fill(value) };
}

interface FakeWorker {
    connect: (handlers: ImageDiffHandlers) => ImageDiffConnection;
    posted: ImageDiffMessage[];
    /** Буферы, отданные transfer-ом: по ним видно, что растры уехали без копии. */
    transferred: ArrayBuffer[][];
    connects: number;
    closed: number;
    failNext: boolean;
    crash: (message: string) => void;
}

/** Транспорт без Worker: разница считается прямо здесь, ответ приходит следующим тиком. */
function fakeWorker(): FakeWorker {
    let live: ImageDiffHandlers | null = null;
    const fake: FakeWorker = {
        posted: [],
        transferred: [],
        connects: 0,
        closed: 0,
        failNext: false,
        crash: (message) => {
            live?.onError(new Error(message));
        },
        connect: (handlers) => {
            live = handlers;
            fake.connects += 1;
            return {
                post: (message, transfer) => {
                    fake.posted.push(message);
                    fake.transferred.push([...transfer]);
                    const fail = fake.failNext;
                    fake.failNext = false;
                    queueMicrotask(() => {
                        handlers.onMessage(
                            fail
                                ? { id: message.id, ok: false, error: 'воркер не смог' }
                                : {
                                      id: message.id,
                                      ok: true,
                                      result: diffPixels(message.before, message.after, message.options),
                                  },
                        );
                    });
                },
                close: () => {
                    fake.closed += 1;
                },
            };
        },
    };
    return fake;
}

describe('клиент воркера разницы картинок', () => {
    it('растры доезжают до воркера transfer-ом и возвращаются результатом', async () => {
        const worker = fakeWorker();
        const client = createImageDiffClient({ connect: worker.connect });
        const before = surface(2, 2, 0);
        const after = surface(2, 2, 255);

        const result = await client.compute(before, after, { accent: ACCENT });

        expect(result.changed).toBe(4);
        expect(worker.posted).toHaveLength(1);
        expect(worker.transferred[0]).toHaveLength(2);
    });

    it('воркер поднимается на первом счёте и живёт один на все запросы', async () => {
        const worker = fakeWorker();
        const client = createImageDiffClient({ connect: worker.connect });

        expect(worker.connects).toBe(0);

        await client.compute(surface(1, 1, 0), surface(1, 1, 0), { accent: ACCENT });
        await client.compute(surface(1, 1, 0), surface(1, 1, 0), { accent: ACCENT });

        expect(worker.connects).toBe(1);
    });

    it('провал счёта возвращается ошибкой запроса', async () => {
        const worker = fakeWorker();
        const client = createImageDiffClient({ connect: worker.connect });
        worker.failNext = true;

        await expect(client.compute(surface(1, 1, 0), surface(1, 1, 0), { accent: ACCENT })).rejects.toThrow(
            'воркер не смог',
        );
    });

    it('падение воркера отпускает висящие запросы, следующий счёт поднимает его заново', async () => {
        const worker = fakeWorker();
        const client = createImageDiffClient({ connect: worker.connect });
        const pending = client.compute(surface(1, 1, 0), surface(1, 1, 0), { accent: ACCENT });

        worker.crash('воркер упал');

        await expect(pending).rejects.toThrow('воркер упал');
        expect(worker.closed).toBe(1);

        await client.compute(surface(1, 1, 0), surface(1, 1, 0), { accent: ACCENT });
        expect(worker.connects).toBe(2);
    });

    it('закрытый клиент отпускает висящее и больше не считает', async () => {
        const worker = fakeWorker();
        const client = createImageDiffClient({ connect: worker.connect });
        const pending = client.compute(surface(1, 1, 0), surface(1, 1, 0), { accent: ACCENT });

        client.close();

        await expect(pending).rejects.toThrow();
        await expect(client.compute(surface(1, 1, 0), surface(1, 1, 0), { accent: ACCENT })).rejects.toThrow();
        expect(worker.closed).toBe(1);
    });
});

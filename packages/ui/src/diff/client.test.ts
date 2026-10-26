import { fixtureIteration } from '@sherpa/fixtures';
import { describe, expect, it } from 'vitest';

import type { DiffParseMessage, DiffWorkerConnection, DiffWorkerHandlers } from './client.js';
import { createDiffClient } from './client.js';
import type { DiffParseRequest } from './model.js';
import { toParseRequest } from './model.js';
import { parseFileDiff } from './parse.js';

const DIFF = fixtureIteration('medium').diff;

function request(index: number): DiffParseRequest {
    const file = DIFF.files[index];
    if (file === undefined) {
        throw new Error(`в фикстуре medium нет файла №${String(index)}`);
    }
    return toParseRequest(file);
}

interface FakeWorker {
    connect: (handlers: DiffWorkerHandlers) => DiffWorkerConnection;
    /** Всё, что уехало в воркер: по этому списку видно попадания в кэш. */
    posted: DiffParseMessage[];
    closed: number;
    /** Ответить провалом вместо модели — проверка, что провал не кэшируется. */
    failNext: boolean;
    /** Уронить воркер целиком, как событие `error` у `Worker`. */
    crash: (message: string) => void;
}

/** Транспорт без Worker: парсер вызывается напрямую, ответ приходит следующим тиком. */
function fakeWorker(): FakeWorker {
    let live: DiffWorkerHandlers | null = null;
    const fake: FakeWorker = {
        posted: [],
        closed: 0,
        failNext: false,
        crash: (message) => {
            live?.onError(new Error(message));
        },
        connect: (handlers) => {
            live = handlers;
            return {
                post: (message) => {
                    fake.posted.push(message);
                    const fail = fake.failNext;
                    fake.failNext = false;
                    queueMicrotask(() => {
                        handlers.onMessage(
                            fail
                                ? { id: message.id, ok: false, error: 'воркер не смог' }
                                : { id: message.id, ok: true, model: parseFileDiff(message.file) },
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

describe('клиент дифф-воркера', () => {
    it('запрос доезжает до воркера и возвращается моделью', async () => {
        const worker = fakeWorker();
        const client = createDiffClient({ connect: worker.connect });
        const file = request(0);

        const model = await client.parseFile(DIFF.diffId, file);

        expect(model.path).toBe(file.path);
        expect(worker.posted).toHaveLength(1);
    });

    it('повторный запрос того же файла воркер не дёргает', async () => {
        const worker = fakeWorker();
        const client = createDiffClient({ connect: worker.connect });
        const file = request(0);

        const first = await client.parseFile(DIFF.diffId, file);
        const second = await client.parseFile(DIFF.diffId, file);

        expect(second).toBe(first);
        expect(worker.posted).toHaveLength(1);
    });

    it('два запроса подряд до ответа сливаются в один', async () => {
        const worker = fakeWorker();
        const client = createDiffClient({ connect: worker.connect });
        const file = request(0);

        const [first, second] = await Promise.all([
            client.parseFile(DIFF.diffId, file),
            client.parseFile(DIFF.diffId, file),
        ]);

        expect(second).toBe(first);
        expect(worker.posted).toHaveLength(1);
    });

    it('другой файл и другая итерация — свои запросы', async () => {
        const worker = fakeWorker();
        const client = createDiffClient({ connect: worker.connect });

        await client.parseFile(DIFF.diffId, request(0));
        await client.parseFile(DIFF.diffId, request(1));
        await client.parseFile('другая-итерация', request(0));

        expect(worker.posted).toHaveLength(3);
    });

    it('ответы разъезжаются по своим запросам', async () => {
        const worker = fakeWorker();
        const client = createDiffClient({ connect: worker.connect });

        const models = await Promise.all([
            client.parseFile(DIFF.diffId, request(0)),
            client.parseFile(DIFF.diffId, request(1)),
        ]);

        expect(models.map((model) => model.path)).toEqual([request(0).path, request(1).path]);
    });

    it('провал не кэшируется: следующий запрос снова идёт в воркер', async () => {
        const worker = fakeWorker();
        const client = createDiffClient({ connect: worker.connect });
        worker.failNext = true;

        await expect(client.parseFile(DIFF.diffId, request(0))).rejects.toThrow('воркер не смог');
        await client.parseFile(DIFF.diffId, request(0));

        expect(worker.posted).toHaveLength(2);
    });

    it('close отпускает висящие запросы и закрывает воркер', async () => {
        const worker = fakeWorker();
        const client = createDiffClient({ connect: worker.connect });

        const pending = client.parseFile(DIFF.diffId, request(0));
        client.close();

        await expect(pending).rejects.toThrow('дифф-воркер закрыт');
        await expect(client.parseFile(DIFF.diffId, request(0))).rejects.toThrow('дифф-воркер закрыт');
        expect(worker.closed).toBe(1);
    });

    it('падение воркера отпускает висящие запросы', async () => {
        const worker = fakeWorker();
        const client = createDiffClient({ connect: worker.connect });

        const pending = client.parseFile(DIFF.diffId, request(0));
        worker.crash('воркер не загрузился');

        await expect(pending).rejects.toThrow('воркер не загрузился');
        expect(worker.closed).toBe(1);
    });

    it('после падения воркера следующий запрос поднимает новый', async () => {
        const worker = fakeWorker();
        const client = createDiffClient({ connect: worker.connect });

        const pending = client.parseFile(DIFF.diffId, request(0));
        worker.crash('воркер не загрузился');
        await expect(pending).rejects.toThrow('воркер не загрузился');

        const model = await client.parseFile(DIFF.diffId, request(0));

        expect(model.path).toBe(request(0).path);
        expect(worker.posted).toHaveLength(2);
    });

    it('ключ кэша не путает разные пары diffId и fileId', async () => {
        const worker = fakeWorker();
        const client = createDiffClient({ connect: worker.connect });
        const [first, second] = [request(0), request(1)];

        const left = await client.parseFile('итерация 1', { ...first, fileId: '2' });
        const right = await client.parseFile('итерация', { ...second, fileId: '1 2' });

        expect(left.path).toBe(first.path);
        expect(right.path).toBe(second.path);
        expect(worker.posted).toHaveLength(2);
    });

    it('воркер поднимается лениво — без запросов его нет', () => {
        const worker = fakeWorker();
        const client = createDiffClient({ connect: worker.connect });

        client.close();

        expect(worker.closed).toBe(0);
    });

    it('модель доезжает до клиента через structured clone без потерь', async () => {
        const worker = fakeWorker();
        const client = createDiffClient({ connect: worker.connect });

        const model = await client.parseFile(DIFF.diffId, request(0));

        expect(structuredClone(model)).toEqual(model);
    });
});

import type { UiFileProgress, UiSeenRange, UiStopSeenRange } from '@sherpa/protocol';
import { describe, expect, it } from 'vitest';

import { createProgressWriter } from './progress-writer.js';
import { changeSeenRanges } from './read-state.js';

/** Координация отметок «просмотрено»: единая очередь записей, откат и сходимость вкладок. */

interface Deferred {
    readonly resolve: (revision: number) => void;
    readonly reject: () => void;
}

function harness(initialRevision = 0) {
    const progress = new Map<string, UiFileProgress>();
    const stops = new Map<string, boolean>();
    const sent: { fileId: string; viewed: boolean }[] = [];
    const stopsSent: { stopId: string; viewed: boolean; ranges: readonly UiStopSeenRange[] }[] = [];
    const stopFilesSent: { stopId: string; fileId: string; viewed: boolean; ranges: readonly UiSeenRange[] }[] = [];
    const pending: Deferred[] = [];

    const writer = createProgressWriter({
        initialRevision,
        read: (fileId) => progress.get(fileId) ?? null,
        apply: (fileId, viewed) => {
            progress.set(fileId, { fileId, seenRanges: progress.get(fileId)?.seenRanges ?? [], viewed });
        },
        restore: (fileId, record) => {
            if (record === null) {
                progress.delete(fileId);
            } else {
                progress.set(fileId, record);
            }
        },
        send: (fileId, viewed) => {
            sent.push({ fileId, viewed });
            return deferred();
        },
        stops: {
            read: (stopId) => stops.get(stopId) ?? null,
            apply: (stopId, viewed) => {
                stops.set(stopId, viewed);
            },
            restore: (stopId, viewed) => {
                if (viewed === null) {
                    stops.delete(stopId);
                } else {
                    stops.set(stopId, viewed);
                }
            },
            send: (stopId, viewed, ranges) => {
                stopsSent.push({ stopId, viewed, ranges });
                return deferred();
            },
        },
        stopFiles: {
            apply: (fileId, change, ranges) => {
                const record = progress.get(fileId) ?? { fileId, viewed: null, seenRanges: [] };
                progress.set(fileId, { ...record, seenRanges: changeSeenRanges(record.seenRanges, change, ranges) });
            },
            send: (stopId, fileId, viewed, ranges) => {
                stopFilesSent.push({ stopId, fileId, viewed, ranges });
                return deferred();
            },
        },
        onSettled: () => undefined,
    });

    function deferred(): Promise<number> {
        return new Promise<number>((resolve, reject) => {
            pending.push({ resolve, reject: () => { reject(new Error('ручка не ответила')); } });
        });
    }

    return { writer, progress, stops, sent, stopsSent, stopFilesSent, pending };
}

/** Пропустить микрозадачи: очередь записей уходит на сервер через `then`. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe('запись прогресса чтения', () => {
    it('отметка ложится в стор сразу, ответ ручки её подтверждает', async () => {
        const { writer, progress, sent, pending } = harness();

        const write = writer.write('a', true);
        expect(progress.get('a')).toEqual({ fileId: 'a', viewed: true, seenRanges: [] });

        await settle();
        expect(sent).toEqual([{ fileId: 'a', viewed: true }]);
        pending[0]?.resolve(1);

        expect(await write).toBe(true);
        expect(progress.get('a')?.viewed).toBe(true);
    });

    it('сорвавшаяся запись откатывает контрол к состоянию до неё', async () => {
        const { writer, progress, pending } = harness();

        const write = writer.write('a', true);
        await settle();
        pending[0]?.reject();

        expect(await write).toBe(false);
        // Записи до отметки не было — откат обязан её убрать, а не оставить `viewed: false`.
        expect(progress.has('a')).toBe(false);
    });

    it('две отметки одного файла уходят на сервер по порядку', async () => {
        const { writer, sent, pending } = harness();

        const first = writer.write('a', true);
        const second = writer.write('a', false);
        await settle();

        // Вторая ждёт ответа первой: иначе на сервер они могли бы лечь в обратном порядке.
        expect(sent).toEqual([{ fileId: 'a', viewed: true }]);
        pending[0]?.resolve(1);
        await settle();
        expect(sent).toEqual([{ fileId: 'a', viewed: true }, { fileId: 'a', viewed: false }]);

        pending[1]?.resolve(2);
        expect(await Promise.all([first, second])).toEqual([true, true]);
    });

    it('провал ранней записи не откатывает более свежую удачную', async () => {
        const { writer, progress, pending } = harness();

        const first = writer.write('a', true);
        const second = writer.write('a', false);
        await settle();
        pending[0]?.reject();
        expect(await first).toBe(false);
        // Откат первой затёр бы отметку, которая на сервер ещё только уходит.
        expect(progress.get('a')?.viewed).toBe(false);

        await settle();
        pending[1]?.resolve(1);
        expect(await second).toBe(true);
        expect(progress.get('a')?.viewed).toBe(false);
    });

    it('провал последней записи возвращает то, что подтвердил сервер', async () => {
        const { writer, progress, pending } = harness();

        const first = writer.write('a', true);
        await settle();
        pending[0]?.resolve(1);
        expect(await first).toBe(true);

        const second = writer.write('a', false);
        await settle();
        pending[1]?.reject();

        expect(await second).toBe(false);
        expect(progress.get('a')).toEqual({ fileId: 'a', viewed: true, seenRanges: [] });
    });

    it('своя запись без разрыва ревизий перечитку не заказывает, с разрывом — заказывает', async () => {
        const own = harness();
        const ownWrite = own.writer.write('a', true);
        await settle();
        own.pending[0]?.resolve(1);
        await ownWrite;

        expect(own.writer.shouldReload(1)).toBe(false);

        // Чужая вкладка успела записать раньше: ревизия 2 пришла своей записью, но ревизии 1
        // эта вкладка не видела — снимок надо перечитать.
        const shared = harness();
        const sharedWrite = shared.writer.write('a', true);
        await settle();
        shared.pending[0]?.resolve(2);
        await sharedWrite;

        expect(shared.writer.shouldReload(2)).toBe(true);
    });

    it('после снятия файла снимок перечитывается даже без события канала', async () => {
        const { writer, pending } = harness();

        const write = writer.write('a', false);
        await settle();
        pending[0]?.resolve(1);
        await write;

        // Сервер мог снять связанные остановки и удалить их диапазоны — локально это не вычислить.
        expect(writer.shouldReload(null)).toBe(true);
        writer.finishReload(
            { files: [{ fileId: 'a', viewed: false, seenRanges: [] }], stops: [], progressRevision: 1 },
            writer.beginReload(),
        );
        expect(writer.shouldReload(null)).toBe(false);
    });

    it('после перезапуска сервера события с меньшей ревизией всё равно зовут на перечитку', () => {
        const { writer } = harness();

        writer.finishReload({ files: [], stops: [], progressRevision: 12 }, writer.beginReload());
        expect(writer.shouldReload(12)).toBe(false);

        // Сервер перезапустили, счётчик пошёл заново: ревизия 1 — чужая отметка на новом сервере,
        // а не устаревшее событие. Сверка «больше применённого» молчала бы до ревизии 13.
        expect(writer.shouldReload(1)).toBe(true);
    });

    it('пока запись в полёте, перечитка откладывается', async () => {
        const { writer, pending } = harness();

        const write = writer.write('a', true);
        expect(writer.shouldReload(5)).toBe(false);

        await settle();
        pending[0]?.resolve(5);
        await write;
        expect(writer.shouldReload(5)).toBe(true);
    });

    it('перечитанный снимок не откатывает записи, которых ручка не застала', async () => {
        const { writer, pending } = harness();

        const mark = writer.beginReload();
        // Ревьюер отметил файл, пока ручка отвечала.
        const write = writer.write('a', true);
        const merged = writer.finishReload(
            { files: [{ fileId: 'b', viewed: true, seenRanges: [] }], stops: [], progressRevision: 3 },
            mark,
        );

        expect(merged.files).toEqual([
            { fileId: 'b', viewed: true, seenRanges: [] },
            { fileId: 'a', viewed: true, seenRanges: [] },
        ]);

        await settle();
        pending[0]?.resolve(4);
        await write;
    });

    it('запись поверх снимка сохраняет его диапазоны, а меньшая ревизия ответ не отбрасывает', async () => {
        const { writer, pending } = harness(2);
        const ranges = [{ side: 'new' as const, start: 1, end: 4 }];

        const mark = writer.beginReload();
        const write = writer.write('a', true);
        const merged = writer.finishReload(
            { files: [{ fileId: 'a', viewed: false, seenRanges: ranges }], stops: [], progressRevision: 3 },
            mark,
        );

        expect(merged.files).toEqual([{ fileId: 'a', viewed: true, seenRanges: ranges }]);
        // Ревизия меньше виденной — это перезапустившийся сервер, а не устаревший ответ: его
        // снимок применяется, и незастанная запись по-прежнему кладётся поверх.
        expect(writer.finishReload({ files: [], stops: [], progressRevision: 1 }, mark).files).toEqual([
            { fileId: 'a', viewed: true, seenRanges: [] },
        ]);

        await settle();
        pending[0]?.resolve(4);
        await write;
    });

    it('отметка остановки уходит вместе с диапазонами и откатывается при провале', async () => {
        const { writer, stops, stopsSent, pending } = harness();
        const ranges = [{ fileId: 'a', side: 'new' as const, start: 3, end: 9 }];

        const write = writer.writeStop('s01', true, ranges);
        // Оптимизм: отметка в сторе ещё до ответа ручки.
        expect(stops.get('s01')).toBe(true);
        await settle();
        expect(stopsSent).toEqual([{ stopId: 's01', viewed: true, ranges }]);

        pending[0]?.reject();
        expect(await write).toBe(false);
        // Записи до отметки не было — откат обязан убрать её целиком.
        expect(stops.has('s01')).toBe(false);
    });

    it('после отметки остановки снимок перечитывается: диапазоны считает сервер', async () => {
        const { writer, pending } = harness();

        const write = writer.writeStop('s01', true, []);
        await settle();
        pending[0]?.resolve(1);
        await write;

        // Ревизия своя и без разрыва, но seen-диапазоны файлов лежат только в снимке.
        expect(writer.shouldReload(1)).toBe(true);
        const merged = writer.finishReload(
            { files: [], stops: [{ stopId: 's01', viewed: true }], progressRevision: 1 },
            writer.beginReload(),
        );
        expect(merged.stops).toEqual([{ stopId: 's01', viewed: true }]);
        expect(writer.shouldReload(1)).toBe(false);
    });

    it('перечитка после отметки остановки не ждёт ревизии из канала', async () => {
        const { writer, pending } = harness();
        // Событие прогресса до вкладки ещё не доезжало: ревизии из канала нет вовсе.
        expect(writer.shouldReload(null)).toBe(false);

        const write = writer.writeStop('s01', true, []);
        await settle();
        pending[0]?.resolve(1);
        await write;

        expect(writer.shouldReload(null)).toBe(true);
        writer.finishReload({ files: [], stops: [], progressRevision: 1 }, writer.beginReload());
        expect(writer.shouldReload(null)).toBe(false);
    });

    it('перечитанный снимок не откатывает отметку остановки, которой ручка не застала', async () => {
        const { writer, pending } = harness();

        const mark = writer.beginReload();
        const write = writer.writeStop('s01', true, []);
        const merged = writer.finishReload({ files: [], stops: [], progressRevision: 3 }, mark);

        expect(merged.stops).toEqual([{ stopId: 's01', viewed: true }]);

        await settle();
        pending[0]?.resolve(4);
        await write;
    });

    it('сорвавшаяся запись откатывается к снимку, приехавшему пока она летела', async () => {
        const { writer, progress, pending } = harness();

        const mark = writer.beginReload();
        const write = writer.write('a', true);
        // Соседняя вкладка успела снять отметку — это и есть состояние сервера без нашей записи.
        const merged = writer.finishReload(
            { files: [{ fileId: 'a', viewed: false, seenRanges: [] }], stops: [], progressRevision: 7 },
            mark,
        );
        expect(merged.files).toEqual([{ fileId: 'a', viewed: true, seenRanges: [] }]);

        await settle();
        pending[0]?.reject();
        expect(await write).toBe(false);
        expect(progress.get('a')).toEqual({ fileId: 'a', viewed: false, seenRanges: [] });
    });

    describe('отметка файла внутри остановки', () => {
        const card = [{ side: 'new' as const, start: 1, end: 5 }];

        it('добавляет строки карточки к записи файла, не трогая признак и остановку', async () => {
            const { writer, progress, stops, stopFilesSent, pending } = harness();
            progress.set('a', { fileId: 'a', viewed: null, seenRanges: [{ side: 'new', start: 20, end: 22 }] });

            const write = writer.writeStopFile('s01', 'a', true, card);
            expect(progress.get('a')).toEqual({
                fileId: 'a',
                viewed: null,
                seenRanges: [
                    { side: 'new', start: 1, end: 5 },
                    { side: 'new', start: 20, end: 22 },
                ],
            });
            expect(stops.has('s01')).toBe(false);

            await settle();
            expect(stopFilesSent).toEqual([{ stopId: 's01', fileId: 'a', viewed: true, ranges: card }]);
            pending[0]?.resolve(1);
            expect(await write).toBe(true);
            // Диапазоны лежат в снимке сервера: его надо перечитать.
            expect(writer.shouldReload(1)).toBe(true);
        });

        it('снятие вычитает строки карточки, снимает просмотренную остановку и диапазонов не шлёт', async () => {
            const { writer, progress, stops, stopFilesSent, pending } = harness();
            progress.set('a', { fileId: 'a', viewed: null, seenRanges: [{ side: 'new', start: 1, end: 10 }] });
            stops.set('s01', true);

            const write = writer.writeStopFile('s01', 'a', false, card);
            expect(progress.get('a')?.seenRanges).toEqual([{ side: 'new', start: 6, end: 10 }]);
            expect(stops.get('s01')).toBe(false);

            await settle();
            expect(stopFilesSent).toEqual([{ stopId: 's01', fileId: 'a', viewed: false, ranges: [] }]);
            pending[0]?.resolve(1);
            expect(await write).toBe(true);
        });

        it('провал откатывает запись файла и отметку остановки', async () => {
            const { writer, progress, stops, pending } = harness();
            const before: UiFileProgress = { fileId: 'a', viewed: null, seenRanges: [{ side: 'new', start: 1, end: 10 }] };
            progress.set('a', before);
            stops.set('s01', true);

            const write = writer.writeStopFile('s01', 'a', false, card);
            await settle();
            pending[0]?.reject();

            expect(await write).toBe(false);
            expect(progress.get('a')).toEqual(before);
            expect(stops.get('s01')).toBe(true);
        });

        it('провал отметки без прежней записи убирает запись целиком', async () => {
            const { writer, progress, pending } = harness();

            const write = writer.writeStopFile('s01', 'a', true, card);
            await settle();
            pending[0]?.reject();

            expect(await write).toBe(false);
            expect(progress.has('a')).toBe(false);
        });

        it('два тогла одной карточки и карточка другого файла уходят строго по порядку постановки', async () => {
            const { writer, stopFilesSent, pending } = harness();

            const first = writer.writeStopFile('s01', 'a', true, card);
            const second = writer.writeStopFile('s01', 'a', false, card);
            const other = writer.writeStopFile('s02', 'b', true, [{ side: 'new', start: 30, end: 31 }]);
            const sentOrder = () => stopFilesSent.map((sent) => [sent.stopId, sent.viewed]);

            await settle();
            expect(sentOrder()).toEqual([['s01', true]]);
            pending[0]?.resolve(1);
            await settle();
            expect(sentOrder()).toEqual([
                ['s01', true],
                ['s01', false],
            ]);
            pending[1]?.resolve(2);
            await settle();
            expect(sentOrder()).toEqual([
                ['s01', true],
                ['s01', false],
                ['s02', true],
            ]);

            pending[2]?.resolve(3);
            expect(await Promise.all([first, second, other])).toEqual([true, true, true]);
        });

        it('карточки одного файла в разных остановках уходят по порядку постановки', async () => {
            const { writer, stopFilesSent, pending } = harness();

            const first = writer.writeStopFile('s01', 'a', true, card);
            const second = writer.writeStopFile('s02', 'a', true, [{ side: 'new', start: 30, end: 31 }]);
            await settle();
            expect(stopFilesSent.map((sent) => sent.stopId)).toEqual(['s01']);

            pending[0]?.resolve(1);
            await settle();
            expect(stopFilesSent.map((sent) => sent.stopId)).toEqual(['s01', 's02']);
            pending[1]?.resolve(2);
            expect(await Promise.all([first, second])).toEqual([true, true]);
        });

        it('два провала подряд в разных остановках одного файла возвращают запись до обоих', async () => {
            const { writer, progress, pending } = harness();
            const before: UiFileProgress = { fileId: 'a', viewed: null, seenRanges: [{ side: 'new', start: 40, end: 41 }] };
            progress.set('a', before);

            const first = writer.writeStopFile('s01', 'a', true, card);
            const second = writer.writeStopFile('s02', 'a', true, [{ side: 'new', start: 30, end: 31 }]);
            await settle();
            pending[0]?.reject();
            expect(await first).toBe(false);
            // Вторая ещё в полёте: на экране остаётся только она.
            expect(progress.get('a')?.seenRanges).toEqual([
                { side: 'new', start: 30, end: 31 },
                { side: 'new', start: 40, end: 41 },
            ]);

            await settle();
            pending[1]?.reject();
            expect(await second).toBe(false);
            expect(progress.get('a')).toEqual(before);
        });

        it('провал ранней отметки карточки не стирает принятую позже соседнюю', async () => {
            const { writer, progress, pending } = harness();

            const first = writer.writeStopFile('s01', 'a', true, card);
            const second = writer.writeStopFile('s02', 'a', true, [{ side: 'new', start: 30, end: 31 }]);
            await settle();
            pending[0]?.reject();
            await first;
            await settle();
            pending[1]?.resolve(1);
            expect(await second).toBe(true);

            expect(progress.get('a')?.seenRanges).toEqual([{ side: 'new', start: 30, end: 31 }]);
        });

        it('провал пина не откатывает отметку карточки того же файла, поставленную следом', async () => {
            const { writer, progress, sent, stopFilesSent, pending } = harness();

            const pin = writer.write('a', true);
            const marked = writer.writeStopFile('s01', 'a', true, card);
            await settle();
            // Запись карточки ждёт ответа пина в общей очереди.
            expect([sent.length, stopFilesSent.length]).toEqual([1, 0]);
            pending[0]?.reject();
            expect(await pin).toBe(false);
            expect(progress.get('a')).toEqual({ fileId: 'a', viewed: null, seenRanges: card });

            await settle();
            pending[1]?.resolve(1);
            expect(await marked).toBe(true);
        });

        it('перечитанный снимок получает поверх незастанные отметки карточек', async () => {
            const { writer, stops, pending } = harness();
            stops.set('s02', true);

            const mark = writer.beginReload();
            const marked = writer.writeStopFile('s01', 'a', true, card);
            const unmarked = writer.writeStopFile('s02', 'b', false, [{ side: 'old', start: 2, end: 3 }]);
            const merged = writer.finishReload(
                {
                    files: [
                        { fileId: 'a', viewed: false, seenRanges: [{ side: 'new', start: 6, end: 8 }] },
                        { fileId: 'b', viewed: null, seenRanges: [{ side: 'old', start: 1, end: 4 }] },
                    ],
                    stops: [{ stopId: 's02', viewed: true }],
                    progressRevision: 5,
                },
                mark,
            );

            expect(merged.files).toEqual([
                { fileId: 'a', viewed: false, seenRanges: [{ side: 'new', start: 1, end: 8 }] },
                {
                    fileId: 'b',
                    viewed: null,
                    seenRanges: [
                        { side: 'old', start: 1, end: 1 },
                        { side: 'old', start: 4, end: 4 },
                    ],
                },
            ]);
            expect(merged.stops).toEqual([{ stopId: 's02', viewed: false }]);

            await settle();
            pending[0]?.resolve(6);
            await settle();
            pending[1]?.resolve(7);
            await Promise.all([marked, unmarked]);
        });

        describe('отметка остановки и снятие её карточки следом', () => {
            const stopRanges = [{ fileId: 'a', side: 'new' as const, start: 1, end: 10 }];
            const before: UiFileProgress = { fileId: 'a', viewed: null, seenRanges: [{ side: 'new', start: 1, end: 10 }] };

            function start() {
                const context = harness();
                context.progress.set('a', before);
                const stop = context.writer.writeStop('s01', true, stopRanges);
                const card = context.writer.writeStopFile('s01', 'a', false, [{ side: 'new', start: 1, end: 5 }]);
                return { ...context, stop, card };
            }

            it('карточка ждёт ответа остановки, на экране обе записи', async () => {
                const { stops, progress, stopsSent, stopFilesSent, pending, stop, card } = start();

                expect(stops.get('s01')).toBe(false);
                expect(progress.get('a')?.seenRanges).toEqual([{ side: 'new', start: 6, end: 10 }]);
                await settle();
                expect([stopsSent.length, stopFilesSent.length]).toEqual([1, 0]);

                pending[0]?.resolve(1);
                await settle();
                expect([stopsSent.length, stopFilesSent.length]).toEqual([1, 1]);
                pending[1]?.resolve(2);
                expect(await Promise.all([stop, card])).toEqual([true, true]);
                expect(stops.get('s01')).toBe(false);
                expect(progress.get('a')?.seenRanges).toEqual([{ side: 'new', start: 6, end: 10 }]);
            });

            it('провал остановки оставляет на экране снятие карточки', async () => {
                const { stops, progress, pending, stop, card } = start();

                await settle();
                pending[0]?.reject();
                expect(await stop).toBe(false);
                expect(stops.get('s01')).toBe(false);
                expect(progress.get('a')?.seenRanges).toEqual([{ side: 'new', start: 6, end: 10 }]);

                await settle();
                pending[1]?.resolve(1);
                expect(await card).toBe(true);
                expect(stops.get('s01')).toBe(false);
            });

            it('провал снятия карточки возвращает отметку остановки и строки файла', async () => {
                const { stops, progress, pending, stop, card } = start();

                await settle();
                pending[0]?.resolve(1);
                expect(await stop).toBe(true);
                await settle();
                pending[1]?.reject();
                expect(await card).toBe(false);

                expect(stops.get('s01')).toBe(true);
                expect(progress.get('a')).toEqual(before);
            });
        });
    });

    describe('единая очередь записей', () => {
        it('отметки разных файлов уходят строго по порядку постановки', async () => {
            const { writer, sent, pending } = harness();

            const first = writer.write('a', true);
            const second = writer.write('b', true);
            await settle();
            expect(sent).toEqual([{ fileId: 'a', viewed: true }]);

            pending[0]?.resolve(1);
            await settle();
            expect(sent).toEqual([
                { fileId: 'a', viewed: true },
                { fileId: 'b', viewed: true },
            ]);
            pending[1]?.resolve(2);
            expect(await Promise.all([first, second])).toEqual([true, true]);
        });

        it('провал записи не блокирует следующую', async () => {
            const { writer, progress, sent, pending } = harness();

            const first = writer.write('a', true);
            const second = writer.write('b', true);
            await settle();
            pending[0]?.reject();
            expect(await first).toBe(false);

            await settle();
            expect(sent.map((write) => write.fileId)).toEqual(['a', 'b']);
            pending[1]?.resolve(1);
            expect(await second).toBe(true);
            expect(progress.has('a')).toBe(false);
            expect(progress.get('b')?.viewed).toBe(true);
        });
    });
});

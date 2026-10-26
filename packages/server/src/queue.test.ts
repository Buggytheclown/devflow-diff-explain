import { LEASE_TTL_SECONDS, MAX_TASK_ATTEMPTS, RESULT_MAX_BYTES } from '@sherpa/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { SherpaDatabase } from './db.js';
import { openDatabase } from './db.js';
import { RpcFailure } from './errors.js';
import type { EnqueueInput, LeasedTask, TaskRecord } from './queue.js';
import { MAX_RESULT_REJECTIONS, TaskQueue } from './queue.js';
import { makeTempSherpaDir, removeTempSherpaDir } from './test-support.js';

const START = new Date('2026-08-19T12:00:00.000Z');

describe('очередь с арендой', () => {
    let sherpaDir: string;
    let dbFile: string;
    let db: SherpaDatabase;
    let now: Date;
    let queue: TaskQueue;

    beforeEach(async () => {
        sherpaDir = await makeTempSherpaDir();
        dbFile = `${sherpaDir}/queue.db`;
        db = openDatabase(dbFile);
        now = START;
        queue = new TaskQueue({ db, now: () => now });
    });

    afterEach(async () => {
        db.close();
        await removeTempSherpaDir(sherpaDir);
    });

    function advanceSeconds(seconds: number): void {
        now = new Date(now.getTime() + seconds * 1000);
    }

    function enqueue(overrides: Partial<EnqueueInput> = {}): TaskRecord {
        return queue.enqueue({
            type: 'echo',
            priority: 'background',
            instructions: 'Верни содержимое файла как есть.',
            contextFiles: [],
            ...overrides,
        });
    }

    function takeNext(workerId: string): LeasedTask {
        const leased = queue.next(workerId);
        if (leased === null) {
            throw new Error(`воркер ${workerId} ожидал задачу, а очередь оказалась пуста`);
        }
        return leased;
    }

    function failureOf(run: () => unknown): RpcFailure {
        try {
            run();
        } catch (error) {
            if (error instanceof RpcFailure) {
                return error;
            }
            throw error;
        }
        throw new Error('ожидалась ошибка RpcFailure, но вызов прошёл успешно');
    }

    describe('порядок выдачи', () => {
        it('интерактивные обгоняют фоновые, внутри класса — FIFO по id', () => {
            const firstBackground = enqueue({ instructions: 'фон 1' });
            const secondBackground = enqueue({ instructions: 'фон 2' });
            const interactive = enqueue({ priority: 'interactive', instructions: 'интерактив' });

            expect(takeNext('w-1').task.id).toBe(interactive.id);
            expect(takeNext('w-2').task.id).toBe(firstBackground.id);
            expect(takeNext('w-3').task.id).toBe(secondBackground.id);
            expect(queue.next('w-4')).toBeNull();
        });

        it('пустая очередь — null, отменённые задачи не выдаются', () => {
            const task = enqueue();
            queue.cancel(task.id);

            expect(queue.next('w-1')).toBeNull();
        });

        it('аренда выдаётся с TTL своего класса приоритета', () => {
            enqueue({ priority: 'interactive' });

            const leased = takeNext('w-1');

            expect(leased.lease.ttlSeconds).toBe(LEASE_TTL_SECONDS.interactive);
            expect(leased.lease.expiresAt).toBe(
                new Date(START.getTime() + LEASE_TTL_SECONDS.interactive * 1000).toISOString(),
            );
            expect(leased.task.attempt).toBe(1);
        });

        it('повторный next того же воркера при живой аренде возвращает ту же задачу', () => {
            enqueue();
            enqueue();
            const first = takeNext('w-1');

            advanceSeconds(10);
            const again = takeNext('w-1');

            expect(again.task.id).toBe(first.task.id);
            expect(again.lease.expiresAt).toBe(first.lease.expiresAt);
        });
    });

    describe('протухание аренды', () => {
        it('истёкшая аренда возвращает задачу в очередь с инкрементом попытки', () => {
            const task = enqueue();
            takeNext('w-1');

            advanceSeconds(LEASE_TTL_SECONDS.background + 1);
            const retaken = takeNext('w-2');

            expect(retaken.task.id).toBe(task.id);
            expect(retaken.task.attempt).toBe(2);
            // Причину возврата аренды переаренда сбрасывает: задача снова живая, старое `expired`
            // не должно пережить re-lease и сбить с толку сверку состояния после рестарта сервера.
            expect(queue.getTask(task.id)).toMatchObject({
                workerId: 'w-2',
                lastLeaseReturnReason: null,
            });
        });

        it('протухшая аренда без переаренды остаётся видимой причиной для сверки состояния', () => {
            const task = enqueue();
            takeNext('w-1');

            advanceSeconds(LEASE_TTL_SECONDS.background + 1);
            queue.listTasks();

            expect(queue.getTask(task.id)).toMatchObject({
                status: 'queued',
                workerId: null,
                lastLeaseReturnReason: 'expired',
            });
        });

        it('исчерпанные попытки закрывают задачу ошибкой, а не выдают её снова', () => {
            const task = enqueue();

            for (let attempt = 1; attempt <= MAX_TASK_ATTEMPTS; attempt += 1) {
                expect(takeNext(`w-${String(attempt)}`).task.attempt).toBe(attempt);
                advanceSeconds(LEASE_TTL_SECONDS.background + 1);
            }

            expect(queue.next('w-последний')).toBeNull();
            const record = queue.getTask(task.id);
            expect(record?.status).toBe('failed');
            expect(record?.failReason).toContain(String(MAX_TASK_ATTEMPTS));
        });

        it('чтение очереди тоже протухает аренды, даже если больше никто её не трогает', () => {
            const task = enqueue();
            takeNext('w-1');

            advanceSeconds(LEASE_TTL_SECONDS.background + 1);

            expect(queue.getTask(task.id)).toMatchObject({ status: 'queued', attempt: 2, workerId: null });
            expect(queue.listTasks()[0]).toMatchObject({ status: 'queued', attempt: 2 });
        });

        it('воркер с истёкшей арендой не может сдать результат', () => {
            const task = enqueue();
            takeNext('w-1');

            advanceSeconds(LEASE_TTL_SECONDS.background + 1);

            expect(failureOf(() => queue.complete('w-1', task.id, 'поздно')).code).toBe('lease_not_held');
            expect(queue.getTask(task.id)?.status).toBe('queued');
        });
    });

    describe('read-only срок аренды', () => {
        it('срок живой аренды виден, у чужого воркера и после сдачи задачи аренды нет', () => {
            const task = enqueue();
            const lease = takeNext('w-1');

            expect(queue.leaseExpiryOf('w-1')).toBe(lease.lease.expiresAt);
            expect(queue.leaseExpiryOf('w-2')).toBeNull();

            queue.complete('w-1', task.id, 'готово');
            expect(queue.leaseExpiryOf('w-1')).toBeNull();
        });

        it('срок протухшей аренды виден как есть, очередь при этом не двигается', () => {
            const task = enqueue();
            const lease = takeNext('w-1');
            advanceSeconds(LEASE_TTL_SECONDS.background + 1);

            let changes = 0;
            queue.subscribeChanges(() => {
                changes += 1;
            });

            // Прошедший срок — сигнал «работа кончилась тогда-то», по нему считают смерть воркера.
            expect(queue.leaseExpiryOf('w-1')).toBe(lease.lease.expiresAt);
            // Чистое чтение: возврат задачи в очередь остаётся за операциями очереди.
            expect(changes).toBe(0);
            expect(db.prepare('SELECT status FROM tasks WHERE id = ?').get(task.id)).toMatchObject({
                status: 'leased',
            });
        });
    });

    describe('возврат аренд вытесненного воркера', () => {
        it('аренда возвращается в очередь сразу, без ожидания TTL, с инкрементом попытки', () => {
            const task = enqueue();
            takeNext('w-мёртвый');

            queue.releaseLeasesOf('w-мёртвый');

            expect(queue.getTask(task.id)).toMatchObject({
                status: 'queued',
                attempt: 2,
                workerId: null,
                lastLeaseReturnReason: 'displaced',
            });
            expect(takeNext('w-новый').task.id).toBe(task.id);
        });

        it('чужие аренды и закрытые задачи не трогаются', () => {
            const held = enqueue();
            takeNext('w-живой');
            const done = enqueue();
            takeNext('w-мёртвый');
            queue.complete('w-мёртвый', done.id, 'готово');

            queue.releaseLeasesOf('w-мёртвый');

            expect(queue.getTask(held.id)).toMatchObject({ status: 'leased', workerId: 'w-живой' });
            expect(queue.getTask(done.id)).toMatchObject({ status: 'done', result: 'готово' });
        });

        it('возврат при исчерпанных попытках закрывает задачу ошибкой, как протухание', () => {
            const task = enqueue();
            for (let attempt = 1; attempt < MAX_TASK_ATTEMPTS; attempt += 1) {
                takeNext(`w-${String(attempt)}`);
                advanceSeconds(LEASE_TTL_SECONDS.background + 1);
            }
            takeNext('w-последний');

            queue.releaseLeasesOf('w-последний');

            expect(queue.getTask(task.id)?.status).toBe('failed');
            expect(queue.getTask(task.id)?.failReason).toContain('попытки исчерпаны');
        });
    });

    describe('сдача результата', () => {
        it('результат принимается, повторный complete — noop', () => {
            const task = enqueue();
            takeNext('w-1');

            expect(queue.complete('w-1', task.id, 'готово')).toEqual({
                kind: 'accepted',
                message: expect.stringContaining(`sherpa/${String(task.id)}`) as unknown,
            });
            expect(queue.getTask(task.id)).toMatchObject({ status: 'done', result: 'готово', workerId: null });

            const repeated = queue.complete('w-1', task.id, 'готово');
            expect(repeated.kind).toBe('noop');
            expect(queue.fail('w-1', task.id, 'передумал').kind).toBe('noop');
        });

        it('пустой результат отбивается с промпт-ошибкой, задача остаётся в аренде', () => {
            const task = enqueue();
            takeNext('w-1');

            const response = queue.complete('w-1', task.id, '   ');

            expect(response.kind).toBe('rejected');
            expect(queue.getTask(task.id)?.status).toBe('leased');
        });

        it('у задачи без приёмщика пустые результаты аренду не сжигают, сколько бы их ни было', () => {
            const task = enqueue();
            takeNext('w-1');

            for (let attempt = 0; attempt <= MAX_RESULT_REJECTIONS; attempt += 1) {
                expect(queue.complete('w-1', task.id, '').kind).toBe('rejected');
            }

            // Дно петли — про отказ приёмщика; у `echo` приёмки по схеме нет и лимита тоже.
            expect(queue.getTask(task.id)).toMatchObject({ status: 'leased', attempt: 1 });
        });

        it('чужой воркер получает lease_not_held', () => {
            const task = enqueue();
            takeNext('w-1');

            expect(failureOf(() => queue.complete('w-2', task.id, 'моё')).code).toBe('lease_not_held');
            expect(queue.getTask(task.id)?.status).toBe('leased');
        });

        it('несуществующая задача — unknown_task', () => {
            expect(failureOf(() => queue.complete('w-1', 404, 'нет такой')).code).toBe('unknown_task');
        });

        it('результат больше лимита завершает задачу ошибкой', () => {
            const task = enqueue();
            takeNext('w-1');

            // Кириллица — 2 байта на символ: лимит меряется в байтах, не в символах.
            const oversized = 'я'.repeat(RESULT_MAX_BYTES / 2 + 1);
            expect(failureOf(() => queue.complete('w-1', task.id, oversized)).code).toBe('result_too_large');

            const record = queue.getTask(task.id);
            expect(record?.status).toBe('failed');
            expect(record?.result).toBeNull();
            expect(record?.failReason).toContain(String(RESULT_MAX_BYTES));
        });

        it('явный отказ закрывает задачу с причиной', () => {
            const task = enqueue();
            takeNext('w-1');

            expect(queue.fail('w-1', task.id, 'нет доступа к файлу')).toEqual({ kind: 'accepted' });
            expect(queue.getTask(task.id)).toMatchObject({ status: 'failed', failReason: 'нет доступа к файлу' });
        });
    });

    describe('приёмка результата', () => {
        it('приёмщик видит задачу и результат, а применение принятого идёт после коммита', () => {
            const seen: { type: string; result: string; statusAtApply: string | undefined }[] = [];
            const task = enqueue();
            queue.setResultAcceptor((record, result) => ({
                kind: 'accepted',
                onCommitted: () => {
                    // Внутри транзакции задача ещё в аренде — применять принятое надо после неё.
                    seen.push({
                        type: record.type,
                        result,
                        statusAtApply: queue.getTask(record.id)?.status,
                    });
                },
            }));
            takeNext('w-1');

            expect(queue.complete('w-1', task.id, 'готово').kind).toBe('accepted');
            expect(seen).toEqual([{ type: 'echo', result: 'готово', statusAtApply: 'done' }]);
        });

        it('отказ приёмщика не тратит попытку и не снимает аренду, дно петли — три отказа', () => {
            const task = enqueue();
            queue.setResultAcceptor(() => ({ kind: 'rejected', errors: ['anchors do not resolve'] }));
            takeNext('w-1');

            for (let attempt = 1; attempt < MAX_RESULT_REJECTIONS; attempt += 1) {
                const response = queue.complete('w-1', task.id, 'кривой вывод');
                expect(response.kind).toBe('rejected');
                expect(response.kind === 'rejected' && response.errors[0]).toBe('anchors do not resolve');
                expect(queue.getTask(task.id)).toMatchObject({ status: 'leased', attempt: 1 });
            }

            expect(queue.complete('w-1', task.id, 'последний кривой вывод').kind).toBe('rejected');
            // Сырой вывод остаётся в задаче: его показывает «Open raw output».
            expect(queue.getTask(task.id)).toMatchObject({
                status: 'failed',
                attempt: 1,
                result: 'последний кривой вывод',
            });
            expect(queue.getTask(task.id)?.failReason).toContain('валидацию');
        });

        it('приёмщик вернул «проверить нечем» — бюджет отказов цел', () => {
            const task = enqueue();
            queue.setResultAcceptor(() => ({ kind: 'deferred', errors: ['the server is not ready'] }));
            takeNext('w-1');

            for (let attempt = 0; attempt <= MAX_RESULT_REJECTIONS; attempt += 1) {
                const response = queue.complete('w-1', task.id, 'нормальный вывод');
                expect(response.kind).toBe('rejected');
                expect(response.kind === 'rejected' && response.errors[0]).toBe('the server is not ready');
            }
            expect(queue.getTask(task.id)).toMatchObject({ status: 'leased', attempt: 1 });

            // Временный сбой кончился — счёт отказов начинается с нуля.
            queue.setResultAcceptor(() => ({ kind: 'rejected', errors: ['nope'] }));
            for (let attempt = 1; attempt < MAX_RESULT_REJECTIONS; attempt += 1) {
                queue.complete('w-1', task.id, 'кривой вывод');
                expect(queue.getTask(task.id)?.status).toBe('leased');
            }
            queue.complete('w-1', task.id, 'кривой вывод');
            expect(queue.getTask(task.id)?.status).toBe('failed');
        });

        it('задача чужого типа проходит мимо приёмщика прежним путём', () => {
            const task = enqueue();
            queue.setResultAcceptor(() => null);
            takeNext('w-1');

            expect(queue.complete('w-1', task.id, '').kind).toBe('rejected');
            expect(queue.getTask(task.id)?.status).toBe('leased');
            expect(queue.complete('w-1', task.id, 'готово').kind).toBe('accepted');
            expect(queue.getTask(task.id)).toMatchObject({ status: 'done', result: 'готово' });
        });

        it('новая аренда даёт полный набор отказов заново', () => {
            const task = enqueue();
            queue.setResultAcceptor(() => ({ kind: 'rejected', errors: ['nope'] }));
            takeNext('w-1');
            queue.complete('w-1', task.id, 'раз');
            queue.complete('w-1', task.id, 'два');

            advanceSeconds(LEASE_TTL_SECONDS.background + 1);
            takeNext('w-2');

            expect(queue.complete('w-2', task.id, 'три').kind).toBe('rejected');
            expect(queue.getTask(task.id)?.status).toBe('leased');
        });
    });

    describe('статусные отметки', () => {
        it('progress пишет последнюю отметку владельца аренды', () => {
            const task = enqueue();
            takeNext('w-1');

            expect(queue.progress('w-1', task.id, 'читаю дифф')).toEqual({ kind: 'accepted' });
            expect(queue.progress('w-1', task.id, 'пишу ответ')).toEqual({ kind: 'accepted' });
            expect(queue.getTask(task.id)?.progressText).toBe('пишу ответ');
        });

        it('progress по закрытой задаче — noop, по чужой — lease_not_held', () => {
            const task = enqueue();
            takeNext('w-1');
            queue.complete('w-1', task.id, 'готово');

            expect(queue.progress('w-1', task.id, 'ещё работаю').kind).toBe('noop');

            const another = enqueue();
            takeNext('w-1');
            expect(failureOf(() => queue.progress('w-2', another.id, 'чужое')).code).toBe('lease_not_held');
        });
    });

    describe('отмена', () => {
        it('задача из очереди отменяется сразу и больше не выдаётся', () => {
            const task = enqueue();

            expect(queue.cancel(task.id)).toBe('cancelled');
            expect(queue.getTask(task.id)?.status).toBe('cancelled');
            expect(queue.next('w-1')).toBeNull();
        });

        it('задача в аренде отменяется формально: воркер узнаёт об этом на следующем вызове', () => {
            const task = enqueue();
            takeNext('w-1');

            expect(queue.cancel(task.id)).toBe('cancelled');
            // Держание сохраняется: воркер ещё крутит отменённую задачу и об отмене не знает.
            expect(queue.getTask(task.id)).toMatchObject({ status: 'cancelled', workerId: 'w-1' });
            expect(queue.getTask(task.id)?.leaseExpiresAt).not.toBeNull();
            expect(queue.next('w-2')).toBeNull();

            const response = queue.complete('w-1', task.id, 'всё равно сделал');
            expect(response).toEqual({ kind: 'noop', message: expect.stringContaining('cancelled') as unknown });
            expect(queue.getTask(task.id)).toMatchObject({
                status: 'cancelled',
                result: null,
                workerId: null,
                leaseExpiresAt: null,
            });
        });

        it.each([
            ['fail', (id: number): unknown => queue.fail('w-1', id, 'не смог')],
            ['progress', (id: number): unknown => queue.progress('w-1', id, 'ещё пишу')],
        ])('%s держателя тоже снимает держание и отвечает noop', (_name, call) => {
            const task = enqueue();
            takeNext('w-1');
            queue.cancel(task.id);

            expect(call(task.id)).toEqual({
                kind: 'noop',
                message: expect.stringContaining('has been cancelled') as unknown,
            });
            expect(queue.getTask(task.id)).toMatchObject({ workerId: null, leaseExpiresAt: null });
        });

        it('`next` того же воркера снимает держание: он двинулся дальше', () => {
            const cancelled = enqueue({ instructions: 'первая' });
            takeNext('w-1');
            queue.cancel(cancelled.id);
            const next = enqueue({ instructions: 'вторая' });

            expect(takeNext('w-1').task.id).toBe(next.id);
            expect(queue.getTask(cancelled.id)).toMatchObject({
                status: 'cancelled',
                workerId: null,
                leaseExpiresAt: null,
            });
        });

        it('протухание держания снимает его без возврата в очередь и без инкремента попытки', () => {
            const task = enqueue();
            takeNext('w-1');
            queue.cancel(task.id);

            advanceSeconds(LEASE_TTL_SECONDS.background + 1);

            expect(queue.getTask(task.id)).toMatchObject({
                status: 'cancelled',
                attempt: 1,
                workerId: null,
                leaseExpiresAt: null,
                lastLeaseReturnReason: null,
            });
        });

        it('вытеснение воркера снимает держание отменённой', () => {
            const task = enqueue();
            takeNext('w-1');
            queue.cancel(task.id);

            queue.releaseLeasesOf('w-1');

            expect(queue.getTask(task.id)).toMatchObject({
                status: 'cancelled',
                attempt: 1,
                workerId: null,
                leaseExpiresAt: null,
            });
        });

        it('держание отменённой считается занятостью воркера', () => {
            const task = enqueue();
            const lease = takeNext('w-1');
            queue.cancel(task.id);

            expect(queue.leaseExpiryOf('w-1')).toBe(lease.lease.expiresAt);

            queue.complete('w-1', task.id, 'поздно');
            expect(queue.leaseExpiryOf('w-1')).toBeNull();
        });

        it('отмена задачи из очереди держателя не заводит', () => {
            const task = enqueue();

            queue.cancel(task.id);

            expect(queue.getTask(task.id)).toMatchObject({ workerId: null, leaseExpiresAt: null });
        });

        it('повторная отмена и отмена закрытой — noop, неизвестной — unknown_task', () => {
            const task = enqueue();
            queue.cancel(task.id);

            expect(queue.cancel(task.id)).toBe('noop');
            expect(failureOf(() => queue.cancel(404)).code).toBe('unknown_task');
        });
    });

    describe('персистентность', () => {
        it('очередь и аренды переживают переоткрытие хранилища', () => {
            const done = enqueue({ instructions: 'первая' });
            const leased = enqueue({ instructions: 'вторая' });
            const queued = enqueue({ instructions: 'третья' });
            takeNext('w-1');
            queue.complete('w-1', done.id, 'готово');
            takeNext('w-1');

            db.close();
            db = openDatabase(dbFile);
            queue = new TaskQueue({ db, now: () => now });

            expect(queue.listTasks().map((task) => [task.id, task.status])).toEqual([
                [done.id, 'done'],
                [leased.id, 'leased'],
                [queued.id, 'queued'],
            ]);
            // Аренда пережила перезапуск — тот же воркер получает ту же задачу, чужой ждёт следующей.
            expect(takeNext('w-1').task.id).toBe(leased.id);
            expect(takeNext('w-2').task.id).toBe(queued.id);
        });
    });

    describe('подписка', () => {
        it('постановка задачи будит подписчиков, отписка глушит', () => {
            let calls = 0;
            const unsubscribe = queue.subscribeChanges(() => {
                calls += 1;
            });

            enqueue();
            expect(calls).toBe(1);

            unsubscribe();
            enqueue();
            expect(calls).toBe(1);
        });
    });
});

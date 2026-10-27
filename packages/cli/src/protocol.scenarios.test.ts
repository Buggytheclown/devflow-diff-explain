import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { PriorityClass } from '@sherpa/protocol';
import { LEASE_TTL_SECONDS, MAX_TASK_ATTEMPTS } from '@sherpa/protocol';
import type { SherpaServer } from '@sherpa/server';
import { startServer } from '@sherpa/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { FakeWorker } from './fake-worker.js';
import { taskResultDirFor, taskResultFileFor, workerIdPathFor } from './paths.js';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/** Собран один раз в globalSetup (`src/bundle.global-setup.ts`) — здесь только запускается. */
const bundlePath = path.join(packageRoot, 'dist', 'devflow-diff-explain.mjs');

const PR_KEY = 'arcanum-909';
/** Короткое окно long-poll: бандл крутит `next` через частые `idle`, как живой сервер раз в четыре минуты. */
const LONG_POLL_SECONDS = 0.2;
/** Сдвиг, гарантированно переживающий аренду интерактивной задачи (и заодно срок смерти воркера). */
const PAST_LEASE_SECONDS = LEASE_TTL_SECONDS.interactive + 1;

/**
 * Протокольные тесты CLI↔сервер: сквозные сценарии жизни сессии против настоящего сервера,
 * где воркер — собранный бандл, запускаемый отдельными процессами. Часы сервера инжектированы,
 * поэтому протухание аренд и смерть воркера случаются мгновенно.
 */
describe('сценарии сессии-воркера', () => {
    let sherpaDir: string;
    let workDir: string;
    let server: SherpaServer;
    let worker: FakeWorker;
    let nowMs: number;

    beforeEach(async () => {
        sherpaDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sherpa-scenario-state-'));
        workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sherpa-scenario-work-'));
        nowMs = Date.now();
        server = await startServer({
            prKey: PR_KEY,
            sherpaDir,
            longPollSeconds: LONG_POLL_SECONDS,
            now: () => new Date(nowMs),
            // Живой Арканум в тестах запрещён, да и маршрутных задач сценариям не надо:
            // без хоста автопостановка не сработает и очередь остаётся такой, какой её ставит тест.
            reviewSourceFactory: () => null,
        });
        worker = new FakeWorker({ bundlePath, sherpaDir, prKey: PR_KEY, workDir });
    });

    afterEach(async () => {
        await server.close();
        await fs.rm(sherpaDir, { recursive: true, force: true });
        await fs.rm(workDir, { recursive: true, force: true });
    });

    /** Сдвиг инжектированных часов: единственный способ протухания в этих тестах. */
    function advance(seconds: number): void {
        nowMs += seconds * 1000;
    }

    function enqueue(instructions: string, priority: PriorityClass = 'interactive'): number {
        return server.queue.enqueue({
            type: 'echo',
            priority,
            instructions,
            contextFiles: ['/tmp/sherpa/task-context.md'],
        }).id;
    }

    /** Путь, который `worker next` выдаёт текущей сессии: tmp процесса воркера — `workDir`. */
    async function resultFileOf(taskId: number, attempt: number): Promise<string> {
        const workerId = (await fs.readFile(workerIdPathFor(sherpaDir, PR_KEY), 'utf8')).trim();
        return taskResultFileFor(taskResultDirFor(workDir, sherpaDir, PR_KEY, workerId), { id: taskId, attempt });
    }

    it('умер молча: аренда протухла, задачу доделывает новая сессия', async () => {
        await worker.register('claude-code');
        const taskId = enqueue('Перескажи дифф.');

        const issued = await worker.next();
        expect(issued.taskId).toBe(taskId);
        expect(issued.stdout).toContain('attempt 1');
        // Путь результата — под tmp процесса, свой у каждой сессии и попытки.
        const firstFile = await resultFileOf(taskId, 1);
        expect(issued.stdout).toContain(`--file ${firstFile}`);

        // Сессия исчезла молча: больше ни одного вызова, ждать нечего — двигаем часы.
        advance(PAST_LEASE_SECONDS);

        const reconnect = await worker.register('claude-code');
        expect(reconnect.code).toBe(0);

        const reissued = await worker.next();
        expect(reissued.taskId).toBe(taskId);
        expect(reissued.stdout).toContain('attempt 2');
        const secondFile = await resultFileOf(taskId, 2);
        expect(path.dirname(secondFile)).not.toBe(path.dirname(firstFile));
        expect(reissued.stdout).toContain(`--file ${secondFile}`);

        const completed = await worker.complete(taskId, 'Ответ второй сессии.');
        expect(completed.code).toBe(0);
        expect(completed.stdout).toContain('accepted');
        expect(server.queue.getTask(taskId)).toMatchObject({
            status: 'done',
            result: 'Ответ второй сессии.',
            attempt: 2,
        });
    });

    it('вернул мусор: пустой результат отбит, задача остаётся за воркером и сдаётся со второй попытки', async () => {
        await worker.register();
        const taskId = enqueue('Верни текст.');
        await worker.next();

        const rejected = await worker.complete(taskId, '   \n\t');
        // rejected — диалог с моделью: код нулевой, в выводе список ошибок и та же команда сдачи.
        expect(rejected.code).toBe(0);
        expect(rejected.stdout).toContain('rejected');
        expect(rejected.stdout).toContain('1. ');
        expect(rejected.stdout).toContain(
            `devflow-diff-explain task complete ${String(taskId)} --file ${path.join(workDir, 'result-1.md')}`,
        );
        expect(server.queue.getTask(taskId)).toMatchObject({ status: 'leased', result: null });

        const accepted = await worker.complete(taskId, 'Нормальный результат.');
        expect(accepted.code).toBe(0);
        expect(accepted.stdout).toContain('accepted');
        expect(server.queue.getTask(taskId)).toMatchObject({ status: 'done', result: 'Нормальный результат.' });
    });

    it('повторил complete: второй вызов — no-op, результат не перезаписан', async () => {
        await worker.register();
        const taskId = enqueue('Верни текст.');
        await worker.next();
        await worker.complete(taskId, 'Первый результат.');

        const repeated = await worker.complete(taskId, 'Второй, случайный результат.');

        expect(repeated.code).toBe(0);
        expect(repeated.stdout).toContain('is already finished');
        expect(repeated.stdout).toContain('devflow-diff-explain worker next');
        expect(server.queue.getTask(taskId)).toMatchObject({ status: 'done', result: 'Первый результат.' });
    });

    it('превысил lease и потом сдал: complete отбит, но работа не теряется', async () => {
        await worker.register();
        const taskId = enqueue('Долгая задача.');
        await worker.next();

        advance(PAST_LEASE_SECONDS);

        const late = await worker.complete(taskId, 'Результат опоздавшего.');
        expect(late.code).toBe(1);
        // Грейс-периода нет, но текст ведёт обратно в петлю, а не в тупик.
        expect(late.stderr).toContain('worker next');
        expect(late.stderr).not.toContain('lease_not_held');
        expect(server.queue.getTask(taskId)).toMatchObject({ status: 'queued', attempt: 2, workerId: null });

        const reissued = await worker.next();
        expect(reissued.taskId).toBe(taskId);
        expect(reissued.stdout).toContain('attempt 2');

        const accepted = await worker.complete(taskId, 'Результат опоздавшего.');
        expect(accepted.code).toBe(0);
        expect(accepted.stdout).toContain('accepted');
        expect(server.queue.getTask(taskId)).toMatchObject({ status: 'done', result: 'Результат опоздавшего.' });
    });

    it('отмена во время аренды: воркер узнаёт об этом при следующем вызове, задача не воскресает', async () => {
        await worker.register();
        const taskId = enqueue('Отменяемая задача.');
        await worker.next();

        expect(server.queue.cancel(taskId)).toBe('cancelled');

        // Прервать сессию нельзя (`docs/protocol.md §5`): и progress, и complete отвечают no-op с текстом отмены.
        const progress = await worker.progress(taskId, 'всё ещё работаю');
        expect(progress.code).toBe(0);
        expect(progress.stdout).toContain('has been cancelled');
        expect(progress.stdout).toContain('devflow-diff-explain worker next');

        const completed = await worker.complete(taskId, 'Результат по отменённой.');
        expect(completed.code).toBe(0);
        expect(completed.stdout).toContain('has been cancelled');
        expect(server.queue.getTask(taskId)).toMatchObject({ status: 'cancelled', result: null });

        // Отменённая задача повторно не выдаётся: следующий next берёт только новую.
        const fresh = enqueue('Задача после отмены.');
        const next = await worker.next();
        expect(next.taskId).toBe(fresh);
    });

    it('реконнект: задача достаётся новой сессии сразу, старой сказано остановить цикл', async () => {
        await worker.register('claude-code');
        const taskId = enqueue('Задача первой сессии.');
        await worker.next();
        const deadWorkerId = await worker.workerId();

        // Сессия A молчит дольше срока смерти; аренда её задачи сама истекла бы только через минуты.
        advance(400);
        const reconnected = await worker.register('claude-code');
        expect(reconnected.code).toBe(0);
        expect(await worker.workerId()).not.toBe(deadWorkerId);

        // Перехват слота вернул аренду мёртвой сессии в очередь — TTL ждать не нужно (`docs/protocol.md §7`).
        const reissued = await worker.next();
        expect(reissued.taskId).toBe(taskId);
        expect(reissued.stdout).toContain('attempt 2');
        await worker.complete(taskId, 'Ответ второй сессии.');
        expect(server.queue.getTask(taskId)).toMatchObject({ status: 'done' });

        // Сессия A ожила и полезла за задачей: слот уже не её — петлю продолжать нечем.
        const ghost = await worker.as(deadWorkerId).next();
        expect(ghost.code).toBe(1);
        expect(ghost.stderr).toContain('stop the loop');
        expect(ghost.stderr).not.toContain('worker_conflict');
    });

    it('попытки исчерпаны: трижды выдана и трижды протухла — задача уходит в ошибку', async () => {
        await worker.register();
        const taskId = enqueue('Никем не доделанная задача.');

        for (let attempt = 1; attempt <= MAX_TASK_ATTEMPTS; attempt += 1) {
            const issued = await worker.next();
            expect(issued.taskId).toBe(taskId);
            expect(issued.stdout).toContain(`attempt ${String(attempt)}`);
            advance(PAST_LEASE_SECONDS);
        }

        // Исчерпанная задача четвёртый раз не выдаётся: next берёт следующую.
        const fresh = enqueue('Следующая задача.');
        const next = await worker.next();
        expect(next.taskId).toBe(fresh);
        expect(server.queue.getTask(taskId)).toMatchObject({ status: 'failed', workerId: null });
        expect(server.queue.getTask(taskId)?.failReason).toContain('попытки исчерпаны');
    });

    it('приоритет под нагрузкой: интерактивная обгоняет ранее поставленную фоновую', async () => {
        await worker.register();
        const background = enqueue('Фоновая задача.', 'background');
        const interactive = enqueue('Интерактивная задача.', 'interactive');

        const first = await worker.next();
        expect(first.taskId).toBe(interactive);
        expect(first.stdout).toContain('Интерактивная задача.');

        await worker.complete(interactive, 'Ответ по интерактивной.');
        const second = await worker.next();
        expect(second.taskId).toBe(background);
    });
});

import fs from 'node:fs/promises';

import type { WorkerRegisterResponse, WorkerStatus } from '@sherpa/protocol';
import {
    PROTOCOL_VERSION,
    RESULT_MAX_BYTES,
    VERDICTS_INSTRUCTION_MAX_CHARS,
    rpcErrorSchema,
    taskAckResponseSchema,
    taskCompleteResponseSchema,
    UI_ENDPOINTS,
    WORKER_DEAD_AFTER_SECONDS,
    WORKER_ENDPOINTS,
    workerNextResponseSchema,
    workerRegisterResponseSchema,
} from '@sherpa/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { selectReviewHost } from './hosts/select.js';
import { REQUEST_BODY_MAX_BYTES } from './http.js';
import { workerIdPathFor } from './paths.js';
import type { SherpaServer } from './server.js';
import { startServer } from './server.js';
import { makeTempSherpaDir, postJson, postRaw, removeTempSherpaDir } from './test-support.js';

const PR_KEY = 'arcanum-777';
const WORKER = 'w-1';
const BASE = { protocolVersion: PROTOCOL_VERSION, cliVersion: '0.1.0', workerId: WORKER };

describe('воркерские ручки', () => {
    let sherpaDir: string;
    let servers: SherpaServer[];
    /** Сдвиг серверных часов: смерть воркера наступает через 6 минут, ждать их в тесте нечего. */
    let clockOffsetMs: number;

    beforeEach(async () => {
        sherpaDir = await makeTempSherpaDir();
        servers = [];
        clockOffsetMs = 0;
    });

    afterEach(async () => {
        for (const server of servers) {
            await server.close();
        }
        await removeTempSherpaDir(sherpaDir);
    });

    /** Окно long-poll задаётся тестом: ждать контрактные 4 минуты в тестах незачем. */
    async function start(longPollSeconds = 0.3): Promise<SherpaServer> {
        const server = await startServer({
            prKey: PR_KEY,
            sherpaDir,
            longPollSeconds,
            now: () => new Date(Date.now() + clockOffsetMs),
            // Живой Арканум в тестах запрещён (docs/testing.md): без хоста прогрев маршрута не ходит в сеть.
            reviewHostFactory: () => null,
        });
        servers.push(server);
        return server;
    }

    async function startWithShortUiGrace(longPollSeconds = 30): Promise<SherpaServer> {
        const server = await startServer({
            prKey: PR_KEY,
            sherpaDir,
            longPollSeconds,
            uiGoneGraceSeconds: 0.1,
            now: () => new Date(Date.now() + clockOffsetMs),
            reviewHostFactory: () => null,
        });
        servers.push(server);
        return server;
    }

    function advanceServerClock(seconds: number): void {
        clockOffsetMs += seconds * 1000;
    }

    function enqueueEcho(server: SherpaServer, instructions = 'Верни содержимое файла как есть.'): number {
        return server.queue.enqueue({
            type: 'echo',
            priority: 'interactive',
            instructions,
            contextFiles: ['/tmp/sherpa/task-context.md'],
        }).id;
    }

    async function openUi(server: SherpaServer): Promise<() => Promise<void>> {
        const controller = new AbortController();
        const response = await fetch(
            `http://127.0.0.1:${String(server.port)}${UI_ENDPOINTS.events}?token=${server.token}`,
            { signal: controller.signal },
        );
        expect(response.status).toBe(200);
        if (response.body === null) {
            throw new Error('SSE-канал UI открылся без тела');
        }

        const reader = response.body.getReader();
        await reader.read();
        return async () => {
            controller.abort();
            await reader.cancel().catch(() => undefined);
        };
    }

    describe('граница запроса', () => {
        it('без токена — 401, ручка не выполняется', async () => {
            const server = await start();

            const response = await postJson(server.port, WORKER_ENDPOINTS.next, BASE);

            expect(response.status).toBe(401);
            expect(rpcErrorSchema.parse(await response.json()).error.code).toBe('unauthorized');
        });

        it('несовместимая версия протокола — version_incompatible с человеческим текстом', async () => {
            const server = await start();

            const response = await postJson(
                server.port,
                WORKER_ENDPOINTS.next,
                { ...BASE, protocolVersion: '9.9.9' },
                server.token,
            );

            expect(response.status).toBe(409);
            const body = rpcErrorSchema.parse(await response.json());
            expect(body.error.code).toBe('version_incompatible');
            expect(body.error.message).toContain('Update the skill');
        });

        it('кривое тело и нарушенная схема — bad_request со списком деталей', async () => {
            const server = await start();

            const broken = await postRaw(server.port, WORKER_ENDPOINTS.next, '{не json', server.token);
            expect(broken.status).toBe(400);
            expect(rpcErrorSchema.parse(await broken.json()).error.code).toBe('bad_request');

            const invalid = await postJson(server.port, WORKER_ENDPOINTS.next, { workerId: '' }, server.token);
            expect(invalid.status).toBe(400);
            const body = rpcErrorSchema.parse(await invalid.json());
            expect(body.error.code).toBe('bad_request');
            expect(body.error.details?.length).toBeGreaterThan(0);
        });

        it('тело больше лимита — bad_request, а не обрыв соединения', async () => {
            const server = await start();

            const response = await postJson(
                server.port,
                WORKER_ENDPOINTS.complete,
                { ...BASE, taskId: 1, result: 'x'.repeat(REQUEST_BODY_MAX_BYTES + 1024) },
                server.token,
            );

            expect(response.status).toBe(400);
            const body = rpcErrorSchema.parse(await response.json());
            expect(body.error.code).toBe('bad_request');
            expect(body.error.message).toContain(String(REQUEST_BODY_MAX_BYTES));
        });
    });

    describe('register', () => {
        it('регистрация сессии: подтверждение и статус воркера с харнесом и моделью', async () => {
            const server = await start();

            const response = await postJson(
                server.port,
                WORKER_ENDPOINTS.register,
                { ...BASE, harness: 'claude-code', model: 'claude-opus-5' },
                server.token,
            );

            expect(response.status).toBe(200);
            const body = workerRegisterResponseSchema.parse(await response.json());
            expect(body.kind).toBe('registered');
            expect(body.message).toContain('devflow-diff-explain worker next');
            expect(server.workerRegistry.status()).toMatchObject({
                kind: 'connected',
                workerId: WORKER,
                harness: 'claude-code',
                model: 'claude-opus-5',
            });
        });

        it('метка языка сессии доезжает до статуса воркера, без неё поля нет', async () => {
            const server = await start();

            await postJson(server.port, WORKER_ENDPOINTS.register, { ...BASE, lang: 'ru' }, server.token);
            expect(server.workerRegistry.status()).toMatchObject({ lang: 'ru' });

            await postJson(
                server.port,
                WORKER_ENDPOINTS.register,
                { ...BASE, workerId: 'w-no-lang' },
                server.token,
            );
            expect(server.workerRegistry.status()).not.toHaveProperty('lang');
        });

        it('вторая сессия перехватывает слот у живой первой', async () => {
            const server = await start();
            await postJson(server.port, WORKER_ENDPOINTS.register, { ...BASE, harness: 'claude-code' }, server.token);

            const response = await postJson(
                server.port,
                WORKER_ENDPOINTS.register,
                { ...BASE, workerId: 'w-2', harness: 'codex' },
                server.token,
            );

            expect(response.status).toBe(200);
            expect(workerRegisterResponseSchema.parse(await response.json()).kind).toBe('registered');
            expect(server.workerRegistry.status()).toMatchObject({
                kind: 'connected',
                workerId: 'w-2',
                harness: 'codex',
            });

            // Вытесненная сессия узнаёт об этом на своём следующем вызове — и только там.
            const displaced = await postJson(server.port, WORKER_ENDPOINTS.next, BASE, server.token);
            expect(displaced.status).toBe(409);
            const body = rpcErrorSchema.parse(await displaced.json());
            expect(body.error.code).toBe('worker_conflict');
            expect(body.error.message).toContain('Another live session');
            expect(body.error.message).toContain('codex');
        });

        it('рукопожатие версий проверяется и здесь', async () => {
            const server = await start();

            const response = await postJson(
                server.port,
                WORKER_ENDPOINTS.register,
                { ...BASE, protocolVersion: '9.9.9' },
                server.token,
            );

            expect(response.status).toBe(409);
            expect(rpcErrorSchema.parse(await response.json()).error.code).toBe('version_incompatible');
            expect(server.workerRegistry.status().kind).toBe('never');
        });

        // Живой сервер аргументов запуска не видит: режим вердиктов локального ревью едет регистрацией `up`.
        it('поручение localVerdicts доезжает до хоста, без поля режим не трогается', async () => {
            const calls: (string | null)[] = [];
            const fixture = selectReviewHost('fixture-small');
            if (fixture === null) {
                throw new Error('фикстурный хост не выбрался');
            }
            const server = await startServer({
                prKey: PR_KEY,
                sherpaDir,
                longPollSeconds: 0.3,
                reviewHostFactory: () => ({
                    ...fixture,
                    setLocalVerdicts: (instruction) => {
                        calls.push(instruction);
                        return true;
                    },
                }),
            });
            servers.push(server);

            const register = async (body: object): Promise<WorkerRegisterResponse> =>
                workerRegisterResponseSchema.parse(
                    await (await postJson(server.port, WORKER_ENDPOINTS.register, body, server.token)).json(),
                );

            // Эхо называет применённое поручение: по нему CLI отличает сервер, который поле понял.
            expect((await register({ ...BASE, localVerdicts: 'on ship, open a PR' })).localVerdicts).toBe(
                'on ship, open a PR',
            );
            expect((await register(BASE)).localVerdicts).toBeUndefined();
            expect((await register({ ...BASE, localVerdicts: 'on ship, merge' })).localVerdicts).toBe('on ship, merge');
            expect((await register({ ...BASE, localVerdicts: null })).localVerdicts).toBeNull();

            expect(calls).toEqual(['on ship, open a PR', 'on ship, merge', null]);
        });

        it('пустое и слишком длинное поручение сервер отклоняет схемой', async () => {
            const server = await start();

            for (const localVerdicts of ['  ', 'x'.repeat(VERDICTS_INSTRUCTION_MAX_CHARS + 1)]) {
                const response = await postJson(
                    server.port,
                    WORKER_ENDPOINTS.register,
                    { ...BASE, localVerdicts },
                    server.token,
                );
                expect(response.status).toBe(400);
            }
            expect(server.workerRegistry.status().kind).toBe('never');
        });

        it('localVerdicts на хосте без режима вердиктов ничего не ломает и эха не получает', async () => {
            const server = await start();

            const response = await postJson(
                server.port,
                WORKER_ENDPOINTS.register,
                { ...BASE, localVerdicts: 'on ship, open a PR' },
                server.token,
            );

            expect(response.status).toBe(200);
            expect(workerRegisterResponseSchema.parse(await response.json()).localVerdicts).toBeUndefined();
        });

        it('после смерти прежней сессии регистрация проходит', async () => {
            const server = await start();
            await postJson(server.port, WORKER_ENDPOINTS.register, BASE, server.token);
            advanceServerClock(WORKER_DEAD_AFTER_SECONDS + 1);

            const response = await postJson(
                server.port,
                WORKER_ENDPOINTS.register,
                { ...BASE, workerId: 'w-2' },
                server.token,
            );

            expect(response.status).toBe(200);
            expect(server.workerRegistry.status()).toMatchObject({ kind: 'connected', workerId: 'w-2' });
        });
    });

    describe('heartbeat', () => {
        it('вызов next регистрирует сессию воркером, даже без register', async () => {
            const server = await start();

            await postJson(server.port, WORKER_ENDPOINTS.next, BASE, server.token);

            expect(server.workerRegistry.status()).toMatchObject({ kind: 'connected', workerId: WORKER });
        });

        it('чужая сессия отбивается до обращения к очереди', async () => {
            const server = await start();
            const taskId = enqueueEcho(server);
            await postJson(server.port, WORKER_ENDPOINTS.next, BASE, server.token);

            const response = await postJson(
                server.port,
                WORKER_ENDPOINTS.complete,
                { ...BASE, workerId: 'w-2', taskId, result: 'чужой результат' },
                server.token,
            );

            expect(response.status).toBe(409);
            // Именно worker_conflict, а не lease_not_held: до очереди запрос не дошёл.
            expect(rpcErrorSchema.parse(await response.json()).error.code).toBe('worker_conflict');
            expect(server.queue.getTask(taskId)).toMatchObject({ status: 'leased', workerId: WORKER });
        });

        it('висящий long-poll держит сессию живой: без чужой регистрации слот остаётся за ней', async () => {
            const server = await start(30);
            const pending = postJson(server.port, WORKER_ENDPOINTS.next, BASE, server.token);
            await new Promise((resolve) => setTimeout(resolve, 50));

            // Часы ушли далеко за срок смерти, но сессия висит в вызове — соединение держит её живой.
            advanceServerClock(WORKER_DEAD_AFTER_SECONDS + 1);
            expect(server.workerRegistry.status()).toMatchObject({ kind: 'connected', workerId: WORKER });

            // Чужой heartbeat слот не отбирает — на это способна только регистрация новой сессии.
            const foreign = await postJson(
                server.port,
                WORKER_ENDPOINTS.next,
                { ...BASE, workerId: 'w-2' },
                server.token,
            );
            expect(foreign.status).toBe(409);
            expect(rpcErrorSchema.parse(await foreign.json()).error.code).toBe('worker_conflict');

            const taskId = enqueueEcho(server, 'задача владельца слота');
            const response = await pending;
            expect(response.status).toBe(200);
            const body = workerNextResponseSchema.parse(await response.json());
            expect(body.kind === 'task' && body.task.id).toBe(taskId);
        });
    });

    describe('перехват слота', () => {
        it('регистрация новой сессии будит висящий long-poll вытесненной сразу', async () => {
            const server = await start(30);
            const pending = postJson(server.port, WORKER_ENDPOINTS.next, BASE, server.token);
            await new Promise((resolve) => setTimeout(resolve, 50));

            const started = Date.now();
            const registered = await postJson(
                server.port,
                WORKER_ENDPOINTS.register,
                { ...BASE, workerId: 'w-2', harness: 'codex' },
                server.token,
            );
            expect(registered.status).toBe(200);

            const response = await pending;
            // Быстрее страховочного тика опроса очереди и несопоставимо быстрее окна long-poll:
            // вытесненная сессия получает «stop the loop» в ту же секунду.
            expect(Date.now() - started).toBeLessThan(500);
            expect(response.status).toBe(409);
            expect(rpcErrorSchema.parse(await response.json()).error.code).toBe('worker_conflict');
            expect(server.workerRegistry.status()).toMatchObject({ kind: 'connected', workerId: 'w-2' });
        });

        it('аренда вытесненной сессии возвращается в очередь и достаётся новой', async () => {
            const server = await start();
            const taskId = enqueueEcho(server);
            const issued = await postJson(server.port, WORKER_ENDPOINTS.next, BASE, server.token);
            expect(workerNextResponseSchema.parse(await issued.json()).kind).toBe('task');

            await postJson(server.port, WORKER_ENDPOINTS.register, { ...BASE, workerId: 'w-2' }, server.token);

            // TTL аренды ждать не нужно: перехват вернул задачу в очередь сразу.
            expect(server.queue.getTask(taskId)).toMatchObject({ status: 'queued', workerId: null });
            const reissued = workerNextResponseSchema.parse(
                await (
                    await postJson(server.port, WORKER_ENDPOINTS.next, { ...BASE, workerId: 'w-2' }, server.token)
                ).json(),
            );
            expect(reissued).toMatchObject({ kind: 'task', task: { id: taskId, attempt: 2 } });

            // Опоздавший результат прежней сессии не сохраняется: её вызов не доходит до очереди.
            const late = await postJson(
                server.port,
                WORKER_ENDPOINTS.complete,
                { ...BASE, taskId, result: 'результат вытесненной сессии' },
                server.token,
            );
            expect(late.status).toBe(409);
            expect(rpcErrorSchema.parse(await late.json()).error.code).toBe('worker_conflict');
            expect(server.queue.getTask(taskId)).toMatchObject({ status: 'leased', workerId: 'w-2' });
        });
    });

    describe('файл идентичности воркера', () => {
        async function readWorkerIdFile(): Promise<string> {
            return (await fs.readFile(workerIdPathFor(sherpaDir, PR_KEY), 'utf8')).trim();
        }

        it('register записывает владельца слота в файл стейта PR, доступный только владельцу', async () => {
            const server = await start();

            await postJson(server.port, WORKER_ENDPOINTS.register, BASE, server.token);
            expect(await readWorkerIdFile()).toBe(WORKER);

            // Перехват переписывает файл: следующие вызовы сессии берут идентичность оттуда.
            await postJson(server.port, WORKER_ENDPOINTS.register, { ...BASE, workerId: 'w-2' }, server.token);
            expect(await readWorkerIdFile()).toBe('w-2');

            const stats = await fs.stat(workerIdPathFor(sherpaDir, PR_KEY));
            expect(stats.mode & 0o777).toBe(0o600);
        });

        it('в файле остаётся владелец слота, а не победитель гонки параллельных регистраций', async () => {
            const server = await start();

            // Обе регистрации проходят (конфликта на register больше нет), слот достаётся одной из
            // них — и файл обязан описывать именно её, каким бы ни был порядок ответов по сети.
            const responses = await Promise.all([
                postJson(server.port, WORKER_ENDPOINTS.register, { ...BASE, workerId: 'w-a' }, server.token),
                postJson(server.port, WORKER_ENDPOINTS.register, { ...BASE, workerId: 'w-b' }, server.token),
            ]);

            expect(responses.map((response) => response.status)).toEqual([200, 200]);
            const status = server.workerRegistry.status();
            expect(await readWorkerIdFile()).toBe(status.kind === 'never' ? null : status.workerId);
        });

        it('незаписываемый файл — internal с указанием остановить петлю: слот занят, а идентичность нет', async () => {
            const server = await start();
            // Каталог на месте файла: запись сорвётся так же, как при отобранных правах.
            await fs.mkdir(workerIdPathFor(sherpaDir, PR_KEY), { recursive: true });

            const response = await postJson(server.port, WORKER_ENDPOINTS.register, BASE, server.token);

            expect(response.status).toBe(500);
            const body = rpcErrorSchema.parse(await response.json());
            expect(body.error.code).toBe('internal');
            expect(body.error.message).toContain('identity file');
        });
    });

    describe('смерть по обрыву соединения', () => {
        /** Грейс паузы между вызовами: тесту незачем ждать минуту. */
        const GAP_GRACE_SECONDS = 0.3;

        async function startWithShortGrace(longPollSeconds: number): Promise<SherpaServer> {
            const server = await startServer({
                prKey: PR_KEY,
                sherpaDir,
                longPollSeconds,
                workerGapGraceSeconds: GAP_GRACE_SECONDS,
                now: () => new Date(Date.now() + clockOffsetMs),
                reviewHostFactory: () => null,
            });
            servers.push(server);
            return server;
        }

        /** Ждёт события «агент отключён» — именно события, а не опроса: его рождает таймер сервера. */
        function disconnection(server: SherpaServer, timeoutMs: number): Promise<WorkerStatus> {
            return new Promise<WorkerStatus>((resolve, reject) => {
                const timer = setTimeout(() => {
                    unsubscribe();
                    reject(new Error(`события об отключении не было за ${String(timeoutMs)} мс`));
                }, timeoutMs);
                const unsubscribe = server.workerRegistry.subscribe((status) => {
                    if (status.kind !== 'disconnected') {
                        return;
                    }
                    clearTimeout(timer);
                    unsubscribe();
                    resolve(status);
                });
            });
        }

        it('оборванный long-poll простаивающей сессии признаётся смертью за грейс', async () => {
            const server = await startWithShortGrace(30);
            const aborter = new AbortController();
            const pending = postJson(server.port, WORKER_ENDPOINTS.next, BASE, server.token, aborter.signal).catch(
                () => null,
            );
            await new Promise((resolve) => setTimeout(resolve, 50));
            expect(server.workerRegistry.status().kind).toBe('connected');

            // Сессию убили: ОС закрыла сокет, входящих запросов больше не будет.
            const dead = disconnection(server, 2000);
            aborter.abort();
            await pending;

            expect(await dead).toMatchObject({ kind: 'disconnected', workerId: WORKER });
        });

        it('сессия со взятой задачей обрыв соединения переживает', async () => {
            const server = await startWithShortGrace(0.3);
            const taskId = enqueueEcho(server);
            const issued = await postJson(server.port, WORKER_ENDPOINTS.next, BASE, server.token);
            expect(workerNextResponseSchema.parse(await issued.json()).kind).toBe('task');

            // Молчание с арендой законно: модель минутами читает файлы, а грейс паузы тут ни при чём.
            advanceServerClock(WORKER_DEAD_AFTER_SECONDS - 1);
            await new Promise((resolve) => setTimeout(resolve, 100));

            expect(server.workerRegistry.status()).toMatchObject({ kind: 'connected', workerId: WORKER });
            expect(server.queue.getTask(taskId)).toMatchObject({ status: 'leased', workerId: WORKER });

            advanceServerClock(2);
            expect(server.workerRegistry.status().kind).toBe('disconnected');
        });
    });

    describe('next', () => {
        it('пустая очередь — idle по исчерпании окна long-poll', async () => {
            const server = await start(0.3);

            const started = Date.now();
            const response = await postJson(server.port, WORKER_ENDPOINTS.next, BASE, server.token);
            const elapsed = Date.now() - started;

            expect(response.status).toBe(200);
            const body = workerNextResponseSchema.parse(await response.json());
            expect(body.kind).toBe('idle');
            expect(elapsed).toBeGreaterThanOrEqual(250);
        });

        it('живой UI сохраняет прежний ответ idle', async () => {
            const server = await startWithShortUiGrace(0.3);
            const closeUi = await openUi(server);

            const response = await postJson(server.port, WORKER_ENDPOINTS.next, BASE, server.token);

            expect(workerNextResponseSchema.parse(await response.json()).kind).toBe('idle');
            await closeUi();
        });

        it('уход UI будит висящий long-poll и сразу возвращает done', async () => {
            const server = await startWithShortUiGrace();
            const closeUi = await openUi(server);
            const pending = postJson(server.port, WORKER_ENDPOINTS.next, BASE, server.token);
            await new Promise((resolve) => setTimeout(resolve, 50));

            const started = Date.now();
            await closeUi();
            const body = workerNextResponseSchema.parse(await (await pending).json());

            expect(body.kind).toBe('done');
            expect(body.kind === 'done' && body.message).toContain('закрыл вкладку');
            expect(Date.now() - started).toBeLessThan(1000);
        });

        it('уход UI не обрывает открытую задачу, done приходит после её завершения', async () => {
            const server = await startWithShortUiGrace();
            const closeUi = await openUi(server);
            const taskId = enqueueEcho(server);
            const issued = workerNextResponseSchema.parse(
                await (await postJson(server.port, WORKER_ENDPOINTS.next, BASE, server.token)).json(),
            );
            expect(issued).toMatchObject({ kind: 'task', task: { id: taskId } });

            await closeUi();
            await new Promise((resolve) => setTimeout(resolve, 150));

            const stillWorking = workerNextResponseSchema.parse(
                await (await postJson(server.port, WORKER_ENDPOINTS.next, BASE, server.token)).json(),
            );
            expect(stillWorking).toMatchObject({ kind: 'task', task: { id: taskId } });

            await postJson(
                server.port,
                WORKER_ENDPOINTS.complete,
                { ...BASE, taskId, result: 'готово' },
                server.token,
            );
            const finished = workerNextResponseSchema.parse(
                await (await postJson(server.port, WORKER_ENDPOINTS.next, BASE, server.token)).json(),
            );
            expect(finished.kind).toBe('done');
        });

        it('done снимает держание отменённой задачи: ушедшая сессия не выглядит занятой', async () => {
            const server = await startWithShortUiGrace();
            const closeUi = await openUi(server);
            const taskId = enqueueEcho(server);
            const issued = workerNextResponseSchema.parse(
                await (await postJson(server.port, WORKER_ENDPOINTS.next, BASE, server.token)).json(),
            );
            expect(issued).toMatchObject({ kind: 'task', task: { id: taskId } });

            expect(server.queue.cancel(taskId)).toBe('cancelled');
            expect(server.queue.getTask(taskId)).toMatchObject({ status: 'cancelled', workerId: BASE.workerId });

            await closeUi();
            await new Promise((resolve) => setTimeout(resolve, 150));
            const finished = workerNextResponseSchema.parse(
                await (await postJson(server.port, WORKER_ENDPOINTS.next, BASE, server.token)).json(),
            );

            expect(finished.kind).toBe('done');
            expect(server.queue.getTask(taskId)).toMatchObject({
                status: 'cancelled',
                workerId: null,
                leaseExpiresAt: null,
            });
        });

        it('задача, поставленная во время ожидания, отдаётся сразу', async () => {
            const server = await start(30);

            const started = Date.now();
            const pending = postJson(server.port, WORKER_ENDPOINTS.next, BASE, server.token);
            await new Promise((resolve) => setTimeout(resolve, 50));
            const taskId = enqueueEcho(server, 'проснись и выдай задачу');

            const body = workerNextResponseSchema.parse(await (await pending).json());
            const elapsed = Date.now() - started;

            expect(body).toMatchObject({ kind: 'task', task: { id: taskId, type: 'echo', attempt: 1 } });
            expect(elapsed).toBeLessThan(5000);
        });

        it('окно берётся из опции сервера', async () => {
            const server = await start(0.3);

            const started = Date.now();
            const response = await postJson(server.port, WORKER_ENDPOINTS.next, BASE, server.token);
            const elapsed = Date.now() - started;

            expect(workerNextResponseSchema.parse(await response.json()).kind).toBe('idle');
            expect(elapsed).toBeGreaterThanOrEqual(250);
            expect(elapsed).toBeLessThan(10_000);
        });

        /**
         * Регрессия №35: срок смерти считается по молчанию, а висящий `next` молчанием не является —
         * иначе честно ждущий час воркер числился бы мёртвым, и UI рисовал бы «агент отключён».
         */
        it('длинное ожидание не делает воркера мёртвым: статус connected всё окно', async () => {
            const server = await start(30);
            const pending = postJson(server.port, WORKER_ENDPOINTS.next, BASE, server.token);
            await new Promise((resolve) => setTimeout(resolve, 50));

            // Часы ушли далеко за срок смерти — соединение вызова держит сессию живой.
            advanceServerClock(WORKER_DEAD_AFTER_SECONDS + 1);
            expect(server.workerRegistry.status()).toMatchObject({ kind: 'connected', workerId: WORKER });

            await new Promise((resolve) => setTimeout(resolve, 500));
            expect(server.workerRegistry.status()).toMatchObject({ kind: 'connected', workerId: WORKER });

            const taskId = enqueueEcho(server, 'задача после долгого ожидания');
            const body = workerNextResponseSchema.parse(await (await pending).json());
            expect(body).toMatchObject({ kind: 'task', task: { id: taskId } });
        });

        it('оборванный клиентом long-poll не забирает задачу в аренду', async () => {
            const server = await start(30);
            const controller = new AbortController();
            const pending = postJson(server.port, WORKER_ENDPOINTS.next, BASE, server.token, controller.signal).catch(
                () => null,
            );

            await new Promise((resolve) => setTimeout(resolve, 50));
            controller.abort();
            await pending;
            // Обрыв доходит до сервера асинхронно — задачу ставим уже после того, как он его заметил.
            await new Promise((resolve) => setTimeout(resolve, 100));

            const taskId = enqueueEcho(server);
            // Заметно дольше страховочного опроса: если бы ожидание было живо, аренда уже выдалась бы.
            await new Promise((resolve) => setTimeout(resolve, 1500));

            expect(server.queue.getTask(taskId)).toMatchObject({ status: 'queued', workerId: null });
        });
    });

    describe('петля задачи', () => {
        it('next → progress → complete проходит целиком', async () => {
            const server = await start();
            const taskId = enqueueEcho(server);

            const next = workerNextResponseSchema.parse(
                await (await postJson(server.port, WORKER_ENDPOINTS.next, BASE, server.token)).json(),
            );
            expect(next).toMatchObject({
                kind: 'task',
                task: { id: taskId, contextFiles: ['/tmp/sherpa/task-context.md'] },
                lease: { taskId, ttlSeconds: 600 },
            });

            const progress = await postJson(
                server.port,
                WORKER_ENDPOINTS.progress,
                { ...BASE, taskId, text: 'читаю контекст' },
                server.token,
            );
            expect(taskAckResponseSchema.parse(await progress.json()).kind).toBe('accepted');

            const complete = await postJson(
                server.port,
                WORKER_ENDPOINTS.complete,
                { ...BASE, taskId, result: 'эхо' },
                server.token,
            );
            expect(taskCompleteResponseSchema.parse(await complete.json()).kind).toBe('accepted');

            const record = server.queue.getTask(taskId);
            expect(record).toMatchObject({ status: 'done', result: 'эхо', progressText: 'читаю контекст' });

            const repeated = await postJson(
                server.port,
                WORKER_ENDPOINTS.complete,
                { ...BASE, taskId, result: 'эхо' },
                server.token,
            );
            expect(taskCompleteResponseSchema.parse(await repeated.json()).kind).toBe('noop');
        });

        it('явный отказ закрывает задачу ошибкой', async () => {
            const server = await start();
            const taskId = enqueueEcho(server);
            await postJson(server.port, WORKER_ENDPOINTS.next, BASE, server.token);

            const response = await postJson(
                server.port,
                WORKER_ENDPOINTS.fail,
                { ...BASE, taskId, reason: 'нет доступа к файлу' },
                server.token,
            );

            expect(taskAckResponseSchema.parse(await response.json()).kind).toBe('accepted');
            expect(server.queue.getTask(taskId)).toMatchObject({ status: 'failed', failReason: 'нет доступа к файлу' });
        });

        it('несуществующая задача — unknown_task', async () => {
            const server = await start();

            const response = await postJson(
                server.port,
                WORKER_ENDPOINTS.complete,
                { ...BASE, taskId: 4040, result: 'в никуда' },
                server.token,
            );

            expect(response.status).toBe(404);
            expect(rpcErrorSchema.parse(await response.json()).error.code).toBe('unknown_task');
        });

        it('слишком большой результат — ошибка задачи, а не отказ валидации запроса', async () => {
            const server = await start();
            const taskId = enqueueEcho(server);
            await postJson(server.port, WORKER_ENDPOINTS.next, BASE, server.token);

            const response = await postJson(
                server.port,
                WORKER_ENDPOINTS.complete,
                { ...BASE, taskId, result: 'я'.repeat(RESULT_MAX_BYTES / 2 + 1) },
                server.token,
            );

            expect(response.status).toBe(413);
            expect(rpcErrorSchema.parse(await response.json()).error.code).toBe('result_too_large');
            expect(server.queue.getTask(taskId)?.status).toBe('failed');
        });
    });

    it('остановка сервера не ждёт висящий long-poll', async () => {
        const server = await start(60);
        const pending = postJson(server.port, WORKER_ENDPOINTS.next, BASE, server.token).catch(() => null);
        await new Promise((resolve) => setTimeout(resolve, 50));

        const started = Date.now();
        await server.close();

        expect(Date.now() - started).toBeLessThan(5000);
        await pending;
    });
});

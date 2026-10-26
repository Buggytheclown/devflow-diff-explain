import fsSync from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import type { ChatAnchor, TaskCompleteResponse, UiChatResponse, UiState } from '@sherpa/protocol';
import {
    LEASE_TTL_SECONDS,
    RESULT_MAX_BYTES,
    UI_CHAT_EVENT,
    UI_ENDPOINTS,
    uiChatAskResponseSchema,
    uiChatCancelResponseSchema,
    uiChatEventSchema,
    uiChatResponseSchema,
    uiChatRetryResponseSchema,
    uiStateSchema,
} from '@sherpa/protocol';
import { makeFixtureHost } from '@sherpa/fixtures';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { chatPayloadDirOf, databasePathFor, routePayloadDirOf, sharedPayloadDirOf } from './paths.js';
import { MAX_RESULT_REJECTIONS } from './queue.js';
import { asRawText, mediumDiff, mediumRawResults, mediumReadySnapshot } from './route/fixture-support.js';
import type { SherpaServer } from './server.js';
import { startServer } from './server.js';
import { get, makeTempSherpaDir, postJson, removeTempSherpaDir } from './test-support.js';

const PR = 'fixture-medium';
const LOCAL_PR = 'unknown-777';
const WORKER = 'w-chat';
const ANSWER = 'Кэш очищается до записи, чтобы следующий читатель не получил прежнее значение.';
const ANCHOR: ChatAnchor = {
    // Активная итерация фикстуры: якорь чужой итерации ручка отбивает.
    diffId: mediumDiff().diffId,
    fileId: 'f-main',
    path: 'src/main.ts',
    side: 'new',
    start: 10,
    end: 12,
};

describe('чат и заметки', () => {
    let sherpaDir: string;
    let servers: SherpaServer[];
    let streams: SseStream[];
    let clockOffsetMs: number;

    beforeEach(async () => {
        sherpaDir = await makeTempSherpaDir();
        servers = [];
        streams = [];
        clockOffsetMs = 0;
    });

    afterEach(async () => {
        for (const stream of streams) {
            stream.close();
        }
        for (const server of servers) {
            await server.close();
        }
        await removeTempSherpaDir(sherpaDir);
    });

    async function start(prKey = LOCAL_PR): Promise<SherpaServer> {
        const server = await startServer({
            prKey,
            sherpaDir,
            longPollSeconds: 0.1,
            now: () => new Date(Date.now() + clockOffsetMs),
            ...(prKey === LOCAL_PR ? { reviewHostFactory: () => null } : {}),
        });
        servers.push(server);
        return server;
    }

    async function readState(server: SherpaServer): Promise<UiState> {
        const response = await get(server.port, UI_ENDPOINTS.state, server.token);
        expect(response.status).toBe(200);
        return uiStateSchema.parse(await response.json());
    }

    async function readChat(server: SherpaServer): Promise<UiChatResponse> {
        const response = await get(server.port, UI_ENDPOINTS.reviewChat, server.token);
        expect(response.status).toBe(200);
        return uiChatResponseSchema.parse(await response.json());
    }

    async function ask(server: SherpaServer, text = 'Почему здесь сбрасывается кэш?', anchor?: ChatAnchor) {
        const response = await postJson(
            server.port,
            UI_ENDPOINTS.reviewChatAsk,
            { text, ...(anchor === undefined ? {} : { anchor }) },
            server.token,
        );
        expect(response.status).toBe(200);
        return uiChatAskResponseSchema.parse(await response.json()).exchange;
    }

    function leaseChat(server: SherpaServer): number {
        server.workerRegistry.register(WORKER, 'claude-code', 'opus-5');
        const leased = server.queue.next(WORKER);
        expect(leased?.task.type).toBe('chat');
        return leased?.task.id ?? 0;
    }

    function complete(server: SherpaServer, taskId: number, answer = ANSWER): TaskCompleteResponse {
        return server.queue.complete(WORKER, taskId, answer);
    }

    /** Каталог вопроса этой задачи: свой файл лежит в нём, общие — в каталоге `shared`. */
    function questionDirOf(server: SherpaServer, taskId: number): string {
        const own = server.queue
            .getTask(taskId)
            ?.contextFiles.find((file) => file.startsWith(chatPayloadDirOf(sherpaDir, server.prKey)));
        expect(own).toBeDefined();
        return path.dirname(own ?? '');
    }

    /** Язык ответа: лестница выбора, снапшот обмена и промпт повтора. */
    describe('язык ответа', () => {
        function guideOf(server: SherpaServer, taskId: number): string {
            const guide = server.queue.getTask(taskId)?.contextFiles[0];
            return guide === undefined ? '' : fsSync.readFileSync(guide, 'utf8');
        }

        it('локаль запроса едет в обмен, промпт и наводку задачи', async () => {
            const server = await start();
            const response = await postJson(
                server.port,
                UI_ENDPOINTS.reviewChatAsk,
                { text: 'Why is the cache dropped here?', locale: 'en' },
                server.token,
            );
            expect(response.status).toBe(200);
            const exchange = uiChatAskResponseSchema.parse(await response.json()).exchange;

            expect(exchange.locale).toBe('en');
            const taskId = exchange.taskId ?? 0;
            expect(server.queue.getTask(taskId)?.instructions).toContain('in English Markdown');
            expect(guideOf(server, taskId)).toContain('Write in English.');
        });

        it('повтор говорит на языке исходного вопроса, а не на текущем выборе', async () => {
            const server = await start();
            const asked = uiChatAskResponseSchema.parse(
                await (
                    await postJson(
                        server.port,
                        UI_ENDPOINTS.reviewChatAsk,
                        { text: 'Why is the cache dropped here?', locale: 'en' },
                        server.token,
                    )
                ).json(),
            ).exchange;
            const firstTask = leaseChat(server);
            server.queue.fail(WORKER, firstTask, 'не хватило контекста');

            const retry = await postJson(
                server.port,
                UI_ENDPOINTS.reviewChatRetry,
                { exchangeId: asked.id },
                server.token,
            );
            expect(uiChatRetryResponseSchema.parse(await retry.json()).outcome).toBe('retried');

            const retried = (await readChat(server)).exchanges[0];
            expect(retried?.locale).toBe('en');
            expect(server.queue.getTask(retried?.taskId ?? 0)?.instructions).toContain('in English Markdown');
        });

        it('без локали в запросе действует явный выбор в настройках', async () => {
            fsSync.writeFileSync(`${sherpaDir}/settings.json`, JSON.stringify({ locale: 'en' }));
            const server = await start();

            expect((await ask(server, 'Вопрос')).locale).toBe('en');
        });

        it('никто языка не назвал — русский', async () => {
            const server = await start();

            expect((await ask(server, 'Вопрос')).locale).toBe('ru');
        });

        it('стоп-лист голоса берётся из локали обмена', async () => {
            const server = await start();
            const exchange = uiChatAskResponseSchema.parse(
                await (
                    await postJson(
                        server.port,
                        UI_ENDPOINTS.reviewChatAsk,
                        { text: 'Why is the cache dropped here?', locale: 'en' },
                        server.token,
                    )
                ).json(),
            ).exchange;
            const taskId = leaseChat(server);
            expect(taskId).toBe(exchange.taskId);

            // Русская фраза-заполнитель на английском обмене нарушением не считается.
            const rejected = complete(server, taskId, 'It is worth noting that the cache is dropped first.');
            expect(rejected.kind).toBe('rejected');
            const accepted = complete(server, taskId, 'Важно отметить. The cache is dropped before the write.');
            expect(accepted.kind).toBe('accepted');
        });
    });

    it('ask атомарно создаёт queued-обмен и interactive-задачу с полным payload', async () => {
        const server = await start();
        const exchange = await ask(server, 'Объясни порядок записи', ANCHOR);
        const [task] = server.queue.listTasks();

        expect(exchange).toMatchObject({ status: 'queued', answer: null, anchor: ANCHOR });
        expect(task).toMatchObject({ type: 'chat', priority: 'interactive', status: 'queued' });
        expect(Buffer.byteLength(task?.instructions ?? '', 'utf8')).toBeLessThan(500);
        // Хоста у этого сервера нет: диффа и текста файла не будет, общей остаётся методичка.
        expect(task?.contextFiles.map((file) => path.basename(file))).toEqual([
            expect.stringMatching(/^chat-guide-[0-9a-f]{8}\.md$/),
            'question.md',
            'selection.patch.md',
            'file-context.md',
            'route-context.md',
            'history.md',
        ]);
        expect(task?.contextFiles[0]?.startsWith(sharedPayloadDirOf(sherpaDir, LOCAL_PR))).toBe(true);
        expect(
            task?.contextFiles.slice(1).every((file) => file.startsWith(chatPayloadDirOf(sherpaDir, LOCAL_PR))),
        ).toBe(true);
        expect(fsSync.readFileSync(task?.contextFiles[1] ?? '', 'utf8')).toContain('Объясни порядок записи');
        expect((await readChat(server)).exchanges).toEqual([exchange]);
    });

    it('генерация маршрута и вопросы чата не трогают payload друг друга', async () => {
        const server = await start(PR);
        server.workerRegistry.register(WORKER, 'claude-code', 'opus-5');
        await ask(server, 'Не удаляй мой контекст');
        const chatTask = server.queue.listTasks().find((task) => task.type === 'chat');
        // Свой файл вопроса: методичка и дифф лежат в общем каталоге и принадлежат обоим.
        const chatFile = chatTask?.contextFiles.find((file) => file.startsWith(chatPayloadDirOf(sherpaDir, PR))) ?? '';

        await server.route.warmup();
        const routeTask = server.queue.listTasks().find((task) => task.type === 'route.skeleton');
        const routeFile = routeTask?.resultSchemaFile ?? '';

        expect(chatFile.startsWith(chatPayloadDirOf(sherpaDir, PR))).toBe(true);
        expect(routeFile.startsWith(routePayloadDirOf(sherpaDir, PR))).toBe(true);
        expect(fsSync.existsSync(chatFile)).toBe(true);
        expect(fsSync.existsSync(routeFile)).toBe(true);
        // Дифф у вопроса без якоря и у скелета — один и тот же общий путь.
        expect(chatTask?.contextFiles[1]).toBe(routeTask?.contextFiles[1]);
        expect(chatTask?.contextFiles[1]?.startsWith(sharedPayloadDirOf(sherpaDir, PR))).toBe(true);

        await ask(server, 'Не удаляй контекст маршрута');
        expect(fsSync.existsSync(chatFile)).toBe(true);
        expect(fsSync.existsSync(routeFile)).toBe(true);
        expect(fsSync.existsSync(chatTask?.contextFiles[1] ?? '')).toBe(true);
    });

    it('ошибка записи обмена откатывает и постановку задачи', async () => {
        const server = await start();
        const db = new DatabaseSync(databasePathFor(sherpaDir, LOCAL_PR));
        db.exec(`
            CREATE TRIGGER reject_chat_exchange
            BEFORE INSERT ON chat_exchanges
            BEGIN
                SELECT RAISE(ABORT, 'test rollback');
            END;
        `);
        try {
            const response = await postJson(
                server.port,
                UI_ENDPOINTS.reviewChatAsk,
                { text: 'Этот вопрос не должен сохраниться' },
                server.token,
            );
            expect(response.status).toBe(500);
            expect(server.queue.listTasks()).toEqual([]);
            expect((await readChat(server)).exchanges).toEqual([]);
        } finally {
            db.exec('DROP TRIGGER reject_chat_exchange;');
            db.close();
        }
    });

    it('interactive chat обгоняет невзятые route.section', async () => {
        const server = await start(PR);
        server.workerRegistry.register(WORKER, 'claude-code', 'opus-5');
        await server.route.warmup();
        const skeleton = server.queue.listTasks().find((task) => task.type === 'route.skeleton');
        expect(server.queue.next(WORKER)?.task.id).toBe(skeleton?.id);
        expect(complete(server, skeleton?.id ?? 0, asRawText(mediumRawResults().skeleton)).kind).toBe('accepted');
        expect(server.queue.listTasks().some((task) => task.type === 'route.section' && task.status === 'queued')).toBe(
            true,
        );

        const exchange = await ask(server, 'Что здесь самое рискованное?');
        const chatTask = server.queue.listTasks().find((task) => task.type === 'chat');

        expect(server.queue.next(WORKER)?.task.id).toBe(chatTask?.id);
        expect((await readChat(server)).exchanges.find((item) => item.id === exchange.id)?.status).toBe('running');
    });

    it('cancel формально закрывает аренду, воркер держит её до позднего complete', async () => {
        const server = await start();
        const exchange = await ask(server);
        const taskId = leaseChat(server);

        const response = await postJson(
            server.port,
            UI_ENDPOINTS.reviewChatCancel,
            { exchangeId: exchange.id },
            server.token,
        );
        expect(uiChatCancelResponseSchema.parse(await response.json()).outcome).toBe('cancelled');
        expect((await readState(server)).tasks).toMatchObject([
            { id: taskId, status: 'cancelled', heldByWorker: true },
        ]);
        expect((await readChat(server)).exchanges[0]).toMatchObject({
            status: 'cancelled',
            answer: null,
            taskId,
        });

        expect(complete(server, taskId).kind).toBe('noop');
        expect((await readState(server)).tasks).toMatchObject([
            { id: taskId, status: 'cancelled', heldByWorker: false },
        ]);
    });

    it('next того же воркера снимает держание отменённой и выдаёт следующий вопрос', async () => {
        const server = await start();
        const first = await ask(server, 'Первый вопрос');
        const cancelledTask = leaseChat(server);
        await postJson(server.port, UI_ENDPOINTS.reviewChatCancel, { exchangeId: first.id }, server.token);

        await ask(server, 'Второй вопрос');
        const nextTask = server.queue.next(WORKER);

        expect(nextTask?.task.id).not.toBe(cancelledTask);
        expect((await readState(server)).tasks).toMatchObject([
            { id: cancelledTask, status: 'cancelled', heldByWorker: false },
            { id: nextTask?.task.id, status: 'leased', heldByWorker: true },
        ]);
    });

    it('каталог вопроса живёт, пока задача открыта или её держит воркер', async () => {
        const server = await start();
        const exchange = await ask(server);
        const taskId = leaseChat(server);
        const dir = questionDirOf(server, taskId);

        expect(fsSync.existsSync(dir)).toBe(true);

        await postJson(server.port, UI_ENDPOINTS.reviewChatCancel, { exchangeId: exchange.id }, server.token);
        // Задача закрыта, но воркер о том ещё не знает и дочитывает её контекст.
        expect(fsSync.existsSync(dir)).toBe(true);

        expect(complete(server, taskId).kind).toBe('noop');
        expect(fsSync.existsSync(dir)).toBe(false);
    });

    it('каталог отвеченного вопроса сносится вместе с закрытием задачи', async () => {
        const server = await start();
        await ask(server);
        const taskId = leaseChat(server);
        const dir = questionDirOf(server, taskId);

        expect(complete(server, taskId).kind).toBe('accepted');

        expect(fsSync.existsSync(dir)).toBe(false);
        expect((await readChat(server)).exchanges[0]).toMatchObject({ status: 'done', answer: ANSWER });
    });

    it('на старте сервера сносятся каталоги, на которые не ссылается ни одна задача', async () => {
        const first = await start();
        await ask(first);
        const openTask = first.queue.listTasks()[0];
        const kept = questionDirOf(first, openTask?.id ?? 0);
        const stray = path.join(chatPayloadDirOf(sherpaDir, LOCAL_PR), 'stray-question');
        fsSync.mkdirSync(stray, { recursive: true });
        await first.close();

        const second = await start();

        expect(fsSync.existsSync(stray)).toBe(false);
        // Вопрос пережил рестарт вместе со своей задачей — его контекст на месте.
        expect(fsSync.existsSync(kept)).toBe(true);
        expect(second.queue.listTasks()[0]?.status).toBe('queued');
    });

    it('retry отменённого вопроса ставит обмену новую задачу', async () => {
        const server = await start();
        const exchange = await ask(server);
        const firstTask = leaseChat(server);
        await postJson(server.port, UI_ENDPOINTS.reviewChatCancel, { exchangeId: exchange.id }, server.token);

        const retry = await postJson(
            server.port,
            UI_ENDPOINTS.reviewChatRetry,
            { exchangeId: exchange.id },
            server.token,
        );
        expect(uiChatRetryResponseSchema.parse(await retry.json()).outcome).toBe('retried');

        const retried = (await readChat(server)).exchanges[0];
        expect(retried).toMatchObject({ id: exchange.id, status: 'queued' });
        expect(retried?.taskId).not.toBe(firstTask);
    });

    it('retry разрешён из failed и cancelled и сохраняет вопрос с якорем', async () => {
        const server = await start();
        const exchange = await ask(server, 'Сохрани этот вопрос', ANCHOR);
        const firstTask = leaseChat(server);
        server.queue.fail(WORKER, firstTask, 'не хватило контекста');
        expect((await readChat(server)).exchanges[0]?.status).toBe('failed');

        const failedRetry = await postJson(
            server.port,
            UI_ENDPOINTS.reviewChatRetry,
            { exchangeId: exchange.id },
            server.token,
        );
        expect(uiChatRetryResponseSchema.parse(await failedRetry.json()).outcome).toBe('retried');
        const secondTask = server.queue.listTasks().find((task) => task.type === 'chat' && task.status === 'queued');
        expect(secondTask?.id).not.toBe(firstTask);

        const cancel = await postJson(
            server.port,
            UI_ENDPOINTS.reviewChatCancel,
            { exchangeId: exchange.id },
            server.token,
        );
        expect(uiChatCancelResponseSchema.parse(await cancel.json()).outcome).toBe('cancelled');
        const cancelledRetry = await postJson(
            server.port,
            UI_ENDPOINTS.reviewChatRetry,
            { exchangeId: exchange.id },
            server.token,
        );
        expect(uiChatRetryResponseSchema.parse(await cancelledRetry.json()).outcome).toBe('retried');

        expect((await readChat(server)).exchanges[0]).toMatchObject({
            id: exchange.id,
            question: 'Сохрани этот вопрос',
            anchor: ANCHOR,
            status: 'queued',
        });
    });

    it('повтор старого вопроса: якорь без итерации считается якорем активной', async () => {
        const first = await start(PR);
        const exchange = await ask(first, 'Вопрос, заданный до итераций', ANCHOR);
        first.queue.fail(WORKER, leaseChat(first), 'не хватило контекста');
        await first.close();
        // Старые обмены писали якорь без `diffId`; стор подставляет им `unknown`.
        stripAnchorIteration(sherpaDir, PR, exchange.id);

        const second = await start(PR);
        const retry = await postJson(
            second.port,
            UI_ENDPOINTS.reviewChatRetry,
            { exchangeId: exchange.id },
            second.token,
        );

        expect(retry.status).toBe(200);
        expect(uiChatRetryResponseSchema.parse(await retry.json()).outcome).toBe('retried');
    });

    it('вопрос по прошлой итерации не берёт текст файла активной', async () => {
        const stored = await start(PR);
        // Патч v1 оседает в хранилище при первой же загрузке диффа.
        await get(stored.port, UI_ENDPOINTS.reviewDiff, stored.token);
        await stored.close();

        // Хост ушёл на v2 и диффа не отдаёт вовсе: единственный верный контекст — сохранённый v1.
        const pushed = makeFixtureHost('medium');
        pushed.advanceIteration();
        pushed.getDiff = () => Promise.reject(new Error('хост прилёг'));
        const server = await startServer({
            prKey: PR,
            sherpaDir,
            longPollSeconds: 0.1,
            reviewHostFactory: () => ({ name: 'fixture', host: pushed }),
        });
        servers.push(server);

        await ask(server, 'Что тут было в прошлой итерации?', ANCHOR);

        const task = server.queue.listTasks().find((candidate) => candidate.type === 'chat');
        const files = task?.contextFiles ?? [];
        const patch = files.find((file) => path.basename(file) === 'selection.patch.md') ?? '';
        const fileContext = files.find((file) => path.basename(file) === 'file-context.md') ?? '';
        expect(fsSync.readFileSync(patch, 'utf8')).toContain('src/main.ts');
        expect(fsSync.readFileSync(fileContext, 'utf8')).toContain('UNAVAILABLE');
    });

    it('невалидный ответ пересдаётся, исчерпание отказов переводит обмен в failed', async () => {
        const server = await start();
        await ask(server);
        const taskId = leaseChat(server);
        const broken = 'Важно отметить: готово 🎉';

        for (let rejection = 1; rejection <= MAX_RESULT_REJECTIONS; rejection += 1) {
            const result = complete(server, taskId, broken);
            expect(result.kind).toBe('rejected');
            if (rejection < MAX_RESULT_REJECTIONS) {
                expect(server.queue.getTask(taskId)?.status).toBe('leased');
            }
        }

        expect(server.queue.getTask(taskId)?.status).toBe('failed');
        expect((await readChat(server)).exchanges[0]).toMatchObject({ status: 'failed', answer: null });
        expect((await readChat(server)).exchanges[0]?.error).toContain('не прошедший валидацию');
    });

    it('ответ больше 256 КБ закрывает задачу и обмен ошибкой', async () => {
        const server = await start();
        await ask(server);
        const taskId = leaseChat(server);

        expect(() => complete(server, taskId, 'x'.repeat(RESULT_MAX_BYTES + 1))).toThrow();

        expect(server.queue.getTask(taskId)?.status).toBe('failed');
        expect((await readChat(server)).exchanges[0]).toMatchObject({ status: 'failed', answer: null });
        expect((await readChat(server)).exchanges[0]?.error).toContain('больше лимита');
    });

    it('progress обновляет running-обмен и ревизия монотонна', async () => {
        const server = await start();
        const initial = await readChat(server);
        await ask(server);
        const afterAsk = await readChat(server);
        const taskId = leaseChat(server);
        const afterLease = await readChat(server);

        server.queue.progress(WORKER, taskId, 'Проверяю инварианты кэша');
        const afterProgress = await readChat(server);
        expect(afterProgress.exchanges[0]).toMatchObject({
            status: 'running',
            progressText: 'Проверяю инварианты кэша',
        });
        expect([initial, afterAsk, afterLease, afterProgress].map((state) => state.chatRevision)).toEqual(
            [...new Set([initial, afterAsk, afterLease, afterProgress].map((state) => state.chatRevision))].sort(
                (left, right) => left - right,
            ),
        );
    });

    it('принятый ответ создаёт заметку только при якоре и с head-коммитом диффа', async () => {
        const server = await start(PR);
        const anchored = await ask(server, 'Почему этот диапазон нужен?', ANCHOR);
        const anchoredTask = leaseChat(server);
        expect(complete(server, anchoredTask).kind).toBe('accepted');

        const first = await readChat(server);
        expect(first.exchanges[0]).toMatchObject({ id: anchored.id, status: 'done', answer: ANSWER });
        expect(first.notes).toEqual([
            expect.objectContaining({
                exchangeId: anchored.id,
                anchor: ANCHOR,
                text: ANSWER,
                lostAnchor: false,
                origin: { commit: mediumReadySnapshot().commit, anchor: ANCHOR },
            }),
        ]);

        await ask(server, 'Вопрос ко всему PR');
        const plainTask = server.queue.next(WORKER)?.task.id ?? 0;
        expect(complete(server, plainTask).kind).toBe('accepted');
        expect((await readChat(server)).notes).toHaveLength(1);
    });

    it('ответ и заметка откатываются вместе, после восстановления сверка применяет результат', async () => {
        const server = await start();
        await ask(server, 'Нужна атомарная заметка', ANCHOR);
        const taskId = leaseChat(server);
        const db = new DatabaseSync(databasePathFor(sherpaDir, LOCAL_PR));
        db.exec(`
            CREATE TRIGGER reject_agent_note
            BEFORE INSERT ON agent_notes
            BEGIN
                SELECT RAISE(ABORT, 'test rollback');
            END;
        `);
        try {
            expect(complete(server, taskId).kind).toBe('accepted');
            expect(await readChat(server)).toMatchObject({
                exchanges: [expect.objectContaining({ status: 'running', answer: null })],
                notes: [],
            });
        } finally {
            db.exec('DROP TRIGGER reject_agent_note;');
            db.close();
        }

        const poke = server.queue.enqueue({
            type: 'echo',
            priority: 'interactive',
            instructions: 'разбуди сверку',
            contextFiles: [],
        });
        server.queue.cancel(poke.id);
        expect(await readChat(server)).toMatchObject({
            exchanges: [expect.objectContaining({ status: 'done', answer: ANSWER })],
            notes: [expect.objectContaining({ text: ANSWER })],
        });
    });

    it('удаление заметки не меняет историю и двигает ревизию', async () => {
        const server = await start();
        await ask(server, 'Закрепи ответ', ANCHOR);
        const taskId = leaseChat(server);
        complete(server, taskId);
        const before = await readChat(server);
        const noteId = before.notes[0]?.id ?? 0;

        const response = await postJson(
            server.port,
            UI_ENDPOINTS.reviewChatNoteDelete,
            { noteId },
            server.token,
        );
        expect(response.status).toBe(200);
        const after = await readChat(server);
        expect(after.notes).toEqual([]);
        expect(after.exchanges).toEqual(before.exchanges);
        expect(after.chatRevision).toBeGreaterThan(before.chatRevision);
    });

    it('вытеснение воркера переживает рестарт, новый воркер продолжает вопрос', async () => {
        const first = await start();
        await ask(first, 'Продолжи после переподключения');
        const taskId = leaseChat(first);

        first.queue.releaseLeasesOf(WORKER);
        expect(first.queue.getTask(taskId)).toMatchObject({
            status: 'queued',
            attempt: 2,
            lastLeaseReturnReason: 'displaced',
        });
        await first.close();

        const second = await start();
        expect((await readChat(second)).exchanges[0]).toMatchObject({ status: 'queued', error: null });
        expect(second.queue.next('w-chat-next')?.task.id).toBe(taskId);
        expect((await readChat(second)).exchanges[0]).toMatchObject({ status: 'running', error: null });
    });

    it('рестарт при выданной аренде chat: та же сессия сдаёт ответ, заметка появляется', async () => {
        const first = await start();
        const exchange = await ask(first, 'Ответь уже после рестарта', ANCHOR);
        const taskId = leaseChat(first);
        expect((await readChat(first)).exchanges[0]).toMatchObject({ status: 'running' });
        await first.close();

        // Живая аренда переживает подъём: сверка не гасит вопрос, у которого ещё есть исполнитель.
        const second = await start();
        expect(second.queue.getTask(taskId)?.status).toBe('leased');
        expect((await readChat(second)).exchanges[0]).toMatchObject({
            id: exchange.id,
            status: 'running',
            error: null,
        });

        expect(complete(second, taskId).kind).toBe('accepted');
        const done = await readChat(second);
        expect(done.exchanges[0]).toMatchObject({ id: exchange.id, status: 'done', answer: ANSWER });
        expect(done.notes).toEqual([
            expect.objectContaining({ exchangeId: exchange.id, anchor: ANCHOR, text: ANSWER }),
        ]);
    });

    it('рестарт при выданной аренде chat: сессия не вернулась, аренда протухает — failed и retry', async () => {
        const first = await start();
        const exchange = await ask(first, 'Сессия не вернётся после рестарта');
        const taskId = leaseChat(first);
        await first.close();

        const second = await start();
        expect((await readChat(second)).exchanges[0]).toMatchObject({ status: 'running' });

        clockOffsetMs = (LEASE_TTL_SECONDS.interactive + 1) * 1000;
        // Чтение очереди реапит протухшую аренду — сверка узнаёт о ней тем же уведомлением.
        second.queue.listTasks();
        const failed = await readChat(second);
        expect(failed.exchanges[0]).toMatchObject({
            id: exchange.id,
            question: 'Сессия не вернётся после рестарта',
            status: 'failed',
        });
        expect(failed.exchanges[0]?.error).toContain('перестал отвечать');
        expect(second.queue.getTask(taskId)?.status).toBe('cancelled');

        const retry = await postJson(
            second.port,
            UI_ENDPOINTS.reviewChatRetry,
            { exchangeId: exchange.id },
            second.token,
        );
        expect(uiChatRetryResponseSchema.parse(await retry.json()).outcome).toBe('retried');
        const retried = second.queue.listTasks().find((task) => task.type === 'chat' && task.status === 'queued');
        expect(retried?.id).not.toBe(taskId);
        expect((await readChat(second)).exchanges[0]).toMatchObject({ status: 'queued', error: null });
    });

    it('task fail и протухание аренды дают failed с сохранённым вопросом', async () => {
        const explicit = await start();
        await ask(explicit, 'Не теряй меня');
        const explicitTask = leaseChat(explicit);
        explicit.queue.fail(WORKER, explicitTask, 'нет доступа к файлу');
        expect((await readChat(explicit)).exchanges[0]).toMatchObject({
            question: 'Не теряй меня',
            status: 'failed',
        });
        expect((await readChat(explicit)).exchanges[0]?.error).toContain('нет доступа к файлу');

        await explicit.close();
        const expired = await start();
        await ask(expired, 'Воркер умер');
        const expiredTask = leaseChat(expired);
        clockOffsetMs = (LEASE_TTL_SECONDS.interactive + 1) * 1000;
        expired.queue.listTasks();
        expect(expired.queue.getTask(expiredTask)).toMatchObject({
            status: 'cancelled',
            lastLeaseReturnReason: 'expired',
        });
        expect((await readChat(expired)).exchanges[1]).toMatchObject({
            question: 'Воркер умер',
            status: 'failed',
        });
    });

    it('переподключение того же воркера после протухания аренды не гасит вопрос', async () => {
        const server = await start();
        await ask(server, 'Реконнект');
        const taskId = leaseChat(server);
        clockOffsetMs = (LEASE_TTL_SECONDS.interactive + 1) * 1000;
        // next() сам реапит протухшую аренду и тут же переарендует ту же задачу тем же вызовом —
        // между «протухла» и «арендована заново» уведомления не бывает, промежуточного queued+expired
        // оркестратор не видит. Живая переаренда не должна гаситься как смерть воркера.
        expect(server.queue.next(WORKER)?.task.id).toBe(taskId);
        expect(server.queue.getTask(taskId)).toMatchObject({ status: 'leased', lastLeaseReturnReason: null });
        expect((await readChat(server)).exchanges[0]).toMatchObject({ status: 'running', error: null });
    });

    it('рестарт сохраняет историю и сводит открытый обмен без задачи в failed', async () => {
        const first = await start();
        await ask(first, 'Готовый ответ', ANCHOR);
        complete(first, leaseChat(first));
        const done = await readChat(first);
        await ask(first, 'Потерянная задача');
        await first.close();

        const db = new DatabaseSync(databasePathFor(sherpaDir, LOCAL_PR));
        db.prepare("DELETE FROM tasks WHERE status = 'queued'").run();
        db.close();

        const second = await start();
        const restarted = await readChat(second);
        expect(restarted.exchanges[0]).toEqual(done.exchanges[0]);
        expect(restarted.notes).toEqual(done.notes);
        expect(restarted.exchanges[1]).toMatchObject({
            question: 'Потерянная задача',
            status: 'failed',
        });
        expect(restarted.exchanges[1]?.error).toContain('потеряна после перезапуска');
    });

    it('SSE chat приходит сразу и после изменения', async () => {
        const server = await start();
        const stream = await openSse(
            `http://127.0.0.1:${String(server.port)}${UI_ENDPOINTS.events}?token=${server.token}`,
        );
        streams.push(stream);
        const first = uiChatEventSchema.parse(JSON.parse((await nextChat(stream)).data));

        await ask(server);

        const changed = uiChatEventSchema.parse(JSON.parse((await nextChat(stream)).data));
        expect(changed.chatRevision).toBeGreaterThan(first.chatRevision);
        expect(changed.chatRevision).toBe((await readChat(server)).chatRevision);
    });
});

async function nextChat(stream: SseStream): Promise<SseEvent> {
    for (;;) {
        const event = await stream.next();
        if (event.event === UI_CHAT_EVENT) {
            return event;
        }
    }
}

interface SseEvent {
    readonly event: string;
    readonly data: string;
}

interface SseStream {
    readonly next: () => Promise<SseEvent>;
    readonly close: () => void;
}

async function openSse(url: string): Promise<SseStream> {
    const controller = new AbortController();
    const response = await fetch(url, { signal: controller.signal });
    if (response.status !== 200 || response.body === null) {
        throw new Error(`SSE-канал не открылся: ${String(response.status)}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const ready: SseEvent[] = [];
    let buffer = '';

    return {
        next: async () => {
            for (;;) {
                const event = ready.shift();
                if (event !== undefined) {
                    return event;
                }
                const chunk: { done: boolean; value?: Uint8Array } = await reader.read();
                if (chunk.done) {
                    throw new Error('SSE-канал закрылся раньше ожидаемого события');
                }
                buffer += decoder.decode(chunk.value, { stream: true });
                let boundary = buffer.indexOf('\n\n');
                while (boundary !== -1) {
                    ready.push(parseSseEvent(buffer.slice(0, boundary)));
                    buffer = buffer.slice(boundary + 2);
                    boundary = buffer.indexOf('\n\n');
                }
            }
        },
        close: () => {
            controller.abort();
        },
    };
}

function parseSseEvent(raw: string): SseEvent {
    let event = 'message';
    const data: string[] = [];
    for (const line of raw.split('\n')) {
        if (line.startsWith('event: ')) {
            event = line.slice('event: '.length);
        } else if (line.startsWith('data: ')) {
            data.push(line.slice('data: '.length));
        }
    }
    return { event, data: data.join('\n') };
}

/** Убирает `diffId` из якоря обмена: так его писали старые версии, и стор подставляет `unknown`. */
function stripAnchorIteration(sherpaDir: string, prKey: string, exchangeId: number): void {
    const db = new DatabaseSync(databasePathFor(sherpaDir, prKey));
    try {
        const row = db.prepare('SELECT anchor FROM chat_exchanges WHERE id = ?').get(exchangeId) as {
            anchor: string;
        };
        const { diffId: _iteration, ...rest } = JSON.parse(row.anchor) as ChatAnchor;
        db.prepare('UPDATE chat_exchanges SET anchor = ? WHERE id = ?').run(JSON.stringify(rest), exchangeId);
    } finally {
        db.close();
    }
}

import fs from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import {
    PROTOCOL_VERSION,
    rpcErrorSchema,
    UI_ENDPOINTS,
    UI_STATE_EVENT,
    uiCancelResponseSchema,
    uiEnqueueResponseSchema,
    uiStateSchema,
    WORKER_ENDPOINTS,
    workerNextResponseSchema,
} from '@sherpa/protocol';
import type { UiState } from '@sherpa/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { databasePathFor } from './paths.js';
import type { SherpaServer } from './server.js';
import { startServer } from './server.js';
import { SettingsStore } from './settings-store.js';
import { directoryAssets } from './static.js';
import { get, makeTempSherpaDir, patchJson, postJson, removeTempSherpaDir } from './test-support.js';

const PR_KEY = 'arcanum-4242';
const WORKER = 'w-ui';
const WORKER_BASE = { protocolVersion: PROTOCOL_VERSION, cliVersion: '0.1.0', workerId: WORKER };
/** Минимальный документ сборки UI: подстановка состояния обязана переживать любой валидный html. */
const INDEX_HTML = [
    '<!doctype html>',
    '<html lang="ru">',
    '    <head>',
    '        <title>Sherpa</title>',
    '        <link rel="stylesheet" href="/assets/app.css" />',
    '    </head>',
    '    <body><div id="root"></div></body>',
    '</html>',
].join('\n');

describe('ручки UI', () => {
    let sherpaDir: string;
    let servers: SherpaServer[];
    let streams: SseStream[];

    beforeEach(async () => {
        sherpaDir = await makeTempSherpaDir();
        servers = [];
        streams = [];
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

    async function start(uiDir?: string): Promise<SherpaServer> {
        // Ключ этого набора арканумный, но живой Арканум в тестах запрещён (docs/testing.md):
        // хоста нет — ревью-ручки отвечают `no_review_host`, SSE остаётся каналом состояния.
        const base = {
            prKey: PR_KEY,
            development: true,
            sherpaDir,
            longPollSeconds: 0.3,
            reviewHostFactory: () => null,
            feedback: { env: {} },
        };
        const server = await startServer(
            uiDir === undefined ? base : { ...base, assets: directoryAssets(uiDir) },
        );
        servers.push(server);
        return server;
    }

    async function readState(server: SherpaServer): Promise<UiState> {
        const response = await get(server.port, UI_ENDPOINTS.state, server.token);
        expect(response.status).toBe(200);
        return uiStateSchema.parse(await response.json());
    }

    async function openEvents(server: SherpaServer, token: string = server.token): Promise<SseStream> {
        const stream = await openSse(`http://127.0.0.1:${String(server.port)}${UI_ENDPOINTS.events}?token=${token}`);
        streams.push(stream);
        return stream;
    }

    describe('снапшот состояния', () => {
        it('без токена — 401', async () => {
            const server = await start();

            const response = await get(server.port, UI_ENDPOINTS.state);

            expect(response.status).toBe(401);
            expect(rpcErrorSchema.parse(await response.json()).error.code).toBe('unauthorized');
        });

        it('пустой PR: ключ, воркер `never`, пустая очередь', async () => {
            const server = await start();

            const state = await readState(server);

            expect(state.prKey).toBe(PR_KEY);
            expect(state.worker.kind).toBe('never');
            expect(state.tasks).toEqual([]);
            expect(state.feedback).toEqual({
                available: false,
                reason:
                    'Нет OAuth-токена Трекера: в окружении сервера он не задан, а `ya` для его получения не найден. ' +
                    'Фидбек можно отправить напрямую в очередь SHERPA или в чат Шерпы.',
            });
            // Хоста у этого набора нет — меты PR взяться неоткуда, и снапшот честно пуст.
            expect(state.pr).toBeNull();
        });

        it('серверные внутренности задачи наружу не выходят', async () => {
            const server = await start();
            server.queue.enqueue({
                type: 'echo',
                priority: 'interactive',
                instructions: 'верни текст',
                contextFiles: ['/tmp/sherpa/context.md'],
            });

            const state = await readState(server);

            expect(state.tasks).toHaveLength(1);
            expect(Object.keys(state.tasks[0] ?? {})).not.toContain('contextFiles');
            expect(Object.keys(state.tasks[0] ?? {})).not.toContain('workerId');
        });
    });

    describe('постановка задачи', () => {
        it('echo с текстом: приоритет по умолчанию интерактивный, текст в инструкции', async () => {
            const server = await start();

            const response = await postJson(
                server.port,
                UI_ENDPOINTS.enqueue,
                { type: 'echo', text: 'привет из UI' },
                server.token,
            );

            expect(response.status).toBe(200);
            const { task } = uiEnqueueResponseSchema.parse(await response.json());
            expect(task.status).toBe('queued');
            expect(task.priority).toBe('interactive');
            expect(task.attempt).toBe(1);
            expect(task.instructions).toContain('привет из UI');
            expect(task.instructions).toContain('echo task');
        });

        it('явный фоновый приоритет доезжает до очереди', async () => {
            const server = await start();

            const response = await postJson(
                server.port,
                UI_ENDPOINTS.enqueue,
                { type: 'echo', text: 'фоновая', priority: 'background' },
                server.token,
            );

            expect(uiEnqueueResponseSchema.parse(await response.json()).task.priority).toBe('background');
        });

        it('пустой текст — bad_request со списком ошибок', async () => {
            const server = await start();

            const response = await postJson(server.port, UI_ENDPOINTS.enqueue, { type: 'echo', text: '' }, server.token);

            expect(response.status).toBe(400);
            const body = rpcErrorSchema.parse(await response.json());
            expect(body.error.code).toBe('bad_request');
            expect(body.error.details?.some((detail) => detail.startsWith('text:'))).toBe(true);
        });

        it('неизвестный тип задачи отбивается валидацией', async () => {
            const server = await start();

            const response = await postJson(
                server.port,
                UI_ENDPOINTS.enqueue,
                { type: 'route.section', text: 'что-то' },
                server.token,
            );

            expect(response.status).toBe(400);
        });
    });

    describe('отмена', () => {
        it('задача из очереди отменяется, повтор — noop', async () => {
            const server = await start();
            const task = server.queue.enqueue({
                type: 'echo',
                priority: 'interactive',
                instructions: 'верни текст',
                contextFiles: [],
            });

            const first = await postJson(server.port, UI_ENDPOINTS.cancel, { taskId: task.id }, server.token);
            const second = await postJson(server.port, UI_ENDPOINTS.cancel, { taskId: task.id }, server.token);

            expect(uiCancelResponseSchema.parse(await first.json()).outcome).toBe('cancelled');
            expect(uiCancelResponseSchema.parse(await second.json()).outcome).toBe('noop');
            expect((await readState(server)).tasks[0]?.status).toBe('cancelled');
        });

        it('несуществующая задача — unknown_task', async () => {
            const server = await start();

            const response = await postJson(server.port, UI_ENDPOINTS.cancel, { taskId: 999 }, server.token);

            expect(response.status).toBe(404);
            expect(rpcErrorSchema.parse(await response.json()).error.code).toBe('unknown_task');
        });
    });

    describe('SSE-канал', () => {
        it('отдаёт снапшот сразу после подключения', async () => {
            const server = await start();

            const stream = await openEvents(server);
            const event = await stream.next();

            expect(event.event).toBe(UI_STATE_EVENT);
            expect(uiStateSchema.parse(JSON.parse(event.data)).prKey).toBe(PR_KEY);
        });

        it('шлёт свежий снапшот после постановки и после сдачи результата', async () => {
            const server = await start();
            const stream = await openEvents(server);
            await nextState(stream);

            await postJson(server.port, UI_ENDPOINTS.enqueue, { type: 'echo', text: 'петля' }, server.token);
            const afterEnqueue = await nextState(stream);
            expect(afterEnqueue.tasks).toHaveLength(1);
            expect(afterEnqueue.tasks[0]?.status).toBe('queued');

            const taskId = afterEnqueue.tasks[0]?.id ?? 0;
            await postJson(server.port, WORKER_ENDPOINTS.next, WORKER_BASE, server.token);
            const afterLease = await nextState(stream);
            expect(afterLease.tasks[0]?.status).toBe('leased');

            await postJson(
                server.port,
                WORKER_ENDPOINTS.complete,
                { ...WORKER_BASE, taskId, result: 'петля' },
                server.token,
            );
            const afterComplete = await nextState(stream);
            expect(afterComplete.tasks[0]?.status).toBe('done');
            expect(afterComplete.tasks[0]?.result).toBe('петля');
        });

        it('токен в query принимается только на SSE-ручке', async () => {
            const server = await start();

            const events = await fetch(
                `http://127.0.0.1:${String(server.port)}${UI_ENDPOINTS.events}?token=${server.token}`,
            );
            const state = await fetch(
                `http://127.0.0.1:${String(server.port)}${UI_ENDPOINTS.state}?token=${server.token}`,
            );

            expect(events.status).toBe(200);
            await events.body?.cancel();
            expect(state.status).toBe(401);
        });

        it('неверный токен в query — 401', async () => {
            const server = await start();

            const response = await fetch(
                `http://127.0.0.1:${String(server.port)}${UI_ENDPOINTS.events}?token=не-тот-токен`,
            );

            expect(response.status).toBe(401);
            expect(rpcErrorSchema.parse(await response.json()).error.code).toBe('unauthorized');
        });

        it('обрыв воркерского соединения доезжает до UI без входящих запросов', async () => {
            // Грейс паузы между вызовами сокращён: ждать минуту в тесте нечего.
            const server = await startServer({
                prKey: PR_KEY,
            development: true,
                sherpaDir,
                longPollSeconds: 30,
                workerGapGraceSeconds: 0.3,
                reviewHostFactory: () => null,
            });
            servers.push(server);
            const stream = await openEvents(server);
            expect((await nextState(stream)).worker.kind).toBe('never');

            const aborter = new AbortController();
            const pending = postJson(
                server.port,
                WORKER_ENDPOINTS.next,
                WORKER_BASE,
                server.token,
                aborter.signal,
            ).catch(() => null);
            expect((await nextState(stream)).worker.kind).toBe('connected');

            // Сессию убили посреди long-poll: больше на сервер никто не ходит, статус меняет таймер.
            aborter.abort();
            await pending;

            const state = await nextState(stream);
            expect(state.worker).toMatchObject({ kind: 'disconnected', workerId: WORKER });
        });

        it('снапшот не собрался — канал закрывается, сервер продолжает отвечать', async () => {
            const server = await start();
            server.queue.enqueue({
                type: 'echo',
                priority: 'interactive',
                instructions: 'верни текст',
                contextFiles: [],
            });
            corruptTasks(sherpaDir);

            const stream = await openEvents(server);
            // Fail-closed: битую строку наружу не пускаем, а исключение из SSE некому поймать —
            // канал закрывается без события, браузер перейдёт в «переподключаюсь».
            await expect(stream.next()).rejects.toThrow('закрылся раньше');

            expect((await get(server.port, UI_ENDPOINTS.state, server.token)).status).toBe(500);
            expect((await get(server.port, '/healthz', server.token)).status).toBe(200);
        });
    });

    describe('статика UI', () => {
        let uiDir: string;

        beforeEach(async () => {
            uiDir = path.join(sherpaDir, 'ui-dist');
            await fs.mkdir(path.join(uiDir, 'assets'), { recursive: true });
            await fs.writeFile(path.join(uiDir, 'index.html'), INDEX_HTML);
            await fs.writeFile(path.join(uiDir, 'assets', 'app.js'), 'export const ok = 1;');
            await fs.writeFile(path.join(sherpaDir, 'secret.txt'), 'токен и прочие тайны');
        });

        it('корень отдаёт index.html без токена', async () => {
            const server = await start(uiDir);

            const response = await get(server.port, '/');

            expect(response.status).toBe(200);
            expect(response.headers.get('content-type')).toContain('text/html');
            expect(await response.text()).toContain('Sherpa');
        });

        it.each([
            ['dark', false, 'dark'], ['light', false, 'light'],
            ['dark', true, 'arcanum-dark'], ['light', true, 'arcanum-light'],
        ] as const)('сохранённая тема %s, Arcanum=%s приезжает в первом кадре', async (theme, arcanum, expected) => {
            new SettingsStore(sherpaDir).patch({ theme, arcanum, textSize: 'l' });
            const server = await start(uiDir);

            const html = await (await get(server.port, '/')).text();

            expect(html).toContain(`data-theme="${expected}"`);
            expect(html).toContain('data-textsize="l"');
            expect(html).not.toContain('<script>');
            expect(html).not.toContain('prefers-color-scheme');
        });

        it('режим auto: тему ставит встроенный скрипт до подключения стилей', async () => {
            const server = await start(uiDir);

            const html = await (await get(server.port, '/')).text();

            // Свежий `settings.json` — это `auto`: подставить нечего, системную тему знает браузер.
            expect(html).not.toContain('data-theme=');
            expect(html).toContain('prefers-color-scheme: dark');
            expect(html.indexOf('<script>')).toBeLessThan(html.indexOf('<link rel="stylesheet"'));
        });

        it('смена темы применяется к следующему запросу index.html без перезапуска', async () => {
            const server = await start(uiDir);
            expect(await (await get(server.port, '/')).text()).not.toContain('data-theme=');

            await patchJson(server.port, UI_ENDPOINTS.settings, { theme: 'dark' }, server.token);

            expect(await (await get(server.port, '/')).text()).toContain('data-theme="dark"');
        });

        it('переход на auto сохраняет Arcanum в системном скрипте следующего документа', async () => {
            new SettingsStore(sherpaDir).patch({ theme: 'dark', arcanum: true });
            const server = await start(uiDir);

            const response = await patchJson(server.port, UI_ENDPOINTS.settings, { theme: 'auto' }, server.token);
            const document = await get(server.port, '/');
            const html = await document.text();

            expect(response.status).toBe(200);
            expect(document.status).toBe(200);
            expect(html).not.toContain('data-theme=');
            expect(html).toContain('prefers-color-scheme: dark');
            expect(html).toContain('"arcanum-dark":"arcanum-light"');
            expect(html.indexOf('<script>')).toBeLessThan(html.indexOf('<link rel="stylesheet"'));
        });

        it('ассеты отдаются с нужным content-type', async () => {
            const server = await start(uiDir);

            const response = await get(server.port, '/assets/app.js');

            expect(response.status).toBe(200);
            expect(response.headers.get('content-type')).toContain('text/javascript');
        });

        it('выход за каталог сборки не проходит', async () => {
            const server = await start(uiDir);

            const response = await fetch(
                `http://127.0.0.1:${String(server.port)}/assets/%2e%2e%2f%2e%2e%2fsecret.txt`,
            );

            expect(response.status).toBe(404);
            expect(await response.text()).not.toContain('тайны');
        });

        it('без uiDir корень остаётся закрытым API-ответом', async () => {
            const server = await start();

            const response = await get(server.port, '/');

            expect(response.status).toBe(401);
        });
    });

    it('петля целиком: постановка из UI → worker next → complete → done в состоянии', async () => {
        const server = await start();

        const enqueued = await postJson(
            server.port,
            UI_ENDPOINTS.enqueue,
            { type: 'echo', text: 'проверка петли' },
            server.token,
        );
        const { task } = uiEnqueueResponseSchema.parse(await enqueued.json());

        const next = await postJson(server.port, WORKER_ENDPOINTS.next, WORKER_BASE, server.token);
        const leased = workerNextResponseSchema.parse(await next.json());
        expect(leased.kind).toBe('task');
        if (leased.kind !== 'task') {
            throw new Error('воркер не получил задачу');
        }
        expect(leased.task.id).toBe(task.id);
        expect(leased.task.instructions).toContain('проверка петли');

        await postJson(
            server.port,
            WORKER_ENDPOINTS.complete,
            { ...WORKER_BASE, taskId: task.id, result: 'проверка петли' },
            server.token,
        );

        const state = await readState(server);
        expect(state.worker.kind).toBe('connected');
        expect(state.tasks[0]?.status).toBe('done');
        expect(state.tasks[0]?.result).toBe('проверка петли');
    });
});

/** Портит строку задачи в обход сервера: так проверяется поведение на повреждённом хранилище. */
function corruptTasks(sherpaDir: string): void {
    const db = new DatabaseSync(databasePathFor(sherpaDir, PR_KEY));
    try {
        db.prepare("UPDATE tasks SET context_files = 'это не json'").run();
    } finally {
        db.close();
    }
}

/**
 * Ближайший снапшот состояния: в канале живут и другие события (ревизия прогресса чтения),
 * а этому набору интересно только состояние.
 */
async function nextState(stream: SseStream): Promise<UiState> {
    for (;;) {
        const event = await stream.next();
        if (event.event === UI_STATE_EVENT) {
            return uiStateSchema.parse(JSON.parse(event.data));
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

/** Минимальный SSE-клиент: `EventSource` в Node нет, а событий в тестах читается по одному. */
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

                // Типы стрима из lib.dom и @types/node расходятся — фиксируем форму чанка сами.
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

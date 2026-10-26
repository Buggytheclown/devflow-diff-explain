import fsSync from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { makeFixtureHost } from '@sherpa/fixtures';
import type { PrDiff, RouteSectionResult, TaskCompleteResponse, UiReviewRouteResponse, UiState } from '@sherpa/protocol';
import {
    LEASE_TTL_SECONDS,
    rpcErrorSchema,
    UI_ENDPOINTS,
    UI_ROUTE_EVENT,
    uiReviewProgressResponseSchema,
    uiReviewRouteResponseSchema,
    uiRouteEventSchema,
    uiRouteFillStopResponseSchema,
    uiRouteGenerateResponseSchema,
    uiStateSchema,
} from '@sherpa/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { databasePathFor, routePayloadDirOf, sharedPayloadDirOf } from './paths.js';
import type { TaskRecord } from './queue.js';
import { MAX_RESULT_REJECTIONS } from './queue.js';
import { requiredSeenRanges } from './progress-store.js';
import { DEFAULT_ROUTE_CONFIG, isSmallPr, MAX_SKELETON_TASKS } from './route-orchestrator.js';
import { contentHashOf } from './route-store.js';
import {
    asRawText,
    mediumDiff,
    mediumRawResults,
    mediumRawResultsEn,
    mediumReadySnapshot,
} from './route/fixture-support.js';
import type { SherpaServer } from './server.js';
import { startServer } from './server.js';
import { get, makeTempSherpaDir, postJson, postRaw, removeTempSherpaDir } from './test-support.js';

/**
 * Оркестрация маршрута на фикстурном хосте: автопостановка, приёмка результатов
 * валидатором, фазы генерации и починка после рестарта. Сетевого хоста тут нет — `fixture-medium`
 * отдаёт тот же дифф, на котором собран голден-корпус валидатора.
 */

const MEDIUM_PR = 'fixture-medium';
const SMALL_PR = 'fixture-small';
const WORKER = 'w-route';

describe('оркестрация маршрута', () => {
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

    async function start(prKey: string = MEDIUM_PR): Promise<SherpaServer> {
        const server = await startServer({
            prKey,
            sherpaDir,
            longPollSeconds: 0.3,
            now: () => new Date(Date.now() + clockOffsetMs),
        });
        servers.push(server);
        return server;
    }

    /** Агент на связи плюс детерминированный прогрев: таймер прогрева ждать в тестах нечего. */
    async function startWithWorker(prKey: string = MEDIUM_PR): Promise<SherpaServer> {
        const server = await start(prKey);
        server.workerRegistry.register(WORKER, 'claude-code', 'opus-5');
        await server.route.warmup();
        return server;
    }

    /** Сервер над той же БД, но хост уже на следующей итерации: пуш случился в простой. */
    async function startWithPushedHost(host: ReturnType<typeof makeFixtureHost>): Promise<SherpaServer> {
        const server = await startServer({
            prKey: MEDIUM_PR,
            sherpaDir,
            longPollSeconds: 0.3,
            reviewHostFactory: () => ({ name: 'fixture', host }),
        });
        servers.push(server);
        server.workerRegistry.register(WORKER, 'claude-code', 'opus-5');
        await server.route.warmup();
        return server;
    }

    async function readRoute(server: SherpaServer): Promise<UiReviewRouteResponse> {
        const response = await get(server.port, UI_ENDPOINTS.reviewRoute, server.token);
        expect(response.status).toBe(200);
        return uiReviewRouteResponseSchema.parse(await response.json());
    }

    async function readState(server: SherpaServer): Promise<UiState> {
        const response = await get(server.port, UI_ENDPOINTS.state, server.token);
        expect(response.status).toBe(200);
        return uiStateSchema.parse(await response.json());
    }

    function routeTasks(server: SherpaServer, type: 'route.skeleton' | 'route.section'): number[] {
        return server.queue
            .listTasks()
            .filter((task) => task.type === type && task.status !== 'cancelled')
            .map((task) => task.id);
    }

    /** Выдать задачу агенту и сдать результат — тот же путь, которым ходит воркерская ручка. */
    function completeTask(server: SherpaServer, taskId: number, result: unknown): TaskCompleteResponse {
        const leased = server.queue.next(WORKER);
        expect(leased?.task.id).toBe(taskId);
        return server.queue.complete(WORKER, taskId, typeof result === 'string' ? result : asRawText(result));
    }

    function sectionFor(planIndex: number): RouteSectionResult {
        const section = mediumRawResults().sections.find((entry) => entry.stops[0]?.planIndex === planIndex);
        if (section === undefined) {
            throw new Error(`у фикстуры нет секции стопа ${String(planIndex)}`);
        }
        return section;
    }

    /** Довести текущую генерацию до ready штатной петлёй воркера. */
    async function completeRoute(server: SherpaServer): Promise<void> {
        completeTask(server, routeTasks(server, 'route.skeleton').at(-1) ?? 0, mediumRawResults().skeleton);
        for (const [position, taskId] of routeTasks(server, 'route.section').entries()) {
            completeTask(server, taskId, sectionFor(position + 1));
        }
        expect((await readRoute(server)).route.phase).toBe('ready');
    }

    /** То же для перестройки: сдаются только ждущие задачи, закрытые прошлым проходом не трогаются. */
    async function completeGeneration(server: SherpaServer, options: { ready?: boolean } = {}): Promise<void> {
        const queued = (type: 'route.skeleton' | 'route.section'): number[] =>
            server.queue
                .listTasks()
                .filter((task) => task.type === type && task.status === 'queued')
                .map((task) => task.id);
        const skeleton = queued('route.skeleton').at(-1);
        if (skeleton !== undefined) {
            completeTask(server, skeleton, mediumRawResults().skeleton);
        }
        for (const [position, taskId] of queued('route.section').entries()) {
            completeTask(server, taskId, sectionFor(position + 1));
        }
        if (options.ready !== false) {
            expect((await readRoute(server)).route.phase).toBe('ready');
        }
    }

    /** Готовый маршрут с одним failed-слотом — исходное состояние ручки fill-stop. */
    async function completeRouteWithFailedFirstStop(server: SherpaServer): Promise<void> {
        completeTask(server, routeTasks(server, 'route.skeleton').at(-1) ?? 0, mediumRawResults().skeleton);
        const sections = routeTasks(server, 'route.section');
        const failedTaskId = sections[0] ?? 0;
        expect(server.queue.next(WORKER)?.task.id).toBe(failedTaskId);
        server.queue.fail(WORKER, failedTaskId, 'агент остановился раньше');
        for (const [position, taskId] of sections.entries()) {
            if (taskId !== failedTaskId) {
                completeTask(server, taskId, sectionFor(position + 1));
            }
        }
        const route = (await readRoute(server)).route;
        expect(route.phase).toBe('ready');
        expect(route.snapshot?.stops[0]?.status).toBe('failed');
    }

    async function readProgress(server: SherpaServer, query = '') {
        return uiReviewProgressResponseSchema.parse(
            await (await get(server.port, `${UI_ENDPOINTS.reviewProgress}${query}`, server.token)).json(),
        );
    }

    async function markStop(server: SherpaServer, stopId = 's01', fileId = 'file-1'): Promise<void> {
        const snapshotId = (await readRoute(server)).route.snapshot?.snapshotId;
        if (snapshotId === undefined) {
            throw new Error('для отметки остановки нужен снапшот маршрута');
        }
        await postJson(
            server.port,
            UI_ENDPOINTS.reviewStopViewed,
            {
                snapshotId,
                stopId,
                viewed: true,
                ranges: [{ fileId, side: 'new', start: 3, end: 7 }],
            },
            server.token,
        );
    }

    /**
     * Отметка остановки теми диапазонами, которые посчитал бы UI: перенос на новый снапшот
     * признаёт её просмотренной, только когда накрыты все изменённые строки её якорей.
     */
    async function markStopCovering(server: SherpaServer, stopId: string): Promise<void> {
        const route = (await readRoute(server)).route;
        const stop = route.snapshot?.stops.find((candidate) => candidate.id === stopId);
        if (route.snapshot === null || stop === undefined) {
            throw new Error(`в снапшоте нет остановки ${stopId}`);
        }
        await postJson(
            server.port,
            UI_ENDPOINTS.reviewStopViewed,
            {
                snapshotId: route.snapshot.snapshotId,
                stopId,
                viewed: true,
                ranges: requiredSeenRanges(stop.anchors, mediumDiff()),
            },
            server.token,
        );
    }

    async function fillStop(server: SherpaServer, snapshotId: string, planIndex: number): Promise<string> {
        const response = await postJson(
            server.port,
            UI_ENDPOINTS.reviewRouteFillStop,
            { snapshotId, planIndex },
            server.token,
        );
        expect(response.status).toBe(200);
        return uiRouteFillStopResponseSchema.parse(await response.json()).outcome;
    }

    it('прогрев ставит скелет: агент на связи, PR выше порога, маршрута нет', async () => {
        const server = await startWithWorker();

        expect(routeTasks(server, 'route.skeleton')).toHaveLength(1);
        const route = await readRoute(server);
        expect(route.route.phase).toBe('reading');
        expect(route.route.smallPr).toBe(false);
        expect(route.routeRevision).toBeGreaterThan(0);
    });

    it('кап генерации приезжает в состояние UI и переживает перечитывание из БД', async () => {
        const server = await startWithWorker();
        expect((await readState(server)).generationCap).toBeNull();

        completeTask(server, routeTasks(server, 'route.skeleton')[0] ?? 0, mediumRawResults().skeleton);

        // Дифф `medium` влезает в бюджет целиком: урезания не было, но факт этого — тоже кап.
        const cap = { filesCovered: mediumDiff().files.length, filesTotal: mediumDiff().files.length, machineFiles: 0, truncated: false };
        expect((await readState(server)).generationCap).toEqual(cap);

        // Рестарт над той же БД: кап лежит в `meta`, а не в памяти процесса.
        await server.close();
        const restarted = await start();
        expect((await readState(restarted)).generationCap).toEqual(cap);
    });

    it('повторная регистрация агента и повторный прогрев дублей не плодят', async () => {
        const server = await startWithWorker();

        server.workerRegistry.register(WORKER, 'claude-code', 'opus-5');
        server.workerRegistry.register('другая-сессия', 'codex');
        await server.route.warmup();
        await server.route.warmup();

        expect(routeTasks(server, 'route.skeleton')).toHaveLength(1);
    });

    it('скелет → секции → готовый снапшот совпадает с фикстурным', async () => {
        const server = await startWithWorker();
        const [skeletonId] = routeTasks(server, 'route.skeleton');

        expect(completeTask(server, skeletonId ?? 0, mediumRawResults().skeleton).kind).toBe('accepted');

        const afterSkeleton = (await readRoute(server)).route;
        expect(afterSkeleton.phase).toBe('filling');
        expect(afterSkeleton.snapshot?.stops.map((stop) => stop.id)).toEqual(
            mediumReadySnapshot().stops.map((stop) => stop.id),
        );
        expect(afterSkeleton.snapshot?.contentHash).toBeNull();

        // Секции ставятся по одной на стоп и в порядке плана: спор за диапазон выигрывает
        // сдавшийся первым, поэтому очередь обязана предлагать стопы по возрастанию номеров.
        const sectionIds = routeTasks(server, 'route.section');
        expect(sectionIds).toHaveLength(6);
        expect(sectionIds.map((id) => server.route.stopsOfTask(id))).toEqual([[1], [2], [3], [4], [5], [6]]);

        for (const [position, taskId] of sectionIds.entries()) {
            const planIndex = position + 1;
            const leased = server.queue.next(WORKER);
            expect(leased?.task.id).toBe(taskId);
            // Аренда взята — стоп заполняется.
            expect((await readRoute(server)).route.snapshot?.stops[position]?.status).toBe('filling');

            expect(server.queue.complete(WORKER, taskId, asRawText(sectionFor(planIndex))).kind).toBe('accepted');
        }

        const ready = (await readRoute(server)).route;
        expect(ready.phase).toBe('ready');
        expect(ready.snapshot?.stops).toEqual(mediumReadySnapshot().stops);
        expect(ready.snapshot?.summary).toBe(mediumReadySnapshot().summary);
        expect(ready.snapshot?.tourOrder).toEqual(mediumReadySnapshot().tourOrder);
        expect(ready.snapshot?.contentHash).toMatch(/^[0-9a-f]{12}$/);
        expect(ready.snapshot?.provenance).toEqual({ harness: 'claude-code', model: 'opus-5', locale: 'ru' });
        expect(ready.snapshot?.commit).toBe(mediumReadySnapshot().commit);
    });

    it('payload задач лежит на диске: контекст и схема существуют к моменту выдачи', async () => {
        const server = await startWithWorker();
        const payloadDir = routePayloadDirOf(sherpaDir, MEDIUM_PR);
        const sharedDir = sharedPayloadDirOf(sherpaDir, MEDIUM_PR);

        const skeleton = server.queue.getTask(routeTasks(server, 'route.skeleton')[0] ?? 0);
        expectPayloadOnDisk(skeleton, payloadDir, sharedDir);

        completeTask(server, skeleton?.id ?? 0, mediumRawResults().skeleton);
        const section = server.queue.getTask(routeTasks(server, 'route.section')[0] ?? 0);
        expectPayloadOnDisk(section, payloadDir, sharedDir);
        // Дифф у скелета и секций один и тот же — общий путь, а не копия на задачу.
        expect(section?.contextFiles[1]).toBe(skeleton?.contextFiles[1]);
        expect(fsSync.readFileSync(section?.contextFiles[2] ?? '', 'utf8')).not.toContain('## Patches');
        // Обе задачи одной генерации — в одном подкаталоге.
        expect(fsSync.readdirSync(payloadDir)).toHaveLength(1);
    });

    it('перезапуск генерации вычищает payload прежней', async () => {
        const server = await startWithWorker();
        const payloadDir = routePayloadDirOf(sherpaDir, MEDIUM_PR);
        const sharedDir = sharedPayloadDirOf(sherpaDir, MEDIUM_PR);
        const before = server.queue.getTask(routeTasks(server, 'route.skeleton')[0] ?? 0);

        // Провал и новая генерация: старые файлы больше никому не нужны.
        server.queue.next(WORKER);
        server.queue.fail(WORKER, before?.id ?? 0, 'не смог');
        expect((await readRoute(server)).route.phase).toBe('failed');
        expect(await server.route.generate()).toBe('started');

        // Каталог прежней генерации снесён; общий дифф ключа переживает её — он не её собственность.
        expect(fsSync.existsSync(before?.resultSchemaFile ?? '')).toBe(false);
        expect(fsSync.existsSync(before?.contextFiles[1] ?? '')).toBe(true);
        expect(fsSync.readdirSync(payloadDir)).toHaveLength(1);
        expectPayloadOnDisk(
            server.queue.getTask(routeTasks(server, 'route.skeleton').at(-1) ?? 0),
            payloadDir,
            sharedDir,
        );
    });

    it('битый скелет: три отклонения не трогают аренду, четвёртого не будет — фаза failed', async () => {
        const server = await startWithWorker();
        const skeletonId = routeTasks(server, 'route.skeleton')[0] ?? 0;
        const broken = asRawText(mediumRawResults().broken.skeletonTourOrderNotPermutation);

        const first = completeTask(server, skeletonId, broken);
        expect(first.kind).toBe('rejected');
        expect(first.kind === 'rejected' && first.errors[0]).toContain('tourOrder');
        expect(server.queue.getTask(skeletonId)).toMatchObject({ status: 'leased', attempt: 1 });
        expect((await readRoute(server)).route.phase).toBe('reading');

        expect(server.queue.complete(WORKER, skeletonId, broken).kind).toBe('rejected');
        expect(server.queue.getTask(skeletonId)?.status).toBe('leased');

        const last = server.queue.complete(WORKER, skeletonId, broken);
        expect(last.kind).toBe('rejected');
        expect(server.queue.getTask(skeletonId)?.status).toBe('failed');

        const route = (await readRoute(server)).route;
        expect(route.phase).toBe('failed');
        expect(route.failure?.message).toContain('Агент не построил план маршрута');
        expect(route.failure?.rawOutput).toBe(broken);
        expect(route.snapshot).toBeNull();
    });

    it('провал секции фазу не роняет: стоп failed, маршрут доходит до ready', async () => {
        const server = await startWithWorker();
        completeTask(server, routeTasks(server, 'route.skeleton')[0] ?? 0, mediumRawResults().skeleton);
        const sectionIds = routeTasks(server, 'route.section');

        // Первый стоп агент завалил явным отказом, остальные сдал как обычно.
        const failing = sectionIds[0] ?? 0;
        server.queue.next(WORKER);
        server.queue.fail(WORKER, failing, 'не разобрался в этом файле');

        for (const [position, taskId] of sectionIds.entries()) {
            if (taskId === failing) {
                continue;
            }
            server.queue.next(WORKER);
            server.queue.complete(WORKER, taskId, asRawText(sectionFor(position + 1)));
        }

        const route = (await readRoute(server)).route;
        expect(route.phase).toBe('ready');
        expect(route.snapshot?.stops[0]?.status).toBe('failed');
        expect(route.snapshot?.stops[0]?.validationNotes.join(' ')).toContain('не разобрался в этом файле');
        expect(route.snapshot?.stops[1]?.status).toBe('ready');
    });

    it('смерть агента: протухшая аренда возвращает задачу, стоп снова queued, фаза filling', async () => {
        const server = await startWithWorker();
        completeTask(server, routeTasks(server, 'route.skeleton')[0] ?? 0, mediumRawResults().skeleton);
        const sectionIds = routeTasks(server, 'route.section');
        // Первый стоп агент сдать успел, на втором его убили.
        completeTask(server, sectionIds[0] ?? 0, sectionFor(1));
        server.queue.next(WORKER);
        expect((await readRoute(server)).route.snapshot?.stops[1]?.status).toBe('filling');

        clockOffsetMs = (LEASE_TTL_SECONDS.background + 1) * 1000;
        // Любое чтение очереди возвращает протухшую аренду — таймеров для этого не нужно.
        server.queue.listTasks();

        expect(server.queue.getTask(sectionIds[1] ?? 0)).toMatchObject({ status: 'queued', attempt: 2 });
        const route = (await readRoute(server)).route;
        expect(route.phase).toBe('filling');
        expect(route.snapshot?.stops[1]?.status).toBe('queued');
        // Заполненное остаётся читаемым: сданный до смерти агента стоп никуда не делся
        // (docs/design/SPEC-elements.md §4.4).
        expect(route.snapshot?.stops[0]).toEqual(mediumReadySnapshot().stops[0]);
    });

    it('батч секций укрупняется конфигом: три стопа в одной задаче', async () => {
        const server = await startServer({
            prKey: MEDIUM_PR,
            sherpaDir,
            longPollSeconds: 0.3,
            route: { sectionBatchSize: 3 },
        });
        servers.push(server);
        server.workerRegistry.register(WORKER, 'claude-code', 'opus-5');
        await server.route.warmup();
        completeTask(server, routeTasks(server, 'route.skeleton')[0] ?? 0, mediumRawResults().skeleton);

        const sectionIds = routeTasks(server, 'route.section');
        expect(sectionIds.map((id) => server.route.stopsOfTask(id))).toEqual([
            [1, 2, 3],
            [4, 5, 6],
        ]);

        // Батч сдаётся одним результатом — валидатор принимает несколько стопов сразу.
        completeTask(server, sectionIds[0] ?? 0, {
            stops: [1, 2, 3].flatMap((planIndex) => sectionFor(planIndex).stops),
        });
        completeTask(server, sectionIds[1] ?? 0, {
            stops: [4, 5, 6].flatMap((planIndex) => sectionFor(planIndex).stops),
        });

        const route = (await readRoute(server)).route;
        expect(route.phase).toBe('ready');
        expect(route.snapshot?.stops).toEqual(mediumReadySnapshot().stops);
    });

    it('малый PR: маршрут не ставится, ручка честно говорит почему', async () => {
        const server = await startWithWorker(SMALL_PR);

        expect(routeTasks(server, 'route.skeleton')).toHaveLength(0);
        const route = (await readRoute(server)).route;
        expect(route.smallPr).toBe(true);
        expect(route.phase).toBe('none');

        const response = await postJson(server.port, UI_ENDPOINTS.reviewRouteGenerate, {}, server.token);
        expect(uiRouteGenerateResponseSchema.parse(await response.json()).outcome).toBe('small_pr');
        expect(routeTasks(server, 'route.skeleton')).toHaveLength(0);
    });

    // Порог меряет только объём правки: по числу файлов одинокий пятисотстрочный файл
    // (RFC в доках) оставался бы без маршрута.
    it('порог маршрута считает строки, а не файлы', () => {
        const diffOf = (changes: readonly [additions: number, deletions: number][]): PrDiff => ({
            diffId: 'd1',
            baseCommit: 'base',
            headCommit: 'head',
            files: changes.map(([additions, deletions], index) => ({
                fileId: `f${String(index)}`,
                path: `file-${String(index)}.md`,
                oldPath: null,
                changeType: 'add',
                binary: false,
                generated: false,
                additions,
                deletions,
                patch: null,
                viewed: null,
                blameUrl: null,
                hostFileUrl: null,
                image: null,
            })),
        });

        expect(isSmallPr(diffOf([[548, 0]]), DEFAULT_ROUTE_CONFIG)).toBe(false);
        expect(isSmallPr(diffOf([[7, 1]]), DEFAULT_ROUTE_CONFIG)).toBe(true);
        expect(isSmallPr(diffOf([[40, 0]]), DEFAULT_ROUTE_CONFIG)).toBe(true);
        expect(
            isSmallPr(
                diffOf([
                    [20, 0],
                    [25, 0],
                ]),
                DEFAULT_ROUTE_CONFIG,
            ),
        ).toBe(false);
    });

    describe('ручка generate', () => {
        async function generate(server: SherpaServer): Promise<string> {
            const response = await postJson(server.port, UI_ENDPOINTS.reviewRouteGenerate, {}, server.token);
            expect(response.status).toBe(200);
            return uiRouteGenerateResponseSchema.parse(await response.json()).outcome;
        }

        it('из фазы none запускает генерацию даже без живого агента', async () => {
            const server = await start();

            expect(await generate(server)).toBe('started');
            expect(routeTasks(server, 'route.skeleton')).toHaveLength(1);
            expect((await readRoute(server)).route.phase).toBe('reading');
        });

        it('из фаз reading/filling — already_running, дублей нет', async () => {
            const server = await startWithWorker();

            expect(await generate(server)).toBe('already_running');
            expect(routeTasks(server, 'route.skeleton')).toHaveLength(1);

            completeTask(server, routeTasks(server, 'route.skeleton')[0] ?? 0, mediumRawResults().skeleton);
            expect(await generate(server)).toBe('already_running');
            expect(routeTasks(server, 'route.skeleton')).toHaveLength(1);
        });

        it('из фазы failed — started: прежний провал стёрт, задача поставлена заново', async () => {
            const server = await startWithWorker();
            const skeletonId = routeTasks(server, 'route.skeleton')[0] ?? 0;
            const broken = asRawText(mediumRawResults().broken.skeletonTourOrderNotPermutation);
            completeTask(server, skeletonId, broken);
            server.queue.complete(WORKER, skeletonId, broken);
            server.queue.complete(WORKER, skeletonId, broken);
            expect((await readRoute(server)).route.phase).toBe('failed');

            expect(await generate(server)).toBe('started');

            const route = (await readRoute(server)).route;
            expect(route.phase).toBe('reading');
            expect(route.failure).toBeNull();
            expect(routeTasks(server, 'route.skeleton')).toHaveLength(2);
        });

        it('из ready запускает новый скелет, оставляя старый снапшот и прогресс читаемыми', async () => {
            const server = await startWithWorker();
            await completeRoute(server);
            await markStop(server);
            const before = (await readRoute(server)).route.snapshot;

            expect(await generate(server)).toBe('started');

            const rebuilding = (await readRoute(server)).route;
            expect(rebuilding.phase).toBe('reading');
            expect(rebuilding.snapshot).toEqual(before);
            expect(rebuilding.failure).toBeNull();
            expect((await readProgress(server)).stops).toEqual([{ stopId: 's01', viewed: true }]);
            expect(routeTasks(server, 'route.skeleton')).toHaveLength(2);
        });

        it('отмена перестройки возвращает ready со старым снапшотом и прогрессом', async () => {
            const server = await startWithWorker();
            await completeRoute(server);
            await markStop(server);
            const before = (await readRoute(server)).route.snapshot;

            expect(await generate(server)).toBe('started');
            server.queue.cancel(routeTasks(server, 'route.skeleton').at(-1) ?? 0);

            const restored = (await readRoute(server)).route;
            expect(restored.phase).toBe('ready');
            expect(restored.snapshot).toEqual(before);
            expect(restored.failure).toBeNull();
            expect((await readProgress(server)).stops).toEqual([{ stopId: 's01', viewed: true }]);
        });

        it('провал скелета перестройки оставляет старый снапшот и прогресс', async () => {
            const server = await startWithWorker();
            await completeRoute(server);
            await markStop(server);
            const before = (await readRoute(server)).route.snapshot;

            expect(await generate(server)).toBe('started');
            const skeletonId = routeTasks(server, 'route.skeleton').at(-1) ?? 0;
            expect(server.queue.next(WORKER)?.task.id).toBe(skeletonId);
            server.queue.fail(WORKER, skeletonId, 'не смог перестроить');

            const failed = (await readRoute(server)).route;
            expect(failed.phase).toBe('failed');
            expect(failed.snapshot).toEqual(before);
            expect(failed.failure?.message).toContain('не смог перестроить');
            expect((await readProgress(server)).stops).toEqual([{ stopId: 's01', viewed: true }]);
        });

        it('отметки нового снапшота появляются переносом, а не сразу с планом', async () => {
            const server = await startWithWorker();
            await completeRoute(server);
            await markStopCovering(server, 's01');
            const before = (await readRoute(server)).route.snapshot;

            expect(await generate(server)).toBe('started');
            expect((await readProgress(server)).stops).toHaveLength(1);

            const skeletonId = routeTasks(server, 'route.skeleton').at(-1) ?? 0;
            expect(completeTask(server, skeletonId, mediumRawResults().skeleton).kind).toBe('accepted');

            const accepted = (await readRoute(server)).route;
            expect(accepted.phase).toBe('filling');
            expect(accepted.snapshot?.snapshotId).not.toBe(before?.snapshotId);
            // Якорей у плана ещё нет — переносить нечего, отметки приедут с заполненными секциями.
            expect((await readProgress(server)).stops).toEqual([]);
            // Якорей у плана нет — `carried` появится только с заморозкой, баннер до неё без чисел.
            expect(accepted.snapshot?.carried).toBeNull();

            await completeGeneration(server);
            expect((await readProgress(server)).stops).toEqual([{ stopId: 's01', viewed: true }]);
        });

        it('опоздавшая отметка старого снапшота не попадает в новый стоп с тем же id', async () => {
            const server = await startWithWorker();
            await completeRoute(server);
            const oldSnapshotId = (await readRoute(server)).route.snapshot?.snapshotId;
            if (oldSnapshotId === undefined) {
                throw new Error('готовому маршруту нужен snapshotId');
            }

            expect(await generate(server)).toBe('started');
            const skeletonId = routeTasks(server, 'route.skeleton').at(-1) ?? 0;
            expect(completeTask(server, skeletonId, mediumRawResults().skeleton).kind).toBe('accepted');

            const activeSnapshotId = (await readRoute(server)).route.snapshot?.snapshotId;
            expect(activeSnapshotId).not.toBe(oldSnapshotId);
            await postJson(
                server.port,
                UI_ENDPOINTS.reviewStopViewed,
                {
                    snapshotId: oldSnapshotId,
                    stopId: 's01',
                    viewed: true,
                    ranges: [{ fileId: 'file-1', side: 'new', start: 3, end: 7 }],
                },
                server.token,
            );

            expect(await readProgress(server)).toMatchObject({ files: [], stops: [] });
        });

        it('сбой переноса отметок откатывает и заморозку снапшота', async () => {
            const server = await startWithWorker();
            await completeRoute(server);
            await markStopCovering(server, 's01');
            const before = (await readRoute(server)).route.snapshot;
            expect(await generate(server)).toBe('started');

            const db = new DatabaseSync(databasePathFor(sherpaDir, MEDIUM_PR));
            // Перенос отметок пишет в `stop_progress` внутри транзакции заморозки снапшота.
            db.exec(`
                CREATE TRIGGER reject_stop_progress_carry
                BEFORE INSERT ON stop_progress
                BEGIN
                    SELECT RAISE(ABORT, 'test rollback');
                END;
            `);
            try {
                await completeGeneration(server, { ready: false });

                const rebuilding = (await readRoute(server)).route;
                // Снапшот не заморожен: транзакция заморозки откатилась вместе с переносом.
                expect(rebuilding.phase).toBe('filling');
                expect(rebuilding.snapshot?.contentHash).toBeNull();
                // Приёмка скелета переноса ещё не делала: якорей у плана нет.
                expect(rebuilding.snapshot?.carried).toBeNull();
                // Отметки прежнего снапшота на месте, отметок нового не появилось.
                expect(db.prepare('SELECT snapshot_id, stop_id, viewed FROM stop_progress').all()).toEqual([
                    { snapshot_id: before?.snapshotId, stop_id: 's01', viewed: 1 },
                ]);
            } finally {
                db.exec('DROP TRIGGER reject_stop_progress_carry;');
                db.close();
            }
        });

        it('новая генерация на той же итерации переносит отметки, а не стирает их', async () => {
            const server = await startWithWorker();
            await completeRoute(server);
            await markStopCovering(server, 's01');
            await postJson(
                server.port,
                UI_ENDPOINTS.reviewFileViewed,
                { fileId: 'file-2', viewed: true },
                server.token,
            );

            expect(await generate(server)).toBe('started');
            await completeGeneration(server);

            const route = (await readRoute(server)).route;
            // Знаменатель — стопы с якорями: синтетическое «Прочее» перенос накрыть не может.
            expect(route.snapshot?.stops).toHaveLength(7);
            expect(route.snapshot?.stops.filter((stop) => stop.anchors.length > 0)).toHaveLength(6);
            expect(route.snapshot?.carried).toEqual({ kept: 1, total: 6, zeroReason: null });
            const progress = uiReviewProgressResponseSchema.parse(
                await (await get(server.port, UI_ENDPOINTS.reviewProgress, server.token)).json(),
            );
            expect(progress.stops).toEqual([{ stopId: 's01', viewed: true }]);
            expect(progress.files).toContainEqual({ fileId: 'file-2', viewed: true, seenRanges: [] });
        });

        it('перенос дал ноль без единой отметки: причина названа как «переносить нечего»', async () => {
            const server = await startWithWorker();
            await completeRoute(server);

            expect(await generate(server)).toBe('started');
            await completeGeneration(server);

            const route = (await readRoute(server)).route;
            expect(route.snapshot?.carried).toEqual({ kept: 0, total: 6, zeroReason: 'no_marks' });
        });

        it('отметки были, но ни одной остановки не накрыли: «переносить нечего» — неправда', async () => {
            const server = await startWithWorker();
            await completeRoute(server);
            // Часть диапазонов остановки: целиком просмотренной она не считается.
            await markStop(server, 's01');

            expect(await generate(server)).toBe('started');
            await completeGeneration(server);

            const route = (await readRoute(server)).route;
            // Перегенерация идёт по той же итерации: перенесённых строк на ней нет по построению,
            // но отметки ревьюера есть — причина считается по итерации-источнику.
            expect(route.snapshot?.carried).toEqual({ kept: 0, total: 6, zeroReason: 'no_overlap' });
        });

        it('без ревью-хоста — no_review_host, а состояние маршрута читается', async () => {
            const server = await start('unknown-777');

            const response = await postJson(server.port, UI_ENDPOINTS.reviewRouteGenerate, {}, server.token);
            expect(response.status).toBe(404);
            expect(rpcErrorSchema.parse(await response.json()).error.code).toBe('no_review_host');
            expect((await readRoute(server)).route.phase).toBe('none');
        });
    });

    /**
     * Язык генерации: лестница «запрос вкладки → настройки → подсказка агента → русский»
     * и снапшот, целиком написанный на одном языке.
     */
    describe('язык генерации', () => {
        async function generateWith(server: SherpaServer, body: unknown): Promise<string> {
            const response = await postJson(server.port, UI_ENDPOINTS.reviewRouteGenerate, body, server.token);
            expect(response.status).toBe(200);
            return uiRouteGenerateResponseSchema.parse(await response.json()).outcome;
        }

        function skeletonInstructionsOf(server: SherpaServer): string {
            const task = server.queue.listTasks().find((candidate) => candidate.type === 'route.skeleton');
            return task?.instructions ?? '';
        }

        function guideOf(server: SherpaServer, type: 'route.skeleton' | 'route.section'): string {
            const task = server.queue
                .listTasks()
                .filter((candidate) => candidate.type === type && candidate.status !== 'cancelled')
                .at(-1);
            const guide = task?.contextFiles.find((file) => file.includes('-guide-'));
            return guide === undefined ? '' : fsSync.readFileSync(guide, 'utf8');
        }

        it('локаль запроса доезжает до промптов, провенанса и синтетического стопа', async () => {
            // Без агента: прогрев не должен успеть запустить генерацию раньше ручки.
            const server = await start();

            expect(await generateWith(server, { locale: 'en' })).toBe('started');
            expect(skeletonInstructionsOf(server)).toContain('in English');
            expect(guideOf(server, 'route.skeleton')).toContain('**Write in English.**');

            const skeletonId = routeTasks(server, 'route.skeleton').at(-1) ?? 0;
            completeTask(server, skeletonId, mediumRawResultsEn().skeleton);

            const route = (await readRoute(server)).route;
            expect(route.snapshot?.provenance.locale).toBe('en');
            expect(route.snapshot?.stops.at(-1)?.title).toBe('Other — lines the model did not place');
            // Секции продолжают скелет: их методичка на том же языке.
            expect(guideOf(server, 'route.section')).toContain('**Write in English.**');
        });

        it('локаль генерации переживает рестарт: скелет принимают на языке его задачи', async () => {
            const first = await start();
            expect(await generateWith(first, { locale: 'en' })).toBe('started');
            const skeletonId = routeTasks(first, 'route.skeleton').at(-1) ?? 0;
            await first.close();

            // Лестница второго процесса дала бы русский: настроек нет, агент языка не называл.
            const second = await start();
            expect(completeTask(second, skeletonId, mediumRawResultsEn().skeleton).kind).toBe('accepted');

            const route = (await readRoute(second)).route;
            expect(route.snapshot?.provenance.locale).toBe('en');
            expect(route.snapshot?.stops.at(-1)?.title).toBe('Other — lines the model did not place');
            expect(guideOf(second, 'route.section')).toContain('**Write in English.**');
        });

        it('без локали в запросе действует явный выбор в настройках', async () => {
            fsSync.writeFileSync(`${sherpaDir}/settings.json`, JSON.stringify({ locale: 'en' }));
            const server = await start();

            expect(await generateWith(server, {})).toBe('started');
            expect(skeletonInstructionsOf(server)).toContain('in English');
        });

        it('настройка `auto` отдаёт решение подсказке агента', async () => {
            const server = await start();
            server.workerRegistry.register(WORKER, 'claude-code', 'opus-5', 'en');
            // Автопостановка прогревом идёт по той же лестнице: языка ей никто не называл.
            await server.route.warmup();

            expect(routeTasks(server, 'route.skeleton')).toHaveLength(1);
            expect(skeletonInstructionsOf(server)).toContain('in English');
        });

        it('никто языка не назвал — русский; тело запроса необязательно', async () => {
            const server = await start();

            const response = await postRaw(server.port, UI_ENDPOINTS.reviewRouteGenerate, '', server.token);
            expect(response.status).toBe(200);
            expect(uiRouteGenerateResponseSchema.parse(await response.json()).outcome).toBe('started');
            expect(skeletonInstructionsOf(server)).toContain('in Russian');
        });

        it('чужая локаль в теле — отказ контракта', async () => {
            const server = await start();

            const response = await postJson(
                server.port,
                UI_ENDPOINTS.reviewRouteGenerate,
                { locale: 'de' },
                server.token,
            );
            expect(response.status).toBe(400);
            expect(rpcErrorSchema.parse(await response.json()).error.code).toBe('bad_request');
        });
    });

    describe('ручка fill-stop', () => {
        function openSectionTasks(server: SherpaServer): TaskRecord[] {
            return server.queue
                .listTasks()
                .filter(
                    (task) =>
                        task.type === 'route.section' && (task.status === 'queued' || task.status === 'leased'),
                );
        }

        it('failed-стоп дозаполняется одной секцией без смены снапшота и потери чужого прогресса', async () => {
            const server = await startWithWorker();
            await completeRouteWithFailedFirstStop(server);
            await markStop(server, 's02', 'file-2');
            const before = (await readRoute(server)).route.snapshot;
            const snapshotId = before?.snapshotId ?? '';
            const beforeHash = before?.contentHash;

            expect(await fillStop(server, snapshotId, 1)).toBe('started');

            const filling = (await readRoute(server)).route;
            expect(filling.phase).toBe('filling');
            expect(filling.snapshot?.snapshotId).toBe(snapshotId);
            expect(filling.snapshot?.contentHash).toBeNull();
            expect(filling.snapshot?.stops[0]).toMatchObject({ status: 'queued', validationNotes: [] });
            const [section] = openSectionTasks(server);
            expect(openSectionTasks(server)).toHaveLength(1);
            expect(server.route.stopsOfTask(section?.id ?? 0)).toEqual([1]);

            expect(completeTask(server, section?.id ?? 0, sectionFor(1)).kind).toBe('accepted');

            const ready = (await readRoute(server)).route;
            expect(ready.phase).toBe('ready');
            expect(ready.snapshot?.snapshotId).toBe(snapshotId);
            expect(ready.snapshot?.stops[0]).toEqual(mediumReadySnapshot().stops[0]);
            expect(ready.snapshot?.contentHash).toMatch(/^[0-9a-f]{12}$/);
            expect(ready.snapshot?.contentHash).not.toBe(beforeHash);
            expect((await readProgress(server)).stops).toEqual([{ stopId: 's02', viewed: true }]);
        });

        it('дозаполнение идёт по сохранённому патчу итерации, даже когда хост прилёг', async () => {
            const first = await startWithWorker();
            await completeRouteWithFailedFirstStop(first);
            const snapshotId = (await readRoute(first)).route.snapshot?.snapshotId ?? '';
            await first.close();

            const broken = makeFixtureHost('medium');
            broken.getDiff = () => Promise.reject(new Error('хост прилёг'));
            const second = await startServer({
                prKey: MEDIUM_PR,
                sherpaDir,
                longPollSeconds: 0.3,
                reviewHostFactory: () => ({ name: 'fixture', host: broken }),
            });
            servers.push(second);

            const response = await postJson(
                second.port,
                UI_ENDPOINTS.reviewRouteFillStop,
                { snapshotId, planIndex: 1 },
                second.token,
            );

            expect(response.status).toBe(200);
            expect(uiRouteFillStopResponseSchema.parse(await response.json()).outcome).toBe('started');
            expect((await readRoute(second)).route.phase).toBe('filling');
        });

        it('недоступный дифф не переводит маршрут в filling и не мутирует failed-стоп', async () => {
            const first = await startWithWorker();
            await completeRouteWithFailedFirstStop(first);
            const before = await readRoute(first);
            const snapshotId = before.route.snapshot?.snapshotId ?? '';
            await first.close();
            // Патча итерации нет ни у хоста, ни локально — резолвить якоря секции не по чему.
            dropIterations(sherpaDir, MEDIUM_PR);

            const broken = makeFixtureHost('medium');
            broken.getDiff = () => Promise.reject(new Error('хост прилёг'));
            const second = await startServer({
                prKey: MEDIUM_PR,
                sherpaDir,
                longPollSeconds: 0.3,
                reviewHostFactory: () => ({ name: 'fixture', host: broken }),
            });
            servers.push(second);
            const beforeFill = await readRoute(second);
            expect(beforeFill.route).toEqual(before.route);

            const response = await postJson(
                second.port,
                UI_ENDPOINTS.reviewRouteFillStop,
                { snapshotId, planIndex: 1 },
                second.token,
            );

            expect(response.status).toBe(502);
            const error = rpcErrorSchema.parse(await response.json());
            expect(error.error.code).toBe('host_unavailable');
            expect(error.error.message).toContain('Хост-адаптер не отдал дифф');
            expect(await readRoute(second)).toEqual(beforeFill);
            expect(openSectionTasks(second)).toHaveLength(0);
        });

        it('гарды различают занятую фазу, старый снапшот и уже заполненный стоп', async () => {
            const server = await startWithWorker();
            expect(await fillStop(server, 'чужой-снапшот', 1)).toBe('already_running');

            completeTask(server, routeTasks(server, 'route.skeleton')[0] ?? 0, mediumRawResults().skeleton);
            const sections = routeTasks(server, 'route.section');
            const fillingSnapshotId = (await readRoute(server)).route.snapshot?.snapshotId ?? '';
            expect(await fillStop(server, fillingSnapshotId, 1)).toBe('already_running');

            const failedTaskId = sections[0] ?? 0;
            expect(server.queue.next(WORKER)?.task.id).toBe(failedTaskId);
            server.queue.fail(WORKER, failedTaskId, 'агент остановился раньше');
            for (const [position, taskId] of sections.entries()) {
                if (taskId !== failedTaskId) {
                    completeTask(server, taskId, sectionFor(position + 1));
                }
            }

            const snapshotId = (await readRoute(server)).route.snapshot?.snapshotId ?? '';
            expect(await fillStop(server, 'старый-снапшот', 1)).toBe('stale_snapshot');
            expect(await fillStop(server, snapshotId, 1)).toBe('started');
            expect(await fillStop(server, snapshotId, 1)).toBe('already_running');
            const [refill] = openSectionTasks(server);
            expect(openSectionTasks(server)).toHaveLength(1);

            expect(completeTask(server, refill?.id ?? 0, sectionFor(1)).kind).toBe('accepted');
            expect(await fillStop(server, snapshotId, 1)).toBe('not_unfilled');
            expect(openSectionTasks(server)).toHaveLength(0);
        });

        it('провал дозаполнения возвращает failed-стоп и фазу ready в том же снапшоте', async () => {
            const server = await startWithWorker();
            await completeRouteWithFailedFirstStop(server);
            const before = (await readRoute(server)).route.snapshot;
            const snapshotId = before?.snapshotId ?? '';

            expect(await fillStop(server, snapshotId, 1)).toBe('started');
            const [section] = openSectionTasks(server);
            expect(server.queue.next(WORKER)?.task.id).toBe(section?.id);
            server.queue.fail(WORKER, section?.id ?? 0, 'повторное заполнение не удалось');

            const ready = (await readRoute(server)).route;
            expect(ready.phase).toBe('ready');
            expect(ready.snapshot?.snapshotId).toBe(snapshotId);
            expect(ready.snapshot?.stops[0]?.status).toBe('failed');
            expect(ready.snapshot?.stops[0]?.validationNotes.join(' ')).toContain('повторное заполнение не удалось');
            expect(ready.snapshot?.stops.slice(1)).toEqual(before?.stops.slice(1));
        });

        it('полная перегенерация и дозаполнение взаимно блокируются', async () => {
            const server = await startWithWorker();
            expect((await readRoute(server)).route.phase).toBe('reading');
            expect(await fillStop(server, 'чужой-снапшот', 1)).toBe('already_running');

            await completeRouteWithFailedFirstStop(server);
            const snapshotId = (await readRoute(server)).route.snapshot?.snapshotId ?? '';
            expect(await fillStop(server, snapshotId, 1)).toBe('started');
            expect(await server.route.generate()).toBe('already_running');
            expect(openSectionTasks(server)).toHaveLength(1);
        });

        it('рестарт посреди дозаполнения сохраняет задачу, а сверка доводит стоп до ready', async () => {
            const first = await startWithWorker();
            await completeRouteWithFailedFirstStop(first);
            const snapshotId = (await readRoute(first)).route.snapshot?.snapshotId ?? '';
            expect(await fillStop(first, snapshotId, 1)).toBe('started');
            const taskId = openSectionTasks(first)[0]?.id ?? 0;
            await first.close();

            const second = await startWithWorker();
            expect((await readRoute(second)).route.phase).toBe('filling');
            expect(openSectionTasks(second).map((task) => task.id)).toEqual([taskId]);
            expect(second.route.stopsOfTask(taskId)).toEqual([1]);

            expect(completeTask(second, taskId, sectionFor(1)).kind).toBe('accepted');
            const ready = (await readRoute(second)).route;
            expect(ready.phase).toBe('ready');
            expect(ready.snapshot?.snapshotId).toBe(snapshotId);
            expect(ready.snapshot?.stops[0]?.status).toBe('ready');
        });
    });

    it('задача маршрута без привязки отменяется, а чужие задачи очереди не трогает', async () => {
        const server = await startWithWorker();
        const skeletonId = routeTasks(server, 'route.skeleton')[0] ?? 0;

        // Сирота: прошлый процесс умер между постановкой задачи и записью её привязки.
        const orphan = server.queue.enqueue({
            type: 'route.section',
            priority: 'background',
            instructions: 'секция без привязки',
            contextFiles: [],
        });
        const echo = server.queue.enqueue({
            type: 'echo',
            priority: 'interactive',
            instructions: 'перескажи дифф',
            contextFiles: [],
        });

        expect(server.queue.getTask(orphan.id)?.status).toBe('cancelled');
        expect(server.route.stopsOfTask(orphan.id)).toBeNull();
        expect(server.queue.getTask(echo.id)?.status).toBe('queued');
        // Агенту достаётся живая задача, а не сирота: интерактивная идёт вперёд фоновой.
        expect(server.queue.next(WORKER)?.task.id).toBe(echo.id);
        server.queue.complete(WORKER, echo.id, 'пересказал');
        expect(server.queue.next(WORKER)?.task.id).toBe(skeletonId);
    });

    it('применение принятого плана срывается: перепостановка не бесконечна', async () => {
        const server = await startWithWorker();
        const raw = asRawText(mediumRawResults().skeleton);

        // Задача закрывается в обход сервера — так выглядит приёмка, чьё применение не доехало
        // до снапшота (упавшая запись, смерть процесса между коммитом и эффектом).
        for (let attempt = 1; attempt <= MAX_SKELETON_TASKS; attempt += 1) {
            const skeletons = routeTasks(server, 'route.skeleton');
            expect(skeletons).toHaveLength(attempt);
            closeTaskBehindServer(sherpaDir, MEDIUM_PR, skeletons.at(-1) ?? 0, raw);
            pokeQueue(server);
        }

        expect(routeTasks(server, 'route.skeleton')).toHaveLength(MAX_SKELETON_TASKS);
        const route = (await readRoute(server)).route;
        expect(route.phase).toBe('failed');
        expect(route.failure?.message).toContain('не смог применить');
        expect(route.failure?.rawOutput).toBe(raw);
    });

    it('дифф не загружен: отказ приёмки бюджета не тратит и задачу не хоронит', async () => {
        const first = await startWithWorker();
        const skeletonId = routeTasks(first, 'route.skeleton')[0] ?? 0;
        await first.close();
        // Патча итерации генерации нет и локально: иначе приёмка обошлась бы без хоста.
        dropIterations(sherpaDir, MEDIUM_PR);

        // Второй сервер поднялся над той же БД, но дифф ему хост не отдал: прогрев сорвался,
        // а агент продолжает держать аренду задачи прошлого процесса.
        const broken = makeFixtureHost('medium');
        broken.getDiff = () => Promise.reject(new Error('хост прилёг'));
        const second = await startServer({
            prKey: MEDIUM_PR,
            sherpaDir,
            longPollSeconds: 0.3,
            reviewHostFactory: () => ({ name: 'fixture', host: broken }),
        });
        servers.push(second);
        second.workerRegistry.register(WORKER, 'claude-code', 'opus-5');
        await second.route.warmup();

        const raw = asRawText(mediumRawResults().skeleton);
        expect(second.queue.next(WORKER)?.task.id).toBe(skeletonId);
        for (let attempt = 0; attempt <= MAX_RESULT_REJECTIONS; attempt += 1) {
            const response = second.queue.complete(WORKER, skeletonId, raw);
            expect(response.kind).toBe('rejected');
            expect(response.kind === 'rejected' && response.errors.join(' ')).toContain('has not loaded the diff');
        }

        expect(second.queue.getTask(skeletonId)).toMatchObject({ status: 'leased', attempt: 1 });
        expect((await readRoute(second)).route.phase).toBe('reading');
    });

    describe('рестарт сервера посреди генерации', () => {
        it('задачи переживают рестарт и не дублируются', async () => {
            const first = await startWithWorker();
            completeTask(first, routeTasks(first, 'route.skeleton')[0] ?? 0, mediumRawResults().skeleton);
            const before = routeTasks(first, 'route.section');
            await first.close();

            const second = await startWithWorker();

            expect(routeTasks(second, 'route.section')).toEqual(before);
            const route = (await readRoute(second)).route;
            expect(route.phase).toBe('filling');
            expect(route.snapshot?.stops[0]?.status).toBe('queued');
        });

        it('доставка недостающей секции не сносит payload переживших рестарт задач', async () => {
            const first = await startWithWorker();
            completeTask(first, routeTasks(first, 'route.skeleton')[0] ?? 0, mediumRawResults().skeleton);
            const before = routeTasks(first, 'route.section');
            const survivor = first.queue.getTask(before[0] ?? 0);
            await first.close();
            // Сервер умер посреди постановки батча: часть секций осталась без задачи.
            dropTask(sherpaDir, MEDIUM_PR, before.at(-1) ?? 0);

            const second = await startWithWorker();

            expect(routeTasks(second, 'route.section')).toHaveLength(before.length);
            for (const file of survivor?.contextFiles ?? []) {
                expect(fsSync.existsSync(file)).toBe(true);
            }
            expectPayloadOnDisk(
                second.queue.getTask(routeTasks(second, 'route.section').at(-1) ?? 0),
                routePayloadDirOf(sherpaDir, MEDIUM_PR),
                sharedPayloadDirOf(sherpaDir, MEDIUM_PR),
            );
        });

        it('фаза без своих задач доставляется заново', async () => {
            const first = await startWithWorker();
            expect(routeTasks(first, 'route.skeleton')).toHaveLength(1);
            await first.close();
            // Сервер умер между приёмкой и записью — задач нет, а фаза осталась.
            dropTasks(sherpaDir, MEDIUM_PR);

            const second = await startWithWorker();

            expect(routeTasks(second, 'route.skeleton')).toHaveLength(1);
            expect((await readRoute(second)).route.phase).toBe('reading');
        });

        it('пуш в простой сервера: скелет принимается против итерации своей задачи', async () => {
            const first = await startWithWorker();
            const skeletonId = routeTasks(first, 'route.skeleton')[0] ?? 0;
            await first.close();

            // Пока сервер лежал, автор запушил: активна уже v2, а план читался по v1.
            const pushed = makeFixtureHost('medium');
            pushed.advanceIteration();
            const second = await startWithPushedHost(pushed);
            const active = (await pushed.listIterations()).find((iteration) => iteration.status === 'active');

            expect(second.queue.next(WORKER)?.task.id).toBe(skeletonId);
            expect(completeTask(second, skeletonId, mediumRawResults().skeleton).kind).toBe('accepted');

            const route = (await readRoute(second)).route;
            expect(route.snapshot?.diffId).toBe(mediumDiff().diffId);
            expect(route.snapshot?.diffId).not.toBe(active?.diffId);
            // Секции этого снапшота резолвятся против того же v1 — иначе приёмка бы их отбила.
            expect(route.phase).toBe('filling');
        });

        it('патч итерации маршрута потерян: генерация встаёт с причиной, а не крутит прогрев', async () => {
            const first = await startWithWorker();
            completeTask(first, routeTasks(first, 'route.skeleton')[0] ?? 0, mediumRawResults().skeleton);
            expect((await readRoute(first)).route.phase).toBe('filling');
            await first.close();
            // Задачи секций потеряны, локальных патчей нет, а PR ушёл вперёд: собрать секцию не
            // из чего, и повторный прогрев тут не помогает — он и не должен зацикливаться.
            dropTasks(sherpaDir, MEDIUM_PR);
            dropIterations(sherpaDir, MEDIUM_PR);

            const pushed = makeFixtureHost('medium');
            pushed.advanceIteration();
            const second = await startWithPushedHost(pushed);

            const route = (await readRoute(second)).route;
            expect(route.phase).toBe('failed');
            expect(route.failure?.message).toContain('Постройте маршрут заново');
            expect(routeTasks(second, 'route.section')).toHaveLength(0);
        });

        it('перестройка переживает рестарт со старым снапшотом и своей задачей', async () => {
            const first = await startWithWorker();
            await completeRoute(first);
            const before = (await readRoute(first)).route.snapshot;
            expect(await first.route.generate()).toBe('started');
            const skeletons = routeTasks(first, 'route.skeleton');
            await first.close();

            const second = await startWithWorker();
            const rebuilding = (await readRoute(second)).route;

            expect(rebuilding.phase).toBe('reading');
            expect(rebuilding.snapshot).toEqual(before);
            expect(routeTasks(second, 'route.skeleton')).toEqual(skeletons);
        });
    });

    it('SSE: событие route приезжает сразу и на каждое изменение маршрута', async () => {
        const server = await start();
        const stream = await openSse(
            `http://127.0.0.1:${String(server.port)}${UI_ENDPOINTS.events}?token=${server.token}`,
        );
        streams.push(stream);

        const first = uiRouteEventSchema.parse(JSON.parse((await nextRoute(stream)).data));

        server.workerRegistry.register(WORKER, 'claude-code', 'opus-5');
        await server.route.warmup();

        const afterStart = uiRouteEventSchema.parse(JSON.parse((await nextRoute(stream)).data));
        expect(afterStart.routeRevision).toBeGreaterThan(first.routeRevision);
        expect(afterStart.routeRevision).toBe((await readRoute(server)).routeRevision);
    });
});

describe('контент-хеш снапшота', () => {
    it('считается по содержимому и не зависит от служебных полей', () => {
        const snapshot = mediumReadySnapshot();
        const sameContent = {
            ...snapshot,
            snapshotId: 'другой-id',
            createdAt: '2030-01-01T00:00:00.000Z',
            provenance: { harness: 'codex', model: null, locale: null },
            contentHash: 'что угодно',
        };
        expect(contentHashOf(sameContent)).toBe(contentHashOf(snapshot));

        const edited = {
            ...snapshot,
            stops: snapshot.stops.map((stop, index) =>
                index === 0 ? { ...stop, paragraph: 'абзац переписан' } : stop,
            ),
        };
        expect(contentHashOf(edited)).not.toBe(contentHashOf(snapshot));
    });
});

/** Стирает локальные патчи итераций: так изображается «дифф не достать ни у хоста, ни у себя». */
function dropIterations(sherpaDir: string, prKey: string): void {
    const db = new DatabaseSync(databasePathFor(sherpaDir, prKey));
    try {
        db.exec('DELETE FROM interdiffs; DELETE FROM iterations;');
    } finally {
        db.close();
    }
}

/** Стирает задачи в обход сервера: так проверяется починка фазы, потерявшей свои задачи. */
function dropTasks(sherpaDir: string, prKey: string): void {
    const db = new DatabaseSync(databasePathFor(sherpaDir, prKey));
    try {
        db.exec('DELETE FROM route_tasks; DELETE FROM tasks;');
    } finally {
        db.close();
    }
}

/** Стирает одну задачу в обход сервера: так изображается смерть посреди постановки батча. */
function dropTask(sherpaDir: string, prKey: string, taskId: number): void {
    const db = new DatabaseSync(databasePathFor(sherpaDir, prKey));
    try {
        db.exec(`DELETE FROM route_tasks WHERE task_id = ${String(taskId)};`);
        db.exec(`DELETE FROM tasks WHERE id = ${String(taskId)};`);
    } finally {
        db.close();
    }
}

/** Закрывает задачу мимо очереди: сервер видит «результат принят», а применить его не успел. */
function closeTaskBehindServer(sherpaDir: string, prKey: string, taskId: number, result: string): void {
    const db = new DatabaseSync(databasePathFor(sherpaDir, prKey));
    try {
        db.prepare(
            `UPDATE tasks SET status = 'done', worker_id = NULL, lease_expires_at = NULL, result = ?
             WHERE id = ?`,
        ).run(result, taskId);
    } finally {
        db.close();
    }
}

/** Изменение очереди, будящее сверку маршрута: правку в обход сервера он иначе не заметит. */
function pokeQueue(server: SherpaServer): void {
    server.queue.cancel(
        server.queue.enqueue({
            type: 'echo',
            priority: 'interactive',
            instructions: 'разбуди сверку',
            contextFiles: [],
        }).id,
    );
}

async function nextRoute(stream: SseStream): Promise<SseEvent> {
    for (;;) {
        const event = await stream.next();
        if (event.event === UI_ROUTE_EVENT) {
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

/** Минимальный SSE-клиент: `EventSource` в Node нет, а событий тут читается по одному. */
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

/**
 * Payload задачи материализован: неизменный контекст — по общему пути, своё и схема — в каталоге
 * генерации этого PR.
 */
function expectPayloadOnDisk(task: TaskRecord | null, payloadDir: string, sharedDir: string): void {
    expect(task?.contextFiles.length).toBeGreaterThan(0);
    for (const file of task?.contextFiles ?? []) {
        expect(file.startsWith(payloadDir) || file.startsWith(sharedDir)).toBe(true);
        expect(fsSync.readFileSync(file, 'utf8').length).toBeGreaterThan(0);
    }
    // Методичка и дифф — общие пути; каталог генерации держит только своё.
    expect(task?.contextFiles.filter((file) => file.startsWith(sharedDir))).toHaveLength(2);
    expect(task?.resultSchemaFile).toBeDefined();
    expect(task?.resultSchemaFile?.startsWith(payloadDir)).toBe(true);
    expect(JSON.parse(fsSync.readFileSync(task?.resultSchemaFile ?? '', 'utf8'))).toMatchObject({ type: 'object' });
}

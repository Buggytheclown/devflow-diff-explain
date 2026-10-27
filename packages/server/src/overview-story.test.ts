import { afterEach, expect, it, vi } from 'vitest';
import { overviewStoryFixture } from '@sherpa/fixtures';
import { preparationProgress, UI_ENDPOINTS, uiReviewRouteResponseSchema } from '@sherpa/protocol';
import { startServer } from './server.js';
import type { SherpaServer } from './server.js';
import { get, makeTempSherpaDir, removeTempSherpaDir } from './test-support.js';
import { validateStorySection, validateStorySkeleton } from './story.js';

const fixture = overviewStoryFixture();
const servers: SherpaServer[] = [];
const dirs: string[] = [];
afterEach(async () => { for (const server of servers.splice(0)) await server.close(); for (const dir of dirs.splice(0)) await removeTempSherpaDir(dir); });
async function start(dir?: string) {
    const root = dir ?? await makeTempSherpaDir(); if (dir === undefined) dirs.push(root);
    const server = await startServer({ prKey: 'fixture-medium', sherpaDir: root }); servers.push(server);
    server.workerRegistry.register('worker', 'codex', 'test'); await server.route.warmup();
    return { server, dir: root };
}
async function next(server: SherpaServer) {
    await vi.waitFor(() => { expect(server.queue.listTasks().some((task) => task.status === 'queued')).toBe(true); });
    const value = server.queue.next('worker'); if (value === null) throw new Error('Missing task'); return value.task;
}
async function complete(server: SherpaServer, result: unknown, type: string) {
    const task = await next(server); expect(task.type).toBe(type);
    expect(server.queue.complete('worker', task.id, JSON.stringify(result))).toMatchObject({ kind: 'accepted' });
    return task;
}
async function finishFiles(server: SherpaServer) {
    for (const part of fixture.parts) await complete(server, part, 'route.section');
    await vi.waitFor(async () => { expect((await read(server)).phase).toBe('ready'); });
}
async function read(server: SherpaServer) { return uiReviewRouteResponseSchema.parse(await (await get(server.port, UI_ENDPOINTS.reviewRoute, server.token)).json()).route; }

it('сначала описание и схема, затем небольшие назначения файлов; перезапуск сохраняет прогресс', async () => {
    const { server, dir } = await start();
    await complete(server, fixture.outline, 'route.skeleton');
    expect(server.queue.listTasks().filter((task) => task.type === 'route.section')).toHaveLength(0);
    await complete(server, { contextRequests: [], diagram: fixture.diagram, reason: null }, 'route.diagram');
    await complete(server, fixture.parts[0], 'route.section');
    const before = await read(server);
    const progress = preparationProgress(before);
    expect(progress.completed).toBe(2 + 1 + (fixture.parts[0]?.stops[0]?.files.length ?? 0));
    expect(progress.percent).toBeLessThan(100);
    await server.close(); const restarted = (await start(dir)).server;
    expect(preparationProgress(await read(restarted))).toEqual(progress);
    for (const part of fixture.parts.slice(1)) await complete(restarted, part, 'route.section');
    await vi.waitFor(async () => { expect(preparationProgress(await read(restarted)).percent).toBe(100); });
});

it('сбой и локальный повтор схемы сохраняют готовые файлы и знаменатель; повтор не дублируется', async () => {
    const { server } = await start(); await complete(server, fixture.outline, 'route.skeleton');
    const diagram = await next(server); expect(diagram.type).toBe('route.diagram'); server.queue.fail('worker', diagram.id, 'Synthetic failure');
    await finishFiles(server);
    const saved = (await read(server)).snapshot; if (saved === null) throw new Error('Missing snapshot');
    const before = preparationProgress(await read(server)); expect(before.status).toBe('partial');
    server.route.retryDiagram(saved.snapshotId); server.route.retryDiagram(saved.snapshotId);
    await complete(server, { contextRequests: [], diagram: null, outcome: 'not_applicable', reason: 'Этот набор изменений не задаёт поток данных.' }, 'route.diagram');
    expect((await read(server)).snapshot?.stops).toEqual(saved.stops);
    expect(preparationProgress(await read(server))).toMatchObject({ total: before.total, percent: 100 });
    expect(server.queue.listTasks().filter((task) => task.type === 'route.diagram')).toHaveLength(2);
});

it('отмена новой подготовки не меняет предыдущий результат и не учитывает его готовность', async () => {
    const { server } = await start(); await complete(server, fixture.outline, 'route.skeleton');
    await complete(server, { contextRequests: [], diagram: fixture.diagram, reason: null }, 'route.diagram'); await finishFiles(server);
    const before = (await read(server)).snapshot; await server.route.generate();
    const pending = preparationProgress(await read(server)); expect(pending).toMatchObject({ completed: 0, total: null });
    if (pending.id === null) throw new Error('Missing generation');
    server.route.cancelGeneration(pending.id);
    expect((await read(server)).snapshot).toEqual(before);
    expect(preparationProgress(await read(server)).status).toBe('cancelled');
});

it('повтор незавершённого блока сохраняет принятые файлы и не создаёт новую подготовку', async () => {
    const { server } = await start(); await complete(server, fixture.outline, 'route.skeleton');
    await complete(server, { contextRequests: [], diagram: fixture.diagram, reason: null }, 'route.diagram');
    await complete(server, fixture.parts[0], 'route.section');
    const failed = await next(server); expect(failed.type).toBe('route.section'); server.queue.fail('worker', failed.id, 'Synthetic file failure');
    for (const part of fixture.parts.slice(2)) await complete(server, part, 'route.section');
    await vi.waitFor(async () => { expect((await read(server)).phase).toBe('failed'); });
    const before = await read(server); const saved = before.snapshot; if (saved === null) throw new Error('Missing snapshot');
    const retry = fixture.parts[1]; if (retry === undefined) throw new Error('Missing retry part');
    expect(await server.route.fillStop(saved.snapshotId, retry.stops[0]?.planIndex ?? 0)).toBe('started');
    await complete(server, retry, 'route.section');
    const after = await read(server);
    expect(after.generation?.id).toBe(before.generation?.id);
    expect(preparationProgress(after)).toMatchObject({ percent: 100, total: preparationProgress(before).total });
    const retained = saved.stops.flatMap((block) => block.guidedFiles ?? []).filter((file) => file.explanation !== null);
    for (const file of retained) expect(after.snapshot?.stops.flatMap((block) => block.guidedFiles ?? []).find((entry) => entry.fileId === file.fileId)).toEqual(file);
});

it('принимает описание длиннее 500 символов, отклоняет чужой файл и неправильное вводное пояснение', () => {
    const summary = ('ПР меняет путь обработки запроса. ').repeat(22);
    expect(validateStorySkeleton(JSON.stringify({ ...fixture.outline, summary, evidence: { claims: [{ quote: summary.trim(), sources: [], limitation: 'Синтетическая проверка длины.' }] } }), fixture.diff, 'ru').ok).toBe(true);
    const part = fixture.parts[0]; if (part === undefined) throw new Error('Missing part');
    const assignment = { files: part.stops[0]?.files.map((file) => file.path) ?? [], introduction: true };
    expect(validateStorySection(JSON.stringify(part), [1], fixture.diff, 'ru', fixture.snapshot.stops, 5, assignment).ok).toBe(true);
    expect(validateStorySection(JSON.stringify(part), [1], fixture.diff, 'ru', fixture.snapshot.stops, 5, { ...assignment, introduction: false }).ok).toBe(false);
    expect(validateStorySection(JSON.stringify(part), [1], fixture.diff, 'ru', fixture.snapshot.stops, 5, { ...assignment, files: ['another.ts'] }).ok).toBe(false);
});

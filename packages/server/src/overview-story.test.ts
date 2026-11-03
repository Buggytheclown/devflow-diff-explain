import { checkpointJson } from '@sherpa/fixtures';
import { afterEach, expect, it, vi } from 'vitest';
import { architectureStoryFixture } from '@sherpa/fixtures';
import { allFilesWorkerResultSchema, preparationProgress, UI_ENDPOINTS, uiReviewRouteResponseSchema } from '@sherpa/protocol';
import { startServer } from './test-support.js';
import type { SherpaServer } from './server.js';
import { get, makeTempSherpaDir, removeTempSherpaDir } from './test-support.js';

const fixture = architectureStoryFixture();
const servers: SherpaServer[] = []; const dirs: string[] = [];
afterEach(async () => { for (const server of servers.splice(0)) await server.close(); for (const dir of dirs.splice(0)) await removeTempSherpaDir(dir); });
async function start(dir?: string) {
    const root = dir ?? await makeTempSherpaDir(); if (dir === undefined) dirs.push(root);
    const server = await startServer({ prKey: 'fixture-medium', sherpaDir: root }); servers.push(server);
    server.workerRegistry.register('worker', 'codex', 'test'); await server.route.warmup(); return { server, dir: root };
}
async function next(server: SherpaServer) {
    await vi.waitFor(() => { expect(server.queue.listTasks().some((task) => task.status === 'queued')).toBe(true); });
    const task = server.queue.next('worker')?.task; if (task === undefined) throw new Error('Missing task'); return task;
}
async function complete(server: SherpaServer, result: unknown, type = 'route.prepare') {
    const task = await next(server); expect(task.type).toBe(type);
    const accepted = server.queue.complete('worker', task.id, checkpointJson(result)); expect(accepted, checkpointJson(accepted)).toMatchObject({ kind: 'accepted' }); return task;
}
async function read(server: SherpaServer) { return uiReviewRouteResponseSchema.parse(await (await get(server.port, UI_ENDPOINTS.reviewRoute, server.token)).json()).route; }

it('длинный пример и аннотации проходят одну worker/приёмную/сохранённую схему и рестарт', async () => {
    const { server, dir } = await start(); await complete(server, fixture.outline, 'route.prepare');
    const source = fixture.body.stops[0]?.files[0]; if (source === undefined) throw new Error('Missing file');
    const note = source.annotations[0]; if (note === undefined) throw new Error('Missing note');
    const file = { ...source, example: { text: 'Подробный пример. '.repeat(60), evidence: { sources: [], limitation: 'Synthetic fixture.' } },
        annotations: Array.from({ length: 13 }, () => ({ ...note, text: 'Содержательное пояснение. '.repeat(50) })) };
    const body = { contractVersion: 6, files: [file] }; expect(allFilesWorkerResultSchema.safeParse(body).success).toBe(true);
    await complete(server, body); const saved = (await read(server)).snapshot?.stops[0]?.guidedFiles?.[0];
    expect(saved?.example?.text).toBe(file.example.text.trim()); expect(saved?.annotations).toHaveLength(13);
    await server.close(); const restarted = (await start(dir)).server;
    expect((await read(restarted)).snapshot?.stops[0]?.guidedFiles?.[0]).toEqual(saved);
});

it('адресное изменение одного блока и готового файла сохраняет остальные поля и ID', async () => {
    const { server } = await start(); await complete(server, fixture.outline, 'route.prepare');
    const first = fixture.body.stops[0]?.files[0]; if (first === undefined) throw new Error('No file');
    await complete(server, { contractVersion: 6, files: [first] });
    const before = (await read(server)).snapshot; if (before === null) throw new Error('No snapshot');
    await complete(server, { contractVersion: 6, update: { blocks: [{ id: before.stops[0]?.id, title: 'Уточнённый заголовок', paragraph: 'Уточнённая роль блока.' }] },
        files: [{ path: first.path, explanation: 'Исправленное пояснение уже принятого файла.' }] });
    const after = (await read(server)).snapshot;
    expect(after?.stops[0]?.title).toBe('Уточнённый заголовок'); expect(after?.stops[0]?.id).toBe(before.stops[0]?.id);
    expect(after?.stops[1]).toEqual(before.stops[1]);
    expect(after?.stops[0]?.guidedFiles?.[0]?.annotations).toEqual(first.annotations);
    expect(after?.stops[0]?.guidedFiles?.[0]?.explanation).toBe('Исправленное пояснение уже принятого файла.');
});

it('перенос, удаление блока и новый порядок применяются вместе; разрыв владельца отклоняется', async () => {
    const { server } = await start(); await complete(server, fixture.outline, 'route.prepare');
    const before = (await read(server)).snapshot; if (before === null) throw new Error('No snapshot');
    const task = await next(server); const [one, two] = before.stops; if (one === undefined || two === undefined) throw new Error('No blocks');
    expect(server.queue.complete('worker', task.id, checkpointJson({ contractVersion: 6, update: { removeBlocks: [one.id] } })).kind).toBe('rejected');
    const completeUpdate = { contractVersion: 6, update: { removeBlocks: [one.id], blockOrder: [two.id], blocks: [{ id: two.id,
        files: before.stops.flatMap((block) => block.guidedFiles?.map((file) => file.path) ?? []), nodeIds: [...new Set(before.stops.flatMap((block) => block.nodeIds ?? []))] }] } };
    expect(server.queue.complete('worker', task.id, checkpointJson(completeUpdate)).kind).toBe('accepted');
    const after = (await read(server)).snapshot;
    expect(after?.stops.map((block) => block.id)).toEqual([two.id]); expect(after?.tourOrder).toEqual([two.id]);
    expect(after?.stops[0]?.guidedFiles).toHaveLength(fixture.diff.files.length);
});

it('отмена новой подготовки сохраняет предыдущий результат и не считает его готовность', async () => {
    const { server } = await start(); await complete(server, fixture.outline, 'route.prepare'); await complete(server, fixture.body);
    const before = (await read(server)).snapshot; await server.route.generate();
    const progress = preparationProgress(await read(server)); expect(progress).toMatchObject({ completed: 0, total: null });
    if (progress.id === null) throw new Error('Missing generation'); server.route.cancelGeneration(progress.id);
    expect((await read(server)).snapshot).toEqual(before); expect(preparationProgress(await read(server)).status).toBe('cancelled');
});

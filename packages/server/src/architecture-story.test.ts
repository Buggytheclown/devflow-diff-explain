import { afterEach, expect, it, vi } from 'vitest';
import { architectureStoryFixture } from '@sherpa/fixtures';
import { preparationProgress, routeSnapshotSchema, UI_ENDPOINTS, uiReviewRouteResponseSchema } from '@sherpa/protocol';
import { architectureGuide, validateArchitectureOverview, validateAllFiles } from './architecture-story.js';
import { startServer } from './server.js';
import type { SherpaServer } from './server.js';
import { get, makeTempSherpaDir, removeTempSherpaDir } from './test-support.js';

const fixture = architectureStoryFixture();
const servers: SherpaServer[] = [];
const dirs: string[] = [];
afterEach(async () => { for (const server of servers.splice(0)) await server.close(); for (const dir of dirs.splice(0)) await removeTempSherpaDir(dir); });
async function start(dir?: string) {
    const root = dir ?? await makeTempSherpaDir(); if (dir === undefined) dirs.push(root);
    const server = await startServer({ prKey: 'fixture-medium', sherpaDir: root }); servers.push(server);
    server.workerRegistry.register('worker', 'codex', 'test'); await server.route.warmup();
    return { server, dir: root };
}
async function read(server: SherpaServer) { return uiReviewRouteResponseSchema.parse(await (await get(server.port, UI_ENDPOINTS.reviewRoute, server.token)).json()).route; }
async function next(server: SherpaServer) {
    await vi.waitFor(() => { expect(server.queue.listTasks().some((task) => task.status === 'queued')).toBe(true); });
    const value = server.queue.next('worker'); if (value === null) throw new Error('Missing task'); return value.task;
}
async function complete(server: SherpaServer, result: unknown, type: string) {
    const task = await next(server); expect(task.type).toBe(type);
    expect(server.queue.complete('worker', task.id, JSON.stringify(result))).toMatchObject({ kind: 'accepted' });
    return task;
}

it('две задачи: целостный обзор с готовыми блоками, затем все файлы одним результатом', async () => {
    const { server } = await start();
    await complete(server, fixture.outline, 'route.skeleton');
    const snapshot = (await read(server)).snapshot;
    expect(snapshot?.stops.every((block) => block.paragraph !== null)).toBe(true);
    expect(snapshot?.flow?.status).toBe('ready');
    expect(server.queue.listTasks().some((task) => task.type === 'route.diagram')).toBe(false);
    await complete(server, fixture.body, 'route.section');
    await vi.waitFor(async () => { expect((await read(server)).phase).toBe('ready'); });
    expect(preparationProgress((await read(server))).percent).toBe(100);
    expect(server.queue.listTasks()).toHaveLength(2);
});

it('продолжение после лимита и рестарта сохраняет обзор и готовые файлы', async () => {
    const { server, dir } = await start(); await complete(server, fixture.outline, 'route.skeleton');
    const before = (await read(server)).snapshot;
    const first = fixture.body.stops[0]; if (first === undefined) throw new Error('Missing files');
    await complete(server, { contractVersion: 6, stops: [{ ...first, files: first.files.slice(0, 1) }] }, 'route.section');
    const progress = preparationProgress((await read(server)));
    expect(progress.files.ready).toBe(1); expect(progress.blocks.ready).toBe(2);
    await server.close(); const restarted = (await start(dir)).server;
    const remaining = { contractVersion: 6, stops: [{ ...first, files: first.files.slice(1) }, ...fixture.body.stops.slice(1)] };
    await complete(restarted, remaining, 'route.section');
    await vi.waitFor(async () => { expect(preparationProgress((await read(restarted))).percent).toBe(100); });
    expect((await read(restarted)).snapshot?.flow).toEqual(before?.flow);
    expect((await read(restarted)).snapshot?.stops.map((block) => block.paragraph)).toEqual(before?.stops.map((block) => block.paragraph));
});

it('не принимает потерянные файлы, подменённые ID и подмену файлов при продолжении', () => {
    const bad = structuredClone(fixture.outline);
    const firstBad = bad.stops[0]; if (firstBad === undefined) throw new Error('Missing block');
    firstBad.nodeIds = ['missing'];
    expect(validateArchitectureOverview(JSON.stringify(bad), fixture.diff).ok).toBe(false);
    const missing = structuredClone(fixture.outline);
    const firstMissing = missing.stops[0]; if (firstMissing === undefined) throw new Error('Missing block');
    firstMissing.files.pop();
    expect(validateArchitectureOverview(JSON.stringify(missing), fixture.diff).ok).toBe(false);
    const checked = validateArchitectureOverview(JSON.stringify(fixture.outline), fixture.diff);
    if (!checked.ok) throw new Error(checked.errors.join('\n'));
    const skipped = { ...fixture.body, stops: fixture.body.stops.slice(1) };
    expect(validateAllFiles(JSON.stringify(skipped), fixture.diff, checked.value.stops).ok).toBe(true);
    const duplicate = { ...fixture.body, stops: [fixture.body.stops[0], fixture.body.stops[0]] };
    expect(validateAllFiles(JSON.stringify(duplicate), fixture.diff, checked.value.stops).ok).toBe(false);
    expect(routeSnapshotSchema.safeParse(fixture.snapshot).success).toBe(true);
});

it('ошибка отрисовки отражается в прогрессе, локальный повтор не меняет описание и файлы', async () => {
    const { server } = await start(); await complete(server, fixture.outline, 'route.skeleton'); await complete(server, fixture.body, 'route.section');
    const saved = (await read(server)).snapshot; if (saved === null) throw new Error('No snapshot');
    server.route.reportDiagramFailure(saved.snapshotId);
    expect(preparationProgress((await read(server))).status).toBe('partial');
    server.route.retryDiagram(saved.snapshotId); server.route.retryDiagram(saved.snapshotId);
    await complete(server, { flow: fixture.outline.flow }, 'route.diagram');
    expect((await read(server)).snapshot?.stops).toEqual(saved.stops);
    expect(preparationProgress((await read(server))).percent).toBe(100);
    expect(architectureGuide('overview', 'ru')).not.toContain('3–6');
});

it('повтор одного блока после общей ошибки не запускает остальные проваленные блоки', async () => {
    const { server } = await start(); await complete(server, fixture.outline, 'route.skeleton');
    const task = await next(server); server.queue.fail('worker', task.id, 'Synthetic failure');
    await vi.waitFor(async () => { expect((await read(server)).phase).toBe('failed'); });
    const snapshot = (await read(server)).snapshot; if (snapshot === null) throw new Error('Missing snapshot');
    await server.route.fillStop(snapshot.snapshotId, 1);
    await complete(server, { ...fixture.body, stops: fixture.body.stops.slice(0, 1) }, 'route.section');
    await vi.waitFor(async () => { expect((await read(server)).phase).toBe('failed'); });
    expect((await read(server)).snapshot?.stops.map((block) => block.status)).toEqual(['ready', 'failed']);
});

it('уточнение обзора сохраняет принятые файлы и переживает рестарт', async () => {
    const { server, dir } = await start();
    await complete(server, fixture.outline, 'route.skeleton');
    const first = fixture.body.stops[0]; if (first === undefined) throw new Error('No files');
    await complete(server, { contractVersion: 6, stops: [{ ...first, files: first.files.slice(0, 1) }] }, 'route.section');
    const before = (await read(server)).snapshot;
    const overview = { ...fixture.outline, summary: 'Уточнённая архитектура.', evidence: { claims: [{ sources: [], limitation: 'Synthetic test.' }] } };
    await complete(server, { contractVersion: 6, overview, stops: [{ ...first, files: first.files.slice(1) }, ...fixture.body.stops.slice(1)] }, 'route.section');
    const refined = (await read(server)).snapshot;
    expect(refined?.summary).toBe(overview.summary);
    expect(refined?.stops.map((block) => block.id)).toEqual(before?.stops.map((block) => block.id));
    expect(refined?.stops[0]?.guidedFiles?.[0]).toEqual(before?.stops[0]?.guidedFiles?.[0]);
    await server.close();
    const restarted = (await start(dir)).server;
    expect((await read(restarted)).snapshot?.summary).toBe(overview.summary);
});

it('несколько схем используют общие ID и проверяемые источники', () => {
    const overview = structuredClone(fixture.outline);
    overview.flow.diagram = { ...overview.flow.diagram, views: [{ title: 'Второй процесс', mermaid: 'flowchart LR\nrule --> saved' }] };
    expect(validateArchitectureOverview(JSON.stringify(overview), fixture.diff).ok).toBe(true);
    const unsafe = { ...overview, flow: { status: 'ready', diagram: { ...overview.flow.diagram, views: [{ title: 'Unsafe', mermaid: 'flowchart LR\nclick rule callback' }] } } };
    expect(validateArchitectureOverview(JSON.stringify(unsafe), fixture.diff).ok).toBe(false);
});

it('приложение выводит метаданные из связей блоков и принимает Markdown без повторения узлов', () => {
    const outline = structuredClone(fixture.outline);
    const { nodes: _nodes, ...diagram } = outline.flow.diagram;
    const raw = { ...outline, summary: '# Цель\n\n| Что | Зачем |\n| --- | --- |\n| Правило | Контроль |',
        evidence: { claims: [{ sources: [], limitation: 'Synthetic fixture.' }] }, flow: { status: 'ready', diagram } };
    const checked = validateArchitectureOverview(JSON.stringify(raw), fixture.diff);
    if (!checked.ok) throw new Error(checked.errors.join('\n'));
    expect(checked.value.flow?.status).toBe('ready');
    if (checked.value.flow?.status === 'ready') {
        expect(checked.value.flow.diagram.nodes.map((node) => node.id)).toEqual([...new Set(outline.stops.flatMap((stop) => stop.nodeIds))]);
    }
    const malformed = { ...raw, stops: raw.stops.map((stop, index) => index === 0 ? { ...stop, nodeIds: ['[bad'] } : stop) };
    expect(validateArchitectureOverview(JSON.stringify(malformed), fixture.diff).ok).toBe(false);
});

it('файлы по путям: произвольная часть и порядок, длинное пояснение; неизвестное и дубликаты отклоняются', () => {
    const checked = validateArchitectureOverview(JSON.stringify(fixture.outline), fixture.diff);
    if (!checked.ok) throw new Error('Invalid outline');
    const files = fixture.body.stops.flatMap((stop) => stop.files).reverse();
    const file = files[0]; if (file === undefined) throw new Error('No file');
    const raw = { contractVersion: 6, files: [{ path: file.path, explanation: '# Детали\n\n' + 'Подробное объяснение. '.repeat(100) }] };
    const result = validateAllFiles(JSON.stringify(raw), fixture.diff, checked.value.stops);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value[0]?.guidedFiles?.[0]?.path).toBe(file.path);
    expect(validateAllFiles(JSON.stringify({ ...raw, files: [raw.files[0], raw.files[0]] }), fixture.diff, checked.value.stops).ok).toBe(false);
    expect(validateAllFiles(JSON.stringify({ ...raw, files: [{ ...raw.files[0], path: 'missing.ts' }] }), fixture.diff, checked.value.stops).ok).toBe(false);
    expect(validateAllFiles(JSON.stringify(raw), fixture.diff, checked.value.stops, { files: [], introduction: false }).ok).toBe(false);
});

it('произвольная часть файлов после рестарта продолжается без потери и повторной сдачи', async () => {
    const { server, dir } = await start();
    await complete(server, fixture.outline, 'route.skeleton');
    const files = fixture.body.stops.flatMap((stop) => stop.files).reverse();
    const first = files[0]; if (first === undefined) throw new Error('No files');
    await complete(server, { contractVersion: 6, files: [first] }, 'route.section');
    expect(preparationProgress(await read(server)).files.ready).toBe(1);
    await server.close();
    const restarted = (await start(dir)).server;
    await complete(restarted, { contractVersion: 6, files: files.slice(1) }, 'route.section');
    await vi.waitFor(async () => { expect(preparationProgress(await read(restarted)).percent).toBe(100); });
});

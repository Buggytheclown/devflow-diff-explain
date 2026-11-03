import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { architectureStoryFixture, readableStoryFixture } from '@sherpa/fixtures';
import { FlowCoordinator, diagramSourceErrors } from './flow-coordinator.js';
import { openDatabase } from './db.js';
import type { SherpaDatabase } from './db.js';
import { RouteStore } from './route-store.js';
import { TaskQueue } from './queue.js';
import { SharedPayloadStore } from './shared-payload.js';
import { validateArchitectureOverview, validateAllFiles } from './architecture-story.js';
import { validateStorySkeleton } from './story.js';
import { makeTempSherpaDir, removeTempSherpaDir } from './test-support.js';

const fixture = architectureStoryFixture();
const provenance = { harness: 'codex', model: 'test', locale: 'ru' as const };

describe('повтор архитектуры через текущие checkpoints', () => {
    let dir: string; let db: SherpaDatabase; let store: RouteStore; let queue: TaskQueue; let flow: FlowCoordinator;
    function start() {
        flow = new FlowCoordinator({ store, queue, dir: path.join(dir, 'flow'),
            shared: new SharedPayloadStore(path.join(dir, 'shared'), () => []), loadDiff: () => Promise.resolve(fixture.diff) });
        queue.setResultAcceptor((task, result) => flow.acceptResult(task, result)); flow.start();
    }
    function accept(id = 'architecture', unavailable = false) {
        const outline = unavailable ? { ...fixture.outline, flow: { status: 'unavailable', reason: 'Источники ещё не изучены.' },
            stops: fixture.outline.stops.map((block) => ({ ...block, nodeIds: [] })) } : fixture.outline;
        const plan = validateArchitectureOverview(JSON.stringify(outline), fixture.diff);
        if (!plan.ok) throw new Error(plan.errors.join('\n'));
        store.acceptSkeleton({ skeleton: plan.value, diff: fixture.diff, provenance, snapshotId: id, previousSnapshotId: null, presentation: 'story' });
    }
    function retry() { const snapshot = store.current(); if (snapshot === null) throw new Error('No snapshot');
        store.setFlow(snapshot.snapshotId, { status: 'pending', taskId: null, round: 0, requests: [], contexts: [], missing: [] }); }
    async function task() {
        await vi.waitFor(() => { const current = store.current()?.flow; expect(current?.status === 'pending' ? current.taskId : null).not.toBeNull(); });
        const leased = queue.next('test'); if (leased === null) throw new Error('No diagram task'); return leased.task;
    }
    beforeEach(async () => {
        dir = await makeTempSherpaDir(); db = openDatabase(path.join(dir, 'state.db')); store = new RouteStore({ db }); queue = new TaskQueue({ db });
        accept(); start(); retry();
    });
    afterEach(async () => { flow.close(); db.close(); await removeTempSherpaDir(dir); });

    it('схема и готовые файлы сохраняются после рестарта; старый {flow} совместим', async () => {
        const pending = await task();
        const body = validateAllFiles(JSON.stringify(fixture.body), fixture.diff, store.current()?.stops ?? []);
        if (!body.ok) throw new Error(body.errors.join('\n'));
        store.applyCheckpoint(undefined, body.value, provenance); store.markReady();
        const files = store.current()?.stops.map((block) => block.guidedFiles);
        flow.close(); store = new RouteStore({ db }); start();
        await vi.waitFor(() => { expect(queue.complete('test', pending.id, JSON.stringify({ flow: fixture.outline.flow })).kind).toBe('accepted'); });
        expect(store.current()?.flow?.status).toBe('ready');
        expect(store.current()?.stops.map((block) => block.guidedFiles)).toEqual(files);
        expect(new RouteStore({ db }).current()).toEqual(store.current());
    });
    it('изначально недоступная архитектура получает схему и связи одним checkpoint', async () => {
        accept('unavailable', true); retry(); const pending = await task();
        const blocks = store.current()?.stops.map((block, index) => ({ id: block.id, nodeIds: fixture.outline.stops[index]?.nodeIds }));
        const updates: string[] = []; const unsubscribe = store.subscribe(() => { updates.push(JSON.stringify(store.current())); });
        expect(queue.complete('test', pending.id, JSON.stringify({ contractVersion: 6, update: { flow: fixture.outline.flow, blocks } })).kind).toBe('accepted');
        unsubscribe();
        expect(store.current()?.flow?.status).toBe('ready'); expect(store.current()?.stops.every((block) => (block.nodeIds?.length ?? 0) > 0)).toBe(true);
        expect(updates).toHaveLength(1);
    });
    it('новый промпт оставляет чтение агенту и не содержит старого proxy-контракта', async () => {
        const pending = await task();
        expect(pending.instructions).toContain('ordinary PR/code tools');
        expect(pending.instructions).toContain(fixture.diff.headCommit);
        const texts = [pending.instructions, ...pending.contextFiles.map((file) => fs.readFileSync(file, 'utf8'))].join('\n');
        expect(texts).not.toContain('Do not browse'); expect(texts).not.toContain('contextRequests'); expect(texts).not.toContain('3–6 nodes');
        expect(fs.readFileSync(pending.resultSchemaFile ?? '', 'utf8')).toContain('removeBlocks');
    });
    it('поздний ответ и ошибка не меняют новый рассказ', async () => {
        const pending = await task(); queue.fail('test', pending.id, 'Synthetic failure');
        await vi.waitFor(() => { expect(store.current()?.flow?.status).toBe('unavailable'); });
        accept('new'); retry(); const newer = await task();
        expect(newer.id).not.toBe(pending.id);
        const old = queue.getTask(pending.id); if (old === null) throw new Error('No task');
        expect(flow.acceptResult(old, JSON.stringify({ flow: fixture.outline.flow }))?.kind).toBe('rejected');
        expect(store.current()?.snapshotId).toBe('new');
    });
    it('старый готовый разбор читается без запуска старого генератора', async () => {
        const legacy = readableStoryFixture();
        const plan = validateStorySkeleton(JSON.stringify(legacy.outline), legacy.diff, 'ru');
        if (!plan.ok) throw new Error(plan.errors.join('\n'));
        store.acceptSkeleton({ skeleton: { ...plan.value, stops: legacy.snapshot.stops, ...(legacy.snapshot.flow === undefined ? {} : { flow: legacy.snapshot.flow }) }, diff: legacy.diff,
            provenance, snapshotId: 'legacy', previousSnapshotId: null, presentation: 'story' }); store.markReady();
        await vi.waitFor(() => { expect(queue.listTasks().filter((task) => task.status === 'queued' || task.status === 'leased')).toHaveLength(0); });
        expect(store.current()?.flow).toEqual(legacy.snapshot.flow);
        expect(store.current()?.stops[0]?.guidedFiles).toEqual(legacy.snapshot.stops[0]?.guidedFiles);
    });
});

it('проверяет полные диапазоны и требует изменённые строки для отметок PR', () => {
    const legacy = readableStoryFixture(); const graph = structuredClone(legacy.diagram);
    const changed = graph.nodes[1]; if (changed === undefined) throw new Error('Missing node');
    changed.sources = [{ kind: 'patch', path: legacy.first.path, side: 'new', start: 99999, end: 100000 }];
    expect(diagramSourceErrors(graph, legacy.diff, [])).not.toHaveLength(0);
    changed.sources = [{ kind: 'context', id: 'external' }];
    expect(diagramSourceErrors(graph, legacy.diff, [{ id: 'external', path: 'x.ts', start: 1, end: 1, text: 'saved', revision: legacy.diff.headCommit }])).toContain('PR changes need supporting changed patch lines.');
});

import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readableStoryFixture } from '@sherpa/fixtures';
import type { ReviewHost } from '@sherpa/protocol';
import { FlowCoordinator, diagramSourceErrors } from './flow-coordinator.js';
import { openDatabase } from './db.js';
import type { SherpaDatabase } from './db.js';
import { RouteStore } from './route-store.js';
import { TaskQueue } from './queue.js';
import { SharedPayloadStore } from './shared-payload.js';
import { validateStorySkeleton, validateStorySection } from './story.js';
import { explanationEvidence, storyEvidenceContext } from './story-evidence.js';
import { makeTempSherpaDir, removeTempSherpaDir } from './test-support.js';

const fixture = readableStoryFixture();
const provenance = { harness: 'codex', model: 'test', locale: 'ru' as const };

describe('независимая схема закреплённого потока', () => {
    let dir: string; let db: SherpaDatabase; let store: RouteStore; let queue: TaskQueue; let flow: FlowCoordinator;
    const readSource = vi.fn<(path: string, revision: string) => Promise<string | null>>();
    function start() {
        flow = new FlowCoordinator({ store, queue, host: { getPr: () => Promise.resolve({ capabilities: { sourceAtRevision: true } }), getSourceAtRevision: readSource } as unknown as ReviewHost,
            dir: path.join(dir, 'flow'), shared: new SharedPayloadStore(path.join(dir, 'shared'), () => []), loadDiff: () => Promise.resolve(fixture.diff) });
        queue.setResultAcceptor((task, result) => flow.acceptResult(task, result)); flow.start();
    }
    function accept(id = 'readable') {
        const plan = validateStorySkeleton(JSON.stringify(fixture.outline), fixture.diff, 'ru');
        if (!plan.ok) throw new Error(plan.errors.join('\n'));
        store.acceptSkeleton({ skeleton: plan.value, diff: fixture.diff, provenance, snapshotId: id, previousSnapshotId: null, presentation: 'story' });
    }
    async function task() {
        await vi.waitFor(() => { expect(queue.listTasks().some((entry) => entry.status === 'queued')).toBe(true); });
        const leased = queue.next('test'); if (leased === null) throw new Error('No diagram task'); return leased.task;
    }
    beforeEach(async () => {
        dir = await makeTempSherpaDir(); db = openDatabase(path.join(dir, 'state.db')); store = new RouteStore({ db }); queue = new TaskQueue({ db });
        readSource.mockReset().mockResolvedValue('input\ntransform\nconsumer\n'); accept(); start();
    });
    afterEach(async () => { flow.close(); db.close(); await removeTempSherpaDir(dir); });

    it('достраивается отдельно от готового текста и сохраняется после рестарта', async () => {
        const pending = await task();
        const body = validateStorySection(JSON.stringify(fixture.body), [1, 2], fixture.diff, 'ru', store.current()?.stops, 4);
        if (!body.ok) throw new Error(body.errors.join('\n'));
        store.applyFillings(body.value, provenance); store.markReady();
        expect(store.read().phase).toBe('ready');
        expect(queue.complete('test', pending.id, JSON.stringify({ contextRequests: [], diagram: fixture.diagram, reason: null })).kind).toBe('accepted');
        expect(store.current()?.flow?.status).toBe('ready');
        const restored = new RouteStore({ db });
        expect(restored.current()?.flow).toEqual(store.current()?.flow);
        const evidence = explanationEvidence(store.current() ?? fixture.snapshot, `file:${fixture.first.fileId}`);
        expect(evidence?.sections.some((entry) => entry.id.endsWith(':example'))).toBe(true);
        expect(storyEvidenceContext(evidence ?? { contractVersion: 4, introduction: fixture.example.evidence, sections: [] }, fixture.diff)).toContain('Flow source:');
    });
    it('читает внешний контекст в head ревизии и сохраняет его между раундами и рестартами', async () => {
        const first = await task();
        expect(queue.complete('test', first.id, JSON.stringify({ contextRequests: [{ path: 'outside/caller.ts', start: 2, end: 3 }], diagram: null, reason: null })).kind).toBe('accepted');
        const second = await task();
        expect(readSource).toHaveBeenCalledWith('outside/caller.ts', fixture.diff.headCommit);
        const state = store.current()?.flow;
        expect(state?.status).toBe('pending');
        if (state?.status !== 'pending') throw new Error('Missing pending state');
        expect(state.contexts[0]?.text).toBe('transform\nconsumer');
        expect(second.contextFiles.map((file) => fs.readFileSync(file, 'utf8')).join('\n')).toContain('outside/caller.ts');
        flow.close(); store = new RouteStore({ db }); start();
        const graph = structuredClone(fixture.diagram);
        graph.nodes[0] = { id: 'request', label: 'Внешний вызов', change: 'existing', sources: [{ kind: 'context', id: 'context-1' }], limitation: null };
        await vi.waitFor(() => { expect(queue.complete('test', second.id, JSON.stringify({ contextRequests: [], diagram: graph, reason: null })).kind).toBe('accepted'); });
        expect(store.current()?.flow?.status).toBe('ready');
    });
    it('недоступный контекст остаётся пробелом; выдуманный источник отклоняется', async () => {
        readSource.mockRejectedValue(new Error('Not accessible'));
        const first = await task();
        queue.complete('test', first.id, JSON.stringify({ contextRequests: [{ path: 'missing.ts', start: 1, end: 2 }], diagram: null, reason: null }));
        const second = await task();
        const state = store.current()?.flow;
        expect(state?.status === 'pending' ? state.missing : []).toHaveLength(1);
        const graph = structuredClone(fixture.diagram);
        graph.nodes[0] = { id: 'request', label: 'Неизвестный вызывающий код', change: 'existing', sources: [{ kind: 'context', id: 'not-saved' }], limitation: null };
        expect(queue.complete('test', second.id, JSON.stringify({ contextRequests: [], diagram: graph, reason: null })).kind).toBe('rejected');
        expect(queue.complete('test', second.id, JSON.stringify({ contextRequests: [], diagram: fixture.diagram, reason: null })).kind).toBe('accepted');
    });
    it('сбой схемы и запоздавший ответ не портят текст и новый рассказ', async () => {
        const pending = await task();
        queue.fail('test', pending.id, 'Synthetic failure');
        await vi.waitFor(() => { expect(store.current()?.flow?.status).toBe('unavailable'); });
        expect(store.current()?.summary).toBe(fixture.outline.summary);
        accept('new-story'); const newer = await task();
        const stale = queue.listTasks().find((entry) => entry.id === pending.id);
        if (stale === undefined) throw new Error('Missing old task');
        expect(flow.acceptResult(stale, JSON.stringify({ contextRequests: [], diagram: fixture.diagram, reason: null }))?.kind).toBe('rejected');
        expect(store.current()?.snapshotId).toBe('new-story');
        expect(newer.id).not.toBe(pending.id);
    });
    it('ограничивает число раундов внешнего контекста', async () => {
        const request = { contextRequests: [{ path: 'outside.ts', start: 1, end: 1 }], diagram: null, reason: null };
        for (let i = 0; i < 2; i += 1) expect(queue.complete('test', (await task()).id, JSON.stringify(request)).kind).toBe('accepted');
        const last = await task();
        expect(queue.complete('test', last.id, JSON.stringify(request)).kind).toBe('rejected');
        expect(queue.complete('test', last.id, JSON.stringify({ contextRequests: [], diagram: null, reason: 'Общий поток не удалось подтвердить.' })).kind).toBe('accepted');
        expect(store.current()?.flow?.status).toBe('unavailable');
    });
});

it('проверяет полные диапазоны и требует изменённые строки для отметок ПРа', () => {
    const graph = structuredClone(fixture.diagram);
    const changed = graph.nodes[1]; if (changed === undefined) throw new Error('Missing node');
    changed.sources = [{ kind: 'patch', path: fixture.first.path, side: 'new', start: 99999, end: 100000 }];
    expect(diagramSourceErrors(graph, fixture.diff, [])).not.toHaveLength(0);
    changed.sources = [{ kind: 'context', id: 'external' }];
    expect(diagramSourceErrors(graph, fixture.diff, [{ id: 'external', path: 'x.ts', start: 1, end: 1, text: 'saved', revision: fixture.diff.headCommit }])).toContain('PR changes need supporting changed patch lines.');
});

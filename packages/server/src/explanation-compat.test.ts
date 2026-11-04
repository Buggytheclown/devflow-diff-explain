import { checkpointJson } from '@sherpa/fixtures';
import { makeFixtureHost, architectureStoryFixture, readableStoryFixture } from '@sherpa/fixtures';
import { routeSnapshotSchema, explanationSnapshotSchema, explanationCanonicalSnapshotSchema } from '@sherpa/protocol';
import type { CodeReader } from '@sherpa/protocol';
import { DatabaseSync } from 'node:sqlite';
import { expect, it } from 'vitest';
import { restoreSnapshot, storedSnapshot } from './explanation-compat.js';
import { contentHashOf } from './route-store.js';
import { acceptedFixture } from './test-support.js';
import { startServer } from './test-support.js';
import { databasePathFor } from './paths.js';
import { makeTempSherpaDir, removeTempSherpaDir } from './test-support.js';

const fixture = readableStoryFixture();
it('генерация и хранение не несут поля ревью; совместимая проекция не теряет данные объяснения', () => {
    const accepted = acceptedFixture(fixture.snapshot);
    const saved = storedSnapshot(fixture.snapshot) as { stops: Record<string, unknown>[] };
    for (const block of [...accepted.value.stops, ...saved.stops]) {
        for (const field of ['tier', 'bridge', 'anchors', 'tests', 'droppedClaims', 'change']) expect(block).not.toHaveProperty(field);
    }
    const restored = routeSnapshotSchema.parse(restoreSnapshot(saved));
    expect(storedSnapshot(restored)).toEqual(saved);
    expect(restored.summary).toBe(fixture.snapshot.summary);
    expect(restored.flow).toEqual(fixture.snapshot.flow);
    expect(restored.stops.map((block) => block.guidedFiles)).toEqual(fixture.snapshot.stops.map((block) => block.guidedFiles));
    expect(restoreSnapshot(fixture.snapshot)).toBe(fixture.snapshot);
    expect(() => restoreSnapshot({ ...fixture.snapshot, format: 'explanation/99' })).toThrow('Unsupported stored explanation format');
    const anotherAuthor = { ...fixture.snapshot, provenance: { harness: 'other', model: 'other', locale: 'ru' as const }, stops: fixture.snapshot.stops.map((block) => ({ ...block, provenance: { harness: 'other', model: 'other', locale: 'ru' as const } })) };
    expect(contentHashOf(anotherAuthor)).toBe(contentHashOf(fixture.snapshot));
});

it('источник только для чтения строит текущий v6; после рестарта можно повторить один упавший блок', async () => {
    const fixture = architectureStoryFixture();
    const dir = await makeTempSherpaDir();
    const full = makeFixtureHost('medium');
    // Методов комментариев, публикации и тредов здесь нет даже на объекте во время выполнения.
    const host: CodeReader = {
        getPr: () => full.getPr(), getDiff: () => full.getDiff(),
        listIterations: () => full.listIterations(), subscribeVersions: (listener) => full.subscribeVersions(listener),
    };
    const options = { prKey: 'fixture-medium', sherpaDir: dir, presentation: 'story' as const, reviewSourceFactory: () => ({ name: 'fixture', host }) };
    let server = await startServer(options);
    try {
        server.workerRegistry.register('test', 'codex', 'test'); await server.route.warmup();
        const next = () => { const lease = server.queue.next('test'); if (lease === null) throw new Error('No task'); return lease.task; };
        expect(server.queue.complete('test', next().id, checkpointJson(fixture.outline)).kind).toBe('accepted');
        server.queue.fail('test', next().id, 'temporary failure');
        await server.close();
        const db = new DatabaseSync(databasePathFor(dir, 'fixture-medium'));
        const rows = db.prepare('SELECT snapshot_json FROM route_snapshots').all(); db.close();
        const saved = JSON.parse(String(rows[0]?.snapshot_json)) as { format: string; blocks: Record<string, unknown>[]; snapshotId: string };
        expect(saved.format).toBe('explanation/2'); expect(saved.blocks[0]).not.toHaveProperty('planIndex');
        server = await startServer(options); server.workerRegistry.register('test', 'codex', 'test'); await server.route.warmup();
        expect(await server.route.fillStop(saved.snapshotId, 1)).toBe('started');
        let retry = next();
        if (retry.type === 'route.diagram') { server.queue.cancel(retry.id); retry = next(); }
        expect(server.route.stopsOfTask(retry.id)).toEqual([1]);
        expect(server.queue.complete('test', retry.id, checkpointJson({ ...fixture.body, stops: [fixture.body.stops[0]] })).kind).toBe('accepted');
    } finally { await server.close(); await removeTempSherpaDir(dir); }
});

it('новый канон хранит пояснения по fileId и выводит порядок из блоков', () => {
    const source = architectureStoryFixture().snapshot;
    const saved = explanationCanonicalSnapshotSchema.parse(storedSnapshot(source));
    expect(saved.blocks[0]).not.toHaveProperty('guidedFiles');
    expect(saved).not.toHaveProperty('tourOrder');
    const restored = routeSnapshotSchema.parse(restoreSnapshot(saved));
    expect(restored.stops.flatMap((block) => block.guidedFiles ?? [])).toEqual(source.stops.flatMap((block) => block.guidedFiles ?? []));
    expect(restored.tourOrder).toEqual(saved.blocks.map((block) => block.id));
    const first = saved.blocks[0]?.fileIds[0];
    if (first === undefined) throw new Error('Fixture needs a file');
    expect(() => restoreSnapshot({ ...saved, blocks: saved.blocks.map((block, index) => index === 0
        ? { ...block, fileIds: [...block.fileIds, first] } : block) })).toThrow('one owner');
});

it('канон сохраняет полный порядок и непрозрачные ID файлов', () => {
    const source = structuredClone(architectureStoryFixture().snapshot);
    source.tourOrder = [...source.tourOrder].reverse();
    const files = source.stops.flatMap((block) => block.guidedFiles ?? []);
    const first = files[0]; const second = files[1];
    if (first === undefined || second === undefined) throw new Error('Fixture needs two files');
    first.fileId = '__proto__';
    second.fileId = 'constructor';
    const saved = explanationCanonicalSnapshotSchema.parse(storedSnapshot(source));
    expect(saved.blocks.map((block) => block.id)).toEqual(source.tourOrder);
    expect(saved.files.map((file) => file.fileId)).toContain('__proto__');
    expect(saved.files.map((file) => file.fileId)).toContain('constructor');
    const restored = routeSnapshotSchema.parse(restoreSnapshot(saved));
    expect(restored.stops.flatMap((block) => block.guidedFiles ?? []).map((file) => file.fileId)).toContain('__proto__');
    expect(restored.stops.flatMap((block) => block.guidedFiles ?? []).map((file) => file.fileId)).toContain('constructor');
});

it('компактное хранение сохраняет проверки доказательств и единственного владельца файла', () => {
    const value = explanationSnapshotSchema.parse(storedSnapshot(fixture.snapshot));
    const first = value.stops[0]?.guidedFiles?.[0];
    const second = value.stops[1];
    if (first === undefined || second === undefined) throw new Error('Fixture needs files in two blocks');
    second.guidedFiles = [first];
    expect(() => restoreSnapshot(value)).toThrow('Files need one owner');
    expect(() => restoreSnapshot({ ...storedSnapshot(fixture.snapshot) as object, summaryEvidence: undefined })).toThrow('introduction evidence');
});

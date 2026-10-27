import { makeFixtureHost, readableStoryFixture } from '@sherpa/fixtures';
import { routeSnapshotSchema, explanationSnapshotSchema } from '@sherpa/protocol';
import type { ReviewSource } from '@sherpa/protocol';
import { DatabaseSync } from 'node:sqlite';
import { expect, it } from 'vitest';
import { restoreSnapshot, storedSnapshot } from './explanation-compat.js';
import { contentHashOf } from './route-store.js';
import { validateStorySkeleton } from './story.js';
import { startServer } from './server.js';
import { databasePathFor } from './paths.js';
import { makeTempSherpaDir, removeTempSherpaDir } from './test-support.js';

const fixture = readableStoryFixture();
it('генерация и хранение не несут поля ревью; совместимая проекция не теряет данные объяснения', () => {
    const accepted = validateStorySkeleton(JSON.stringify(fixture.outline), fixture.diff, 'ru');
    if (!accepted.ok) throw new Error(accepted.errors.join('\n'));
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
    const anotherAuthor = { ...fixture.snapshot, provenance: { harness: 'other', model: 'other', locale: 'ru' as const }, stops: fixture.snapshot.stops.map((block) => ({ ...block, provenance: { harness: 'other', model: 'other', locale: 'ru' as const } })) };
    expect(contentHashOf(anotherAuthor)).toBe(contentHashOf(fixture.snapshot));
});

it('источник только для чтения строит v4; после рестарта можно повторить один упавший блок', async () => {
    const dir = await makeTempSherpaDir();
    const full = makeFixtureHost('medium');
    // Методов комментариев, публикации и тредов здесь нет даже на объекте во время выполнения.
    const host: ReviewSource = {
        getPr: () => full.getPr(), getDiff: (slice) => full.getDiff(slice),
        listIterations: () => full.listIterations(), watchIterations: (listener) => full.watchIterations(listener),
    };
    const options = { prKey: 'fixture-medium', sherpaDir: dir, presentation: 'story' as const, reviewSourceFactory: () => ({ name: 'fixture', host }) };
    let server = await startServer(options);
    try {
        server.workerRegistry.register('test', 'codex', 'test'); await server.route.warmup();
        const next = () => { const lease = server.queue.next('test'); if (lease === null) throw new Error('No task'); return lease.task; };
        expect(server.queue.complete('test', next().id, JSON.stringify(fixture.outline)).kind).toBe('accepted');
        server.queue.fail('test', next().id, 'temporary failure');
        await server.close();
        const db = new DatabaseSync(databasePathFor(dir, 'fixture-medium'));
        const rows = db.prepare('SELECT snapshot_json FROM route_snapshots').all(); db.close();
        const saved = JSON.parse(String(rows[0]?.snapshot_json)) as { format: string; stops: Record<string, unknown>[]; snapshotId: string };
        expect(saved.format).toBe('explanation/1'); expect(saved.stops[0]).not.toHaveProperty('tier');
        server = await startServer(options); server.workerRegistry.register('test', 'codex', 'test'); await server.route.warmup();
        expect(await server.route.fillStop(saved.snapshotId, 1)).toBe('started');
        let retry = next();
        if (retry.type === 'route.diagram') { server.queue.cancel(retry.id); retry = next(); }
        expect(server.route.stopsOfTask(retry.id)).toEqual([1]);
        expect(server.queue.complete('test', retry.id, JSON.stringify({ ...fixture.body, stops: [fixture.body.stops[0]] })).kind).toBe('accepted');
    } finally { await server.close(); await removeTempSherpaDir(dir); }
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

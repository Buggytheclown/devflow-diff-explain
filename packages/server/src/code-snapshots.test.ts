import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { openDatabase, transaction, afterDatabaseCommit } from './db.js';
import { CodeSnapshots } from './code-snapshots.js';
import { IterationStore } from './iteration-store.js';
import { prDiffSchema } from '@sherpa/protocol';
import { parseUnifiedPatch } from '@sherpa/protocol/diff';
import { SavedSources, sourceFileEvidence, withSavedSources } from './saved-sources.js';
import { SnapshotReader } from './snapshot-reader.js';
import type { CodeSnapshotInput, CodeReader } from '@sherpa/protocol';
import { exportFixture } from './fixture-import.js';
import { blobsDirOf, databasePathFor } from './paths.js';
import { BlobCache } from './blob-cache.js';
import { startServer } from './server.js';
import { ARTIFACT_ENDPOINTS, UI_ENDPOINTS, WORKER_ENDPOINTS, PROTOCOL_VERSION, SAVED_SOURCE_ENDPOINT } from '@sherpa/protocol';
import { readCheckpoint } from './architecture-checkpoint.js';
import { architectureStoryFixture, checkpointJson } from '@sherpa/fixtures';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const close of cleanup.splice(0).reverse()) await close(); });
async function setup() {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'code-snapshot-'));
    const db = openDatabase(path.join(dir, 'db.sqlite'));
    cleanup.push(async () => { db.close(); await fs.rm(dir, { recursive: true, force: true }); });
    const root = path.join(dir, 'export'); await fs.mkdir(root);
    await fs.writeFile(path.join(root, 'old'), 'one\nold\n');
    await fs.writeFile(path.join(root, 'new'), 'one\nnew\n');
    const input: CodeSnapshotInput = { format: 'code-snapshot/1', project: 'arcanum-123', diffId: 'diff-1', baseCommit: 'base', headCommit: 'head',
        capturedAt: '2026-11-03T00:00:00.000Z', pr: null, activate: true, sources: [],
        files: [{ path: 'src/a.ts', oldPath: null, changeType: 'modify', before: { file: 'old', kind: 'text' }, after: { file: 'new', kind: 'text' }, patch: null, generated: false, hostFileUrl: null }] };
    const manifest = path.join(root, 'snapshot.json');
    const write = async () => { await fs.writeFile(manifest, JSON.stringify(input)); };
    await write();
    return { db, root, manifest, input, write, snapshots: new CodeSnapshots(db, input.project) };
}

it('импортирует полные стороны и patch атомарно; после удаления экспорта читает без агента', async () => {
    const { db, root, manifest, snapshots } = await setup();
    const receipt = await snapshots.importSnapshot(manifest);
    expect(await snapshots.importSnapshot(manifest)).toEqual(receipt);
    expect(db.prepare('SELECT count(*) AS n FROM code_snapshots').get()?.n).toBe(1);
    await fs.rm(root, { recursive: true });
    const active = snapshots.active(); expect(active).not.toBeNull();
    if (active === null) throw new Error('Missing snapshot');
    expect(active.diff.files[0]?.patch).toContain('+new');
    const reopened = openDatabase(path.join(root, '..', 'db.sqlite'));
    try {
        expect(new IterationStore({ db: reopened }).get(active.diff.diffId)?.diff).toEqual(active.diff);
    } finally { reopened.close(); }
    expect(snapshots.file(active.diff, 'src/a.ts')).toEqual({ oldText: 'one\nold\n', newText: 'one\nnew\n' });
    const saved = new SavedSources(db, null, snapshots);
    expect((await saved.capture(active.diff, { path: 'src/a.ts', side: 'new', start: 1, end: 2 })).text).toBe('one\nnew');
});

it('отклоняет неполные стороны и ложный patch, сохраняя прежний активный снимок', async () => {
    const { snapshots, manifest, input, root, write, db } = await setup();
    const first = await snapshots.importSnapshot(manifest);
    input.diffId = 'bad'; input.headCommit = 'new-head';
    firstFile(input).after = null; await write();
    await expect(snapshots.importSnapshot(manifest)).rejects.toThrow('side');
    firstFile(input).after = { file: 'new', kind: 'text' };
    firstFile(input).patch = 'patch';
    await fs.writeFile(path.join(root, 'patch'), '@@ -1,2 +1,2 @@\n one\n-old\n+wrong\n'); await write();
    await expect(snapshots.importSnapshot(manifest)).rejects.toThrow('Patch');
    expect(snapshots.active()?.id).toBe(first.codeSnapshotId);
    expect(db.prepare('SELECT count(*) AS n FROM code_snapshots').get()?.n).toBe(1);
});

it('отклоняет traversal и symlink escape', async () => {
    const { input, write, snapshots, manifest, root } = await setup();
    firstFile(input).after = { file: '../db.sqlite', kind: 'binary' }; await write();
    await expect(snapshots.importSnapshot(manifest)).rejects.toThrow('relative path');
    await fs.symlink('../db.sqlite', path.join(root, 'escape'));
    firstFile(input).after = { file: 'escape', kind: 'binary' }; await write();
    await expect(snapshots.importSnapshot(manifest)).rejects.toThrow('escapes');
    expect(snapshots.active()).toBeNull();
});

it('импортирует вне результата модели большие текстовые и бинарные оригиналы', async () => {
    const { input, root, snapshots, manifest, write, db } = await setup();
    const big = 'x'.repeat(3_000_000); await fs.writeFile(path.join(root, 'new'), big);
    const bytes = Buffer.from([0, 255, 3, 4]); await fs.writeFile(path.join(root, 'image'), bytes);
    input.files.push({ path: 'image.png', oldPath: null, changeType: 'add', before: null, after: { file: 'image', kind: 'binary' }, generated: false, hostFileUrl: null, patch: null });
    await write(); await snapshots.importSnapshot(manifest);
    const active = snapshots.active(); if (active === null) throw new Error('Missing snapshot');
    expect(snapshots.file(active.diff, 'src/a.ts')?.newText).toBe(big);
    expect(snapshots.raw(active.diff.diffId, 'image.png', 'new')).toEqual(new Uint8Array(bytes));
    const source = await new SavedSources(db, null, snapshots).capture(active.diff, { path: 'src/a.ts', side: 'new', start: 1, end: 1 });
    expect(source.text).toBe(big);
    expect(active.diff.files[1]?.image?.after?.size).toBe(4);
});

it('добавляет источники только в свою версию, конфликт откатывает весь импорт', async () => {
    const { snapshots, manifest, input, root, db } = await setup();
    const receipt = await snapshots.importSnapshot(manifest);
    const extra = path.join(root, 'sources.json');
    const source = { path: 'outside.ts', revision: input.headCommit, artifact: { file: 'new', kind: 'text' } };
    const write = async (sources: unknown[], project = input.project) => { await fs.writeFile(extra, JSON.stringify({ format: 'code-sources/1', project, codeSnapshotId: receipt.codeSnapshotId, sources })); };
    await write([source]); await snapshots.importSources(extra);
    await fs.writeFile(path.join(root, 'conflict'), 'different');
    await write([{ ...source, path: 'new-source.ts' }, { ...source, artifact: { file: 'conflict', kind: 'text' } }]);
    await expect(snapshots.importSources(extra)).rejects.toThrow('Conflicting');
    expect(snapshots.source(input.diffId, input.headCommit, 'new-source.ts')).toBeNull();
    expect(snapshots.source(input.diffId, input.headCommit, 'outside.ts')).toBe('one\nnew\n');
    expect(db.prepare('SELECT count(*) AS n FROM code_artifacts').get()?.n).toBe(2);
    await write([source], 'other'); await expect(snapshots.importSources(extra)).rejects.toThrow('project');
});

it('новая версия появляется только при импорте, архив не переключает активную', async () => {
    const { snapshots, manifest, input, write } = await setup();
    const original = await snapshots.importSnapshot(manifest);
    input.diffId = 'archive'; input.headCommit = 'archive-head'; input.capturedAt = '2020-01-01T00:00:00.000Z'; await write();
    await snapshots.importSnapshot(manifest);
    expect(snapshots.active()?.id).toBe(original.codeSnapshotId);
    input.diffId = 'new'; input.headCommit = 'new-head'; input.capturedAt = '2026-11-04T00:00:00.000Z'; await write();
    const next = await snapshots.importSnapshot(manifest);
    expect(snapshots.active()?.id).toBe(next.codeSnapshotId);
    expect(snapshots.forDiff(original.diffId)?.id).toBe(original.codeSnapshotId);
});

it('перехваченное вложенное исключение откатывает общую запись и уведомления', async () => {
    const { db } = await setup(); let notified = false;
    const nested = transaction(db, () => { throw new Error('nested'); });
    const outer = transaction(db, () => {
        db.prepare("INSERT INTO meta (key, value) VALUES ('test', 'value')").run();
        afterDatabaseCommit(db, () => { notified = true; });
        try { nested(); } catch { /* Внешний код обработал исключение. */ }
    });
    expect(outer).toThrow('nested failure');
    expect(db.prepare("SELECT value FROM meta WHERE key = 'test'").get()).toBeUndefined(); expect(notified).toBe(false);
});

it('production HTTP читает импортированные фикстуры после restart и удаления экспорта', async () => {
    const { root } = await setup();
    const project = 'arcanum-987';
    const manifest = await exportFixture('medium', project, root);
    let server = await startServer({ prKey: project, sherpaDir: path.join(root, '..', 'state'), snapshot: manifest, idleSeconds: 0 });
    cleanup.push(async () => { await server.close(); });
    const get = (endpoint: string) => fetch(`http://127.0.0.1:${String(server.port)}${endpoint}`, { headers: { authorization: `Bearer ${server.token}` } });
    let response = await get(UI_ENDPOINTS.reviewDiff); expect(response.status).toBe(200);
    const { diff } = await response.json() as { diff: { diffId: string; files: { fileId: string; binary: boolean; changeType: string }[] } };
    await server.close(); await fs.rm(root, { recursive: true });
    server = await startServer({ prKey: project, sherpaDir: path.join(root, '..', 'state'), idleSeconds: 0 });
    for (const file of diff.files) {
        for (const side of ['old', 'new']) {
            response = await get(`${ARTIFACT_ENDPOINTS.raw}?diffId=${encodeURIComponent(diff.diffId)}&fileId=${encodeURIComponent(file.fileId)}&side=${side}`);
            expect(response.status).toBe(file.changeType === (side === 'old' ? 'add' : 'delete') ? 404 : 200);
        }
        response = await get(`${UI_ENDPOINTS.reviewFileContent}?diffId=${encodeURIComponent(diff.diffId)}&fileId=${encodeURIComponent(file.fileId)}`);
        expect(response.status).toBe(200);
    }
    expect(server.queue.listTasks()).toEqual([]);
});

it('новая сессия принимает только текущий envelope и sources, без legacy worker-ввода', () => {
    const fixture = architectureStoryFixture();
    expect(readCheckpoint(JSON.stringify(fixture.outline)).ok).toBe(false);
    expect(readCheckpoint(JSON.stringify(fixture.body)).ok).toBe(false);
    expect(readCheckpoint(checkpointJson(fixture.outline)).ok).toBe(true);
    const invalid = readCheckpoint(JSON.stringify({ contractVersion: 6, overview: fixture.outline }));
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) expect(invalid.errors.join('\n')).toContain('overview.evidence');
});

it('сбой регистрации откатывает все артефакты; повтор импорта завершается успешно', async () => {
    const { db, snapshots, manifest } = await setup();
    db.exec("CREATE TRIGGER import_failure BEFORE INSERT ON code_snapshots BEGIN SELECT RAISE(ABORT, 'import crash'); END;");
    await expect(snapshots.importSnapshot(manifest)).rejects.toThrow('import crash');
    expect(snapshots.active()).toBeNull();
    expect(db.prepare('SELECT count(*) AS n FROM code_artifacts').get()?.n).toBe(0);
    db.exec('DROP TRIGGER import_failure;');
    await snapshots.importSnapshot(manifest);
    expect(snapshots.active()).not.toBeNull();
});

it('чат публикует новый источник только после импорта и читает полный исходник offline', async () => {
    const { root, manifest, input } = await setup();
    const stateDir = path.join(root, '..', 'chat-state');
    let server = await startServer({ prKey: input.project, sherpaDir: stateDir, snapshot: manifest, idleSeconds: 0 });
    cleanup.push(async () => { await server.close(); });
    const http = globalThis.fetch;
    // Само приложение лишено сети; тестовый клиент обращается к loopback исходным transport.
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Network disabled'));
    const get = (endpoint: string) => http(`http://127.0.0.1:${String(server.port)}${endpoint}`, { headers: { authorization: `Bearer ${server.token}` } });
    const post = (endpoint: string, body: unknown) => http(`http://127.0.0.1:${String(server.port)}${endpoint}`, { method: 'POST', headers: { authorization: `Bearer ${server.token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    server.workerRegistry.register('reader', 'test');
    const exchange = await server.chat.ask('На чём основан ответ?', null);
    const leased = server.queue.next('reader'); if (leased?.task.type !== 'chat') throw new Error('Missing chat');
    const result = '[Caller](#code?path=outside.ts&side=new&start=1&end=1)';
    const complete = () => post(WORKER_ENDPOINTS.complete, { protocolVersion: PROTOCOL_VERSION, cliVersion: '0.31.0', workerId: 'reader', taskId: leased.task.id, grantToken: leased.lease.grantToken, result });
    expect((await complete()).status).toBe(400);
    expect(server.queue.getTask(leased.task.id)?.status).toBe('leased');
    const { diff } = await (await get(UI_ENDPOINTS.reviewDiff)).json() as { diff: { codeSnapshotId: string } };
    await fs.writeFile(path.join(root, 'outside'), 'saved caller\ncomplete context\n');
    const sources = path.join(root, 'sources.json');
    await fs.writeFile(sources, JSON.stringify({ format: 'code-sources/1', project: input.project, codeSnapshotId: diff.codeSnapshotId,
        sources: [{ path: 'outside.ts', revision: input.headCommit, artifact: { file: 'outside', kind: 'text' } }] }));
    expect((await post(ARTIFACT_ENDPOINTS.sources, { manifest: sources })).status).toBe(200);
    expect(server.queue.getTask(leased.task.id)?.status).toBe('leased');
    expect((await complete()).status).toBe(200);
    const chat = await (await get(UI_ENDPOINTS.reviewChat)).json() as { exchanges: { id: number; answer: string }[] };
    const answer = chat.exchanges.find((item) => item.id === exchange.id)?.answer;
    const sourceId = /#source\?id=([a-f0-9]{64})/.exec(answer ?? '')?.[1];
    expect(sourceId).toBeDefined();
    await server.close(); await fs.rm(root, { recursive: true });
    server = await startServer({ prKey: input.project, sherpaDir: stateDir, idleSeconds: 0 });
    const count = server.queue.listTasks().length;
    expect(await (await get(`${SAVED_SOURCE_ENDPOINT}?id=${sourceId ?? ''}`)).json()).toMatchObject({ text: 'saved caller', fullFile: true });
    expect(await (await get(`${ARTIFACT_ENDPOINTS.source}?id=${sourceId ?? ''}`)).text()).toBe('saved caller\ncomplete context\n');
    expect(server.queue.listTasks()).toHaveLength(count);
});

function firstFile(input: CodeSnapshotInput) {
    const file = input.files[0]; if (file === undefined) throw new Error('Missing file'); return file;
}


it('принимает только известные сведения о PR без review-возможностей и фиктивных значений', async () => {
    const { input, write, snapshots, manifest } = await setup();
    input.pr = { title: 'Pinned change', url: 'https://example.test/pr/1' };
    await write(); await snapshots.importSnapshot(manifest);
    expect(snapshots.active()?.diff.metadata).toEqual(input.pr);
});


it('метаданные без ханков не принимают произвольный текст, повторный импорт сохраняет исходную дату', async () => {
    const { input, root, manifest, write, snapshots, db } = await setup();
    firstFile(input).before = firstFile(input).after;
    firstFile(input).patch = 'metadata.patch';
    await fs.writeFile(path.join(root, 'metadata.patch'), 'not a patch'); await write();
    await expect(snapshots.importSnapshot(manifest)).rejects.toThrow('metadata-only');
    await fs.writeFile(path.join(root, 'metadata.patch'), 'diff --git a/src/a.ts b/src/a.ts\nold mode 100644\nnew mode 100755\n');
    await snapshots.importSnapshot(manifest);
    const captured = snapshots.active()?.capturedAt;
    input.capturedAt = '2026-11-04T00:00:00.000Z'; await write();
    await snapshots.importSnapshot(manifest);
    expect(snapshots.active()?.capturedAt).toBe(captured);
    const iteration = db.prepare('SELECT diff_json, code_snapshot_id FROM iterations WHERE diff_id = ?').get(input.diffId);
    expect(iteration?.code_snapshot_id).toBe(snapshots.active()?.id);
    expect(JSON.parse(String(iteration?.diff_json)) as unknown).toMatchObject({ kind: 'code-snapshot-ref' });
    expect(new IterationStore({ db }).get(input.diffId)?.diff.capturedAt).toBe(captured);
});


it('отклоняет смещённые координаты даже когда applyPatch мог найти текст рядом', async () => {
    const { input, root, manifest, write, snapshots } = await setup();
    firstFile(input).patch = 'shifted.patch';
    await fs.writeFile(path.join(root, 'shifted.patch'), '--- src/a.ts\n+++ src/a.ts\n@@ -2,2 +2,2 @@\n one\n-old\n+new\n');
    await write(); await expect(snapshots.importSnapshot(manifest)).rejects.toThrow('coordinates');
    expect(snapshots.active()).toBeNull();
});


it('добавляет полные байты к прежнему diffId, сохраняя непрозрачные fileId и patch для старых связей', async () => {
    const { input, manifest, write, snapshots, db } = await setup();
    const patch = '--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,2 +1,2 @@\n one\n-old\n+new\n';
    const legacy = prDiffSchema.parse({ diffId: input.diffId, baseCommit: input.baseCommit, headCommit: input.headCommit,
        files: [{ fileId: 'opaque-native-id', path: 'src/a.ts', oldPath: null, changeType: 'modify', binary: false, generated: false,
            additions: 1, deletions: 1, patch, viewed: true, blameUrl: null, hostFileUrl: null }] });
    const iterations = new IterationStore({ db });
    iterations.upsert(legacy, { diffId: legacy.diffId, baseCommit: legacy.baseCommit, headCommit: legacy.headCommit, createdAt: input.capturedAt, status: 'active' });
    const saved = await new SavedSources(db, { getSourceAtRevision: () => Promise.resolve('one\nnew\n') } as unknown as CodeReader).capture(legacy, { path: 'src/a.ts', side: 'new', start: 1, end: 2 });
    expect(saved.fullFile).not.toBe(true);
    const conflicting = await new SavedSources(db, { getSourceAtRevision: () => Promise.resolve('wrong\n') } as unknown as CodeReader).capture(legacy, { path: 'src/a.ts', side: 'new', start: 1, end: 1 });
    firstFile(input).fileId = 'new-export-id'; await write();
    const receipt = await snapshots.importSnapshot(manifest);
    expect(snapshots.active()?.diff.files[0]).toMatchObject({ fileId: 'opaque-native-id', patch });
    expect(iterations.get(input.diffId)?.diff.codeSnapshotId).toBe(receipt.codeSnapshotId);
    expect(snapshots.file(legacy, 'opaque-native-id')?.newText).toBe('one\nnew\n');
    expect(new SavedSources(db, null, snapshots).get(saved.id)).toMatchObject({ id: saved.id, text: saved.text, fullFile: true });
    expect(new SavedSources(db, null, snapshots).get(conflicting.id)?.fullFile).not.toBe(true);
    await expect(new SavedSources(db, null, snapshots).capture(legacy, { path: 'src/a.ts', side: 'new', start: 1, end: 1 })).rejects.toThrow('conflicts with pinned snapshot');
    expect(await snapshots.importSnapshot(manifest)).toEqual(receipt);
});

it('конфликтующий patch при дополнении legacy отклоняется атомарно и не трогает старый JSON', async () => {
    const { db, input, manifest, write, root, snapshots } = await setup();
    const historicalPatch = '--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,2 +1,2 @@\n one\n-old\n+new\n';
    const legacy = prDiffSchema.parse({ diffId: input.diffId, baseCommit: input.baseCommit, headCommit: input.headCommit,
        files: [{ fileId: 'opaque-id', path: 'src/a.ts', oldPath: null, changeType: 'modify', binary: false,
            generated: false, additions: 1, deletions: 1, patch: historicalPatch, viewed: null, blameUrl: null, hostFileUrl: null }] });
    const iterations = new IterationStore({ db });
    iterations.upsert(legacy, { diffId: input.diffId, baseCommit: input.baseCommit, headCommit: input.headCommit, createdAt: input.capturedAt, status: 'active' });
    const original = db.prepare('SELECT diff_json FROM iterations WHERE diff_id = ?').get(input.diffId)?.diff_json;
    firstFile(input).patch = 'alternate.patch';
    await fs.writeFile(path.join(root, 'alternate.patch'), `diff --git a/src/a.ts b/src/a.ts\n${historicalPatch}`);
    await write();
    await expect(snapshots.importSnapshot(manifest)).rejects.toThrow('saved patch');
    expect(db.prepare('SELECT diff_json FROM iterations WHERE diff_id = ?').get(input.diffId)?.diff_json).toBe(original);
    expect(db.prepare('SELECT count(*) AS n FROM code_snapshots').get()?.n).toBe(0);
    expect(db.prepare('SELECT count(*) AS n FROM code_artifacts').get()?.n).toBe(0);
    expect(iterations.get(input.diffId)?.diff.files[0]?.fileId).toBe('opaque-id');
});

it('одинаковые локальные revision не раскрывают оригинал другой версии', async () => {
    const { db, input, manifest, snapshots } = await setup();
    const iterations = new IterationStore({ db });
    const old = prDiffSchema.parse({ diffId: 'version-a', baseCommit: input.baseCommit, headCommit: input.headCommit,
        files: [{ fileId: 'a-opaque', path: 'src/a.ts', oldPath: null, changeType: 'modify', binary: false,
            generated: false, additions: 0, deletions: 0, patch: null, viewed: null, blameUrl: null, hostFileUrl: null }] });
    iterations.upsert(old, { diffId: old.diffId, baseCommit: old.baseCommit, headCommit: old.headCommit, createdAt: '2026-11-02T00:00:00.000Z', status: 'previous' });
    await snapshots.importSnapshot(manifest);
    const reader = new SnapshotReader(snapshots, iterations);
    expect(await reader.getSourceAtRevision('src/a.ts', input.baseCommit)).toBeNull();
    const oldFile = old.files[0]; if (oldFile === undefined) throw new Error('Missing old file');
    await expect(new SavedSources(db, reader, snapshots).file(old, oldFile)).rejects.toThrow('Pinned file content is unavailable');
    await expect(new SavedSources(db, reader, snapshots).capture(old, { path: 'src/a.ts', side: 'old', start: 1, end: 1 })).rejects.toThrow('Source unavailable');
});

it('одни байты с иным происхождением не заменяют первый захват', async () => {
    const { db, input, manifest, root, snapshots } = await setup();
    const receipt = await snapshots.importSnapshot(manifest);
    const origin = (scope: string) => ({ url: 'https://example.test/source', capturedAt: input.capturedAt, scope });
    const source = (scope: string) => ({ path: 'outside.ts', revision: input.headCommit, artifact: { file: 'new', kind: 'text' }, origin: origin(scope) });
    const sourceManifest = path.join(root, 'sources.json');
    const write = async (sources: unknown[]) => fs.writeFile(sourceManifest, JSON.stringify({ format: 'code-sources/1', project: input.project, codeSnapshotId: receipt.codeSnapshotId, sources }));
    await write([source('first')]); await snapshots.importSources(sourceManifest);
    await write([{ ...source('first'), path: 'second.ts' }, source('second')]);
    await expect(snapshots.importSources(sourceManifest)).rejects.toThrow('Conflicting immutable source');
    expect(snapshots.sourceArtifact(input.diffId, input.headCommit, 'outside.ts')?.origin?.scope).toBe('first');
    expect(snapshots.sourceArtifact(input.diffId, input.headCommit, 'second.ts')).toBeNull();
    expect(db.prepare('SELECT count(*) AS n FROM code_sources WHERE snapshot_id = ?').get(receipt.codeSnapshotId)?.n).toBe(3);
});

it('целый внешний файл получает проверяемую ссылку на импортированный head', async () => {
    const { db, input, manifest, root, snapshots } = await setup();
    const receipt = await snapshots.importSnapshot(manifest);
    const sourceManifest = path.join(root, 'sources.json');
    await fs.writeFile(sourceManifest, JSON.stringify({ format: 'code-sources/1', project: input.project, codeSnapshotId: receipt.codeSnapshotId,
        sources: [{ path: 'outside.ts', revision: input.headCommit, artifact: { file: 'new', kind: 'text' } }] }));
    await snapshots.importSources(sourceManifest);
    const diff = snapshots.active()?.diff; if (diff === undefined) throw new Error('Missing diff');
    const saved = new SavedSources(db, null, snapshots);
    const prepared = JSON.parse(await saved.prepare(diff, JSON.stringify({ sources: [{ kind: 'file', path: 'outside.ts' }] }), false)) as { sources: { sourceId: string }[] };
    const sourceId = prepared.sources[0]?.sourceId; expect(sourceId).toMatch(/^[a-f0-9]{64}$/);
    expect(withSavedSources(saved, () => sourceFileEvidence(diff, { path: 'outside.ts', sourceId }))).toMatchObject({ fullFile: true, path: 'outside.ts' });
    expect(withSavedSources(saved, () => sourceFileEvidence(diff, { path: 'other.ts', sourceId }))).toBeNull();
});

it('legacy enrichment сохраняет порядок и известные поля, а конфликт метаданных откатывает', async () => {
    const { db, input, manifest, write, snapshots } = await setup();
    input.files.push({ path: 'src/b.ts', oldPath: null, changeType: 'modify', before: { file: 'old', kind: 'text' },
        after: { file: 'new', kind: 'text' }, patch: null, generated: false, hostFileUrl: null });
    const savedFiles = ['src/b.ts', 'src/a.ts'].map((filePath, index) => ({ fileId: `opaque-${String(index)}`,
        path: filePath, oldPath: null, changeType: 'modify' as const, binary: false, generated: index === 0,
        additions: 0, deletions: 0, patch: null, viewed: true, blameUrl: 'https://example.test/blame',
        hostFileUrl: index === 0 ? 'https://example.test/old-file' : null }));
    const legacy = prDiffSchema.parse({ diffId: input.diffId, baseCommit: input.baseCommit, headCommit: input.headCommit,
        capturedAt: '2026-11-02T00:00:00.000Z', metadata: { title: 'Historical title', url: 'https://example.test/old' }, files: savedFiles });
    input.pr = { title: 'Changed title', url: 'https://example.test/new' };
    const iterations = new IterationStore({ db });
    iterations.upsert(legacy, { diffId: input.diffId, baseCommit: input.baseCommit, headCommit: input.headCommit, createdAt: input.capturedAt, status: 'active' });
    const minimal = structuredClone(input) as unknown as { files: Record<string, unknown>[] };
    for (const file of minimal.files) { delete file.generated; delete file.hostFileUrl; }
    await fs.writeFile(manifest, JSON.stringify(minimal));
    const receipt = await snapshots.importSnapshot(manifest);
    expect(snapshots.active()?.diff.files.map((file) => file.fileId)).toEqual(['opaque-0', 'opaque-1']);
    expect(snapshots.active()?.diff.files[0]).toMatchObject({ viewed: true, blameUrl: 'https://example.test/blame', additions: 0,
        generated: true, hostFileUrl: 'https://example.test/old-file' });
    expect(snapshots.active()?.diff).toMatchObject({ capturedAt: legacy.capturedAt, metadata: legacy.metadata });
    const original = db.prepare('SELECT diff_json FROM iterations WHERE diff_id = ?').get(input.diffId)?.diff_json;
    firstFile(input).generated = true; await write();
    expect((await snapshots.importSnapshot(manifest)).codeSnapshotId).toBe(receipt.codeSnapshotId);
    firstFile(input).generated = false; firstFile(input).hostFileUrl = 'https://example.test/changed'; await write();
    expect((await snapshots.importSnapshot(manifest)).codeSnapshotId).toBe(receipt.codeSnapshotId);
    expect(snapshots.active()?.diff.files[0]?.hostFileUrl).toBe('https://example.test/old-file');
    firstFile(input).hostFileUrl = null; firstFile(input).before = { file: 'old', kind: 'binary' }; await write();
    await expect(snapshots.importSnapshot(manifest)).rejects.toThrow('saved file metadata');
    expect(db.prepare('SELECT diff_json FROM iterations WHERE diff_id = ?').get(input.diffId)?.diff_json).toBe(original);
    expect(db.prepare('SELECT count(*) AS n FROM code_snapshots').get()?.n).toBe(1);
});

it('новые разные diffId допускают одинаковые байты, старый ID принимает точный реимпорт', async () => {
    const { db, input, manifest, write, snapshots } = await setup();
    const first = await snapshots.importSnapshot(manifest);
    input.diffId = 'same-bytes-other-version'; await write();
    const second = await snapshots.importSnapshot(manifest);
    expect(second.codeSnapshotId).not.toBe(first.codeSnapshotId);
    expect(snapshots.forDiff(first.diffId)?.id).toBe(first.codeSnapshotId);
    input.diffId = first.diffId; await write();
    expect((await snapshots.importSnapshot(manifest)).codeSnapshotId).toBe(first.codeSnapshotId);

    const stored = snapshots.forDiff(first.diffId); if (stored === null) throw new Error('Missing snapshot');
    const importedArtifact = (artifact: (typeof stored.files)[number]['before']) => artifact === null ? null :
        { hash: artifact.hash, size: artifact.size, kind: artifact.kind, ...(artifact.mode === undefined ? {} : { mode: artifact.mode }) };
    const identity = { project: input.project, baseCommit: input.baseCommit, headCommit: input.headCommit,
        files: stored.diff.files.map((file, index) => ({ path: file.path, oldPath: file.oldPath, changeType: file.changeType,
            patchHash: file.patch === null ? null : createHash('sha256').update(file.patch).digest('hex'),
            fileId: stored.files[index]?.fileId, before: importedArtifact(stored.files[index]?.before ?? null),
            after: importedArtifact(stored.files[index]?.after ?? null), patchOrigin: stored.files[index]?.patchOrigin }))
            .sort((a, b) => a.path.localeCompare(b.path)) };
    const oldId = createHash('sha256').update(JSON.stringify(identity)).digest('hex');
    input.diffId = 'historical-id'; await write();
    db.prepare('INSERT INTO code_snapshots (id, project, diff_id, data) VALUES (?, ?, ?, ?)')
        .run(oldId, input.project, input.diffId, JSON.stringify({ ...stored, id: oldId, diff: { ...stored.diff, diffId: input.diffId, codeSnapshotId: oldId } }));
    expect((await snapshots.importSnapshot(manifest)).codeSnapshotId).toBe(oldId);
    expect(snapshots.forDiff(input.diffId)?.id).toBe(oldId);
});

it('повторный импорт заново читает общий артефакт и ловит изменённые байты', async () => {
    const { input, root, write, manifest, snapshots, db } = await setup();
    input.files.push({ path: 'src/b.ts', oldPath: null, changeType: 'modify', before: { file: 'old', kind: 'text' },
        after: { file: 'new', kind: 'text' }, patch: null, generated: false, hostFileUrl: null });
    await write();
    const receipt = await snapshots.importSnapshot(manifest);
    expect(snapshots.active()?.files[0]?.after?.hash).toBe(snapshots.active()?.files[1]?.after?.hash);
    await fs.writeFile(path.join(root, 'new'), 'changed\n');
    await expect(snapshots.importSnapshot(manifest)).rejects.toThrow('Patch does not reproduce');
    expect(snapshots.active()?.id).toBe(receipt.codeSnapshotId);
    expect(db.prepare('SELECT count(*) AS n FROM code_artifacts').get()?.n).toBe(2);
});

it('старый opaque image blobId читает импортированные байты после рестарта без экспорта', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'legacy-image-'));
    cleanup.push(async () => { await fs.rm(dir, { recursive: true, force: true }); });
    const project = 'legacy-image-project';
    const exportRoot = path.join(dir, 'export');
    await fs.mkdir(exportRoot);
    const expected = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);
    await fs.writeFile(path.join(exportRoot, 'image'), expected);
    const blobId = 'blob:opaque-pinned-image';
    const input: CodeSnapshotInput = { format: 'code-snapshot/1', project, diffId: 'image-diff', baseCommit: 'base', headCommit: 'head',
        capturedAt: '2026-11-03T00:00:00.000Z', pr: null, activate: true, sources: [],
        files: [{ path: 'image.png', oldPath: null, changeType: 'add', before: null,
            after: { file: 'image', kind: 'binary' }, patch: null, generated: false, hostFileUrl: null }] };
    const manifest = path.join(exportRoot, 'snapshot.json');
    await fs.writeFile(manifest, JSON.stringify(input));
    const diff = prDiffSchema.parse({ diffId: input.diffId, baseCommit: input.baseCommit, headCommit: input.headCommit,
        files: [{ fileId: 'opaque-file-id', path: 'image.png', oldPath: null, changeType: 'add', binary: true,
            generated: false, additions: 0, deletions: 0, patch: null, viewed: null, blameUrl: null, hostFileUrl: null,
            image: { mime: 'image/png', before: null, after: { blobId, size: expected.length } } }] });
    const iteration = { diffId: input.diffId, baseCommit: input.baseCommit, headCommit: input.headCommit,
        createdAt: input.capturedAt, status: 'active' as const };
    const stateDir = path.join(dir, 'state');
    const dbPath = databasePathFor(stateDir, project);
    await fs.mkdir(path.dirname(dbPath), { recursive: true });
    const db = openDatabase(dbPath);
    new IterationStore({ db }).upsert(diff, iteration);
    db.close();
    const canonicalId = createHash('sha256').update(expected).digest('hex');
    const cache = new BlobCache(stateDir, blobsDirOf(stateDir, project));
    await cache.write(blobId, expected);
    let server = await startServer({ prKey: project, sherpaDir: stateDir, idleSeconds: 0 });
    try {
        const blob = (id: string) => fetch(`http://127.0.0.1:${String(server.port)}${UI_ENDPOINTS.reviewBlob}?blobId=${encodeURIComponent(id)}`,
            { headers: { authorization: `Bearer ${server.token}` } });
        // До импорта доступен старый непрозрачный ID только из файлового кеша.
        expect(new Uint8Array(await (await blob(blobId)).arrayBuffer())).toEqual(expected);
        await cache.write(canonicalId, new Uint8Array([8, 8, 8]));
        expect((await blob(canonicalId)).status).toBe(404);
        await cache.write(canonicalId, expected);
        expect(new Uint8Array(await (await blob(canonicalId)).arrayBuffer())).toEqual(expected);
        await server.close();
        server = await startServer({ prKey: project, sherpaDir: stateDir, idleSeconds: 0 });
        expect(new Uint8Array(await (await blob(blobId)).arrayBuffer())).toEqual(expected);
        await server.close();
        server = await startServer({ prKey: project, sherpaDir: stateDir, snapshot: manifest, idleSeconds: 0 });
        await cache.write(blobId, new Uint8Array([9, 9, 9]));
        await cache.write(canonicalId, new Uint8Array([8, 8, 8]));
        expect(new Uint8Array(await (await blob(blobId)).arrayBuffer())).toEqual(expected);
        expect(new Uint8Array(await (await blob(canonicalId)).arrayBuffer())).toEqual(expected);
        await server.close();
        await fs.rm(exportRoot, { recursive: true });
        server = await startServer({ prKey: project, sherpaDir: stateDir, idleSeconds: 0 });
        expect(new Uint8Array(await (await blob(blobId)).arrayBuffer())).toEqual(expected);
        expect(new Uint8Array(await (await blob(canonicalId)).arrayBuffer())).toEqual(expected);
    } finally { await server.close(); }
});

it('конфликт alias другого снимка откатывает все новые байты и снимок', async () => {
    const { db, input, root, manifest, write, snapshots } = await setup();
    await fs.writeFile(path.join(root, 'image-a'), new Uint8Array([1, 2, 3]));
    await fs.writeFile(path.join(root, 'image-b'), new Uint8Array([4, 5, 6]));
    input.files = [{ path: 'image.png', oldPath: null, changeType: 'add', before: null,
        after: { file: 'image-a', kind: 'binary' }, patch: null, generated: false, hostFileUrl: null }];
    const oldImage = { mime: 'image/png', before: null, after: { blobId: 'blob:opaque-image', size: 3 } } as const;
    const legacy = (diffId: string) => prDiffSchema.parse({ diffId, baseCommit: input.baseCommit, headCommit: input.headCommit,
        files: [{ fileId: `opaque-${diffId}`, path: 'image.png', oldPath: null, changeType: 'add', binary: true,
            generated: false, additions: 0, deletions: 0, patch: null, viewed: null, blameUrl: null, hostFileUrl: null, image: oldImage }] });
    const iterations = new IterationStore({ db });
    iterations.upsert(legacy(input.diffId), { diffId: input.diffId, baseCommit: input.baseCommit, headCommit: input.headCommit, createdAt: input.capturedAt, status: 'active' });
    await write(); const first = await snapshots.importSnapshot(manifest);
    expect(snapshots.active()?.diff.files[0]?.image?.after?.blobId).toBe('blob:opaque-image');
    expect(snapshots.bytes('blob:opaque-image')).toEqual(new Uint8Array([1, 2, 3]));
    input.diffId = 'conflicting-version'; firstFile(input).after = { file: 'image-b', kind: 'binary' };
    iterations.upsert(legacy(input.diffId), { diffId: input.diffId, baseCommit: input.baseCommit, headCommit: input.headCommit, createdAt: input.capturedAt, status: 'previous' });
    await write();
    await expect(snapshots.importSnapshot(manifest)).rejects.toThrow('Conflicting immutable image blob');
    expect(snapshots.active()?.id).toBe(first.codeSnapshotId);
    expect(snapshots.forDiff(input.diffId)).toBeNull();
    expect(snapshots.bytes('blob:opaque-image')).toEqual(new Uint8Array([1, 2, 3]));
    expect(db.prepare('SELECT count(*) AS n FROM code_artifacts').get()?.n).toBe(1);
});

it('локальный cache старого blobId проверяется до регистрации alias', async () => {
    const { db, input, root, manifest, write } = await setup();
    await fs.writeFile(path.join(root, 'image'), new Uint8Array([1, 2, 3]));
    input.files = [{ path: 'image.png', oldPath: null, changeType: 'add', before: null,
        after: { file: 'image', kind: 'binary' }, patch: null, generated: false, hostFileUrl: null }];
    const blobId = 'blob:cached-old';
    const legacy = prDiffSchema.parse({ diffId: input.diffId, baseCommit: input.baseCommit, headCommit: input.headCommit,
        files: [{ fileId: 'opaque-file', path: 'image.png', oldPath: null, changeType: 'add', binary: true,
            generated: false, additions: 0, deletions: 0, patch: null, viewed: null, blameUrl: null, hostFileUrl: null,
            image: { mime: 'image/png', before: null, after: { blobId, size: 3 } } }] });
    new IterationStore({ db }).upsert(legacy, { diffId: input.diffId, baseCommit: input.baseCommit, headCommit: input.headCommit,
        createdAt: input.capturedAt, status: 'active' });
    const local = vi.fn(() => Promise.resolve(new Uint8Array([9, 9, 9])));
    const snapshots = new CodeSnapshots(db, input.project, local);
    await write();
    await expect(snapshots.importSnapshot(manifest)).rejects.toThrow('Conflicting local image blob');
    expect(local).toHaveBeenCalledWith(blobId);
    expect(db.prepare('SELECT count(*) AS n FROM code_snapshots').get()?.n).toBe(0);
    expect(db.prepare('SELECT count(*) AS n FROM code_artifacts').get()?.n).toBe(0);
    expect(db.prepare('SELECT count(*) AS n FROM code_artifact_aliases').get()?.n).toBe(0);
});


it('диагностика malformed не отклоняет исторически допустимую нормализацию пустой стороны', async () => {
    const { input, root, manifest, snapshots, write } = await setup();
    await fs.writeFile(path.join(root, 'old'), '');
    await fs.writeFile(path.join(root, 'new'), 'new\n');
    // diff/applyPatch нормализует заявленную 1 в 0, если у стороны нет строк тела.
    const patch = '@@ -1 +1 @@\n+new';
    expect(parseUnifiedPatch(patch).malformed).toBe(true);
    await fs.writeFile(path.join(root, 'provided.patch'), patch);
    firstFile(input).patch = 'provided.patch';
    await write();
    const receipt = await snapshots.importSnapshot(manifest);
    const active = snapshots.active(); if (active === null) throw new Error('Missing snapshot');
    expect(active.diff.files[0]?.patch).toBe(patch);
    expect(snapshots.file(active.diff, 'src/a.ts')).toEqual({ oldText: '', newText: 'new\n' });
    expect(await snapshots.importSnapshot(manifest)).toEqual(receipt);
});

it('сохранённый усечённый legacy patch остаётся читаемым и не переписывается', async () => {
    const { db, input, snapshots } = await setup();
    const patch = '@@ -1,2 +1,2 @@\n?unknown\n';
    const diff = prDiffSchema.parse({ diffId: input.diffId, baseCommit: input.baseCommit, headCommit: input.headCommit,
        files: [{ fileId: 'legacy-id', path: 'src/a.ts', oldPath: null, changeType: 'modify', binary: false,
            generated: false, additions: 0, deletions: 0, patch, viewed: null, blameUrl: null, hostFileUrl: null }] });
    const iterations = new IterationStore({ db });
    iterations.upsert(diff, { diffId: input.diffId, baseCommit: input.baseCommit, headCommit: input.headCommit,
        createdAt: input.capturedAt, status: 'active' });
    const before = db.prepare('SELECT diff_json FROM iterations WHERE diff_id = ?').get(input.diffId)?.diff_json;
    expect((await new SnapshotReader(snapshots, iterations).getDiff()).files[0]).toMatchObject({ fileId: 'legacy-id', patch });
    expect(db.prepare('SELECT diff_json FROM iterations WHERE diff_id = ?').get(input.diffId)?.diff_json).toBe(before);
});

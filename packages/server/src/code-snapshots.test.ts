import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { openDatabase, transaction, afterDatabaseCommit } from './db.js';
import { CodeSnapshots } from './code-snapshots.js';
import { IterationStore } from './iteration-store.js';
import { prDiffSchema } from '@sherpa/protocol';
import { SavedSources } from './saved-sources.js';
import type { CodeSnapshotInput } from '@sherpa/protocol';
import { exportFixture } from './fixture-import.js';
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
    const complete = () => post(WORKER_ENDPOINTS.complete, { protocolVersion: PROTOCOL_VERSION, cliVersion: '0.31.0', workerId: 'reader', taskId: leased.task.id, result });
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
    const iteration = db.prepare('SELECT diff_json FROM iterations WHERE diff_id = ?').get(input.diffId);
    expect(JSON.parse(String(iteration?.diff_json)) as unknown).toMatchObject({ capturedAt: captured });
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
    firstFile(input).fileId = 'new-export-id'; await write();
    const receipt = await snapshots.importSnapshot(manifest);
    expect(snapshots.active()?.diff.files[0]).toMatchObject({ fileId: 'opaque-native-id', patch });
    expect(iterations.get(input.diffId)?.diff.codeSnapshotId).toBe(receipt.codeSnapshotId);
    expect(snapshots.file(legacy, 'opaque-native-id')?.newText).toBe('one\nnew\n');
    expect(await snapshots.importSnapshot(manifest)).toEqual(receipt);
});

import { afterEach, expect, it, vi } from 'vitest';
import { makeFixtureHost } from '@sherpa/fixtures';
import { SAVED_SOURCE_ENDPOINT, WORKER_ENDPOINTS, PROTOCOL_VERSION, UI_ENDPOINTS, uiReviewRouteResponseSchema } from '@sherpa/protocol';
import { startServer } from './server.js';
import { makeTempSherpaDir, removeTempSherpaDir, postJson, get } from './test-support.js';
import { architectureStoryFixture } from '@sherpa/fixtures';
import type { ReviewSource } from '@sherpa/protocol';
import { openDatabase } from './db.js';
import { SavedSources, withSavedSources } from './saved-sources.js';
import { storyEvidenceResolver } from './story-evidence.js';
import { chatCodeLinkErrors } from './chat-code-links.js';

const databases: ReturnType<typeof openDatabase>[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
function setup() {
    const db = openDatabase(':memory:'); databases.push(db);
    const read = vi.fn((_path: string, _revision: string) => Promise.resolve('first\ncaller()\nlast'));
    const source = new SavedSources(db, { getSourceAtRevision: read } as unknown as ReviewSource);
    return { db, read, source, diff: architectureStoryFixture().diff };
}
it('сохраняет точную версию вне патча и повторно читает без хоста', async () => {
    const { db, read, source, diff } = setup();
    const raw = { summary: 'Вызов.', evidence: { claims: [{ sources: [{ kind: 'lines' as const, path: 'outside/caller.ts', side: 'new' as const, start: 2, end: 2 }], limitation: null }] } };
    const result = JSON.parse(await source.prepare(diff, JSON.stringify(raw), false)) as typeof raw;
    expect(read).toHaveBeenCalledWith('outside/caller.ts', diff.headCommit);
    const accepted = withSavedSources(source, () => storyEvidenceResolver(diff)(result.evidence, raw.summary));
    expect(accepted.ok).toBe(true);
    if (!accepted.ok) throw new Error('Invalid source');
    const id = accepted.value.claims[0]?.sources[0]?.sourceId;
    expect(id).toBeDefined();
    const offline = new SavedSources(db, null);
    expect(offline.get(id ?? '')?.text).toBe('caller()');
    expect(withSavedSources(offline, () => chatCodeLinkErrors(`[caller](#source?id=${id ?? ''})`, diff, null))).toEqual([]);
    expect(withSavedSources(offline, () => chatCodeLinkErrors(`[caller](#source?id=${id ?? ''})`, { ...diff, diffId: 'other' }, null))).not.toEqual([]);
    const wrongRevision = { ...diff, headCommit: 'different' };
    expect(withSavedSources(offline, () => storyEvidenceResolver(wrongRevision)(result.evidence, raw.summary)).ok).toBe(false);
});
it('чат получает сохранённую ссылку, а не выдуманные координаты текущего checkout', async () => {
    const { source, diff } = setup();
    const prepared = await source.prepare(diff, '[caller](#source?path=outside%2Fcaller.ts&side=old&start=2&end=2)', true);
    expect(prepared).toMatch(/#source\?id=[a-f0-9]{64}/);
    await expect(source.prepare(diff, '[bad](#source?path=outside.ts&side=new&start=10&end=11)', true)).rejects.toThrow('Source unavailable');
});
it('не подтверждает отсутствующую сторону удалённого файла', async () => {
    const { source, diff, read } = setup();
    const file = diff.files[0]; if (file === undefined) throw new Error('No file');
    await expect(source.capture({ ...diff, files: [{ ...file, changeType: 'delete' }] }, { path: file.path, side: 'new', start: 1, end: 1 })).rejects.toThrow('absent');
    expect(read).not.toHaveBeenCalled();
});

it('HTTP complete сохраняет источник вне патча, перезапуск читает его без агента и сети', async () => {
    const dir = await makeTempSherpaDir();
    const host = makeFixtureHost('medium');
    const read = vi.fn(() => Promise.resolve('caller();\n'));
    Object.assign(host, { getSourceAtRevision: read });
    let server = await startServer({ sherpaDir: dir, prKey: 'fixture-medium', reviewSourceFactory: () => ({ name: 'fixture', host }) });
    try {
        server.workerRegistry.register('worker', 'test'); await server.route.warmup();
        const task = server.queue.next('worker')?.task;
        if (task === undefined) throw new Error('No task');
        const fixture = architectureStoryFixture();
        const result = { ...fixture.outline, evidence: { claims: [{ sources: [{ kind: 'lines', path: 'outside.ts', side: 'new', start: 1, end: 1 }], limitation: null }] } };
        const response = await postJson(server.port, WORKER_ENDPOINTS.complete, { protocolVersion: PROTOCOL_VERSION, cliVersion: '0.26.0', workerId: 'worker', taskId: task.id, result: JSON.stringify(result) }, server.token);
        expect(await response.json()).toMatchObject({ kind: 'accepted' });
        const state = uiReviewRouteResponseSchema.parse(await (await get(server.port, UI_ENDPOINTS.reviewRoute, server.token)).json());
        const saved = state.route.snapshot?.summaryEvidence?.claims[0]?.sources[0];
        expect(saved?.sourceId).toBeDefined();
        await server.close();
        read.mockRejectedValue(new Error('Offline'));
        server = await startServer({ sherpaDir: dir, prKey: 'fixture-medium', reviewSourceFactory: () => ({ name: 'fixture', host }) });
        const stored = await get(server.port, `${SAVED_SOURCE_ENDPOINT}?id=${saved?.sourceId ?? ''}`, server.token);
        expect(await stored.json()).toMatchObject({ text: 'caller();', path: 'outside.ts' });
    } finally { await server.close(); await removeTempSherpaDir(dir); }
});

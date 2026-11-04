import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { CodeSnapshotInput } from '@sherpa/protocol';
import { ARTIFACT_ENDPOINTS, PROTOCOL_VERSION, UI_ENDPOINTS, WORKER_ENDPOINTS, workerNextResponseSchema, taskCompleteResponseSchema, uiReviewFileContentResponseSchema, uiReviewRouteResponseSchema } from '@sherpa/protocol';
import { expect, it } from 'vitest';
import { startServer } from './server.js';
import { postJson } from './test-support.js';

it('HTTP принимает обзор свыше 256 КиБ и выдаёт 10001 оставшийся файл', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'large-checkpoint-'));
    const exportDir = path.join(root, 'export');
    await fs.mkdir(exportDir);
    await fs.writeFile(path.join(exportDir, 'before'), 'export const value = 0;\n');
    await fs.writeFile(path.join(exportDir, 'after'), 'export const value = 1;\n');
    const paths = Array.from({ length: 10_002 }, (_, index) => `src/large/module/file-${String(index).padStart(5, '0')}-context.ts`);
    const pending = paths.slice(1);
    const manifest: CodeSnapshotInput = { format: 'code-snapshot/1', project: 'local-large-checkpoint',
        diffId: 'large-diff', baseCommit: 'base', headCommit: 'head', capturedAt: '2026-11-04T00:00:00.000Z', pr: null,
        files: paths.map((file) => ({ path: file, oldPath: null, changeType: 'modify', before: { file: 'before', kind: 'text' },
            after: { file: 'after', kind: 'text' }, patch: null, generated: false, hostFileUrl: null })), sources: [], activate: true };
    const manifestFile = path.join(exportDir, 'snapshot.json');
    await fs.writeFile(manifestFile, JSON.stringify(manifest));
    let server: Awaited<ReturnType<typeof startServer>> | null = null;
    try {
        server = await startServer({ prKey: manifest.project, sherpaDir: path.join(root, 'state'), longPollSeconds: 0.2 });
        const imported = await postJson(server.port, ARTIFACT_ENDPOINTS.snapshot, { manifest: manifestFile }, server.token);
        expect(imported.status).toBe(200);
        server.workerRegistry.register('large-worker', 'test');
        await server.route.warmup();
        const request = { protocolVersion: PROTOCOL_VERSION, cliVersion: '0.32.0', workerId: 'large-worker' };
        const first = workerNextResponseSchema.parse(await (await postJson(server.port, WORKER_ENDPOINTS.next, request, server.token)).json());
        if (first.kind !== 'task') throw new Error('Missing overview task');
        const overview = { contractVersion: 6, summary: 'Large change.', evidence: { sources: [], limitation: 'Synthetic import.' },
            flow: { status: 'not_applicable', reason: 'No process diagram applies.' },
            stops: [{ title: 'All changed files', paragraph: 'The files are pending explanation.',
                evidence: { sources: [], limitation: 'Synthetic import.' }, nodeIds: [], files: paths, relatedFiles: [] }] };
        const result = JSON.stringify({ contractVersion: 6, overview,
            files: [{ path: paths[0], explanation: 'Accepted explanation.' }] });
        expect(Buffer.byteLength(result)).toBeGreaterThan(256 * 1024);
        const complete = await postJson(server.port, WORKER_ENDPOINTS.complete, { ...request, taskId: first.task.id,
            grantToken: first.lease.grantToken, result }, server.token);
        expect(complete.status).toBe(200);
        expect(taskCompleteResponseSchema.parse(await complete.json()).kind).toBe('accepted');
        const state = uiReviewRouteResponseSchema.parse(await (await fetch(`http://127.0.0.1:${String(server.port)}${UI_ENDPOINTS.reviewRoute}`,
            { headers: { authorization: `Bearer ${server.token}` } })).json()).route;
        expect(state.phase).toBe('filling');
        expect(state.snapshot?.stops.flatMap((block) => block.guidedFiles ?? [])).toHaveLength(paths.length);
        expect(state.snapshot?.stops.flatMap((block) => block.guidedFiles ?? [])[0]?.explanation).toBe('Accepted explanation.');
        const original = await fetch(`http://127.0.0.1:${String(server.port)}${UI_ENDPOINTS.reviewFileContent}?diffId=large-diff&fileId=${encodeURIComponent(paths[0] ?? '')}`,
            { headers: { authorization: `Bearer ${server.token}` } });
        expect(original.status).toBe(200);
        expect(uiReviewFileContentResponseSchema.parse(await original.json()).content).toEqual({
            oldText: 'export const value = 0;\n', newText: 'export const value = 1;\n',
        });
        const next = workerNextResponseSchema.parse(await (await postJson(server.port, WORKER_ENDPOINTS.next, request, server.token)).json());
        if (next.kind !== 'task') throw new Error('Missing files task');
        const planFile = next.task.contextFiles.find((file) => file.endsWith('-plan.md'));
        if (planFile === undefined) throw new Error('Missing assignment plan');
        const plan = await fs.readFile(planFile, 'utf8');
        const assignment = JSON.parse(plan.split('## Current assignment\n\n')[1]?.split('\n\n## Relevant blocks')[0] ?? 'null') as { files: string[] } | null;
        expect(assignment?.files).toHaveLength(pending.length);
        expect(assignment?.files[0]).toBe(pending[0]);
        expect(assignment?.files.at(-1)).toBe(pending.at(-1));
    } finally {
        await server?.close();
        await fs.rm(root, { recursive: true, force: true });
    }
}, 60_000);

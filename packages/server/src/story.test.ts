import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { explanationText, UI_ENDPOINTS, UI_DEV_ENDPOINTS, uiReviewRouteResponseSchema } from '@sherpa/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { mediumDiff, mediumRawResults } from './route/fixture-support.js';
import { walkPatch } from './route/diff-index.js';
import { startServer } from './server.js';
import { databasePathFor } from './paths.js';
import type { SherpaServer } from './server.js';
import { validateStorySection } from './story.js';
import { get, postRaw, makeTempSherpaDir, removeTempSherpaDir } from './test-support.js';

function limited(quote: string) { return { claims: [{ quote, sources: [], limitation: 'Synthetic fixture for lifecycle checks; semantic quality is tested separately.' }] }; }

const outline = { contractVersion: 2, evidence: limited('Запись завершается до сброса кэша.'), summary: 'Запись завершается до сброса кэша.', stops: [
    { title: 'Порядок записи', intent: 'Объяснить изменение порядка операций.' },
    { title: 'Проверки', intent: 'Кратко объяснить проверяемый контракт.' },
] };
const body = { contractVersion: 2, stops: [
    { planIndex: 1, paragraph: 'Сначала сохраняется запись. После успешного завершения обновляется кэш.', evidence: limited('Сначала сохраняется запись.') },
    { planIndex: 2, paragraph: 'Тесты проверяют успешную запись и обработку ошибки.', evidence: limited('Тесты проверяют успешную запись и обработку ошибки.') },
] };

describe('короткий рассказ', () => {
    let dir: string;
    let servers: SherpaServer[];
    beforeEach(async () => { dir = await makeTempSherpaDir(); servers = []; });
    afterEach(async () => { for (const server of servers) await server.close(); await removeTempSherpaDir(dir); });
    async function start(presentation: 'story' | 'legacy' = 'story', prKey = 'fixture-medium') {
        const server = await startServer({ prKey, sherpaDir: dir, presentation });
        servers.push(server);
        server.workerRegistry.register('worker', 'codex', 'test');
        await server.route.warmup();
        return server;
    }
    async function read(server: SherpaServer) {
        const response = await get(server.port, UI_ENDPOINTS.reviewRoute, server.token);
        return uiReviewRouteResponseSchema.parse(await response.json()).route;
    }
    function next(server: SherpaServer) {
        const task = server.queue.next('worker');
        if (task === null) throw new Error('No task');
        return task.task;
    }
    function complete(server: SherpaServer, result: unknown) {
        const task = next(server);
        expect(server.queue.complete('worker', task.id, JSON.stringify(result)).kind).toBe('accepted');
        return task;
    }

    it('малый ПР получает введение и одну задачу на весь рассказ без обязательных якорей', async () => {
        const server = await start('story', 'fixture-small');
        complete(server, outline);
        const partial = await read(server);
        expect(partial.smallPr).toBe(false);
        expect(partial.snapshot?.presentation).toBe('story');
        expect(partial.snapshot?.summary).toBe(outline.summary);
        expect(partial.snapshot?.stops).toHaveLength(2);
        const tasks = server.queue.listTasks().filter((task) => task.type === 'route.section');
        expect(tasks).toHaveLength(1);
        expect(server.route.stopsOfTask(tasks[0]?.id ?? 0)).toEqual([1, 2]);
        const payload = tasks[0]?.contextFiles.map((file) => fs.readFileSync(file, 'utf8')).join('\n');
        expect(payload).toContain(outline.summary);
        complete(server, body);
        const ready = await read(server);
        expect(ready.phase).toBe('ready');
        expect(ready.snapshot?.stops.every((stop) => stop.status === 'ready')).toBe(true);
    });

    it('пропущенный раздел отклоняется; провал тела не превращается в готовый рассказ', async () => {
        const server = await start();
        complete(server, outline);
        const task = next(server);
        expect(server.queue.complete('worker', task.id, JSON.stringify({ stops: [body.stops[0]] })).kind).toBe('rejected');
        server.queue.fail('worker', task.id, 'failed');
        const state = await read(server);
        expect(state.phase).toBe('failed');
        expect(state.snapshot?.summary).toBe(outline.summary);
        expect(state.failure).not.toBeNull();
    });

    it('незавершённый рассказ восстанавливается после рестарта, без повторной постановки плана', async () => {
        const server = await start();
        complete(server, outline);
        const leased = next(server);
        await server.close();
        const restarted = await start();
        expect(next(restarted).id).toBe(leased.id);
        expect(restarted.queue.complete('worker', leased.id, JSON.stringify(body)).kind).toBe('accepted');
        expect((await read(restarted)).phase).toBe('ready');
    });

    it('переход сохраняет старый snapshot, отзывает legacy-работу и не повторяет миграцию после рестарта', async () => {
        const legacy = await start('legacy');
        complete(legacy, mediumRawResults().skeleton);
        const oldId = (await read(legacy)).snapshot?.snapshotId;
        const leased = next(legacy);
        const feedback = legacy.queue.enqueue({ type: 'review.feedback', priority: 'interactive', instructions: 'legacy', contextFiles: [] });
        await legacy.close();
        const server = await start();
        expect(server.queue.getTask(leased.id)?.status).toBe('cancelled');
        expect(server.queue.getTask(feedback.id)?.status).toBe('cancelled');
        const response = await get(server.port, `${UI_ENDPOINTS.reviewRoute}?snapshot=${String(oldId)}`, server.token);
        expect(uiReviewRouteResponseSchema.parse(await response.json()).route.snapshot?.snapshotId).toBe(oldId);
        complete(server, outline);
        await server.close();
        const restarted = await start();
        complete(restarted, body);
        expect((await read(restarted)).phase).toBe('ready');
    });

    it('чат и retry сохраняют показанное введение, даже после достройки рассказа', async () => {
        const server = await start();
        complete(server, outline);
        const snapshot = (await read(server)).snapshot;
        if (snapshot === null) throw new Error('Missing snapshot');
        const explanation = { snapshotId: snapshot.snapshotId, diffId: snapshot.diffId, commit: snapshot.commit,
            text: explanationText(snapshot) };
        const question = await server.chat.ask('Почему выбран такой порядок?', null, 'ru', explanation);
        const chatTask = next(server);
        expect(chatTask.type).toBe('chat');
        server.queue.fail('worker', chatTask.id, 'temporary failure');
        complete(server, body);
        expect(await server.chat.retry(question.id)).toBe('retried');
        const retry = next(server);
        const context = retry.contextFiles.find((file) => file.endsWith('route-context.md'));
        expect(context).toBeDefined();
        const text = fs.readFileSync(context ?? '', 'utf8');
        expect(text).toContain(outline.summary);
        expect(text).not.toContain(body.stops[0]?.paragraph);
        expect(text).toContain(snapshot.commit);
    });

    it('отклоняет подменённый рассказ и якорь другой версии', async () => {
        const server = await start();
        complete(server, outline);
        const snapshot = (await read(server)).snapshot;
        if (snapshot === null) throw new Error('Missing snapshot');
        const explanation = { snapshotId: snapshot.snapshotId, diffId: snapshot.diffId, commit: snapshot.commit, text: 'invented' };
        await expect(server.chat.ask('Why?', null, 'en', explanation)).rejects.toThrow();
        expect(server.queue.listTasks().filter((task) => task.type === 'chat')).toHaveLength(0);
    });

    it('вопрос по строкам получает основания всего текста и код другого файла; retry не читает новый рассказ', async () => {
        const server = await start();
        const files = mediumDiff().files.filter((file) => file.patch !== null && [...walkPatch(file.patch)].some((line) => line.new !== null));
        const sources = files.slice(0, 2).map((file) => ({ kind: 'lines' as const, path: file.path, side: 'new' as const,
            start: [...walkPatch(file.patch ?? '')].find((line) => line.new !== null)?.new ?? 1,
            end: [...walkPatch(file.patch ?? '')].find((line) => line.new !== null)?.new ?? 1 }));
        const first = sources[0]; const other = files[1];
        if (first === undefined || other === undefined) throw new Error('No sources');
        complete(server, { ...outline, evidence: { claims: [{ quote: outline.summary, sources, limitation: null }] } });
        complete(server, { ...body, stops: body.stops.map((stop) => ({ ...stop,
            evidence: { claims: [{ quote: stop.paragraph, sources, limitation: null }] } })) });
        const snapshot = (await read(server)).snapshot;
        if (snapshot === null) throw new Error('No snapshot');
        const question = await server.chat.ask('Как связаны эти файлы?', { ...first, fileId: files[0]?.fileId ?? '', diffId: snapshot.diffId }, 'ru', {
            snapshotId: snapshot.snapshotId, diffId: snapshot.diffId, commit: snapshot.commit,
            sectionId: snapshot.stops[0]?.id ?? '', text: explanationText(snapshot, snapshot.stops[0]?.id),
        });
        expect(question.explanation?.evidence?.sections).toHaveLength(2);
        const chat = next(server);
        const evidenceFile = chat.contextFiles.find((file) => file.endsWith('story-evidence.md'));
        const context = fs.readFileSync(evidenceFile ?? '', 'utf8');
        expect(context).toContain(other.path);
        const actual = [...walkPatch(other.patch ?? '')].find((line) => line.new !== null)?.raw.slice(1);
        expect(context).toContain(actual);
        server.queue.fail('worker', chat.id, 'temporary');
        await server.route.generate();
        complete(server, outline); complete(server, body);
        expect((await postRaw(server.port, UI_DEV_ENDPOINTS.fixtureAdvanceIteration, '{}', server.token)).status).toBe(200);
        expect(await server.chat.retry(question.id)).toBe('retried');
        const retry = next(server);
        expect(fs.readFileSync(retry.contextFiles.find((file) => file.endsWith('story-evidence.md')) ?? '', 'utf8')).toBe(context);
    });

    it('останавливает незавершённый v1 при обновлении и сохраняет показанное введение', async () => {
        const server = await start();
        complete(server, outline);
        const leased = next(server);
        await server.close();
        const db = new DatabaseSync(databasePathFor(dir, 'fixture-medium'));
        db.prepare("DELETE FROM meta WHERE key='generation_story_contract_version'").run();
        db.close();
        const restarted = await start();
        expect(restarted.queue.getTask(leased.id)?.status).toBe('cancelled');
        expect((await read(restarted)).phase).toBe('failed');
        expect((await read(restarted)).snapshot?.summary).toBe(outline.summary);
        expect(restarted.queue.listTasks().filter((task) => task.status === 'queued')).toHaveLength(0);
    });
});

it('ссылки рассказа допускают повторение и неизменённый контекст, но отвергают отсутствующие строки', () => {
    const diff = mediumDiff();
    const file = diff.files.find((entry) => entry.patch !== null && [...walkPatch(entry.patch)].some((line) => !line.changed && line.new !== null));
    if (file?.patch == null) throw new Error('No context in fixture');
    const line = [...walkPatch(file.patch)].find((entry) => !entry.changed && entry.new !== null)?.new;
    if (line == null) throw new Error('No context line');
    const anchor = { kind: 'lines' as const, path: file.path, side: 'new' as const, start: line, end: line };
    const valid = { contractVersion: 2, stops: body.stops.map((stop) => ({ ...stop, evidence: { claims: [{ quote: stop.paragraph, sources: [anchor], limitation: null }] } })) };
    expect(validateStorySection(JSON.stringify(valid), [1, 2], diff, 'ru').ok).toBe(true);
    valid.stops[0]?.evidence.claims[0]?.sources.push({ ...anchor, start: 999999, end: 999999 });
    expect(validateStorySection(JSON.stringify(valid), [1, 2], diff, 'ru').ok).toBe(false);
});

it('отклоняет длинные примеры кода, чтобы рассказ оставался коротким', () => {
    const diff = mediumDiff();
    const anchor = mediumRawResults().sections[0]?.stops[0]?.anchors[0];
    if (anchor === undefined) throw new Error('No code fixture');
    const example = { kind: 'lines', ...anchor, end: anchor.start + 20 };
    const long = { contractVersion: 2, stops: [{ ...body.stops[0], evidence: { claims: [{ quote: body.stops[0]?.paragraph, sources: [example], limitation: null }] } }] };
    expect(validateStorySection(JSON.stringify(long), [1], diff, 'ru').ok).toBe(false);
    example.end = anchor.start + 8;
    expect(validateStorySection(JSON.stringify(long), [1], diff, 'ru').ok).toBe(true);
});

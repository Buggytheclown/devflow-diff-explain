import { makeFixtureHost, readableStoryFixture } from '@sherpa/fixtures';
import { UI_ENDPOINTS } from '@sherpa/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startServer } from './server.js';
import type { SherpaServer } from './server.js';
import { get, postJson, makeTempSherpaDir, removeTempSherpaDir } from './test-support.js';

/** Проверка состава работающего сервера, а не только отсутствия кнопок в UI. */
describe('сервер объяснения подключает только нужные возможности', () => {
    let dir: string; let server: SherpaServer;
    const host = makeFixtureHost('medium');
    const watch = vi.spyOn(host, 'watchThreads');
    const threads = vi.spyOn(host, 'getThreads');
    const updateFetch = vi.fn<typeof fetch>();
    beforeEach(async () => {
        vi.clearAllMocks(); dir = await makeTempSherpaDir();
        server = await startServer({ prKey: 'fixture-medium', sherpaDir: dir, presentation: 'story', reviewHostFactory: () => ({ name: 'fixture', host }), updateCheck: { fetch: updateFetch } });
    });
    afterEach(async () => { await server.close(); await removeTempSherpaDir(dir); });
    it('SSE не запускает треды, ручки публикации/прогресса/фидбека отсутствуют, чтение доступно', async () => {
        const abort = new AbortController();
        const response = await fetch(`http://127.0.0.1:${String(server.port)}${UI_ENDPOINTS.events}?token=${server.token}`, { signal: abort.signal });
        await response.body?.getReader().read(); abort.abort();
        expect(watch).not.toHaveBeenCalled(); expect(threads).not.toHaveBeenCalled();
        for (const endpoint of [UI_ENDPOINTS.reviewPublish, UI_ENDPOINTS.reviewSaveDraft, UI_ENDPOINTS.reviewThreadResolved, UI_ENDPOINTS.reviewFileViewed]) {
            expect((await postJson(server.port, endpoint, {}, server.token)).status).toBe(404);
        }
        expect((await get(server.port, UI_ENDPOINTS.reviewThreads, server.token)).status).toBe(404);
        expect((await get(server.port, UI_ENDPOINTS.reviewProgress, server.token)).status).toBe(404);
        expect((await get(server.port, UI_ENDPOINTS.reviewDiff, server.token)).status).toBe(200);
        await postJson(server.port, UI_ENDPOINTS.updateCheck, {}, server.token);
        expect(updateFetch).not.toHaveBeenCalled();
    });
    it('ответ по строкам сохраняется в exchange без второй скрытой заметки', async () => {
        server.workerRegistry.register('test', 'codex', 'test');
        await server.route.warmup();
        const fixture = readableStoryFixture();
        let next = server.queue.next('test'); if (next === null) throw new Error('No plan');
        expect(server.queue.complete('test', next.task.id, JSON.stringify(fixture.outline)).kind).toBe('accepted');
        next = server.queue.next('test'); if (next === null) throw new Error('No body');
        expect(server.queue.complete('test', next.task.id, JSON.stringify(fixture.body)).kind).toBe('accepted');
        for (const pending of server.queue.listTasks()) if (pending.type === 'route.diagram') server.queue.cancel(pending.id);
        await server.chat.ask('Что изменилось в этой строке?', { ...fixture.anchor, fileId: fixture.first.fileId, diffId: fixture.diff.diffId, selectedText: 'saved' }, 'ru');
        const question = server.queue.next('test'); if (question === null) throw new Error('No question');
        expect(server.queue.complete('test', question.task.id, 'Правило определяет дальнейшее действие.').kind).toBe('accepted');
        const response = await get(server.port, UI_ENDPOINTS.reviewChat, server.token);
        const body = await response.json() as { exchanges: {answer:string}[]; notes:unknown[] };
        expect(body.exchanges.at(-1)?.answer).toBe('Правило определяет дальнейшее действие.'); expect(body.notes).toEqual([]);
    });
});

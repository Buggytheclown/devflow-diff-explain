import type { UiTask, WorkerStatus } from '@sherpa/protocol';
import { describe, expect, it } from 'vitest';

import { agentPillView } from './agent-pill-view.js';
import { createT } from '../i18n/index.js';

const t = createT('ru');

const CONNECTED: WorkerStatus = {
    kind: 'connected',
    workerId: 'w-1',
    harness: 'claude-code',
    model: 'opus-5',
    registeredAt: '2026-08-21T10:30:00.000Z',
    lastSeenAt: '2026-08-21T11:59:00.000Z',
};

function task(overrides: Partial<UiTask> & Pick<UiTask, 'id' | 'status'>): UiTask {
    return {
        type: 'echo',
        priority: 'interactive',
        heldByWorker: overrides.status === 'leased',
        attempt: 1,
        instructions: 'echo',
        progressText: null,
        result: null,
        failReason: null,
        createdAt: '2026-08-21T11:00:00.000Z',
        updatedAt: '2026-08-21T11:00:00.000Z',
        ...overrides,
    };
}

describe('индикатор агента', () => {
    it('подключён и без работы — харнес в подписи', () => {
        const view = agentPillView(CONNECTED, [], t);

        expect(view.tone).toBe('connected');
        expect(view.label).toBe('Агент · claude-code');
    });

    it('без харнеса подпись держится на id воркера', () => {
        const view = agentPillView({ ...CONNECTED, harness: undefined }, [], t);

        expect(view.label).toBe('Агент · w-1');
    });

    it('интерактивная задача в очереди — состояние «работает» со счётчиком очереди', () => {
        const view = agentPillView(
            CONNECTED,
            [
                task({ id: 1, status: 'leased' }),
                task({ id: 2, status: 'queued' }),
                task({ id: 3, status: 'done' }),
            ], t);

        expect(view.tone).toBe('working');
        expect(view.label).toBe('Агент работает · 2 в очереди');
    });

    it('фоновая задача генерации маршрута тоже делает агента работающим', () => {
        const view = agentPillView(CONNECTED, [
            task({ id: 1, status: 'leased', type: 'route.skeleton', priority: 'background' }),
        ], t);

        expect(view.tone).toBe('working');
        expect(view.label).toBe('Агент работает · 1 в очереди');
    });

    it('chat-задачи входят в общий счётчик работы и очереди', () => {
        const view = agentPillView(CONNECTED, [
            task({ id: 1, status: 'leased', type: 'chat' }),
            task({ id: 2, status: 'queued', type: 'chat' }),
        ], t);

        expect(view.label).toBe('Агент работает · 2 в очереди');
    });

    it('отменённая задача считается работой, пока её держит воркер', () => {
        const held = task({ id: 1, status: 'cancelled', type: 'chat', heldByWorker: true });

        expect(agentPillView(CONNECTED, [held], t)).toMatchObject({
            tone: 'working',
            label: 'Агент работает · 1 в очереди',
        });
        // Воркер отозвался — держание снято, работы больше нет.
        expect(agentPillView(CONNECTED, [{ ...held, heldByWorker: false }], t).tone).toBe('connected');
    });

    it('последняя задача упала — красное состояние', () => {
        const view = agentPillView(
            CONNECTED,
            [
                task({ id: 1, status: 'done', updatedAt: '2026-08-21T11:00:00.000Z' }),
                task({ id: 2, status: 'failed', updatedAt: '2026-08-21T11:30:00.000Z' }),
            ], t);

        expect(view.tone).toBe('failed');
        expect(view.label).toBe('Агент · задача упала');
    });

    it('успех новее провала — состояние сбрасывается', () => {
        const view = agentPillView(
            CONNECTED,
            [
                task({ id: 1, status: 'failed', updatedAt: '2026-08-21T11:00:00.000Z' }),
                task({ id: 2, status: 'done', updatedAt: '2026-08-21T11:30:00.000Z' }),
            ], t);

        expect(view.tone).toBe('connected');
    });

    it('отключённый воркер старше и упавшей задачи, и очереди', () => {
        const view = agentPillView(
            { ...CONNECTED, kind: 'disconnected' },
            [task({ id: 1, status: 'queued' }), task({ id: 2, status: 'failed' })], t);

        expect(view.tone).toBe('disconnected');
        expect(view.label).toBe('Агент отключён');
        expect(view.title).toContain('в очереди: 1');
    });

    it('воркер ни разу не подключался — то же состояние, но тултип не врёт про сессию', () => {
        const view = agentPillView({ kind: 'never' }, [], t);

        expect(view.tone).toBe('disconnected');
        expect(view.title).toBe('Агент ещё ни разу не подключался к этому PR');
    });

    it('тултип несёт харнес, модель, id сессии, время её жизни и длину очереди', () => {
        const view = agentPillView(CONNECTED, [task({ id: 1, status: 'queued' })], t);

        expect(view.title).toBe('claude-code · opus-5 · w-1 · сессия живёт 1 ч 29 мин · в очереди: 1');
    });
});

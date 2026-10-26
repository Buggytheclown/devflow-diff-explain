import type { WorkerStatus } from '@sherpa/protocol';
import { WORKER_DEAD_AFTER_SECONDS } from '@sherpa/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { SherpaDatabase } from './db.js';
import { openDatabase } from './db.js';
import { RpcFailure } from './errors.js';
import { makeTempSherpaDir, removeTempSherpaDir } from './test-support.js';
import { WORKER_GAP_GRACE_SECONDS, WorkerRegistry } from './worker-registry.js';

const START = new Date('2026-08-19T12:00:00.000Z');

describe('жизненный цикл воркера', () => {
    let sherpaDir: string;
    let db: SherpaDatabase;
    let offsetMs: number;
    /** С какого момента реального времени часы теста идут сами: null — часы стоят. */
    let runningSince: number | null;
    let registry: WorkerRegistry;
    let events: WorkerStatus[];
    /** До какого момента у воркера аренда — то же, что очередь отдаёт регистру read-only. */
    let leaseExpiries: Map<string, string>;

    beforeEach(async () => {
        sherpaDir = await makeTempSherpaDir();
        db = openDatabase(`${sherpaDir}/worker.db`);
        offsetMs = 0;
        runningSince = null;
        leaseExpiries = new Map();
        registry = createRegistry();
        events = [];
        registry.subscribe((status) => events.push(status));
    });

    afterEach(async () => {
        registry.close();
        db.close();
        await removeTempSherpaDir(sherpaDir);
    });

    function now(): Date {
        return new Date(START.getTime() + offsetMs + (runningSince === null ? 0 : Date.now() - runningSince));
    }

    function createRegistry(gapGraceSeconds?: number): WorkerRegistry {
        return new WorkerRegistry({
            db,
            now,
            leaseExpiryOf: (workerId) => leaseExpiries.get(workerId) ?? null,
            ...(gapGraceSeconds === undefined ? {} : { gapGraceSeconds }),
        });
    }

    /** Воркер взял задачу: аренда кончится через `seconds` и сама не продлевается. */
    function leaseFor(workerId: string, seconds: number): void {
        leaseExpiries.set(workerId, new Date(now().getTime() + seconds * 1000).toISOString());
    }

    function advanceSeconds(seconds: number): void {
        offsetMs += seconds * 1000;
    }

    /** Пускает часы теста вровень с реальными: только так проверяется сам таймер смерти. */
    function startClock(): void {
        runningSince = Date.now();
    }

    function failureOf(run: () => unknown): RpcFailure {
        try {
            run();
        } catch (error) {
            if (error instanceof RpcFailure) {
                return error;
            }
            throw error;
        }
        throw new Error('ожидалась ошибка RpcFailure, но вызов прошёл успешно');
    }

    describe('регистрация', () => {
        it('до первой сессии статус — never', () => {
            expect(registry.status()).toEqual({ kind: 'never' });
            expect(events).toEqual([]);
        });

        it('register на пустом слоте занимает его и объявляет о подключении', () => {
            registry.register('w-1', 'claude-code');

            expect(registry.status()).toMatchObject({
                kind: 'connected',
                workerId: 'w-1',
                harness: 'claude-code',
                registeredAt: START.toISOString(),
            });
            expect(events).toHaveLength(1);
            expect(events[0]?.kind).toBe('connected');
        });

        it('повторный register той же сессии — продление, а не новая регистрация', () => {
            registry.register('w-1', 'claude-code', 'claude-opus-5');
            advanceSeconds(60);
            registry.register('w-1');

            const status = registry.status();
            expect(status).toMatchObject({
                kind: 'connected',
                workerId: 'w-1',
                // Харнес и модель прошлой регистрации не теряются, время начала сессии не сдвигается.
                harness: 'claude-code',
                model: 'claude-opus-5',
                registeredAt: START.toISOString(),
            });
            expect(status.kind === 'connected' && status.lastSeenAt).toBe(
                new Date(START.getTime() + 60_000).toISOString(),
            );
            expect(events).toHaveLength(1);
        });

        it('модель объявляется вместе с харнесом и обновляется продлением', () => {
            registry.register('w-1', 'claude-code');
            expect(registry.status()).not.toHaveProperty('model');

            registry.register('w-1', 'claude-code', 'claude-opus-5');
            expect(registry.status()).toMatchObject({ harness: 'claude-code', model: 'claude-opus-5' });

            registry.register('w-1', 'claude-code', 'claude-sonnet-5');
            expect(registry.status()).toMatchObject({ model: 'claude-sonnet-5' });
        });

        it('язык сессии живёт по тем же правилам, что харнес и модель', () => {
            registry.register('w-1', 'claude-code', 'claude-opus-5');
            expect(registry.status()).not.toHaveProperty('lang');

            registry.register('w-1', undefined, undefined, 'ru');
            expect(registry.status()).toMatchObject({ lang: 'ru' });

            // Продление без метки её не стирает.
            registry.register('w-1');
            expect(registry.status()).toMatchObject({ lang: 'ru' });

            // Новая сессия объявляет свой язык сама.
            registry.register('w-2', 'codex', undefined, 'en');
            expect(registry.status()).toMatchObject({ workerId: 'w-2', lang: 'en' });

            // ...и не наследует язык вытесненной, если молчит о нём.
            registry.register('w-3');
            expect(registry.status()).not.toHaveProperty('lang');
        });

        it('смена языка сессии — событие статуса: UI перерисовывается', () => {
            registry.register('w-1', 'claude-code', 'claude-opus-5', 'ru');
            expect(events).toHaveLength(1);

            registry.register('w-1', 'claude-code', 'claude-opus-5', 'en');

            expect(events).toHaveLength(2);
            expect(events[1]).toMatchObject({ workerId: 'w-1', lang: 'en' });
        });

        it('свежая регистрация перехватывает слот у живой сессии, вытесненный workerId возвращается наружу', () => {
            registry.register('w-1', 'claude-code');
            advanceSeconds(1);

            // Прежняя сессия ещё жива — и всё равно уступает: новая сессия всегда права.
            expect(registry.register('w-2', 'codex')).toBe('w-1');

            expect(registry.status()).toMatchObject({
                kind: 'connected',
                workerId: 'w-2',
                harness: 'codex',
                registeredAt: new Date(START.getTime() + 1000).toISOString(),
            });
            expect(events.map((event) => event.kind)).toEqual(['connected', 'connected']);
        });

        it('соединения вытесненной сессии на срок жизни нового владельца не влияют', () => {
            registry.register('w-1');
            // Прежняя сессия висит в long-poll: её соединение открыто в момент перехвата.
            const closeOld = registry.holdConnection('w-1');

            expect(registry.register('w-2')).toBe('w-1');
            // ...и закрывается уже после него.
            closeOld();

            advanceSeconds(WORKER_GAP_GRACE_SECONDS - 1);
            expect(registry.status()).toMatchObject({ kind: 'connected', workerId: 'w-2' });
            advanceSeconds(2);
            expect(registry.status().kind).toBe('disconnected');
        });

        it('после смерти прежней сессии слот занимает новая, вытесненный workerId возвращается наружу', () => {
            expect(registry.register('w-1', 'claude-code')).toBeNull();
            advanceSeconds(WORKER_DEAD_AFTER_SECONDS + 1);

            // По вытесненному id вызывающий возвращает аренды мёртвой сессии в очередь.
            expect(registry.register('w-2', 'codex')).toBe('w-1');

            expect(registry.status()).toMatchObject({
                kind: 'connected',
                workerId: 'w-2',
                harness: 'codex',
                registeredAt: new Date(START.getTime() + (WORKER_DEAD_AFTER_SECONDS + 1) * 1000).toISOString(),
            });
            expect(events.map((event) => event.kind)).toEqual(['connected', 'connected']);
        });
    });

    describe('heartbeat', () => {
        it('вызовы продлевают жизнь, пауза дольше грейса убивает', () => {
            registry.register('w-1');

            // Сессия без открытого соединения и без аренды живёт только паузу между вызовами.
            advanceSeconds(WORKER_GAP_GRACE_SECONDS - 1);
            registry.touch('w-1');
            advanceSeconds(WORKER_GAP_GRACE_SECONDS - 1);
            expect(registry.status().kind).toBe('connected');

            advanceSeconds(2);
            expect(registry.status().kind).toBe('disconnected');
        });

        it('сессия без register занимает свободный слот сама', () => {
            expect(registry.touch('w-1')).toBeNull();

            expect(registry.status()).toMatchObject({ kind: 'connected', workerId: 'w-1' });
            expect(events.map((event) => event.kind)).toEqual(['connected']);
        });

        it('heartbeat, перехвативший слот у мёртвой сессии, возвращает её workerId', () => {
            registry.register('w-1', 'claude-code', 'claude-opus-5', 'ru');
            advanceSeconds(WORKER_DEAD_AFTER_SECONDS + 1);

            expect(registry.touch('w-2')).toBe('w-1');
            const status = registry.status();
            expect(status).toMatchObject({ kind: 'connected', workerId: 'w-2' });
            // Метки прежней сессии к новой отношения не имеют.
            expect(status).not.toHaveProperty('harness');
            expect(status).not.toHaveProperty('model');
            expect(status).not.toHaveProperty('lang');
        });

        it('heartbeat чужого воркера при живом владельце — worker_conflict', () => {
            registry.register('w-1');

            const failure = failureOf(() => {
                registry.touch('w-2');
            });
            expect(failure.code).toBe('worker_conflict');
            expect(registry.status()).toMatchObject({ kind: 'connected', workerId: 'w-1' });
        });

        it('heartbeat не порождает поток событий', () => {
            registry.register('w-1');
            advanceSeconds(10);
            registry.touch('w-1');
            advanceSeconds(10);
            registry.touch('w-1');

            expect(events).toHaveLength(1);
        });
    });

    describe('владение слотом', () => {
        it('владелец и пустой слот проходят, чужой живой — нет', () => {
            expect(() => {
                registry.assertOwner('w-1');
            }).not.toThrow();

            registry.register('w-1');
            expect(() => {
                registry.assertOwner('w-1');
            }).not.toThrow();
            const failure = failureOf(() => {
                registry.assertOwner('w-2');
            });
            expect(failure.code).toBe('worker_conflict');
        });

        it('мёртвый владелец не мешает', () => {
            registry.register('w-1');
            advanceSeconds(WORKER_DEAD_AFTER_SECONDS + 1);

            expect(() => {
                registry.assertOwner('w-2');
            }).not.toThrow();
        });
    });

    describe('живость по соединению', () => {
        it('открытое воркерское соединение держит сессию живой сколь угодно долго', () => {
            registry.register('w-1');
            registry.holdConnection('w-1');

            advanceSeconds(WORKER_DEAD_AFTER_SECONDS * 10);

            expect(registry.status().kind).toBe('connected');
            expect(events.map((event) => event.kind)).toEqual(['connected']);
        });

        it('обрыв соединения без аренды убивает сессию за грейс', () => {
            registry.register('w-1');
            const close = registry.holdConnection('w-1');
            advanceSeconds(600);

            close();
            advanceSeconds(WORKER_GAP_GRACE_SECONDS - 1);
            // Отсчёт идёт от закрытия соединения, а не от последнего вызова: между ними были минуты.
            expect(registry.status().kind).toBe('connected');

            advanceSeconds(2);
            expect(registry.status().kind).toBe('disconnected');
        });

        it('обрыв соединения с арендой оставляет сессию живой до общего срока смерти', () => {
            registry.register('w-1');
            // Аренда длиннее срока молчания: раньше кончится он.
            leaseFor('w-1', WORKER_DEAD_AFTER_SECONDS * 2);
            registry.holdConnection('w-1')();

            advanceSeconds(WORKER_DEAD_AFTER_SECONDS - 1);
            expect(registry.status().kind).toBe('connected');

            advanceSeconds(2);
            expect(registry.status().kind).toBe('disconnected');
        });

        it('протухшая аренда сессию не держит: работа кончается вместе с арендой', () => {
            registry.register('w-1');
            // Аренда кончится раньше срока молчания — дальше действует только грейс паузы,
            // а он к этому моменту давно вышел.
            leaseFor('w-1', WORKER_DEAD_AFTER_SECONDS / 2);
            registry.holdConnection('w-1')();

            advanceSeconds(WORKER_DEAD_AFTER_SECONDS / 2 - 1);
            expect(registry.status().kind).toBe('connected');

            advanceSeconds(2);
            expect(registry.status().kind).toBe('disconnected');
        });

        it('новое соединение отменяет отсчёт грейса', () => {
            registry.register('w-1');
            registry.holdConnection('w-1')();
            advanceSeconds(WORKER_GAP_GRACE_SECONDS - 1);

            registry.holdConnection('w-1');
            advanceSeconds(WORKER_GAP_GRACE_SECONDS * 10);

            expect(registry.status().kind).toBe('connected');
            expect(events.map((event) => event.kind)).toEqual(['connected']);
        });

        it('соединение чужого воркера владельца слота живым не делает', () => {
            registry.register('w-1');
            registry.holdConnection('w-2');

            advanceSeconds(WORKER_GAP_GRACE_SECONDS + 1);

            expect(registry.status()).toMatchObject({ kind: 'disconnected', workerId: 'w-1' });
        });

        it('отключение по обрыву объявляется таймером, без входящих запросов', async () => {
            registry.close();
            registry = createRegistry(0.15);
            events = [];
            registry.subscribe((status) => events.push(status));

            startClock();
            registry.register('w-1');
            const close = registry.holdConnection('w-1');
            await new Promise((resolve) => setTimeout(resolve, 200));
            expect(events.map((event) => event.kind)).toEqual(['connected']);

            close();
            await new Promise((resolve) => setTimeout(resolve, 300));

            expect(events.map((event) => event.kind)).toEqual(['connected', 'disconnected']);
        });

        it('таймер смерти взводится на конец аренды, а не на общий срок молчания', async () => {
            registry.close();
            registry = createRegistry(0.15);
            events = [];
            registry.subscribe((status) => events.push(status));

            startClock();
            registry.register('w-1');
            // `progress` двигает время последнего вызова, но не срок аренды, поэтому аренда способна
            // кончиться сильно раньше шести минут молчания — событие должно прийти вместе с ней.
            leaseFor('w-1', 0.2);
            registry.holdConnection('w-1')();

            await new Promise((resolve) => setTimeout(resolve, 400));

            expect(events.map((event) => event.kind)).toEqual(['connected', 'disconnected']);
        });
    });

    describe('события', () => {
        it('checkNow объявляет об отключении молчащей сессии', () => {
            registry.register('w-1', 'claude-code');
            advanceSeconds(WORKER_DEAD_AFTER_SECONDS + 1);

            registry.checkNow();
            registry.checkNow();

            expect(events.map((event) => event.kind)).toEqual(['connected', 'disconnected']);
            expect(events[1]).toMatchObject({ workerId: 'w-1', harness: 'claude-code' });
        });

        it('отключение объявляется таймером, без входящих запросов', async () => {
            registry.register('w-1');
            // Оставляем 80 мс до срока смерти и перевзводим таймер под сдвинутые часы,
            // которые с этого момента идут вровень с реальными.
            advanceSeconds(WORKER_GAP_GRACE_SECONDS - 0.08);
            startClock();
            registry.checkNow();
            expect(events.map((event) => event.kind)).toEqual(['connected']);

            await new Promise((resolve) => setTimeout(resolve, 300));

            expect(events.map((event) => event.kind)).toEqual(['connected', 'disconnected']);
        });

        it('отписка перестаёт получать события', () => {
            const seen: WorkerStatus[] = [];
            const unsubscribe = registry.subscribe((status) => seen.push(status));

            registry.register('w-1');
            unsubscribe();
            advanceSeconds(WORKER_DEAD_AFTER_SECONDS + 1);
            registry.checkNow();

            expect(seen.map((status) => status.kind)).toEqual(['connected']);
            expect(events.map((event) => event.kind)).toEqual(['connected', 'disconnected']);
        });
    });

    it('статус переживает перезапуск сервера: слот лежит в хранилище', () => {
        registry.register('w-1', 'claude-code', 'claude-opus-5');
        registry.close();

        const restarted = new WorkerRegistry({ db, now: () => new Date(START.getTime() + offsetMs) });
        try {
            expect(restarted.status()).toMatchObject({
                kind: 'connected',
                workerId: 'w-1',
                harness: 'claude-code',
                model: 'claude-opus-5',
            });
        } finally {
            restarted.close();
        }
    });
});

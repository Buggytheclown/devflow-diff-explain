import { setTimeout as delay } from 'node:timers/promises';

import { PROTOCOL_VERSION, UI_ENDPOINTS, WORKER_ENDPOINTS } from '@sherpa/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_IDLE_SECONDS, formatIdlePeriod, IdleWatch, readIdleSeconds } from './idle.js';
import { readManifest } from './manifest.js';
import { manifestPathFor } from './paths.js';
import type { SherpaServer } from './server.js';
import { startServer } from './server.js';
import { makeTempSherpaDir, postJson, removeTempSherpaDir } from './test-support.js';

const PR_KEY = 'arcanum-24680';

/** Порог живого сервера в интеграционных проверках: доли секунды вместо четверти часа. */
const SHORT_IDLE_SECONDS = 0.3;
/** Заведомо больше порога и нескольких тиков проверки. */
const OVER_IDLE_MS = 900;
const WAIT_TIMEOUT_MS = 5000;

/** Управляемые часы: тот же приём, что в тестах очереди и регистра воркера. */
function makeClock(): { now: () => Date; advance: (seconds: number) => void } {
    let current = Date.parse('2026-08-20T10:00:00.000Z');
    return {
        now: () => new Date(current),
        advance: (seconds) => {
            current += seconds * 1000;
        },
    };
}

describe('IdleWatch', () => {
    it('гасит сервер, когда порог простоя пройден', () => {
        const clock = makeClock();
        const watch = new IdleWatch({ idleSeconds: DEFAULT_IDLE_SECONDS, now: clock.now });
        const stop = vi.fn();
        watch.arm(stop);

        clock.advance(DEFAULT_IDLE_SECONDS - 1);
        watch.checkNow();
        expect(stop).not.toHaveBeenCalled();

        clock.advance(2);
        watch.checkNow();
        expect(stop).toHaveBeenCalledTimes(1);
    });

    it('останавливает ровно один раз', () => {
        const clock = makeClock();
        const watch = new IdleWatch({ idleSeconds: 60, now: clock.now });
        const stop = vi.fn();
        watch.arm(stop);

        clock.advance(600);
        watch.checkNow();
        watch.checkNow();
        expect(stop).toHaveBeenCalledTimes(1);
    });

    it('открытое соединение держит сервер живым сколько угодно долго', () => {
        const clock = makeClock();
        const watch = new IdleWatch({ idleSeconds: 60, now: clock.now });
        const stop = vi.fn();
        watch.arm(stop);

        const closed = watch.open();
        clock.advance(3600);
        watch.checkNow();
        expect(stop).not.toHaveBeenCalled();

        // Отсчёт начинается с закрытия соединения, а не с его открытия.
        closed();
        watch.checkNow();
        expect(stop).not.toHaveBeenCalled();

        clock.advance(61);
        watch.checkNow();
        expect(stop).toHaveBeenCalledTimes(1);
    });

    it('второе соединение держит сервер после закрытия первого', () => {
        const clock = makeClock();
        const watch = new IdleWatch({ idleSeconds: 60, now: clock.now });
        const stop = vi.fn();
        watch.arm(stop);

        const first = watch.open();
        const second = watch.open();
        first();
        first();

        clock.advance(600);
        watch.checkNow();
        expect(stop).not.toHaveBeenCalled();

        second();
        clock.advance(61);
        watch.checkNow();
        expect(stop).toHaveBeenCalledTimes(1);
    });

    it('входящий запрос сбрасывает отсчёт', () => {
        const clock = makeClock();
        const watch = new IdleWatch({ idleSeconds: 60, now: clock.now });
        const stop = vi.fn();
        watch.arm(stop);

        clock.advance(59);
        watch.open()();
        clock.advance(59);
        watch.checkNow();
        expect(stop).not.toHaveBeenCalled();

        clock.advance(2);
        watch.checkNow();
        expect(stop).toHaveBeenCalledTimes(1);
    });

    it('нулевой порог выключает самоостановку', () => {
        const clock = makeClock();
        const watch = new IdleWatch({ idleSeconds: 0, now: clock.now });
        const stop = vi.fn();
        watch.arm(stop);

        clock.advance(86_400);
        watch.checkNow();
        expect(watch.enabled).toBe(false);
        expect(stop).not.toHaveBeenCalled();
    });

    it('после close() не останавливает', () => {
        const clock = makeClock();
        const watch = new IdleWatch({ idleSeconds: 60, now: clock.now });
        const stop = vi.fn();
        watch.arm(stop);
        watch.close();

        clock.advance(600);
        watch.checkNow();
        expect(stop).not.toHaveBeenCalled();
    });
});

describe('readIdleSeconds', () => {
    it('без переменной — дефолтная четверть часа', () => {
        expect(readIdleSeconds({})).toBe(DEFAULT_IDLE_SECONDS);
        expect(DEFAULT_IDLE_SECONDS).toBe(900);
    });

    it('читает число из окружения', () => {
        expect(readIdleSeconds({ SHERPA_IDLE_SECONDS: '2' })).toBe(2);
        expect(readIdleSeconds({ SHERPA_IDLE_SECONDS: '0' })).toBe(0);
    });

    it('мусор, пустое значение и отрицательное число — дефолт', () => {
        for (const raw of ['', '   ', 'скоро', '-5', 'NaN']) {
            expect(readIdleSeconds({ SHERPA_IDLE_SECONDS: raw }), raw).toBe(DEFAULT_IDLE_SECONDS);
        }
    });
});

describe('formatIdlePeriod', () => {
    it('круглые значения — в минутах, остальные — в секундах', () => {
        expect(formatIdlePeriod(900)).toBe('15 мин');
        expect(formatIdlePeriod(60)).toBe('1 мин');
        expect(formatIdlePeriod(2)).toBe('2 с');
        expect(formatIdlePeriod(90)).toBe('90 с');
    });
});

describe('сервер по простою', () => {
    let sherpaDir: string;
    let servers: SherpaServer[];

    beforeEach(async () => {
        sherpaDir = await makeTempSherpaDir();
        servers = [];
    });

    afterEach(async () => {
        for (const server of servers) {
            await server.close();
        }
        await removeTempSherpaDir(sherpaDir);
    });

    async function start(longPollSeconds?: number): Promise<SherpaServer> {
        // Ревью-хост здесь не при делах, а живой Арканум в тестах запрещён (docs/testing.md).
        const base = {
            prKey: PR_KEY,
            sherpaDir,
            idleSeconds: SHORT_IDLE_SECONDS,
            reviewSourceFactory: () => null,
        };
        const server = await startServer(
            longPollSeconds === undefined ? base : { ...base, longPollSeconds },
        );
        servers.push(server);
        return server;
    }

    function manifestOfPr(): Promise<unknown> {
        return readManifest(manifestPathFor(sherpaDir, PR_KEY));
    }

    it('останавливается сам и убирает свой манифест', async () => {
        const server = await start();
        expect(await manifestOfPr()).not.toBeNull();

        await waitFor(async () => (await manifestOfPr()) === null);
        // Порт освобождён — сервер закрыт целиком, а не только снял манифест.
        await expect(fetch(`http://127.0.0.1:${String(server.port)}/healthz`)).rejects.toThrow();
    });

    it('открытый SSE-канал держит сервер живым', async () => {
        const server = await start();
        const abort = new AbortController();
        const events = await fetch(
            `http://127.0.0.1:${String(server.port)}${UI_ENDPOINTS.events}?token=${server.token}`,
            { signal: abort.signal },
        );
        expect(events.status).toBe(200);
        // Тело читаем в никуда: иначе обрыв по abort() всплывёт ошибкой непрочитанного стрима.
        void events.text().catch(() => undefined);

        await delay(OVER_IDLE_MS);
        expect(await manifestOfPr()).not.toBeNull();

        // Вкладку закрыли — отсчёт пошёл заново и сервер гаснет.
        abort.abort();
        await waitFor(async () => (await manifestOfPr()) === null);
    });

    it('висящий long-poll `worker next` держит сервер живым', async () => {
        const server = await start(1.5);
        const pending = postJson(
            server.port,
            WORKER_ENDPOINTS.next,
            { protocolVersion: PROTOCOL_VERSION, cliVersion: '0.0.0', workerId: 'сессия-в-петле' },
            server.token,
        );

        await delay(OVER_IDLE_MS);
        expect(await manifestOfPr()).not.toBeNull();

        const response = await pending;
        expect(response.status).toBe(200);
        await waitFor(async () => (await manifestOfPr()) === null);
    });

    it('запросы отодвигают остановку', async () => {
        const server = await start();

        for (let attempt = 0; attempt < 4; attempt += 1) {
            await delay(OVER_IDLE_MS / 4);
            const health = await fetch(`http://127.0.0.1:${String(server.port)}/healthz`, {
                headers: { authorization: `Bearer ${server.token}` },
            });
            expect(health.status, `запрос ${String(attempt)}`).toBe(200);
        }

        await waitFor(async () => (await manifestOfPr()) === null);
    });

    it('с нулевым порогом не гаснет', async () => {
        const server = await startServer({ prKey: PR_KEY, sherpaDir, idleSeconds: 0, reviewSourceFactory: () => null });
        servers.push(server);

        await delay(OVER_IDLE_MS);
        expect(await manifestOfPr()).not.toBeNull();
    });
});

async function waitFor(condition: () => Promise<boolean>): Promise<void> {
    const deadline = Date.now() + WAIT_TIMEOUT_MS;
    while (Date.now() < deadline) {
        if (await condition()) {
            return;
        }
        await delay(25);
    }
    throw new Error('условие не выполнилось за отведённое время');
}

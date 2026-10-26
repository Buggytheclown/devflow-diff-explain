import { makeFixtureHost } from '@sherpa/fixtures';
import type { PrMeta, ReviewHost } from '@sherpa/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PrMetaCache } from './pr-meta.js';

/**
 * Кеш меты PR: до первого успеха отдаёт null и повторяет загрузку, после успеха хост
 * не опрашивает. Мета берётся у фикстурного хоста — руками валидный `PrMeta` не собрать.
 */

const RETRY_MS = 10;

describe('кеш меты PR', () => {
    let base: PrMeta;

    beforeEach(async () => {
        base = await makeFixtureHost('medium').getPr();
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    function metaWith(title: string): PrMeta {
        return { ...base, title };
    }

    /** Хост с подменяемым `getPr`; вызовы считает сам мок. */
    function hostOf(getPr: () => Promise<PrMeta>): { host: ReviewHost; getPr: ReturnType<typeof vi.fn> } {
        const mock = vi.fn(getPr);
        return { host: { getPr: mock } as unknown as ReviewHost, getPr: mock };
    }

    it('до первого успеха отдаёт null и подписчиков не будит', async () => {
        const { host, getPr } = hostOf(() => Promise.reject(new Error('хост прилёг')));
        const cache = new PrMetaCache({ host, retryIntervalMs: RETRY_MS });
        const woken = vi.fn();
        cache.subscribe(woken);
        const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

        try {
            await cache.refresh();

            expect(cache.get()).toBeNull();
            expect(woken).not.toHaveBeenCalled();
            expect(getPr).toHaveBeenCalledTimes(1);
        } finally {
            stderr.mockRestore();
            cache.close();
        }
    });

    it('успех кладёт мету и будит подписчиков ровно раз', async () => {
        const { host } = hostOf(() => Promise.resolve(metaWith('первый заголовок')));
        const cache = new PrMetaCache({ host, retryIntervalMs: RETRY_MS });
        const woken = vi.fn();
        cache.subscribe(woken);

        try {
            await cache.refresh();

            expect(cache.get()?.title).toBe('первый заголовок');
            expect(woken).toHaveBeenCalledTimes(1);
        } finally {
            cache.close();
        }
    });

    it('провал первой загрузки повторяется по таймеру, после успеха хост не опрашивается', async () => {
        let attempt = 0;
        const { host, getPr } = hostOf(() => {
            attempt += 1;
            return attempt < 3 ? Promise.reject(new Error('таймаут')) : Promise.resolve(metaWith('доехало'));
        });
        const cache = new PrMetaCache({ host, retryIntervalMs: RETRY_MS });
        const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

        try {
            cache.start();
            await vi.advanceTimersByTimeAsync(0);
            expect(cache.get()).toBeNull();

            await vi.advanceTimersByTimeAsync(RETRY_MS);
            expect(cache.get()).toBeNull();
            expect(getPr).toHaveBeenCalledTimes(2);

            await vi.advanceTimersByTimeAsync(RETRY_MS);
            expect(cache.get()?.title).toBe('доехало');
            expect(getPr).toHaveBeenCalledTimes(3);

            // Ретрай снят: успешную мету сам кеш больше не перечитывает.
            await vi.advanceTimersByTimeAsync(RETRY_MS * 10);
            expect(getPr).toHaveBeenCalledTimes(3);
        } finally {
            stderr.mockRestore();
            cache.close();
        }
    });

    it('ответ не по контракту прежнюю мету не затирает и уходит в stderr', async () => {
        let broken = false;
        const { host } = hostOf(() =>
            broken
                ? Promise.resolve({ ...metaWith('битая'), state: 'нет такого состояния' } as unknown as PrMeta)
                : Promise.resolve(metaWith('живая')),
        );
        const cache = new PrMetaCache({ host, retryIntervalMs: RETRY_MS });
        const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

        try {
            await cache.refresh();
            broken = true;
            await cache.refresh();

            expect(cache.get()?.title).toBe('живая');
            expect(stderr.mock.calls.some((call) => String(call[0]).includes('мета PR не обновилась'))).toBe(
                true,
            );
        } finally {
            stderr.mockRestore();
            cache.close();
        }
    });

    it('поздний ответ старого refresh не перетирает свежий', async () => {
        const pending: { resolve: (meta: PrMeta) => void }[] = [];
        const { host } = hostOf(
            () =>
                new Promise<PrMeta>((resolve) => {
                    pending.push({ resolve });
                }),
        );
        const cache = new PrMetaCache({ host, retryIntervalMs: RETRY_MS });

        try {
            const first = cache.refresh();
            const second = cache.refresh();
            expect(pending).toHaveLength(2);

            // Второй запрос стартовал позже и ответил раньше — он и есть свежая мета.
            pending[1]?.resolve(metaWith('свежая'));
            await second;
            expect(cache.get()?.title).toBe('свежая');

            pending[0]?.resolve(metaWith('протухшая'));
            await first;
            expect(cache.get()?.title).toBe('свежая');
        } finally {
            cache.close();
        }
    });

    it('close отпускает подписчиков: ответ запроса in-flight их уже не будит', async () => {
        const pending: { resolve: (meta: PrMeta) => void }[] = [];
        const { host } = hostOf(
            () =>
                new Promise<PrMeta>((resolve) => {
                    pending.push({ resolve });
                }),
        );
        const cache = new PrMetaCache({ host, retryIntervalMs: RETRY_MS });
        const woken = vi.fn();
        cache.subscribe(woken);

        const inFlight = cache.refresh();
        cache.close();
        pending[0]?.resolve(metaWith('доехала после close'));
        await inFlight;

        // Мета в кеш ещё ложится (запрос стартовал до close), а звать по ней уже некого.
        expect(cache.get()?.title).toBe('доехала после close');
        expect(woken).not.toHaveBeenCalled();
    });

    it('close гасит ретрай, закрытый кеш к хосту не ходит', async () => {
        const { host, getPr } = hostOf(() => Promise.reject(new Error('хост прилёг')));
        const cache = new PrMetaCache({ host, retryIntervalMs: RETRY_MS });
        const woken = vi.fn();
        cache.subscribe(woken);
        const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

        try {
            cache.start();
            await vi.advanceTimersByTimeAsync(0);
            expect(getPr).toHaveBeenCalledTimes(1);

            cache.close();
            await vi.advanceTimersByTimeAsync(RETRY_MS * 10);

            expect(getPr).toHaveBeenCalledTimes(1);
            // Закрытый кеш к хосту не ходит и подписчиков не зовёт.
            cache.start();
            await cache.refresh();
            expect(getPr).toHaveBeenCalledTimes(1);
            expect(woken).not.toHaveBeenCalled();
        } finally {
            stderr.mockRestore();
        }
    });

    it('без хоста мета остаётся null, а start и refresh безвредны', async () => {
        const cache = new PrMetaCache({ host: null, retryIntervalMs: RETRY_MS });
        const woken = vi.fn();
        cache.subscribe(woken);

        cache.start();
        await cache.refresh();
        await vi.advanceTimersByTimeAsync(RETRY_MS * 10);

        expect(cache.get()).toBeNull();
        expect(woken).not.toHaveBeenCalled();
        cache.close();
    });

    it('отписавшийся слушатель больше не будится', async () => {
        const { host } = hostOf(() => Promise.resolve(metaWith('мета')));
        const cache = new PrMetaCache({ host, retryIntervalMs: RETRY_MS });
        const stays = vi.fn();
        const leaves = vi.fn();
        cache.subscribe(stays);
        const release = cache.subscribe(leaves);

        try {
            release();
            await cache.refresh();

            expect(stays).toHaveBeenCalledTimes(1);
            expect(leaves).not.toHaveBeenCalled();
        } finally {
            cache.close();
        }
    });
});

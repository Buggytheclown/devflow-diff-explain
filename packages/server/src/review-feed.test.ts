import type { ReviewHost, Thread } from '@sherpa/protocol';
import { describe, expect, it, vi } from 'vitest';

import { ReviewFeed } from './review-feed.js';

/**
 * Ленивая подписка на треды хоста и монотонная ревизия для SSE. Хост здесь фейковый: важно не
 * что он присылает, а когда фид на него подписывается и когда двигает ревизию.
 */

/** Тред-заглушка: фиду важна только сериализуемость снапшота. */
function threadsOf(...ids: string[]): Thread[] {
    return ids.map((id) => ({ id }) as unknown as Thread);
}

interface FakeHost {
    readonly host: ReviewHost;
    /** Прислать снапшот тредов так, как это сделал бы поллинг хоста. */
    readonly emit: (threads: Thread[]) => void;
    readonly watchThreads: ReturnType<typeof vi.fn>;
    readonly unwatch: ReturnType<typeof vi.fn>;
}

function fakeHost(): FakeHost {
    let callback: ((threads: Thread[]) => void) | null = null;
    const unwatch = vi.fn(() => {
        callback = null;
    });
    const watchThreads = vi.fn((onThreads: (threads: Thread[]) => void) => {
        callback = onThreads;
        return unwatch;
    });
    return {
        host: { watchThreads } as unknown as ReviewHost,
        emit: (threads) => {
            if (callback === null) {
                throw new Error('фид не подписан на хост — эмитить некому');
            }
            callback(threads);
        },
        watchThreads,
        unwatch,
    };
}

describe('фид ревью', () => {
    it('подписка на хост стартует с первым слушателем и снимается с последним', () => {
        const fake = fakeHost();
        const feed = new ReviewFeed(fake.host);

        expect(fake.watchThreads).not.toHaveBeenCalled();

        const release = feed.subscribe(() => undefined);
        expect(fake.watchThreads).toHaveBeenCalledTimes(1);
        expect(fake.unwatch).not.toHaveBeenCalled();

        release();
        expect(fake.unwatch).toHaveBeenCalledTimes(1);
    });

    it('два слушателя держат одну подписку хоста, повторная отписка чужую не снимает', () => {
        const fake = fakeHost();
        const feed = new ReviewFeed(fake.host);

        const first = feed.subscribe(() => undefined);
        const second = feed.subscribe(() => undefined);
        expect(fake.watchThreads).toHaveBeenCalledTimes(1);

        first();
        first();
        // Второй слушатель ещё висит — сколько бы раз ни отпустили первого, подписка держится.
        expect(fake.unwatch).not.toHaveBeenCalled();

        second();
        expect(fake.unwatch).toHaveBeenCalledTimes(1);
    });

    it('одинаковый снапшот ревизию не двигает, изменённый двигает', () => {
        const fake = fakeHost();
        const feed = new ReviewFeed(fake.host);
        const seen: number[] = [];
        feed.subscribe((revision) => seen.push(revision));

        fake.emit(threadsOf('t1'));
        expect(feed.revision).toBe(1);

        fake.emit(threadsOf('t1'));
        expect(feed.revision).toBe(1);

        fake.emit(threadsOf('t1', 't2'));
        expect(feed.revision).toBe(2);
        expect(seen).toEqual([1, 2]);
    });

    it('последний снапшот переживает паузу без слушателей', () => {
        const fake = fakeHost();
        const feed = new ReviewFeed(fake.host);

        const release = feed.subscribe(() => undefined);
        fake.emit(threadsOf('t1'));
        expect(feed.revision).toBe(1);
        release();

        feed.subscribe(() => undefined);
        // Тот же снапшот после реконнекта — не событие: иначе UI перечитывал бы ручку впустую.
        fake.emit(threadsOf('t1'));
        expect(feed.revision).toBe(1);

        fake.emit(threadsOf('t2'));
        expect(feed.revision).toBe(2);
    });

    it('несериализуемый снапшот считается изменением', () => {
        const fake = fakeHost();
        const feed = new ReviewFeed(fake.host);
        feed.subscribe(() => undefined);

        const circular: Record<string, unknown> = { id: 't1' };
        circular.self = circular;
        const threads = [circular] as unknown as Thread[];

        fake.emit(threads);
        expect(feed.revision).toBe(1);
        // Сравнить не с чем — каждый такой снапшот честнее считать новым.
        fake.emit(threads);
        expect(feed.revision).toBe(2);
    });

    it('bumpLocalWrite будит слушателей и растит ревизию', () => {
        const fake = fakeHost();
        const feed = new ReviewFeed(fake.host);
        const seen: number[] = [];
        feed.subscribe((revision) => seen.push(revision));

        expect(feed.bumpLocalWrite()).toBe(1);
        expect(feed.bumpLocalWrite()).toBe(2);
        expect(seen).toEqual([1, 2]);
        expect(feed.revision).toBe(2);
    });

    it('после close подписка — no-op, хост не перевзводится, ревизия стоит', () => {
        const fake = fakeHost();
        const feed = new ReviewFeed(fake.host);
        const seen: number[] = [];

        feed.subscribe((revision) => seen.push(revision));
        feed.bumpLocalWrite();
        feed.close();

        expect(fake.unwatch).toHaveBeenCalledTimes(1);

        const release = feed.subscribe((revision) => seen.push(revision));
        expect(fake.watchThreads).toHaveBeenCalledTimes(1);
        release();

        expect(feed.bumpLocalWrite()).toBe(1);
        expect(feed.revision).toBe(1);
        expect(seen).toEqual([1]);
    });

    it('подписка на статус живёт по той же лени и снимается вместе с тредами', () => {
        const fake = fakeHost();
        const unwatchStatus = vi.fn();
        const watchStatus = vi.fn((_onChange: () => void) => unwatchStatus);
        const onStatusChange = vi.fn();
        const feed = new ReviewFeed(fake.host, { watchStatus, onStatusChange });

        expect(watchStatus).not.toHaveBeenCalled();

        const release = feed.subscribe(() => undefined);
        expect(watchStatus).toHaveBeenCalledTimes(1);
        // Хосту прокидывается ровно тот обработчик, который дали фиду.
        expect(watchStatus.mock.calls[0]?.[0]).toBe(onStatusChange);
        // Пока слушатель есть, подписка на статус живая.
        expect(unwatchStatus).not.toHaveBeenCalled();

        release();
        expect(unwatchStatus).toHaveBeenCalledTimes(1);
    });

    it('без onStatusChange статус не слушается вовсе', () => {
        const fake = fakeHost();
        const watchStatus = vi.fn(() => () => undefined);
        const feed = new ReviewFeed(fake.host, { watchStatus });

        feed.subscribe(() => undefined);

        expect(fake.watchThreads).toHaveBeenCalledTimes(1);
        expect(watchStatus).not.toHaveBeenCalled();
    });

    it('без хоста подписка ничего не заводит, а локальный bump работает', () => {
        const watchStatus = vi.fn(() => () => undefined);
        const onStatusChange = vi.fn();
        const feed = new ReviewFeed(null, { watchStatus, onStatusChange });
        const seen: number[] = [];

        const release = feed.subscribe((revision) => seen.push(revision));
        expect(watchStatus).not.toHaveBeenCalled();

        expect(feed.bumpLocalWrite()).toBe(1);
        expect(seen).toEqual([1]);

        release();
        feed.close();
    });
});

import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { selectReviewSource } from './select.js';

/**
 * Выбор адаптера по префиксу ключа. Хосты тут только создаются: ни сети, ни диска
 * до первого вызова метода они не трогают.
 */

const SHERPA_DIR = path.join(os.tmpdir(), 'sherpa-select-test');

describe('выбор хост-адаптера', () => {
    it('рантайм объяснения получает только операции чтения с привязанным экземпляром', async () => {
        const source = selectReviewSource('fixture-medium');
        if (source === null) throw new Error('No fixture source');
        for (const method of ['publishBatch', 'saveDraft', 'getThreads', 'watchThreads', 'setFileViewed']) {
            expect(method in source.host).toBe(false);
        }
        const before = await source.host.getDiff();
        source.advanceIteration?.();
        expect((await source.host.getDiff()).diffId).not.toBe(before.diffId);
        expect((await source.host.listIterations()).find((iteration) => iteration.status === 'active')?.diffId).not.toBe(before.diffId);
    });

    it('кривой ключ GitHub хостом не становится', () => {
        for (const key of ['github-acme--sherpa', 'github-acme--sherpa--0', 'github---sherpa--1']) {
            expect(selectReviewSource(key, { sherpaDir: SHERPA_DIR }), key).toBeNull();
        }
    });

    it('чужие префиксы выбирают своих, неизвестный — ничей', () => {
        expect(selectReviewSource('arcanum-4242')?.name).toBe('arcanum');
        expect(selectReviewSource('fixture-medium')?.name).toBe('fixture');
        expect(selectReviewSource('whatever-1')).toBeNull();
    });
});

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { selectReviewHost } from './select.js';

/**
 * Выбор адаптера по префиксу ключа. Хосты тут только создаются: ни сети, ни диска
 * до первого вызова метода они не трогают.
 */

const SHERPA_DIR = path.join(os.tmpdir(), 'sherpa-select-test');

describe('выбор хост-адаптера', () => {
    it('ключ GitHub поднимает GitHub-хост со своим whoami и подпиской на статус', () => {
        const selected = selectReviewHost('github-acme--ui--kit--42', { sherpaDir: SHERPA_DIR });

        expect(selected?.name).toBe('github');
        expect(selected?.currentUser).toBeDefined();
        expect(selected?.watchStatus).toBeDefined();
        // Итераций у GitHub нет, поэтому дев-«пуша» и раундов фидбека тоже.
        expect(selected?.advanceIteration).toBeUndefined();
        expect(selected?.feedback).toBeUndefined();
    });

    it('кривой ключ GitHub хостом не становится', () => {
        for (const key of ['github-acme--sherpa', 'github-acme--sherpa--0', 'github---sherpa--1']) {
            expect(selectReviewHost(key, { sherpaDir: SHERPA_DIR }), key).toBeNull();
        }
    });

    it('ключ локального git-ревью поднимает локальный хост, но только с каталогом проекта', () => {
        const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'sherpa-select-repo-'));
        const sherpaDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sherpa-select-state-'));
        try {
            // Без `--repo` и без сохранённого состояния ключа каталога взять неоткуда.
            expect(selectReviewHost('local-git-app-0badc0de', { sherpaDir })).toBeNull();

            const selected = selectReviewHost('local-git-app-0badc0de', { repo, sherpaDir });

            expect(selected?.name).toBe('local-git');
            expect(selected?.feedback).toBeDefined();
            expect(selected?.refresh).toBeDefined();
        } finally {
            fs.rmSync(repo, { recursive: true, force: true });
            fs.rmSync(sherpaDir, { recursive: true, force: true });
        }
    });

    it('чужие префиксы выбирают своих, неизвестный — ничей', () => {
        expect(selectReviewHost('arcanum-4242')?.name).toBe('arcanum');
        expect(selectReviewHost('fixture-medium')?.name).toBe('fixture');
        expect(selectReviewHost('whatever-1')).toBeNull();
    });
});

import { fixtureIteration } from '@sherpa/fixtures';
import type { FileDiff, Lens, Thread } from '@sherpa/protocol';
import { describe, expect, it } from 'vitest';

import { createT } from '../i18n/index.js';
import type { OwnershipSummary } from './overview-model.js';
import { discussionStats, ownershipSummary } from './overview-model.js';

const t = createT('ru');

function summarize(files: readonly FileDiff[], lens: Lens | null, segment: 'mine' | 'all'): OwnershipSummary {
    return ownershipSummary(files, lens, segment, t, t('overview.ownership.fallbackNote'), 'CODEOWNERS');
}

const DATA = fixtureIteration('medium');
const BASE = requiredFile();

function file(
    fileId: string,
    path: string,
    additions: number,
    deletions: number,
    generated = false,
): FileDiff {
    return { ...BASE, fileId, path, additions, deletions, generated };
}

const FILES = [
    file('mine', 'services/orders/a.ts', 4, 1),
    file('uncovered', 'services/orders/b.ts', 2, 2),
    file('other', 'infra/ci/config.ts', 3, 0),
    file('generated', 'pnpm-lock.yaml', 10, 5, true),
];
const OWNERSHIP: Lens = {
    id: 'mine',
    label: 'My files',
    paths: ['services/orders/a.ts'],
    available: true,
    note: null,
    zones: [
        {
            path: 'services/orders',
            mine: true,
            owner: 'checkout-team',
            paths: ['services/orders/a.ts'],
        },
        {
            path: 'infra/ci',
            mine: false,
            owner: null,
            paths: ['infra/ci/config.ts'],
        },
    ],
};

describe('Overview: файлы по ownership', () => {
    it('группирует по зонам, владельцам и файлам вне зон', () => {
        const summary = summarize(FILES, OWNERSHIP, 'all');

        expect(summary).toMatchObject({
            available: true,
            mineFiles: 1,
            totalFiles: 4,
            mineLines: 5,
            totalLines: 27,
        });
        expect(summary.groups).toEqual([
            {
                path: 'services/orders',
                files: 1,
                lines: 5,
                additions: 4,
                deletions: 1,
                ownership: 'mine',
                owner: 'checkout-team',
                note: 'Ваша зона ответственности по CODEOWNERS.',
            },
            {
                path: 'infra/ci',
                files: 1,
                lines: 3,
                additions: 3,
                deletions: 0,
                ownership: 'other',
                owner: null,
                note: 'Вне вашей зоны CODEOWNERS.',
            },
            {
                path: 'Вне зон CODEOWNERS',
                files: 1,
                lines: 4,
                additions: 2,
                deletions: 2,
                ownership: 'other',
                owner: null,
                note: 'Файлы не покрыты зонами CODEOWNERS.',
            },
            {
                path: 'Машинные файлы',
                files: 1,
                lines: 15,
                additions: 10,
                deletions: 5,
                ownership: 'generated',
                owner: null,
                note: 'Машинные файлы приглушены и считаются просмотренными по умолчанию.',
            },
        ]);
    });

    it('сегмент «Моя зона» оставляет только файлы ownership.paths', () => {
        expect(summarize(FILES, OWNERSHIP, 'mine').groups).toEqual([
            {
                path: 'services/orders',
                files: 1,
                lines: 5,
                additions: 4,
                deletions: 1,
                ownership: 'mine',
                owner: 'checkout-team',
                note: 'Ваша зона ответственности по CODEOWNERS.',
            },
        ]);
    });

    it('объяснение хоста доходит до карточки и у работающей линзы', () => {
        const note = 'GitHub did not tell which teams you are in (read:org scope?).';

        expect(summarize(FILES, { ...OWNERSHIP, note }, 'all').note).toBe(note);
        expect(summarize(FILES, OWNERSHIP, 'all').note).toBeNull();
    });

    it('zones:null сохраняет запасную группировку по префиксу со смешанной группой', () => {
        const summary = summarize(FILES, { ...OWNERSHIP, zones: null }, 'all');

        expect(summary.groups.map((group) => [group.path, group.ownership])).toEqual([
            ['services/orders', 'mixed'],
            ['infra/ci', 'other'],
            ['pnpm-lock.yaml', 'generated'],
        ]);
    });

    it('при недоступном фильтре edge-фикстуры чужие зоны остаются видимыми', () => {
        const edge = fixtureIteration('edge');
        const summary = summarize(edge.diff.files, edge.ownership, 'mine');

        expect(summary.available).toBe(false);
        expect(summary.note).toContain('do not own');
        expect(summary.groups.some((group) => group.ownership === 'other' && group.owner !== null)).toBe(true);
        expect(summary.groups.some((group) => group.ownership === 'generated')).toBe(true);
    });

    it('medium-фикстура сводит числа шапки из тех же файлов, что зоны', () => {
        const summary = summarize(DATA.diff.files, DATA.ownership, 'all');
        const mine = new Set(DATA.ownership?.paths ?? []);
        const mineLines = DATA.diff.files.reduce(
            (total, item) => total + (mine.has(item.path) ? item.additions + item.deletions : 0),
            0,
        );

        expect(summary).toMatchObject({ mineFiles: 12, totalFiles: 21, mineLines: 570, totalLines: 868 });
        expect(mineLines).toBe(570);
        expect(DATA.ownership?.zones?.filter((zone) => zone.mine).flatMap((zone) => zone.paths)).toEqual(
            DATA.ownership?.paths,
        );
    });
});

describe('Overview: счётчики обсуждения', () => {
    it('считает открытые, resolved и бот-треды по тем же Thread-моделям', () => {
        const person = requiredThread((thread) => !thread.resolved && !thread.root.author.bot);
        const bot = requiredThread((thread) => !thread.resolved && thread.root.author.bot);
        const resolvedBot: Thread = { ...bot, id: 'resolved-bot', resolved: true };

        expect(discussionStats([person, bot, resolvedBot])).toEqual({ open: 2, resolved: 1, bots: 2 });
    });
});

function requiredFile(): FileDiff {
    const found = DATA.diff.files[0];
    if (found === undefined) {
        throw new Error('medium fixture has no files');
    }
    return found;
}

function requiredThread(predicate: (thread: Thread) => boolean): Thread {
    const found = DATA.threads.find(predicate);
    if (found === undefined) {
        throw new Error('medium fixture lacks required thread');
    }
    return found;
}

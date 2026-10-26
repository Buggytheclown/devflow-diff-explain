import type { PrMeta } from '@sherpa/protocol';
import { describe, expect, it } from 'vitest';

import { breadcrumbFor, breadcrumbFromPrKey, documentTitleFor } from './pr-key.js';

const PR: PrMeta = {
    id: '4821',
    url: 'https://a.yandex-team.ru/review/4821',
    title: 'Окно редактирования заказа',
    author: { login: 'alice', displayName: null, bot: false, avatarUrl: null },
    fromBranch: 'users/alice/edit-window',
    toBranch: 'trunk',
    state: 'open',
    statusLabel: 'review_in_progress',
    checks: 'passed',
    updatedAt: '2026-08-24T06:00:00.000Z',
    capabilities: { publishVerdicts: ['comment', 'ship', 'sticky_ship', 'request_changes'], fileViewedSync: true, fileContent: true, commentIssues: true, commentResolve: true, editPublished: true, iterations: false, blobs: false },
    verdicts: [],
    viewer: { login: 'alice', displayName: null, bot: false, avatarUrl: null },
};

describe('breadcrumbFromPrKey', () => {
    it('разбирает ключ на хост и номер PR', () => {
        expect(breadcrumbFromPrKey('arcanum-4821')).toEqual(['arcanum', 'PR 4821']);
    });

    it('делит по первому дефису — номер может его содержать', () => {
        expect(breadcrumbFromPrKey('unknown-owner-repo-42')).toEqual(['unknown', 'PR owner-repo-42']);
    });

    it('ключ без разделителя показывается как есть', () => {
        expect(breadcrumbFromPrKey('local')).toEqual(['local']);
        expect(breadcrumbFromPrKey('trailing-')).toEqual(['trailing-']);
    });
});

describe('breadcrumbFor', () => {
    it('без меты — запасная текстовая цепочка из ключа', () => {
        expect(breadcrumbFor('arcanum-4821', null)).toEqual([
            { text: 'arcanum', href: null },
            { text: 'PR 4821', href: null },
        ]);
    });

    it('с метой последний сегмент ведёт на PR у хоста', () => {
        expect(breadcrumbFor('arcanum-4821', PR)).toEqual([
            { text: 'arcanum', href: null },
            { text: 'PR 4821', href: 'https://a.yandex-team.ru/review/4821' },
        ]);
    });

    it('ключ без разделителя сохраняет свой сегмент и получает ссылку рядом', () => {
        expect(breadcrumbFor('local', PR)).toEqual([
            { text: 'local', href: null },
            { text: 'PR 4821', href: 'https://a.yandex-team.ru/review/4821' },
        ]);
    });
});

describe('documentTitleFor', () => {
    it('с метой — заголовок PR', () => {
        expect(documentTitleFor('arcanum-4821', PR)).toBe('Окно редактирования заказа · Sherpa');
    });

    it('без меты — номер PR из ключа', () => {
        expect(documentTitleFor('arcanum-4821', null)).toBe('PR 4821 · Sherpa');
    });

    it('пустого заголовка не бывает: пустая мета и ключ без разделителя тоже дают текст', () => {
        expect(documentTitleFor('local', null)).toBe('local · Sherpa');
        expect(documentTitleFor('arcanum-4821', { ...PR, title: '   ' })).toBe('PR 4821 · Sherpa');
        expect(documentTitleFor('', null)).toBe('Sherpa');
    });
});

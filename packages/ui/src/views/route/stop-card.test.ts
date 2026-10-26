import type { Thread } from '@sherpa/protocol';
import { describe, expect, it } from 'vitest';

import { stopChangeThreads } from './stop-card.tsx';
import { createT } from '../../i18n/index.js';

const t = createT('ru');

function thread(id: string, line: number | null): Thread {
    return {
        id,
        anchor:
            line === null
                ? null
                : {
                      fileId: 'f1',
                      path: 'services/orders/src/domain/order.ts',
                      position: { side: 'new', line, size: 1 },
                  },
        resolved: false,
        resolvedBy: null,
        outdated: false,
        pinnedTo: null,
        root: {
            id: `${id}-root`,
            author: { login: 'reviewer', displayName: 'Ревьюер', bot: false, avatarUrl: null },
            body: 'текст',
            draft: false,
            issue: null,
            resolved: null,
            createdAt: '2026-09-01T10:00:00.000Z',
            editedAt: null,
            replies: [],
        },
    };
}

const THREADS = new Map<string, Thread>([
    ['t-line', thread('t-line', 33)],
    ['t-pr', thread('t-pr', null)],
]);

describe('ссылки на треды-причины', () => {
    it('тред с якорем называет строку, без якоря — PR', () => {
        expect(
            stopChangeThreads({ kind: 'changed', reason: null, threadIds: ['t-line', 't-pr'] }, THREADS, t),
        ).toEqual([
            { id: 't-line', label: 'тред у строки 33' },
            { id: 't-pr', label: 'тред к PR' },
        ]);
    });

    it('неизвестный id ссылки не даёт', () => {
        expect(
            stopChangeThreads({ kind: 'changed', reason: null, threadIds: ['t-line', 'нет-такого'] }, THREADS, t),
        ).toEqual([{ id: 't-line', label: 'тред у строки 33' }]);
    });

    it('стоп без классификации ссылок не имеет', () => {
        expect(stopChangeThreads(null, THREADS, t)).toEqual([]);
    });
});

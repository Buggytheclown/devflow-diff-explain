import type { ChatExchange } from '@sherpa/protocol';
import { expect, it } from 'vitest';
import { exchangesForReading } from './chat-scope.js';

const base: ChatExchange = { id: 1, question: 'Почему?', anchor: null, status: 'done', taskId: null, answer: 'Ответ', progressText: null,
    error: null, locale: null, createdAt: '2026-11-04T10:00:00.000Z', updatedAt: '2026-11-04T10:00:00.000Z' };
const shown = { snapshotId: 'review-a', diffId: 'diff-a', commit: 'commit-a', codeSnapshotId: 'a'.repeat(64), text: 'Описание' };
const anchored = { diffId: 'diff-a', fileId: 'file-a', path: 'src/a.ts', side: 'new' as const, start: 2, end: 2 };

it('сохраняет старые вопросы, не смешивая точные версии A и B', () => {
    const a = { ...base, id: 1, explanation: shown };
    const b = { ...base, id: 2, explanation: { ...shown, codeSnapshotId: 'b'.repeat(64) } };
    const oldAnchor = { ...base, id: 3, anchor: anchored };
    const unknown = { ...base, id: 4 };
    const otherAnchor = { ...base, id: 5, anchor: { ...anchored, diffId: 'diff-b' } };
    expect(exchangesForReading([a, b, oldAnchor, unknown, otherAnchor], 'diff-a', 'a'.repeat(64), true).map((item) => item.id)).toEqual([1, 3, 4]);
});

it('не приписывает обмен без ID кода закреплённой версии', () => {
    const legacy = { ...base, explanation: { ...shown, codeSnapshotId: undefined } };
    expect(exchangesForReading([legacy], 'diff-a', 'a'.repeat(64), true)).toEqual([]);
    expect(exchangesForReading([legacy], 'diff-a', 'a'.repeat(64), false)).toEqual([legacy]);
});

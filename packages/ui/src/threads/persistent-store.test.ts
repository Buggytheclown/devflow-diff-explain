import { describe, expect, it } from 'vitest';

import { persistentThreadStore } from './persistent-store.js';

describe('персистентный стор тредов', () => {
    it('возвращает тот же стор после ремаунта вью и сохраняет текст композера', () => {
        const first = persistentThreadStore('fixture-persist-test', 'diff-1', [], new Set(['f1']));
        first.openComposer({
            key: 'new:f1:new:10',
            threadId: null,
            parentId: null,
            anchor: { fileId: 'f1', path: 'app.ts', position: { side: 'new', line: 10, size: 1 } },
            text: 'не потерять',
            commentId: null,
            status: 'error',
            slow: false,
            confirmDiscard: false,
            resolvedAtOpen: false,
        });

        const remounted = persistentThreadStore('fixture-persist-test', 'diff-1', [], new Set(['f1']));

        expect(remounted).toBe(first);
        expect(remounted.getComposer('new:f1:new:10')).toMatchObject({
            text: 'не потерять',
            status: 'error',
        });
    });

    it('пуш переводит открытую итерацию в прошлую, не роняя стор и текст композера', () => {
        const active = persistentThreadStore('fixture-persist-test', 'diff-2', [], new Set(['f1']));
        active.openComposer({
            key: 'new:f1:new:10',
            threadId: null,
            parentId: null,
            anchor: { fileId: 'f1', path: 'app.ts', position: { side: 'new', line: 10, size: 1 } },
            text: 'написано до пуша',
            commentId: null,
            status: 'idle',
            slow: false,
            confirmDiscard: false,
            resolvedAtOpen: false,
        });

        const layout = { diffId: 'diff-2', fileIdByPath: new Map([['app.ts', 'f1']]) };
        const past = persistentThreadStore('fixture-persist-test', 'diff-2', [], new Set(['f1']), layout);
        past.setIterationLayout(layout);

        expect(past).toBe(active);
        expect(past.getComposer('new:f1:new:10')?.text).toBe('написано до пуша');
        expect(past.getSnapshot().iterationLayout).toBe(layout);
    });
});

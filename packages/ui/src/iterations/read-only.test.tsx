// @vitest-environment jsdom
import type { Thread } from '@sherpa/protocol';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';

import { publishDisabledReason } from '../components/review-action-model.js';
import { createT } from '../i18n/index.js';
import { ViewedToggle } from '../components/viewed-toggle.tsx';
import type { ComposerTransport } from '../threads/composer.js';
import { createThreadStore } from '../threads/store.js';
import { NewCommentComposer, openPrComposer, ThreadList } from '../threads/thread-list.tsx';
import { READ_ONLY_REASON, ReadOnlyIterationProvider } from './read-only.tsx';

const t = createT('ru');

/**
 * Режим чтения прошлой итерации: контролы, которые пишут в PR, выключены с одной и той же
 * подсказкой.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mounted: (() => void)[] = [];

afterEach(() => {
    for (const cleanup of mounted.splice(0)) {
        cleanup();
    }
});

function render(node: React.ReactNode, readOnly: boolean): HTMLElement {
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    act(() => {
        root.render(<ReadOnlyIterationProvider readOnly={readOnly}>{node}</ReadOnlyIterationProvider>);
    });
    mounted.push(() => {
        act(() => {
            root.unmount();
        });
        host.remove();
    });
    return host;
}

const TRANSPORT: ComposerTransport = {
    save: () => Promise.reject(new Error('тест не сохраняет')),
    update: () => Promise.resolve({ outcome: 'saved' as const }),
    delete: () => Promise.resolve(),
};

const THREAD: Thread = {
    id: 't1',
    resolved: false,
    resolvedBy: null,
    outdated: false,
    pinnedTo: null,
    anchor: { fileId: 'f1', path: 'app.ts', position: { side: 'new', line: 10, size: 1 } },
    root: {
        id: 'c1',
        author: { login: 'avery', displayName: 'Avery', bot: false, avatarUrl: null },
        body: 'вопрос по строке',
        createdAt: '2026-08-31T06:00:00.000Z',
        editedAt: null,
        draft: false,
        issue: false,
        resolved: false,
        replies: [],
    },
};

describe('контролы записи в режиме чтения', () => {
    it('отметка «просмотрено» выключена и объясняет причину', () => {
        const host = render(<ViewedToggle viewed={false} className="file-card__viewed" onToggle={() => undefined} />, true);
        const toggle = host.querySelector<HTMLButtonElement>('.viewed-toggle');

        expect(toggle?.disabled).toBe(true);
        expect(toggle?.title).toBe(t(READ_ONLY_REASON));
    });

    it('в активной итерации отметка работает как раньше', () => {
        const host = render(
            <ViewedToggle viewed={false} className="file-card__viewed" title="0 из 3" onToggle={() => undefined} />,
            false,
        );
        const toggle = host.querySelector<HTMLButtonElement>('.viewed-toggle');

        expect(toggle?.disabled).toBe(false);
        expect(toggle?.title).toBe('0 из 3');
    });

    it('композер комментария не сохраняет и не редактируется', () => {
        const store = createThreadStore([], new Set(['f1']));
        openPrComposer(store, true);
        const host = render(
            <NewCommentComposer
                composerKey="new:pr"
                store={store}
                transport={TRANSPORT}
                initialLayout="markdown"
            />,
            true,
        );

        const save = host.querySelector<HTMLButtonElement>('.thread-composer__save');
        expect(save?.disabled).toBe(true);
        expect(save?.title).toBe(t(READ_ONLY_REASON));
        expect(host.querySelector<HTMLTextAreaElement>('.thread-composer__markdown')?.disabled).toBe(true);
    });

    it('ответить в тред нельзя, а сам тред читается', () => {
        const store = createThreadStore([THREAD], new Set(['f1']));
        const host = render(
            <ThreadList
                threads={[THREAD]}
                store={store}
                actions={{ transport: TRANSPORT, resolve: () => Promise.resolve(true) }}
                now={Date.now()}
            />,
            true,
        );
        const reply = [...host.querySelectorAll<HTMLButtonElement>('.thread__row-actions button')].find(
            (button) => button.textContent === 'Ответить',
        );

        expect(host.textContent).toContain('вопрос по строке');
        expect(reply?.disabled).toBe(true);
        expect(reply?.title).toBe(t(READ_ONLY_REASON));
    });

    it('резолв и переоткрытие треда недоступны', () => {
        const store = createThreadStore([THREAD], new Set(['f1']));
        const host = render(
            <ThreadList
                threads={[THREAD]}
                store={store}
                actions={{ transport: TRANSPORT, resolve: () => Promise.resolve(true) }}
                now={Date.now()}
            />,
            true,
        );
        const resolve = host.querySelector<HTMLButtonElement>('.thread__resolve');

        expect(resolve?.disabled).toBe(true);
        expect(resolve?.title).toBe(t(READ_ONLY_REASON));
    });

    it('повтор сорвавшейся отправки в композере тоже заблокирован', () => {
        const store = createThreadStore([], new Set(['f1']));
        openPrComposer(store, true);
        const composer = store.getComposer('new:pr');
        expect(composer).not.toBeNull();
        store.updateComposer('new:pr', { text: 'не доехало', status: 'error' });
        const host = render(
            <NewCommentComposer
                composerKey="new:pr"
                store={store}
                transport={TRANSPORT}
                initialLayout="markdown"
            />,
            true,
        );
        const retry = [...host.querySelectorAll<HTMLButtonElement>('.thread-composer__status button')].find(
            (button) => button.textContent === 'повторить',
        );

        expect(retry?.disabled).toBe(true);
        expect(retry?.title).toBe(t(READ_ONLY_REASON));
    });

    it('шип и публикация выключены той же причиной', () => {
        expect(
            publishDisabledReason({
                t: createT('ru'),
                connection: 'online',
                pendingComposer: false,
                publishing: false,
                readOnlyIteration: true,
            }),
        ).toBe(t(READ_ONLY_REASON));
        expect(
            publishDisabledReason({ t: createT('ru'), connection: 'online', pendingComposer: false, publishing: false }),
        ).toBeNull();
    });
});

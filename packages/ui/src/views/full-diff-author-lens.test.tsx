// @vitest-environment jsdom
import { anchor, comment, fixtureIteration, human, thread } from '@sherpa/fixtures';
import type { Thread } from '@sherpa/protocol';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';

import { toParseRequest } from '../diff/model.js';
import { parseFileDiff } from '../diff/parse.js';
import { createDiffViewStore } from '../diff-view/store.js';
import { createSessionStore } from '../session/session-store.js';
import { createThreadStore } from '../threads/store.js';
import { DiffWorkspace } from './full-diff.tsx';

/**
 * Линза по автору на полном диффе: её ставит карточка обсуждения на Обзоре, снимает —
 * чип в тулбаре рядом с источниками комментариев.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const VIEWPORT = 900;

class NoopResizeObserver {
    observe(): void {
        // Ширина в jsdom не меняется никогда.
    }
    unobserve(): void {
        // См. `observe`.
    }
    disconnect(): void {
        // См. `observe`.
    }
}
(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= NoopResizeObserver;

// В jsdom все прямоугольники нулевые: без размеров виртуализатор не нарисует ни одной строки.
Element.prototype.getBoundingClientRect = function fakeRect(): DOMRect {
    return {
        x: 0,
        y: 0,
        top: 0,
        left: 0,
        right: VIEWPORT,
        bottom: VIEWPORT,
        width: VIEWPORT,
        height: VIEWPORT,
        toJSON: () => ({}),
    };
};
for (const name of ['offsetWidth', 'offsetHeight'] as const) {
    Object.defineProperty(HTMLElement.prototype, name, { configurable: true, get: () => VIEWPORT });
}
Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: () => undefined });

const DATA = fixtureIteration('medium');
const FILE = (() => {
    const file = DATA.diff.files.find((candidate) => candidate.path === 'services/orders/src/domain/edit-window.ts');
    if (file === undefined) {
        throw new Error('фикстуре medium нужен edit-window.ts');
    }
    return file;
})();

function lineThread(login: string, line: number, body: string): Thread {
    return thread({
        id: `${login}-thread`,
        anchor: anchor(DATA.diff.diffId, FILE.path, { side: 'new', line }),
        root: comment({
            id: `${login}-root`,
            author: human(login, login),
            body,
            createdAt: '2026-08-24T10:00:00.000Z',
        }),
    });
}

const THREADS: readonly Thread[] = [
    lineThread('ada', 6, 'ada body'),
    lineThread('morgan', 8, 'morgan body'),
];

const mounted: (() => void)[] = [];

afterEach(() => {
    for (const unmount of mounted.splice(0)) {
        unmount();
    }
});

function mount(threadAuthor: string | null) {
    const host = document.createElement('div');
    document.body.append(host);
    const files = [FILE];
    const store = createDiffViewStore({ files });
    store.setModel(FILE.fileId, parseFileDiff(toParseRequest(FILE)));
    const threadStore = createThreadStore(THREADS, new Set([FILE.fileId]));
    const session = createSessionStore({
        initial: {
            view: 'diff',
            filter: 'all',
            threadAuthor,
        },
    });
    const root = createRoot(host);
    act(() => {
        root.render(
            <DiffWorkspace
                pr={DATA.pr}
                diff={{ ...DATA.diff, files }}
                lenses={{ ownership: DATA.ownership, extra: DATA.extraLenses, ownershipSource: 'CODEOWNERS' }}
                prKey="fixture-medium"
                session={session}
                store={store}
                threadStore={threadStore}
                threadNow={Date.parse('2026-08-24T12:00:00.000Z')}
                parse={(file) => Promise.resolve(parseFileDiff(toParseRequest(file)))}
                loadContent={() => Promise.resolve(null)}
                onSetViewed={() => Promise.resolve(0)}
                initialSelectionTarget={null}
                selectionNavigationRequest={0}
            />,
        );
    });
    mounted.push(() => {
        act(() => {
            root.unmount();
        });
        host.remove();
    });
    return { host, session };
}

describe('линза по автору на полном диффе', () => {
    it('без линзы видны треды обоих авторов и чипа снятия нет', () => {
        const { host } = mount(null);

        expect(host.textContent).toContain('ada body');
        expect(host.textContent).toContain('morgan body');
        expect(host.querySelector('.thread-chip--author')).toBeNull();
    });

    it('линза оставляет треды одного автора и показывает чип с его именем', () => {
        const { host } = mount('ada');

        expect(host.textContent).toContain('ada body');
        expect(host.textContent).not.toContain('morgan body');
        expect(host.querySelector('.thread-chip--author')?.textContent).toContain('треды: ada');
    });

    it('клик по чипу снимает линзу и возвращает чужие треды', () => {
        const { host, session } = mount('ada');

        act(() => {
            host.querySelector<HTMLButtonElement>('.thread-chip--author')?.click();
        });

        expect(session.getSnapshot().threadAuthor).toBeNull();
        expect(host.querySelector('.thread-chip--author')).toBeNull();
        expect(host.textContent).toContain('morgan body');
    });
});

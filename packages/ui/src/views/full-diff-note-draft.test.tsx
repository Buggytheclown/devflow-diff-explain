// @vitest-environment jsdom
import { fixtureIteration } from '@sherpa/fixtures';
import type { AgentNote, ChatAnchor } from '@sherpa/protocol';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { toParseRequest } from '../diff/model.js';
import { parseFileDiff } from '../diff/parse.js';
import { createDiffViewStore } from '../diff-view/store.js';
import { noteDraftText } from '../notes/note-draft.js';
import { createSessionStore } from '../session/session-store.js';
import { createT } from '../i18n/index.js';
import { SettingsProvider } from '../settings/context.tsx';
import { createUiSettingsStore } from '../settings/settings-store.js';
import { createThreadStore } from '../threads/store.js';
import { DiffWorkspace } from './full-diff.tsx';

/**
 * «В черновик комментария» у заметки агента: композер встаёт у того же диапазона с цитатой,
 * сама заметка остаётся на месте, а открытый композер скроллится в вьюпорт и получает фокус.
 */

const DATA = fixtureIteration('medium');
const FILE = (() => {
    const file = DATA.diff.files.find((candidate) => candidate.path === 'services/orders/src/domain/edit-window.ts');
    if (file === undefined) {
        throw new Error('фикстуре medium нужен edit-window.ts');
    }
    return file;
})();
const NOTE_ANCHOR: ChatAnchor = { diffId: DATA.diff.diffId, fileId: FILE.fileId, path: FILE.path, side: 'new', start: 6, end: 8 };
const NOTE: AgentNote = {
    id: 7,
    exchangeId: 70,
    anchor: NOTE_ANCHOR,
    text: 'Первая строка ответа.\n\nВторая строка ответа.\n',
    lostAnchor: false,
    origin: { commit: 'abcdef1', anchor: NOTE_ANCHOR },
    createdAt: '2026-09-01T10:00:00.000Z',
};
const COMPOSER_KEY = `new:${FILE.fileId}:new:6`;

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const VIEWPORT_WIDTH = 900;
const VIEWPORT_HEIGHT = 700;

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
        right: VIEWPORT_WIDTH,
        bottom: VIEWPORT_HEIGHT,
        width: VIEWPORT_WIDTH,
        height: VIEWPORT_HEIGHT,
        toJSON: () => ({}),
    };
};
for (const [name, value] of [
    ['offsetWidth', VIEWPORT_WIDTH],
    ['offsetHeight', VIEWPORT_HEIGHT],
] as const) {
    Object.defineProperty(HTMLElement.prototype, name, { configurable: true, get: () => value });
}
const scrollIntoView = vi.fn();
Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: scrollIntoView });

const mounted: (() => void)[] = [];

afterEach(() => {
    for (const unmount of mounted.splice(0)) {
        unmount();
    }
    scrollIntoView.mockClear();
    window.localStorage.clear();
});

function mount() {
    // Раскладка редактора детерминирована: markdown даёт обычную textarea вместо ProseMirror.
    const settings = createUiSettingsStore({ initial: { composerLayout: 'markdown' } });
    const host = document.createElement('div');
    document.body.append(host);
    const files = [FILE];
    const store = createDiffViewStore({ files });
    store.setModel(FILE.fileId, parseFileDiff(toParseRequest(FILE)));
    const threadStore = createThreadStore([], new Set([FILE.fileId]));
    const session = createSessionStore({
        initial: { view: 'diff', filter: 'all' },
    });
    const root = createRoot(host);
    act(() => {
        root.render(
            <SettingsProvider store={settings}>
                <DiffWorkspace
                    pr={DATA.pr}
                    diff={{ ...DATA.diff, files }}
                    lenses={{ ownership: DATA.ownership, extra: DATA.extraLenses, ownershipSource: 'CODEOWNERS' }}
                    prKey="fixture-medium"
                    session={session}
                    store={store}
                    threadStore={threadStore}
                    threadNow={Date.parse('2026-09-01T12:00:00.000Z')}
                    parse={(file) => Promise.resolve(parseFileDiff(toParseRequest(file)))}
                    loadContent={() => Promise.resolve(null)}
                    onSetViewed={() => Promise.resolve(0)}
                    notes={[NOTE]}
                />
            </SettingsProvider>,
        );
    });
    mounted.push(() => {
        act(() => {
            root.unmount();
        });
        host.remove();
    });
    return {
        host,
        store,
        threadStore,
        settle: async () => {
            for (let step = 0; step < 8; step += 1) {
                await act(async () => {
                    await new Promise((resolve) => setTimeout(resolve, 20));
                });
            }
        },
    };
}

function draftButton(host: HTMLElement): HTMLButtonElement {
    const button = [...host.querySelectorAll<HTMLButtonElement>('.agent-note__actions button')].find(
        (candidate) => candidate.textContent === 'В черновик комментария',
    );
    if (button === undefined) {
        throw new Error('у развёрнутой заметки нет действия «В черновик комментария»');
    }
    return button;
}

describe('черновик комментария из заметки агента', () => {
    it('открывает композер у якоря заметки с цитатой и не трогает саму заметку', async () => {
        const view = mount();
        await view.settle();

        act(() => {
            view.host.querySelector<HTMLButtonElement>('[data-note="7"]')?.click();
        });
        act(() => {
            draftButton(view.host).click();
        });

        const composer = view.threadStore.getComposer(COMPOSER_KEY);
        expect(composer?.anchor).toEqual({
            fileId: FILE.fileId,
            path: FILE.path,
            position: { side: 'new', line: 6, size: 3 },
        });
        expect(composer?.text).toBe(noteDraftText(NOTE, createT('ru')));
        // Черновик несохранённый: в хост он уйдёт только по явному сохранению.
        expect(composer?.commentId).toBeNull();
        expect(composer?.status).toBe('idle');
        expect(view.host.querySelectorAll('[data-note="7"]')).toHaveLength(1);
        expect(view.store.getSnapshot().selection).toBeNull();
    });

    it('скроллит открытый композер в вьюпорт и ставит фокус в поле', async () => {
        const view = mount();
        await view.settle();
        act(() => {
            view.host.querySelector<HTMLButtonElement>('[data-note="7"]')?.click();
        });
        scrollIntoView.mockClear();

        act(() => {
            draftButton(view.host).click();
        });
        await view.settle();

        const node = view.host.querySelector<HTMLElement>(`[data-composer-key="${COMPOSER_KEY}"]`);
        expect(node).not.toBeNull();
        expect(scrollIntoView).toHaveBeenCalled();
        expect(node?.contains(document.activeElement)).toBe(true);
    });

    it('повторное действие не затирает набранный ревьюером текст', async () => {
        const view = mount();
        await view.settle();
        act(() => {
            view.host.querySelector<HTMLButtonElement>('[data-note="7"]')?.click();
        });
        act(() => {
            draftButton(view.host).click();
        });
        act(() => {
            view.threadStore.updateComposer(COMPOSER_KEY, { text: 'своё замечание' });
        });

        act(() => {
            draftButton(view.host).click();
        });

        expect(view.threadStore.getComposer(COMPOSER_KEY)?.text).toBe('своё замечание');
    });
});

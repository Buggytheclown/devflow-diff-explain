// @vitest-environment jsdom
import { fixtureInterdiff, fixtureIteration } from '@sherpa/fixtures';
import type { UiChatAskAnchor } from '@sherpa/protocol';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { DiffFileModel } from '../diff/model.js';
import { toParseRequest } from '../diff/model.js';
import { parseFileDiff } from '../diff/parse.js';
import { lineKey } from '../diff-view/selection.js';
import { createDiffViewStore } from '../diff-view/store.js';
import { createSessionStore } from '../session/session-store.js';
import { createThreadStore } from '../threads/store.js';
import { DiffWorkspace } from './full-diff.tsx';

/**
 * Срез между итерациями в читалке: `fileId` у файлов среза из другого пространства
 * имён, поэтому вопрос агенту к ним не привязать — ни кнопкой поповера, ни якорем в композере
 * чата.
 */

const V2 = fixtureIteration('medium', 1);
const SLICE = fixtureInterdiff('medium', 0, 1);
const FILE = (() => {
    const file = SLICE.files[0];
    if (file === undefined) {
        throw new Error('интердиффу medium нужен хотя бы один файл');
    }
    return file;
})();
const MODEL = parseFileDiff(toParseRequest(FILE));
const ADDED_LINE = addedLineKey(MODEL);
const SLICE_COMMITS = {
    baseCommit: fixtureIteration('medium', 0).iteration.headCommit,
    headCommit: V2.iteration.headCommit,
};

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class {
    observe(): void {
        // В jsdom нет раскладки.
    }
    unobserve(): void {
        // В jsdom нет раскладки.
    }
    disconnect(): void {
        // В jsdom нет раскладки.
    }
};

const cleanups: (() => void)[] = [];

afterEach(() => {
    for (const cleanup of cleanups.splice(0)) {
        cleanup();
    }
});

function mount(slice: boolean) {
    const host = document.createElement('div');
    document.body.append(host);
    const files = [FILE];
    const store = createDiffViewStore({ files });
    store.setModel(FILE.fileId, MODEL);
    const threadStore = createThreadStore([], new Set([FILE.fileId]));
    const session = createSessionStore({ initial: { view: 'diff', filter: 'all' } });
    const onSelectionAnchorChange = vi.fn<(anchor: UiChatAskAnchor | null) => void>();
    const root = createRoot(host);
    act(() => {
        root.render(
            <DiffWorkspace
                pr={V2.pr}
                diff={{ ...SLICE, files }}
                lenses={{ ownership: null, extra: [], ownershipSource: null }}
                prKey="fixture-medium"
                session={session}
                store={store}
                threadStore={threadStore}
                threadNow={Date.parse('2026-08-24T12:00:00.000Z')}
                slice={slice ? SLICE_COMMITS : null}
                agentConnected
                onAskSelection={() => undefined}
                onSelectionAnchorChange={onSelectionAnchorChange}
                parse={(file) => Promise.resolve(parseFileDiff(toParseRequest(file)))}
                loadContent={() => Promise.resolve(null)}
                onSetViewed={() => Promise.resolve(0)}
            />,
        );
    });
    cleanups.push(() => {
        act(() => {
            root.unmount();
        });
        host.remove();
    });
    return { host, store, onSelectionAnchorChange };
}

/** Первая добавленная строка файла: у неё однозначная сторона, и якорь вопроса собирается. */
function addedLineKey(model: DiffFileModel): string {
    if (model.content.kind === 'text') {
        for (const block of model.content.blocks) {
            if (block.kind !== 'hunk') {
                continue;
            }
            for (const line of block.lines) {
                const key = line.kind === 'add' ? lineKey(line) : null;
                if (key !== null) {
                    return key;
                }
            }
        }
    }
    throw new Error('в файле интердиффа нет добавленных строк');
}

function askButton(host: HTMLElement): HTMLButtonElement {
    const button = [...host.querySelectorAll<HTMLButtonElement>('.selection-popover__button')].find(
        (candidate) => candidate.textContent === 'Спросить агента',
    );
    if (button === undefined) {
        throw new Error('в поповере выделения нет кнопки вопроса');
    }
    return button;
}

describe('выделение в срезе между итерациями', () => {
    it('вопрос агенту выключен и объясняет причину, якорь в чат не уезжает', () => {
        const view = mount(true);
        act(() => {
            view.store.startSelection(FILE.fileId, ADDED_LINE);
        });

        const ask = askButton(view.host);
        expect(ask.disabled).toBe(true);
        expect(ask.title).toBe('в срезе вопрос не привязать к файлу — спросите в активной итерации');
        expect(view.onSelectionAnchorChange.mock.calls.some(([anchor]) => anchor !== null)).toBe(false);
    });

    it('вне среза вопрос доступен и якорь уходит в композер чата', () => {
        const view = mount(false);
        act(() => {
            view.store.startSelection(FILE.fileId, ADDED_LINE);
        });

        expect(askButton(view.host).disabled).toBe(false);
        expect(view.onSelectionAnchorChange.mock.calls.some(([anchor]) => anchor !== null)).toBe(true);
    });
});

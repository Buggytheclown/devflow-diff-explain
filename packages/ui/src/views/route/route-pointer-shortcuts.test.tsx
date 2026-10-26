// @vitest-environment jsdom
import { fileContentOf, fixtureIteration, routeFixtures } from '@sherpa/fixtures';
import type { RouteSnapshot } from '@sherpa/protocol';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';

import { toParseRequest } from '../../diff/model.js';
import { parseFileDiff } from '../../diff/parse.js';
import { createDiffViewStore } from '../../diff-view/store.js';
import { createSessionStore } from '../../session/session-store.js';
import { ShortcutsProvider } from '../../shortcuts/context.tsx';
import type { PointerTarget } from '../../shortcuts/pointer-target.js';
import type { ShortcutRegistry } from '../../shortcuts/registry.js';
import { createShortcutRegistry } from '../../shortcuts/registry.js';
import { createThreadStore } from '../../threads/store.js';
import { RouteWorkspace } from './route-workspace.tsx';

/**
 * Клавиши маршрута по цели под мышью (docs/design/SPEC-elements.md §5): фокуса нет вовсе, курсор стоит над
 * остановкой, строкой или тредом. Трекер подставлен — `elementFromPoint` в jsdom нет.
 */

const DATA = fixtureIteration('medium');
const SNAPSHOT: RouteSnapshot = (() => {
    const snapshot = routeFixtures('medium')?.states.ready?.snapshot ?? null;
    if (snapshot === null) {
        throw new Error('фикстуре medium нужен готовый снапшот маршрута');
    }
    return snapshot;
})();
const FILE_IDS = new Set(DATA.diff.files.map((file) => file.fileId));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Тулбар меряет свою высоту наблюдателем, которого в jsdom нет; раскладки тут всё равно нет.
(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class {
    observe(): void {
        // Раскладки в jsdom нет — наблюдать нечего.
    }
    unobserve(): void {
        // Раскладки в jsdom нет — наблюдать нечего.
    }
    disconnect(): void {
        // Раскладки в jsdom нет — наблюдать нечего.
    }
};

const mounted: (() => void)[] = [];

afterEach(() => {
    for (const unmount of mounted.splice(0)) {
        unmount();
    }
});

function mount() {
    const host = document.createElement('div');
    document.body.append(host);
    const store = createDiffViewStore({ files: DATA.diff.files });
    for (const file of DATA.diff.files) {
        store.setModel(file.fileId, parseFileDiff(toParseRequest(file)));
    }
    const session = createSessionStore({ initial: { view: 'route', filter: 'all' } });
    const threadStore = createThreadStore(DATA.threads, FILE_IDS);
    const stopWrites: { stopId: string; viewed: boolean }[] = [];
    const registry = createShortcutRegistry();
    registry.setActiveScope('route');
    let hovered: Element | null = null;
    const pointer: PointerTarget = {
        hovered: () => hovered,
        target: (selector) => hovered?.closest(selector) ?? document.activeElement?.closest(selector) ?? null,
        dispose: () => undefined,
    };
    const root = createRoot(host);
    act(() => {
        root.render(
            <ShortcutsProvider registry={registry} pointer={pointer}>
                <RouteWorkspace
                    pr={DATA.pr}
                    diff={DATA.diff}
                    lenses={{ ownership: DATA.ownership, extra: DATA.extraLenses, ownershipSource: 'CODEOWNERS' }}
                    snapshot={SNAPSHOT}
                    session={session}
                    store={store}
                    threadStore={threadStore}
                    progressLoaded
                    threadNow={Date.parse('2026-08-24T12:00:00.000Z')}
                    parse={(file) => Promise.resolve(parseFileDiff(toParseRequest(file)))}
                    loadContent={(fileId) => {
                        const file = DATA.diff.files.find((candidate) => candidate.fileId === fileId);
                        return Promise.resolve(file === undefined ? null : fileContentOf(file));
                    }}
                    onSetViewed={() => Promise.resolve(0)}
                    onSetStopViewed={(stopId, viewed) => {
                        stopWrites.push({ stopId, viewed });
                        return Promise.resolve(stopWrites.length);
                    }}
                />
            </ShortcutsProvider>,
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
        stopWrites,
        hover: (element: Element | null) => {
            hovered = element;
        },
        press: (key: string) => {
            press(registry, key);
        },
        settle: async () => {
            for (let step = 0; step < 6; step += 1) {
                await act(async () => {
                    await new Promise((resolve) => setTimeout(resolve, 20));
                });
            }
        },
    };
}

/** Нажатие идёт через реестр: единственный слушатель страницы делает ровно это. */
function press(registry: ShortcutRegistry, key: string): void {
    act(() => {
        registry.handle({
            key,
            code: `Key${key.toUpperCase()}`,
            ctrlKey: false,
            metaKey: false,
            shiftKey: false,
            altKey: false,
            target: document.body,
            preventDefault: () => undefined,
        });
    });
}

function stopSection(host: HTMLElement, stopId: string): HTMLElement {
    const section = host.querySelector<HTMLElement>(`[data-stop="${stopId}"]`);
    if (section === null) {
        throw new Error(`в разметке нет остановки ${stopId}`);
    }
    return section;
}

/** Первая добавленная строка в карточке файла остановки: её адрес читается из разметки. */
function addedRow(section: HTMLElement): { readonly element: HTMLElement; readonly fileId: string; readonly line: number } {
    const row = section.querySelector<HTMLElement>('.file-card[data-file] .diff-row[data-key^="a"]');
    const fileId = row?.closest<HTMLElement>('[data-file]')?.dataset.file;
    const key = row?.dataset.key;
    if (row === null || fileId === undefined || key === undefined) {
        throw new Error('в остановке нет нарисованной добавленной строки');
    }
    return { element: row, fileId, line: Number(key.slice(1)) };
}

describe('клавиши маршрута по цели под мышью', () => {
    it('v отмечает остановку под курсором', async () => {
        const view = mount();
        await view.settle();
        view.hover(stopSection(view.host, 's02'));

        view.press('v');
        await view.settle();

        expect(document.activeElement).toBe(document.body);
        expect(view.stopWrites).toEqual([{ stopId: 's02', viewed: true }]);
    });

    it('x сворачивает остановку под курсором', async () => {
        const view = mount();
        await view.settle();
        const section = stopSection(view.host, 's01');
        expect(section.querySelectorAll('.route-collapsed')).toHaveLength(0);
        view.hover(section);

        view.press('x');
        await view.settle();

        expect(stopSection(view.host, 's01').querySelectorAll('.route-collapsed')).toHaveLength(1);
    });

    it('c открывает композер на строке под курсором', async () => {
        const view = mount();
        await view.settle();
        const row = addedRow(stopSection(view.host, 's01'));
        view.hover(row.element);

        view.press('c');

        expect(view.threadStore.getComposer(`new:${row.fileId}:new:${String(row.line)}`)?.anchor?.position).toEqual({
            side: 'new',
            line: row.line,
            size: 1,
        });
    });

    it('r открывает ответ в тред под курсором', async () => {
        const view = mount();
        await view.settle();
        const thread = view.host.querySelector<HTMLElement>('[data-stop] .thread[data-thread-id]');
        const threadId = thread?.dataset.threadId;
        if (thread === null || threadId === undefined) {
            throw new Error('на маршруте нет нарисованного треда');
        }
        view.hover(thread.querySelector('.thread__row') ?? thread);

        view.press('r');

        expect(view.threadStore.getComposer(`reply:${threadId}`)?.threadId).toBe(threadId);
    });

    it('e раскрывает контекст ханка под курсором', async () => {
        const view = mount();
        await view.settle();
        const { element, fileId } = gapRow(view.host);
        view.hover(element);

        view.press('e');
        await view.settle();

        expect(view.store.getSnapshot().expansion.get(fileId)?.size).toBeGreaterThan(0);
    });

    it('строка и остановка приходят от одного узла: мышь на чужой остановке цель не уводит', async () => {
        const view = mount();
        await view.settle();
        const { element, fileId } = gapRow(view.host);
        act(() => {
            element.focus();
        });
        // Под курсором — остановка без этого файла. Возьми её вместе со строкой под фокусом,
        // и карточки не найдётся: контекст не раскроется вовсе.
        const foreign = [...view.host.querySelectorAll<HTMLElement>('[data-stop]')].find(
            (section) =>
                section !== element.closest('[data-stop]') &&
                section.querySelector(`.file-card[data-file="${CSS.escape(fileId)}"]`) === null,
        );
        if (foreign === undefined) {
            throw new Error('фикстуре нужна остановка без этого файла');
        }
        view.hover(foreign);

        view.press('e');
        await view.settle();

        expect(view.store.getSnapshot().expansion.get(fileId)?.size).toBeGreaterThan(0);
    });
});

/** Строка сразу под перемычкой: рядом с ней есть что раскрывать, и `e` доступна. */
function gapRow(host: HTMLElement): { readonly element: HTMLElement; readonly fileId: string } {
    const gap = host.querySelector<HTMLElement>('[data-stop] .file-card[data-file] .diff-gap');
    const fileId = gap?.closest<HTMLElement>('[data-file]')?.dataset.file;
    let row: HTMLElement | null = null;
    for (let node = gap?.nextElementSibling ?? null; node !== null; node = node.nextElementSibling) {
        const candidate = node.matches('[data-key]') ? node : node.querySelector('[data-key]');
        if (candidate instanceof HTMLElement) {
            row = candidate;
            break;
        }
    }
    if (row === null || fileId === undefined) {
        throw new Error('на маршруте нет перемычки со строкой под ней');
    }
    return { element: row, fileId };
}

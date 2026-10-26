// @vitest-environment jsdom
import { fixtureIteration, routeFixtures } from '@sherpa/fixtures';
import type { RouteSnapshot } from '@sherpa/protocol';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { toParseRequest } from '../../diff/model.js';
import { parseFileDiff } from '../../diff/parse.js';
import { createDiffViewStore } from '../../diff-view/store.js';
import { createSessionStore } from '../../session/session-store.js';
import { createThreadStore } from '../../threads/store.js';
import { RouteWorkspace } from './route-workspace.tsx';

/**
 * Фильтр «что нового» включают снаружи вью (кнопка баннера второго захода), поэтому проверяется
 * живая вью в jsdom: верхняя остановка, которую фильтр прячет, обязана остаться на экране —
 * так же, как при смене файлового фильтра (docs/design/SPEC-elements.md §2.7).
 *
 * Прямоугольников в jsdom нет: обмер подменяется так, чтобы верхней остановкой оказалась первая
 * секция разметки — именно её и должен удержать фильтр.
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
const KEPT_NOTE = 'оставлена на экране — вне текущего фильтра';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class {
    observe(): void {
        // Раскладки в jsdom нет.
    }
    unobserve(): void {
        // Раскладки в jsdom нет.
    }
    disconnect(): void {
        // Раскладки в jsdom нет.
    }
};

function rect(top: number, bottom: number): DOMRect {
    return {
        top,
        bottom,
        left: 0,
        right: 0,
        width: 0,
        height: bottom - top,
        x: 0,
        y: top,
        toJSON: () => ({}),
    };
}

beforeEach(() => {
    // Секции остановок — единственное, что имеет высоту: якорь тогда встаёт на первую из них.
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function stubbed(this: Element): DOMRect {
        return this instanceof HTMLElement && this.dataset.stop !== undefined ? rect(0, 100) : rect(0, 0);
    });
});

const mounted: (() => void)[] = [];

afterEach(() => {
    for (const unmount of mounted.splice(0)) {
        unmount();
    }
    vi.restoreAllMocks();
});

/** Классификация всем стопам, кроме одного: он и станет верхней остановкой вне фильтра. */
function snapshotChangedExcept(stopId: string): RouteSnapshot {
    return {
        ...SNAPSHOT,
        previousSnapshotId: 'route-medium-9f3c1ab',
        carried: { kept: 4, total: 7, zeroReason: null },
        stops: SNAPSHOT.stops.map((stop) =>
            stop.id === stopId ? stop : { ...stop, change: { kind: 'changed', reason: null, threadIds: [] } },
        ),
    };
}

function mount(snapshot: RouteSnapshot) {
    const host = document.createElement('div');
    document.body.append(host);
    const store = createDiffViewStore({ files: DATA.diff.files });
    for (const file of DATA.diff.files) {
        store.setModel(file.fileId, parseFileDiff(toParseRequest(file)));
    }
    const session = createSessionStore({ initial: { view: 'route', filter: 'all' } });
    const root = createRoot(host);
    act(() => {
        root.render(
            <RouteWorkspace
                pr={DATA.pr}
                diff={DATA.diff}
                lenses={{ ownership: DATA.ownership, extra: DATA.extraLenses, ownershipSource: 'CODEOWNERS' }}
                snapshot={snapshot}
                session={session}
                store={store}
                threadStore={createThreadStore(DATA.threads, FILE_IDS)}
                threadNow={Date.parse('2026-08-24T12:00:00.000Z')}
                parse={(file) => Promise.resolve(parseFileDiff(toParseRequest(file)))}
                loadContent={() => Promise.resolve(null)}
                onSetViewed={() => Promise.resolve(0)}
                onSetStopViewed={() => Promise.resolve(0)}
                onSetStopFileViewed={() => Promise.resolve(0)}
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

/** Первая секция остановки в разметке — та, что в подменённом обмере стоит вверху вьюпорта. */
function topStopId(host: HTMLElement): string {
    const section = host.querySelector<HTMLElement>('[data-stop]');
    if (section?.dataset.stop === undefined) {
        throw new Error('вью маршрута не нарисовала ни одной остановки');
    }
    return section.dataset.stop;
}

function stopIds(host: HTMLElement): string[] {
    return [...host.querySelectorAll<HTMLElement>('[data-stop]')].map((section) => section.dataset.stop ?? '');
}

describe('фильтр «что нового» и остановка, оставленная на экране', () => {
    it('верхняя остановка без изменений остаётся на экране с пометкой', () => {
        const first = topStopId(mount(SNAPSHOT).host);
        const { host, session } = mount(snapshotChangedExcept(first));

        expect(topStopId(host)).toBe(first);

        act(() => {
            session.setRouteFilter('new');
        });

        expect(stopIds(host)).toContain(first);
        expect(host.textContent).toContain(KEPT_NOTE);
    });

    it('верхняя остановка с изменениями фильтр проходит — оставлять нечего', () => {
        // Классификация у всех остановок: пустой id не совпадает ни с одной.
        const { host, session } = mount(snapshotChangedExcept(''));

        act(() => {
            session.setRouteFilter('new');
        });

        expect(host.textContent).not.toContain(KEPT_NOTE);
    });

    it('возврат к полному маршруту снимает пометку', () => {
        const first = topStopId(mount(SNAPSHOT).host);
        const { host, session } = mount(snapshotChangedExcept(first));

        act(() => {
            session.setRouteFilter('new');
        });
        act(() => {
            session.setRouteFilter('all');
        });

        expect(host.textContent).not.toContain(KEPT_NOTE);
    });
});

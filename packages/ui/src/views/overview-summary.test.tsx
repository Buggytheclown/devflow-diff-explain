// @vitest-environment jsdom
import { fixtureIteration, routeFixtures } from '@sherpa/fixtures';
import type { UiRouteState } from '@sherpa/protocol';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createSessionStore } from '../session/session-store.js';
import { createThreadStore } from '../threads/store.js';
import { ViewFrame } from './view-frames.tsx';

/**
 * Карточка «Кратко» рисует summary словарём описания остановки: абзацы, список, код, ссылки.
 * Внутренние ссылки уводят к остановке маршрута и к файлу полного диффа.
 */

const DATA = fixtureIteration('medium');
const FILE_IDS = new Set(DATA.diff.files.map((file) => file.fileId));
const DOCS_PATH = 'services/orders/docs/edit-window.md';

// React 19 требует явного признания среды: без него каждый `act` пишет предупреждение.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function readyState(): UiRouteState {
    const fixture = routeFixtures('medium')?.states.ready ?? null;
    if (fixture === null) {
        throw new Error('фикстуре medium нужно готовое состояние маршрута');
    }
    return fixture;
}

const mounted: { unmount: () => void; host: HTMLElement }[] = [];

afterEach(() => {
    for (const view of mounted.splice(0)) {
        act(() => {
            view.unmount();
        });
        view.host.remove();
    }
});

function mount(handlers: { onJumpToStop: (stopId: string) => void; onOpenFile: (fileId: string) => void }) {
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    act(() => {
        root.render(
            <ViewFrame
                view="overview"
                prKey="fixture-medium"
                session={createSessionStore({ initial: { view: 'overview', filter: 'all' } })}
                diff={DATA.diff}
                lenses={{ ownership: DATA.ownership, extra: DATA.extraLenses, ownershipSource: 'CODEOWNERS' }}
                threads={DATA.threads}
                threadStore={createThreadStore(DATA.threads, FILE_IDS)}
                threadNow={Date.parse('2026-08-24T12:00:00.000Z')}
                reviewHostAvailable
                generation={{ route: readyState() }}
                {...handlers}
            />,
        );
    });
    mounted.push({
        unmount: () => {
            root.unmount();
        },
        host,
    });
    const summary = host.querySelector<HTMLElement>('.overview-card__text.md-blocks');
    if (summary === null) {
        throw new Error('карточка «Кратко» не нарисовала summary');
    }
    return summary;
}

function link(summary: HTMLElement, href: string): HTMLElement {
    const element = summary.querySelector<HTMLElement>(`a[href="${href}"]`);
    if (element === null) {
        throw new Error(`в summary нет ссылки ${href}`);
    }
    return element;
}

describe('карточка «Кратко»', () => {
    it('рисует абзацы, список, инлайн-код и жирный словарём описания остановки', () => {
        const summary = mount({ onJumpToStop: vi.fn(), onOpenFile: vi.fn() });

        expect(summary.querySelectorAll('p.md-p').length).toBeGreaterThanOrEqual(3);
        expect(summary.querySelectorAll('ul.md-list > li')).toHaveLength(3);
        expect(summary.querySelector('code.md-code')?.textContent).toBe('EditWindow');
        expect(summary.querySelector('strong.md-strong')).not.toBeNull();
        expect(summary.textContent).not.toContain('`');
    });

    it('ссылка `#stop-N` уводит к остановке с этим плановым номером', () => {
        const onJumpToStop = vi.fn();
        const summary = mount({ onJumpToStop, onOpenFile: vi.fn() });

        act(() => {
            link(summary, '#stop-3').click();
        });

        expect(onJumpToStop).toHaveBeenCalledExactlyOnceWith('s03');
    });

    it('ссылка `#file-<path>` открывает файл диффа по его id', () => {
        const onOpenFile = vi.fn();
        const summary = mount({ onJumpToStop: vi.fn(), onOpenFile });
        const fileId = DATA.diff.files.find((file) => file.path === DOCS_PATH)?.fileId;

        act(() => {
            link(summary, `#file-${DOCS_PATH}`).click();
        });

        expect(fileId).toBeDefined();
        expect(onOpenFile).toHaveBeenCalledExactlyOnceWith(fileId);
    });
});

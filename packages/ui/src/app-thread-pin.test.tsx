// @vitest-environment jsdom
import { fixtureIteration, routeFixtures } from '@sherpa/fixtures';
import type { Iteration, RouteSnapshot, Thread, UiRouteState, UiState } from '@sherpa/protocol';
import { UI_ENDPOINTS } from '@sherpa/protocol';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { App } from './app.tsx';
import { updateFragment } from './fragment.js';
import type { Viewing } from './iterations/viewing.js';
import { sessionFragmentPatch } from './session/session-fragment.js';
import type { SessionStore } from './session/session-store.js';
import { createSessionStore } from './session/session-store.js';
import type { Store, StoreSnapshot } from './store.js';

/**
 * Переход «Показать на старом коммите»: тред, приколотый к прошлой итерации,
 * открывает её полный дифф с фокусом на себе. Точка входа — свёртка «вне диффа» в карточке
 * обсуждения на Обзоре (docs/design/SPEC-additions-2026-08-26.md §1e): такой тред больше нигде
 * не прочитать. Выбор итерации и `thread` уезжают во фрагмент одним патчем — иначе смена итерации сняла бы `thread` как якорь чужого диффа.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const V1 = fixtureIteration('medium', 0);
const V2 = fixtureIteration('medium', 1);

/**
 * Тред на файле, который ушёл из PR со вторым пушем: он в свёртке «вне диффа» на Обзоре.
 * Автор переписан человеком: бот-треды карточка обсуждения не раскрывает никогда (§1e п.3).
 */
const OUTSIDE_THREAD = (() => {
    const v2FileIds = new Set(V2.diff.files.map((file) => file.fileId));
    const thread = V2.threads.find(
        (candidate) => candidate.anchor !== null && !v2FileIds.has(candidate.anchor.fileId),
    );
    if (thread?.pinnedTo == null) {
        throw new Error('фикстуре medium нужен тред на ушедшем файле с пином');
    }
    return {
        ...thread,
        root: { ...thread.root, author: { login: 'morgan', displayName: 'Morgan Price', bot: false, avatarUrl: null } },
    };
})();

const THREADS: readonly Thread[] = V2.threads.map((thread) =>
    thread.id === OUTSIDE_THREAD.id ? OUTSIDE_THREAD : thread,
);

const READY_SNAPSHOT: RouteSnapshot = (() => {
    const snapshot = routeFixtures('medium')?.states.ready?.snapshot ?? null;
    if (snapshot === null) {
        throw new Error('фикстуре medium нужен готовый снапшот маршрута');
    }
    return snapshot;
})();

const ITERATIONS: readonly Iteration[] = [
    {
        diffId: V1.diff.diffId,
        baseCommit: V1.diff.baseCommit,
        headCommit: V1.diff.headCommit,
        createdAt: '2026-08-19T09:00:00.000Z',
        status: 'previous',
    },
    {
        diffId: V2.diff.diffId,
        baseCommit: V2.diff.baseCommit,
        headCommit: V2.diff.headCommit,
        createdAt: '2026-08-21T11:00:00.000Z',
        status: 'active',
    },
];

const ROUTE: UiRouteState = {
    phase: 'ready',
    smallPr: false,
    snapshot: { ...READY_SNAPSHOT, diffId: V2.diff.diffId, commit: V2.diff.headCommit },
    failure: null,
    stale: null,
};

const cleanups: (() => void)[] = [];

afterEach(() => {
    for (const cleanup of cleanups.splice(0)) {
        cleanup();
    }
    vi.restoreAllMocks();
});

interface Mounted {
    readonly host: HTMLElement;
    readonly session: SessionStore;
    readonly calls: string[];
    readonly settle: () => Promise<void>;
}

function mountApp(): Mounted {
    const originalFetch = globalThis.fetch;
    const globals = globalThis as { ResizeObserver?: unknown };
    const originalResizeObserver = globals.ResizeObserver;
    globals.ResizeObserver ??= class {
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

    const calls: string[] = [];
    const json = (body: unknown): Response =>
        new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    globalThis.fetch = (input: RequestInfo | URL): Promise<Response> => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        calls.push(url);
        const query = new URLSearchParams(url.split('?')[1] ?? '');
        switch (url.split('?')[0] ?? '') {
            case UI_ENDPOINTS.reviewDiff:
                return Promise.resolve(json({ diff: query.get('diffId') === V1.diff.diffId ? V1.diff : V2.diff }));
            case UI_ENDPOINTS.reviewLenses:
                return Promise.resolve(json({ ownership: V2.ownership, extra: V2.extraLenses, ownershipSource: 'CODEOWNERS' }));
            case UI_ENDPOINTS.reviewThreads:
                return Promise.resolve(json({ threads: THREADS }));
            case UI_ENDPOINTS.reviewProgress:
                return Promise.resolve(json({ diffId: query.get('diffId') ?? V2.diff.diffId, files: [], stops: [], progressRevision: 1 }));
            case UI_ENDPOINTS.reviewRoute:
                return Promise.resolve(json({ route: ROUTE, routeRevision: 1 }));
            case UI_ENDPOINTS.reviewSnapshots:
                return Promise.resolve(json({ snapshots: [] }));
            case UI_ENDPOINTS.reviewChat:
                return Promise.resolve(json({ exchanges: [], notes: [], chatRevision: 1 }));
            default:
                return Promise.resolve(json({}));
        }
    };

    const state: UiState = {
        prKey: 'fixture/medium',
        worker: { kind: 'never' },
        tasks: [],
        reviewHost: 'fixture',
        pr: V2.pr,
        feedback: { available: false, reason: 'Тестовый канал фидбека недоступен.' },
        iterations: [...ITERATIONS],
        update: null,
        generationCap: null,
    };
    const snapshot: StoreSnapshot = {
        connection: 'online',
        state,
        error: null,
        progressRevision: 1,
        threadsRevision: 1,
        routeRevision: 1,
        chatRevision: 1,
    };
    const store: Store = {
        subscribe: () => () => undefined,
        getSnapshot: () => snapshot,
        close: () => undefined,
    };

    // Адрес пишется тем же кодом, что и в main: иначе тест не увидит, переживает ли `thread`
    // смену итерации.
    window.location.hash = '#t=токен';
    let persistedViewing: Viewing = { kind: 'current' };
    const session = createSessionStore({
        initial: { view: 'overview', filter: 'all' },
        viewPinned: true,
        persist: (next, fragment) => {
            const patch = sessionFragmentPatch(next, persistedViewing, fragment);
            persistedViewing = next.viewing;
            history.replaceState(null, '', updateFragment(window.location.hash, patch));
        },
    });

    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    act(() => {
        root.render(<App store={store} session={session} token="токен" />);
    });

    cleanups.push(() => {
        act(() => {
            root.unmount();
        });
        host.remove();
        globalThis.fetch = originalFetch;
        globals.ResizeObserver = originalResizeObserver;
    });

    const settle = async (): Promise<void> => {
        for (let step = 0; step < 6; step += 1) {
            await act(async () => {
                await new Promise((resolve) => setTimeout(resolve, 0));
            });
        }
    };

    return { host, session, calls, settle };
}

function click(host: HTMLElement, selector: string): void {
    const element = host.querySelector<HTMLElement>(selector);
    expect(element, selector).not.toBeNull();
    act(() => {
        element?.click();
    });
}

describe('показать тред на старом коммите', () => {
    it('свёртка «вне диффа» на Обзоре раскрывает тред с чипом пина', async () => {
        const mounted = mountApp();
        await mounted.settle();

        expect(mounted.host.textContent).toContain('Вне диффа');

        click(mounted.host, '.discussion-card__outside-toggle');

        expect(mounted.host.textContent).toContain(
            `закреплён за ${(OUTSIDE_THREAD.pinnedTo?.commit ?? '').slice(0, 7)}`,
        );
        expect(mounted.host.querySelector('.thread__pin-action')).not.toBeNull();
    });

    it('переход открывает итерацию пина на полном диффе, сохранив `thread` во фрагменте', async () => {
        const mounted = mountApp();
        await mounted.settle();
        click(mounted.host, '.discussion-card__outside-toggle');
        click(mounted.host, '.thread__pin-action');
        await mounted.settle();

        expect(mounted.session.getSnapshot().view).toBe('diff');
        expect(mounted.session.getSnapshot().viewing).toEqual({ kind: 'diff', diffId: V1.diff.diffId });
        expect(window.location.hash).toContain(`diff=${V1.diff.diffId}`);
        expect(window.location.hash).toContain(`thread=${OUTSIDE_THREAD.id}`);
        expect(mounted.calls).toContain(`${UI_ENDPOINTS.reviewDiff}?diffId=${V1.diff.diffId}`);
    });

    it('прошлая итерация открывается в режиме чтения и без маршрута', async () => {
        const mounted = mountApp();
        await mounted.settle();
        click(mounted.host, '.discussion-card__outside-toggle');
        click(mounted.host, '.thread__pin-action');
        await mounted.settle();

        expect(mounted.host.textContent).toContain('Вы смотрите прошлую итерацию');
        expect(mounted.host.textContent).toContain('только чтение');
        expect(mounted.host.querySelector('.snapshot-pill')?.textContent).toContain(
            `дифф ${V1.diff.headCommit.slice(0, 7)} · без маршрута`,
        );
    });
});

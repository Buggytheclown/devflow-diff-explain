// @vitest-environment jsdom
import {
    fixtureIteration,
    MEDIUM_DIFF_ID,
    MEDIUM_DIFF_ID_V2,
    MEDIUM_HEAD_COMMIT,
    MEDIUM_HEAD_COMMIT_V2,
    routeFixtures,
} from '@sherpa/fixtures';
import type { Iteration, RouteSnapshot, UiRouteState, UiState } from '@sherpa/protocol';
import { UI_ENDPOINTS } from '@sherpa/protocol';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { App } from './app.tsx';
import type { RouteFilter, SessionStore } from './session/session-store.js';
import { createSessionStore } from './session/session-store.js';
import type { ViewId } from './session/views.js';
import type { Store, StoreSnapshot } from './store.js';

/**
 * Стыки итераций в App: какие баннеры живут на какой вкладке и в какой фазе, и что
 * недействительный фильтр «что нового» сбрасывается. Вкладка здесь всегда не маршрутная —
 * проверяется именно то, что видно вне маршрута; разметку самих баннеров проверяет
 * `iteration-banners.test.tsx`.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const DATA = fixtureIteration('medium');
const READY_SNAPSHOT: RouteSnapshot = (() => {
    const snapshot = routeFixtures('medium')?.states.ready?.snapshot ?? null;
    if (snapshot === null) {
        throw new Error('фикстуре medium нужен готовый снапшот маршрута');
    }
    return snapshot;
})();
const PR_COMMIT = 'a71d4e2c9b8f5301d6e4a2c7b09f8e3d5a4c6b21';

/** Второй заход: снапшот с предыдущим, перенесённым прогрессом и парой классифицированных стопов. */
function secondPass(changed: readonly string[]): RouteSnapshot {
    return {
        ...READY_SNAPSHOT,
        previousSnapshotId: 'route-medium-9f3c1ab',
        carried: { kept: 4, total: 7, zeroReason: null },
        stops: READY_SNAPSHOT.stops.map((stop) =>
            changed.includes(stop.id) ? { ...stop, change: { kind: 'changed', reason: null, threadIds: [] } } : stop,
        ),
    };
}

function routeState(patch: Partial<UiRouteState> = {}): UiRouteState {
    return { phase: 'ready', smallPr: false, snapshot: READY_SNAPSHOT, failure: null, stale: null, ...patch };
}

const STALE: UiRouteState['stale'] = {
    routeCommit: READY_SNAPSHOT.commit,
    prCommit: PR_COMMIT,
    prDiffId: '182801',
    newIterations: 2,
    affectedStopIds: [],
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
    readonly settle: () => Promise<void>;
    /** Сколько раз вкладка сходила за ручкой: у диффа и линз своей ревизии нет. */
    readonly calls: (endpoint: string) => number;
    /** Новый снимок состояния, как по SSE; с маршрутом растёт и `routeRevision` — он же перечитку и заводит. */
    readonly push: (patch: { readonly iterations?: readonly Iteration[]; readonly route?: UiRouteState }) => void;
}

/** Итерация PR в списке состояния; `active` — та, что отдают ручки без параметров. */
function iteration(diffId: string, headCommit: string, status: Iteration['status']): Iteration {
    return {
        diffId,
        baseCommit: READY_SNAPSHOT.baseCommit,
        headCommit,
        createdAt: '2026-08-21T10:00:00.000Z',
        status,
    };
}

function mountApp(options: {
    readonly route: UiRouteState;
    readonly view?: ViewId;
    readonly routeFilter?: RouteFilter;
    readonly iterations?: readonly Iteration[];
}): Mounted {
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

    // Маршрут и снимок состояния меняются по ходу теста: ручку и подписку кормит `push`.
    let route = options.route;
    const json = (body: unknown): Response =>
        new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    const calls = new Map<string, number>();
    globalThis.fetch = (input: RequestInfo | URL): Promise<Response> => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        const endpoint = url.split('?')[0] ?? '';
        calls.set(endpoint, (calls.get(endpoint) ?? 0) + 1);
        switch (endpoint) {
            case UI_ENDPOINTS.reviewDiff:
                return Promise.resolve(json({ diff: DATA.diff }));
            case UI_ENDPOINTS.reviewLenses:
                return Promise.resolve(json({ ownership: DATA.ownership, extra: DATA.extraLenses, ownershipSource: 'CODEOWNERS' }));
            case UI_ENDPOINTS.reviewThreads:
                return Promise.resolve(json({ threads: DATA.threads }));
            case UI_ENDPOINTS.reviewProgress:
                return Promise.resolve(json({ diffId: DATA.diff.diffId, files: [], stops: [], progressRevision: 1 }));
            case UI_ENDPOINTS.reviewRoute:
                return Promise.resolve(json({ route, routeRevision: snapshot.routeRevision ?? 1 }));
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
        pr: DATA.pr,
        feedback: { available: false, reason: 'Тестовый канал фидбека недоступен.' },
        iterations: [...(options.iterations ?? [])],
        update: null,
        generationCap: null,
    };
    let snapshot: StoreSnapshot = {
        connection: 'online',
        state,
        error: null,
        progressRevision: 1,
        threadsRevision: 1,
        routeRevision: 1,
        chatRevision: 1,
    };
    const listeners = new Set<() => void>();
    const store: Store = {
        subscribe: (listener) => {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        getSnapshot: () => snapshot,
        close: () => undefined,
    };

    const session = createSessionStore({
        initial: {
            view: options.view ?? 'overview',
            filter: 'all',
            ...(options.routeFilter === undefined ? {} : { routeFilter: options.routeFilter }),
        },
        viewPinned: true,
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
        for (let step = 0; step < 4; step += 1) {
            await act(async () => {
                await new Promise((resolve) => setTimeout(resolve, 0));
            });
        }
    };

    const push = (patch: { readonly iterations?: readonly Iteration[]; readonly route?: UiRouteState }): void => {
        if (patch.route !== undefined) {
            route = patch.route;
        }
        snapshot = {
            ...snapshot,
            routeRevision: (snapshot.routeRevision ?? 0) + (patch.route === undefined ? 0 : 1),
            state:
                patch.iterations === undefined
                    ? snapshot.state
                    : ({ ...snapshot.state, iterations: [...patch.iterations] } as UiState),
        };
        act(() => {
            for (const listener of listeners) {
                listener();
            }
        });
    };

    return { host, session, settle, calls: (endpoint) => calls.get(endpoint) ?? 0, push };
}

describe('баннеры итераций вне вкладки маршрута', () => {
    it('устаревший маршрут виден на любой вкладке: перестроить можно откуда угодно', async () => {
        const mounted = mountApp({ route: routeState({ stale: STALE }) });
        await mounted.settle();

        expect(mounted.host.textContent).toContain('Маршрут построен для');
        expect(mounted.host.textContent).toContain('Перестроить маршрут');
    });

    it('в фазе перестройки stale-баннер уходит: кнопка всё равно заблокирована', async () => {
        const mounted = mountApp({ route: routeState({ phase: 'reading', stale: STALE }) });
        await mounted.settle();

        expect(mounted.host.textContent).not.toContain('Маршрут построен для');
    });

    it('баннера второго захода вне маршрута нет: его кнопка включает фильтр маршрута', async () => {
        const mounted = mountApp({ route: routeState({ snapshot: secondPass(['s02']) }) });
        await mounted.settle();

        expect(mounted.host.textContent).not.toContain('Маршрут перестроен для');
    });
});

describe('действительность фильтра «что нового»', () => {
    it('готовый снапшот без классифицированных остановок сбрасывает фильтр', async () => {
        const mounted = mountApp({ route: routeState(), routeFilter: 'new' });
        await mounted.settle();

        expect(mounted.session.getSnapshot().routeFilter).toBe('all');
    });

    it('есть классифицированные остановки — фильтр остаётся включённым', async () => {
        const mounted = mountApp({ route: routeState({ snapshot: secondPass(['s02', 's03']) }), routeFilter: 'new' });
        await mounted.settle();

        expect(mounted.session.getSnapshot().routeFilter).toBe('new');
    });

    it('снапшота ещё нет — включённый фильтр не трогают', async () => {
        const mounted = mountApp({ route: routeState({ phase: 'none', snapshot: null }), routeFilter: 'new' });
        await mounted.settle();

        expect(mounted.session.getSnapshot().routeFilter).toBe('new');
    });
});

/**
 * Своей ревизии у диффа и линз нет: внутри итерации они неизменны. Перечитывать их надо в
 * момент, когда «без параметров» начинает означать другую итерацию, — а это приёмка нового
 * скелета, не сам пуш: маршрут на прошлой итерации читается целиком, без дрейфа якорей.
 */
describe('перечитка диффа и линз при смене итерации', () => {
    const V1_ACTIVE = iteration(MEDIUM_DIFF_ID, MEDIUM_HEAD_COMMIT, 'active');
    const V1_PREVIOUS = { ...V1_ACTIVE, status: 'previous' } as const;
    const V2_ACTIVE = iteration(MEDIUM_DIFF_ID_V2, MEDIUM_HEAD_COMMIT_V2, 'active');
    const SNAPSHOT_V2: RouteSnapshot = {
        ...READY_SNAPSHOT,
        snapshotId: 'route-medium-a71d4e2',
        diffId: MEDIUM_DIFF_ID_V2,
        commit: MEDIUM_HEAD_COMMIT_V2,
        previousSnapshotId: READY_SNAPSHOT.snapshotId,
    };

    it('пуш при живом маршруте дифф не трогает: снапшот остался на прошлой итерации', async () => {
        const mounted = mountApp({ route: routeState(), iterations: [V1_ACTIVE] });
        await mounted.settle();
        expect(mounted.calls(UI_ENDPOINTS.reviewDiff)).toBe(1);
        expect(mounted.calls(UI_ENDPOINTS.reviewLenses)).toBe(1);

        mounted.push({ iterations: [V1_PREVIOUS, V2_ACTIVE], route: routeState({ stale: STALE }) });
        await mounted.settle();

        expect(mounted.calls(UI_ENDPOINTS.reviewDiff)).toBe(1);
        expect(mounted.calls(UI_ENDPOINTS.reviewLenses)).toBe(1);
    });

    it('маршрут переехал на новую итерацию — дифф и линзы перечитаны', async () => {
        const mounted = mountApp({ route: routeState(), iterations: [V1_ACTIVE] });
        await mounted.settle();

        mounted.push({ iterations: [V1_PREVIOUS, V2_ACTIVE], route: routeState({ stale: STALE }) });
        await mounted.settle();
        expect(mounted.calls(UI_ENDPOINTS.reviewDiff)).toBe(1);

        mounted.push({ route: routeState({ snapshot: SNAPSHOT_V2 }) });
        await mounted.settle();

        expect(mounted.calls(UI_ENDPOINTS.reviewDiff)).toBe(2);
        expect(mounted.calls(UI_ENDPOINTS.reviewLenses)).toBe(2);
    });

    it('маршрута нет — читалка переезжает на новую итерацию сразу по пушу', async () => {
        const mounted = mountApp({
            route: routeState({ phase: 'none', snapshot: null }),
            iterations: [V1_ACTIVE],
        });
        await mounted.settle();

        mounted.push({ iterations: [V1_PREVIOUS, V2_ACTIVE] });
        await mounted.settle();

        expect(mounted.calls(UI_ENDPOINTS.reviewDiff)).toBe(2);
        expect(mounted.calls(UI_ENDPOINTS.reviewLenses)).toBe(2);
    });

    it('прочие изменения состояния за диффом не гоняют', async () => {
        const mounted = mountApp({ route: routeState(), iterations: [V1_ACTIVE] });
        await mounted.settle();

        mounted.push({ iterations: [V1_ACTIVE] });
        await mounted.settle();

        expect(mounted.calls(UI_ENDPOINTS.reviewDiff)).toBe(1);
    });
});

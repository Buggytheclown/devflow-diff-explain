// @vitest-environment jsdom
import { fixtureIteration, routeFixtures } from '@sherpa/fixtures';
import type { Iteration, RouteSnapshot, UiRouteStale, UiRouteState, UiSnapshotSummary, UiState } from '@sherpa/protocol';
import { UI_ENDPOINTS } from '@sherpa/protocol';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { App } from './app.tsx';
import { parseFileDiff } from './diff/parse.js';
import type { Viewing } from './iterations/viewing.js';
import type { SessionStore } from './session/session-store.js';
import { createSessionStore } from './session/session-store.js';
import type { ViewId } from './session/views.js';
import type { Store, StoreSnapshot } from './store.js';

/**
 * Пикер снапшотов в App: какие параметры уезжают в ручки при выборе прошлого снапшота,
 * что показывает баннер режима чтения и как приложение переживает сервер без ручки снапшотов.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const DATA = fixtureIteration('medium');
const CURRENT_SNAPSHOT: RouteSnapshot = (() => {
    const snapshot = routeFixtures('medium')?.states.ready?.snapshot ?? null;
    if (snapshot === null) {
        throw new Error('фикстуре medium нужен готовый снапшот маршрута');
    }
    return snapshot;
})();
const OLD_COMMIT = '5c1d0aa8b7e6f4302d9c8b7a6f5e4d3c2b1a0999';
const OLD_DIFF_ID = '182799';

const OLD_SNAPSHOT: RouteSnapshot = {
    ...CURRENT_SNAPSHOT,
    snapshotId: 'route-medium-5c1d0aa',
    commit: OLD_COMMIT,
    diffId: OLD_DIFF_ID,
    createdAt: '2026-08-31T06:00:00.000Z',
};

function summaryOf(snapshot: RouteSnapshot, status: UiSnapshotSummary['status']): UiSnapshotSummary {
    return {
        snapshotId: snapshot.snapshotId,
        diffId: snapshot.diffId,
        commit: snapshot.commit,
        baseCommit: snapshot.baseCommit,
        createdAt: snapshot.createdAt,
        provenance: snapshot.provenance,
        previousSnapshotId: snapshot.previousSnapshotId,
        status,
    };
}

const SNAPSHOTS: readonly UiSnapshotSummary[] = [
    summaryOf(OLD_SNAPSHOT, 'stale'),
    summaryOf(CURRENT_SNAPSHOT, 'current'),
];

function routeState(patch: Partial<UiRouteState> = {}): UiRouteState {
    return { phase: 'ready', smallPr: false, snapshot: CURRENT_SNAPSHOT, failure: null, stale: null, ...patch };
}

/** PR ушёл вперёд от снапшота: активная итерация известна только из `stale` — сервер старой версии срезов не отдаёт. */
const PR_COMMIT = 'c0ffee1b2a3d4e5f60718293a4b5c6d7e8f90123';
const PR_DIFF_ID = '182802';
const STALE: UiRouteStale = {
    routeCommit: CURRENT_SNAPSHOT.commit,
    prCommit: PR_COMMIT,
    prDiffId: PR_DIFF_ID,
    newIterations: 1,
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
    readonly calls: string[];
    readonly setIterations: (iterations: readonly Iteration[]) => void;
    readonly settle: () => Promise<void>;
}

function mountApp(options: {
    readonly viewing?: Viewing;
    readonly view?: ViewId;
    readonly snapshots?: readonly UiSnapshotSummary[] | 'missing';
    readonly route?: UiRouteState;
}): Mounted {
    const originalFetch = globalThis.fetch;
    const globals = globalThis as { Worker?: unknown; ResizeObserver?: unknown };
    const originalWorker = globals.Worker;
    const originalResizeObserver = globals.ResizeObserver;

    // Настоящего воркера в jsdom нет, а фоновый разбор диффа стартует по таймеру и на
    // загруженной машине успевает до размонтирования: разбираем тем же парсером в том же потоке.
    class FakeWorker {
        private readonly listeners = new Map<string, ((event: unknown) => void)[]>();
        addEventListener(type: string, listener: (event: unknown) => void): void {
            this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
        }
        postMessage(message: { id: number; file: Parameters<typeof parseFileDiff>[0] }): void {
            const reply = { id: message.id, ok: true, model: parseFileDiff(message.file) };
            queueMicrotask(() => {
                for (const listener of this.listeners.get('message') ?? []) {
                    listener({ data: reply });
                }
            });
        }
        terminate(): void {
            this.listeners.clear();
        }
    }
    globals.Worker = FakeWorker;
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
    const notFound = (): Response =>
        new Response(JSON.stringify({ error: { code: 'not_found', message: 'ручки нет' } }), {
            status: 404,
            headers: { 'content-type': 'application/json' },
        });
    const route = options.route ?? routeState();
    globalThis.fetch = (input: RequestInfo | URL): Promise<Response> => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        calls.push(url);
        const query = new URLSearchParams(url.split('?')[1] ?? '');
        switch (url.split('?')[0] ?? '') {
            case UI_ENDPOINTS.reviewDiff:
                return Promise.resolve(
                    json({
                        diff:
                            query.get('diffId') === null
                                ? DATA.diff
                                : { ...DATA.diff, diffId: query.get('diffId'), headCommit: OLD_COMMIT },
                    }),
                );
            case UI_ENDPOINTS.reviewLenses:
                return Promise.resolve(json({ ownership: DATA.ownership, extra: DATA.extraLenses, ownershipSource: 'CODEOWNERS' }));
            case UI_ENDPOINTS.reviewThreads:
                return Promise.resolve(json({ threads: DATA.threads }));
            case UI_ENDPOINTS.reviewProgress:
                return Promise.resolve(
                    json({
                        diffId: query.get('diffId') ?? DATA.diff.diffId,
                        files: [],
                        stops: [],
                        progressRevision: 1,
                    }),
                );
            case UI_ENDPOINTS.reviewRoute:
                return Promise.resolve(
                    json({
                        route:
                            query.get('snapshot') === null
                                ? route
                                : { ...route, snapshot: OLD_SNAPSHOT, stale: null },
                        routeRevision: 1,
                    }),
                );
            case UI_ENDPOINTS.reviewSnapshots:
                return options.snapshots === 'missing'
                    ? Promise.resolve(notFound())
                    : Promise.resolve(json({ snapshots: options.snapshots ?? SNAPSHOTS }));
            case UI_ENDPOINTS.reviewChat:
                return Promise.resolve(json({ exchanges: [], notes: [], chatRevision: 1 }));
            default:
                return Promise.resolve(json({}));
        }
    };

    let state: UiState = {
        prKey: 'fixture/medium',
        worker: { kind: 'never' },
        tasks: [],
        reviewHost: 'fixture',
        pr: DATA.pr,
        feedback: { available: false, reason: 'Тестовый канал фидбека недоступен.' },
        iterations: [],
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
            return () => {
                listeners.delete(listener);
            };
        },
        getSnapshot: () => snapshot,
        close: () => undefined,
    };
    const setIterations = (iterations: readonly Iteration[]): void => {
        state = { ...state, iterations: [...iterations] };
        snapshot = { ...snapshot, state };
        for (const listener of [...listeners]) {
            listener();
        }
    };

    const session = createSessionStore({
        initial: {
            view: options.view ?? 'overview',
            filter: 'all',
            ...(options.viewing === undefined ? {} : { viewing: options.viewing }),
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
        globals.Worker = originalWorker;
        globals.ResizeObserver = originalResizeObserver;
    });

    const settle = async (): Promise<void> => {
        for (let step = 0; step < 6; step += 1) {
            await act(async () => {
                await new Promise((resolve) => setTimeout(resolve, 0));
            });
        }
    };

    return { host, session, calls, setIterations, settle };
}

describe('выбор прошлого снапшота', () => {
    it('шлёт ручкам параметры выбранного снапшота и его итерации', async () => {
        const mounted = mountApp({ viewing: { kind: 'snapshot', snapshotId: OLD_SNAPSHOT.snapshotId } });
        await mounted.settle();

        expect(mounted.calls).toContain(`${UI_ENDPOINTS.reviewRoute}?snapshot=${OLD_SNAPSHOT.snapshotId}`);
        expect(mounted.calls).toContain(`${UI_ENDPOINTS.reviewDiff}?diffId=${OLD_DIFF_ID}`);
        expect(mounted.calls).toContain(`${UI_ENDPOINTS.reviewProgress}?diffId=${OLD_DIFF_ID}`);
    });

    it('поднимает баннер режима чтения и возвращает к текущему', async () => {
        const mounted = mountApp({ viewing: { kind: 'snapshot', snapshotId: OLD_SNAPSHOT.snapshotId } });
        await mounted.settle();

        expect(mounted.host.textContent).toContain('Вы смотрите снапшот');
        expect(mounted.host.textContent).toContain('только чтение');

        const back = [...mounted.host.querySelectorAll('button')].find(
            (button) => button.textContent === 'К текущему',
        );
        expect(back).toBeDefined();
        act(() => {
            back?.click();
        });

        expect(mounted.session.getSnapshot().viewing).toEqual({ kind: 'current' });
    });

    it('в режиме чтения прогресс не пишется: ни отметок, ни зеркала', async () => {
        const mounted = mountApp({
            viewing: { kind: 'snapshot', snapshotId: OLD_SNAPSHOT.snapshotId },
            view: 'diff',
        });
        await mounted.settle();

        // Отметки и зеркало покрытия — единственные записи прогресса; в чтении их нет.
        expect(mounted.calls.some((url) => url.startsWith(UI_ENDPOINTS.reviewViewedMirror))).toBe(false);
        expect(mounted.calls.some((url) => url.startsWith(UI_ENDPOINTS.reviewFileViewed))).toBe(false);
        expect(mounted.calls.some((url) => url.startsWith(UI_ENDPOINTS.reviewStopViewed))).toBe(false);
    });

    it('индикатор в шапке называет выбранный снапшот и его статус', async () => {
        const mounted = mountApp({
            viewing: { kind: 'snapshot', snapshotId: OLD_SNAPSHOT.snapshotId },
            view: 'diff',
        });
        await mounted.settle();

        expect(mounted.host.querySelector('.snapshot-pill')?.textContent).toContain(
            `снапшот ${OLD_COMMIT.slice(0, 7)} · устарел`,
        );
    });

    it('новый список итераций по SSE выбор не сбрасывает', async () => {
        const mounted = mountApp({ viewing: { kind: 'snapshot', snapshotId: OLD_SNAPSHOT.snapshotId } });
        await mounted.settle();

        act(() => {
            mounted.setIterations([
                {
                    diffId: OLD_DIFF_ID,
                    baseCommit: 'base',
                    headCommit: OLD_COMMIT,
                    createdAt: '2026-08-31T06:00:00.000Z',
                    status: 'previous',
                },
                {
                    diffId: CURRENT_SNAPSHOT.diffId,
                    baseCommit: 'base',
                    headCommit: CURRENT_SNAPSHOT.commit,
                    createdAt: '2026-08-31T09:00:00.000Z',
                    status: 'active',
                },
            ]);
        });
        await mounted.settle();

        expect(mounted.session.getSnapshot().viewing).toEqual({
            kind: 'snapshot',
            snapshotId: OLD_SNAPSHOT.snapshotId,
        });
        expect(mounted.host.textContent).toContain('только чтение');
    });
});

describe('сервер без ручки снапшотов', () => {
    it('404 не ломает приложение и не показывает ошибку', async () => {
        const mounted = mountApp({ snapshots: 'missing', view: 'diff' });
        await mounted.settle();

        expect(mounted.host.textContent).not.toContain('ручки нет');
        expect(mounted.host.querySelector('.snapshot-pill')?.textContent).toContain('снапшот');
        expect(mounted.host.textContent).not.toContain('только чтение');
    });

    it('неизвестный выбор из адреса снимается и показывается текущее', async () => {
        const mounted = mountApp({ snapshots: 'missing', viewing: { kind: 'snapshot', snapshotId: 'нет-такого' } });
        await mounted.settle();

        expect(mounted.session.getSnapshot().viewing).toEqual({ kind: 'current' });
        expect(mounted.host.textContent).not.toContain('только чтение');
    });
});

/**
 * Сегодняшний сервер шлёт `iterations: []`, и об активной итерации знает только маршрут
 * без параметров. Он читается отдельно от данных вкладки — иначе выбор итерации стирал бы
 * то, по чему сам же и разрешается, и слетал бы в «текущее».
 */
describe('выбор итерации без списка итераций', () => {
    it('переживает перезагрузку с `diff=` в адресе', async () => {
        const mounted = mountApp({
            viewing: { kind: 'diff', diffId: PR_DIFF_ID },
            view: 'diff',
            route: routeState({ stale: STALE }),
        });
        await mounted.settle();

        expect(mounted.session.getSnapshot().viewing).toEqual({ kind: 'diff', diffId: PR_DIFF_ID });
        // Это активная итерация: ручки те же, без параметров, и запись не запрещена.
        expect(mounted.calls.some((url) => url.includes(`diffId=${PR_DIFF_ID}`))).toBe(false);
        expect(mounted.host.textContent).not.toContain('только чтение');
        expect(mounted.host.querySelector('.snapshot-pill')?.textContent).toContain(
            `дифф ${PR_COMMIT.slice(0, 7)} · без маршрута`,
        );
    });

    it('держится после «Открыть дифф … без маршрута» в stale-баннере', async () => {
        const mounted = mountApp({ view: 'diff', route: routeState({ stale: STALE }) });
        await mounted.settle();

        const open = [...mounted.host.querySelectorAll('button')].find((button) =>
            button.textContent.startsWith('Открыть дифф'),
        );
        expect(open).toBeDefined();
        act(() => {
            open?.click();
        });
        await mounted.settle();

        expect(mounted.session.getSnapshot().viewing).toEqual({ kind: 'diff', diffId: PR_DIFF_ID });
        expect(mounted.host.textContent).not.toContain('только чтение');
    });

    it('перегенерация на активной итерации режимом чтения не становится', async () => {
        const regenerated: RouteSnapshot = {
            ...CURRENT_SNAPSHOT,
            snapshotId: 'route-medium-regen',
            createdAt: '2026-08-31T07:00:00.000Z',
        };
        const mounted = mountApp({
            viewing: { kind: 'snapshot', snapshotId: regenerated.snapshotId },
            view: 'diff',
            snapshots: [summaryOf(regenerated, 'stale'), summaryOf(CURRENT_SNAPSHOT, 'current')],
        });
        await mounted.settle();

        expect(mounted.session.getSnapshot().viewing).toEqual({ kind: 'snapshot', snapshotId: regenerated.snapshotId });
        expect(mounted.host.textContent).not.toContain('только чтение');
    });
});

describe('режим чтения гасит запись во всех точках', () => {
    it('терминальные действия выключены с подсказкой', async () => {
        const mounted = mountApp({
            viewing: { kind: 'snapshot', snapshotId: OLD_SNAPSHOT.snapshotId },
            view: 'diff',
        });
        await mounted.settle();

        const disabled = [...mounted.host.querySelectorAll<HTMLButtonElement>('button[disabled]')];
        expect(disabled.some((button) => button.title === 'только в активной итерации')).toBe(true);
    });

    it('на Обзоре индикатор снапшота стоит в шапке PR', async () => {
        const mounted = mountApp({ view: 'overview' });
        await mounted.settle();

        expect(mounted.host.querySelector('.pr-header .snapshot-pill')).not.toBeNull();
    });
});

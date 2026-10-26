// @vitest-environment jsdom
import { fixtureInterdiff, fixtureIteration } from '@sherpa/fixtures';
import type { Iteration, PrDiff, UiState } from '@sherpa/protocol';
import { UI_ENDPOINTS } from '@sherpa/protocol';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { App } from './app.tsx';
import type { Viewing } from './iterations/viewing.js';
import type { SessionStore } from './session/session-store.js';
import { createSessionStore } from './session/session-store.js';
import type { ViewId } from './session/views.js';
import type { Store, StoreSnapshot } from './store.js';

/**
 * Срез между итерациями в App: какими параметрами грузится дифф, чего в срезе не
 * спрашивают вовсе, и что показывают шапка, баннер, вкладка маршрута и пустой срез.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const V1 = fixtureIteration('medium', 0);
const V2 = fixtureIteration('medium', 1);
const V3 = fixtureIteration('medium', 2);
const INTERDIFF: PrDiff = fixtureInterdiff('medium', 0, 1);
const BASE = V1.iteration.diffId;
const HEAD = V2.iteration.diffId;
const SLICE: Viewing = { kind: 'slice', base: BASE, head: HEAD };

const ITERATIONS: readonly Iteration[] = [
    { ...V1.iteration, status: 'previous' },
    { ...V2.iteration, status: 'active' },
];

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

function mountApp(options: {
    readonly viewing?: Viewing;
    readonly view?: ViewId;
    /** Ответ ручки среза; по умолчанию — интердифф фикстуры. */
    readonly interdiff?: PrDiff;
    /** Ручка среза отвечает отказом с этим текстом (400 у Арканума, 502 у фикстуры). */
    readonly sliceError?: string;
    /** Итерации PR; по умолчанию — v1 прошлая и v2 активная. */
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

    const calls: string[] = [];
    const json = (body: unknown): Response =>
        new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    globalThis.fetch = (input: RequestInfo | URL): Promise<Response> => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        calls.push(url);
        const query = new URLSearchParams(url.split('?')[1] ?? '');
        switch (url.split('?')[0] ?? '') {
            case UI_ENDPOINTS.reviewDiff:
                if (query.get('base') !== null && options.sliceError !== undefined) {
                    return Promise.resolve(
                        new Response(JSON.stringify({ error: { code: 'bad_request', message: options.sliceError } }), {
                            status: 400,
                            headers: { 'content-type': 'application/json' },
                        }),
                    );
                }
                return Promise.resolve(
                    json({ diff: query.get('base') === null ? V2.diff : (options.interdiff ?? INTERDIFF) }),
                );
            case UI_ENDPOINTS.reviewLenses:
                return Promise.resolve(json({ ownership: V2.ownership, extra: V2.extraLenses, ownershipSource: 'CODEOWNERS' }));
            case UI_ENDPOINTS.reviewThreads:
                return Promise.resolve(json({ threads: V2.threads }));
            case UI_ENDPOINTS.reviewProgress:
                return Promise.resolve(json({ diffId: query.get('diffId') ?? V2.diff.diffId, files: [], stops: [], progressRevision: 1 }));
            case UI_ENDPOINTS.reviewRoute:
                return Promise.resolve(
                    json({
                        route: { phase: 'none', smallPr: false, snapshot: null, failure: null, stale: null },
                        routeRevision: 1,
                    }),
                );
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
        iterations: [...(options.iterations ?? ITERATIONS)],
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

    const session = createSessionStore({
        initial: {
            view: options.view ?? 'diff',
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

describe('срез между итерациями', () => {
    it('грузит дифф ручкой base/head и не спрашивает ни прогресс, ни линзы', async () => {
        const mounted = mountApp({ viewing: SLICE });
        await mounted.settle();

        expect(mounted.calls).toContain(`${UI_ENDPOINTS.reviewDiff}?base=${BASE}&head=${HEAD}`);
        expect(mounted.calls.some((url) => url.startsWith(UI_ENDPOINTS.reviewProgress))).toBe(false);
        expect(mounted.calls.some((url) => url.startsWith(UI_ENDPOINTS.reviewLenses))).toBe(false);
        // Дифф итерации в срезе не нужен: ручку без параметров никто не зовёт.
        expect(mounted.calls).not.toContain(UI_ENDPOINTS.reviewDiff);
    });

    it('индикатор называет обе стороны, а баннер объясняет режим чтения', async () => {
        const mounted = mountApp({ viewing: SLICE });
        await mounted.settle();

        expect(mounted.host.querySelector('.snapshot-pill')?.textContent).toContain(
            `срез ${V1.iteration.headCommit.slice(0, 7)} → ${V2.iteration.headCommit.slice(0, 7)}`,
        );
        expect(mounted.host.textContent).toContain('Вы смотрите срез между итерациями');
        expect(mounted.host.textContent).toContain('только чтение');
    });

    it('«К активной итерации» возвращает вкладку к активной итерации', async () => {
        const mounted = mountApp({ viewing: SLICE });
        await mounted.settle();

        const back = [...mounted.host.querySelectorAll('button')].find(
            (button) => button.textContent === 'К активной итерации',
        );
        expect(back).toBeDefined();
        act(() => {
            back?.click();
        });

        expect(mounted.session.getSnapshot().viewing).toEqual({ kind: 'current' });
    });

    it('в срезе выключена запись: причина у контролов своя', async () => {
        const mounted = mountApp({ viewing: SLICE });
        await mounted.settle();

        const disabled = [...mounted.host.querySelectorAll<HTMLButtonElement>('button[disabled]')];
        expect(disabled.some((button) => button.title === 'в срезе между итерациями')).toBe(true);
        expect(disabled.some((button) => button.title === 'только в активной итерации')).toBe(false);
    });

    it('пустой срез показывает честный экран и выход к активной итерации', async () => {
        const mounted = mountApp({ viewing: SLICE, interdiff: { ...INTERDIFF, files: [] } });
        await mounted.settle();

        expect(mounted.host.textContent).toContain(
            `Между итерациями ${V1.iteration.headCommit.slice(0, 7)} → ${V2.iteration.headCommit.slice(0, 7)} изменений нет`,
        );
        const back = [...mounted.host.querySelectorAll('button')].find(
            (button) => button.textContent === 'К активной итерации',
        );
        expect(back).toBeDefined();
    });

    it('отказ ручки среза показан как есть, с выходом к активной итерации', async () => {
        const mounted = mountApp({ viewing: SLICE, sliceError: 'итерация 182799 неизвестна хосту' });
        await mounted.settle();

        expect(mounted.host.textContent).toContain('итерация 182799 неизвестна хосту');
        const back = [...mounted.host.querySelectorAll('button')].find(
            (button) => button.textContent === 'К активной итерации',
        );
        expect(back).toBeDefined();
        act(() => {
            back?.click();
        });

        expect(mounted.session.getSnapshot().viewing).toEqual({ kind: 'current' });
    });

    it('вкладка маршрута объясняет, что для среза маршрут не строится', async () => {
        const mounted = mountApp({ viewing: SLICE, view: 'route' });
        await mounted.settle();

        expect(mounted.host.textContent).toContain('Маршрут для среза между итерациями не строится');
        const toDiff = [...mounted.host.querySelectorAll('button')].find(
            (button) => button.textContent === 'К полному диффу',
        );
        expect(toDiff).toBeDefined();
        act(() => {
            toDiff?.click();
        });
        await mounted.settle();

        expect(mounted.session.getSnapshot().view).toBe('diff');
        // Срез при переходе на вкладку диффа сохраняется.
        expect(mounted.session.getSnapshot().viewing).toEqual(SLICE);
    });

    it('вкладка обзора не показывает пустые карточки, а объясняет, почему их нет', async () => {
        const mounted = mountApp({ viewing: SLICE, view: 'overview' });
        await mounted.settle();

        expect(mounted.host.textContent).toContain('Для среза обзор не собирается');
        // Пустые линзы среза не должны выдавать себя за ответ хоста про зоны ответственности.
        expect(mounted.host.textContent).not.toContain('Хост не отдал зону ответственности');
        const toDiff = [...mounted.host.querySelectorAll('button')].find(
            (button) => button.textContent === 'К полному диффу',
        );
        act(() => {
            toDiff?.click();
        });

        expect(mounted.session.getSnapshot().view).toBe('diff');
        expect(mounted.session.getSnapshot().viewing).toEqual(SLICE);
    });

    it('срез с несуществующей базой снимается: вкладка падает в активную итерацию', async () => {
        const mounted = mountApp({ viewing: { kind: 'slice', base: 'нет-такой', head: HEAD } });
        await mounted.settle();

        expect(mounted.session.getSnapshot().viewing).toEqual({ kind: 'current' });
        expect(mounted.host.textContent).not.toContain('Вы смотрите срез');
    });

    describe('срез между двумя прошлыми итерациями, когда активная ушла дальше', () => {
        const THREE: readonly Iteration[] = [
            { ...V1.iteration, status: 'previous' },
            { ...V2.iteration, status: 'previous' },
            { ...V3.iteration, status: 'active' },
        ];

        it('открывается из адреса: дифф грузится ручкой base/head, индикатор называет обе стороны', async () => {
            const mounted = mountApp({ viewing: SLICE, iterations: THREE });
            await mounted.settle();

            expect(mounted.session.getSnapshot().viewing).toEqual(SLICE);
            expect(mounted.calls).toContain(`${UI_ENDPOINTS.reviewDiff}?base=${BASE}&head=${HEAD}`);
            expect(mounted.host.querySelector('.snapshot-pill')?.textContent).toContain(
                `срез ${V1.iteration.headCommit.slice(0, 7)} → ${V2.iteration.headCommit.slice(0, 7)}`,
            );
            expect(mounted.host.textContent).toContain('Вы смотрите срез между итерациями');
        });

        it('открывается из меню в два шага: Shift+клик по одной прошлой итерации, клик по другой', async () => {
            const mounted = mountApp({ viewing: { kind: 'diff', diffId: BASE }, iterations: THREE });
            await mounted.settle();

            act(() => {
                mounted.host.querySelector<HTMLButtonElement>('button.snapshot-pill--button')?.click();
            });
            act(() => {
                mounted.host
                    .querySelector(`.snapshot-picker__row[data-diff="${HEAD}"]`)
                    ?.dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true }));
            });
            // Первый край меню не закрывает и выбора не меняет.
            expect(mounted.session.getSnapshot().viewing).toEqual({ kind: 'diff', diffId: BASE });
            act(() => {
                mounted.host
                    .querySelector(`.snapshot-picker__row[data-diff="${BASE}"]`)
                    ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
            });
            await mounted.settle();

            expect(mounted.session.getSnapshot().viewing).toEqual(SLICE);
            expect(mounted.calls).toContain(`${UI_ENDPOINTS.reviewDiff}?base=${BASE}&head=${HEAD}`);
        });
    });
});

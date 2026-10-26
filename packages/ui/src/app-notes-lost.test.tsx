// @vitest-environment jsdom
import { chatFixtures, fixtureIteration } from '@sherpa/fixtures';
import type { AgentNote, UiChatResponse, UiRouteState, UiState } from '@sherpa/protocol';
import { UI_ENDPOINTS } from '@sherpa/protocol';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { App } from './app.tsx';
import type { SessionStore } from './session/session-store.js';
import { createSessionStore } from './session/session-store.js';
import type { ViewId } from './session/views.js';
import type { Store, StoreSnapshot } from './store.js';

/**
 * Заметки, потерявшие якорь после пуша: баннер приоритета 120, его действие открывает
 * чат на потерявшей заметке, а чип у обмена называет её последнее удачное место.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
HTMLElement.prototype.scrollIntoView = function noopScrollIntoView(): void {
    // В jsdom нет прокрутки.
};

const V2 = fixtureIteration('medium', 1);
const CHAT = chatFixtures('medium');
const NOTES: readonly AgentNote[] = CHAT?.notesAfterPush ?? [];
const LOST = NOTES.find((note) => note.lostAnchor);

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
}

function mountApp(options: { readonly notes?: readonly AgentNote[]; readonly view?: ViewId } = {}): Mounted {
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

    const chat: UiChatResponse = {
        exchanges: [...(CHAT?.exchanges ?? [])],
        notes: [...(options.notes ?? NOTES)],
        chatRevision: 1,
    };
    const route: UiRouteState = {
        phase: 'none',
        smallPr: false,
        snapshot: null,
        failure: null,
        stale: null,
    };
    const json = (body: unknown): Response =>
        new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    globalThis.fetch = (input: RequestInfo | URL): Promise<Response> => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        const query = new URLSearchParams(url.split('?')[1] ?? '');
        switch (url.split('?')[0] ?? '') {
            case UI_ENDPOINTS.reviewDiff:
                return Promise.resolve(json({ diff: V2.diff }));
            case UI_ENDPOINTS.reviewLenses:
                return Promise.resolve(json({ ownership: V2.ownership, extra: V2.extraLenses, ownershipSource: 'CODEOWNERS' }));
            case UI_ENDPOINTS.reviewThreads:
                return Promise.resolve(json({ threads: V2.threads }));
            case UI_ENDPOINTS.reviewProgress:
                return Promise.resolve(json({ diffId: query.get('diffId') ?? V2.diff.diffId, files: [], stops: [], progressRevision: 1 }));
            case UI_ENDPOINTS.reviewRoute:
                return Promise.resolve(json({ route, routeRevision: 1 }));
            case UI_ENDPOINTS.reviewChat:
                return Promise.resolve(json(chat));
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
        iterations: [{ ...V2.iteration, status: 'active' }],
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
        initial: { view: options.view ?? 'overview', filter: 'all' },
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

    return { host, session, settle };
}

function buttonWith(host: HTMLElement, text: string): HTMLButtonElement | undefined {
    return [...host.querySelectorAll<HTMLButtonElement>('button')].find((button) =>
        button.textContent.includes(text),
    );
}

describe('уведомление о заметках без якоря', () => {
    it('баннер называет число потерявших якорь и виден вне вкладки маршрута', async () => {
        const mounted = mountApp();
        await mounted.settle();

        expect(mounted.host.textContent).toContain('1 заметка потеряла якорь после нового пуша');
    });

    it('без потерянных заметок баннера нет', async () => {
        const mounted = mountApp({ notes: NOTES.filter((note) => !note.lostAnchor) });
        await mounted.settle();

        expect(mounted.host.textContent).not.toContain('потеряла якорь после нового пуша');
    });

    it('«Показать» открывает чат на потерявшей заметке и её обмене', async () => {
        const mounted = mountApp();
        await mounted.settle();
        expect(mounted.session.getSnapshot().chatOpen).toBe(false);

        await act(async () => {
            buttonWith(mounted.host, 'Показать')?.click();
            await Promise.resolve();
        });
        await mounted.settle();

        expect(mounted.session.getSnapshot().chatOpen).toBe(true);
        const exchange = mounted.host.querySelector(`[data-exchange="${String(LOST?.exchangeId ?? 0)}"]`);
        expect(exchange?.textContent).toContain('якорь потерян после пуша');
        // Переходить из чата к коду некуда: в активной итерации заметки там нет.
        const pin = exchange?.querySelector<HTMLButtonElement>('.chat-message__note');
        expect(pin?.disabled).toBe(true);
        expect(pin?.title).toBe('якорь потерян — в коде этой итерации заметки нет');
    });

    it('крестик закрывает баннер на эту сессию вкладки', async () => {
        const mounted = mountApp();
        await mounted.settle();

        await act(async () => {
            mounted.host
                .querySelector<HTMLButtonElement>('[aria-label="Скрыть баннер о потерянных заметках"]')
                ?.click();
            await Promise.resolve();
        });

        expect(mounted.host.textContent).not.toContain('потеряла якорь после нового пуша');
    });
});

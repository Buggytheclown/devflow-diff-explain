// @vitest-environment jsdom
import { fixtureIteration, routeFixtures } from '@sherpa/fixtures';
import type { UiState } from '@sherpa/protocol';
import { UI_ENDPOINTS } from '@sherpa/protocol';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';

import { App } from './app.tsx';
import type { DiffParseMessage, DiffParseReply } from './diff/client.js';
import { parseFileDiff } from './diff/parse.js';
import { createSessionStore } from './session/session-store.js';
import type { Store, StoreSnapshot } from './store.js';

/**
 * «Прочее» целиком через приложение. Точки входа Ask AI: «Прочее» открывает чат с перечнем
 * непокрытых диапазонов и без якоря, штрихованная полоса Full diff — с якорем ровно на свой
 * диапазон; ни там, ни там вопрос не уходит, в композере он ждёт ⏎. И Обзор, пока маршрут
 * не открывали, знает о «Прочем» то же, что маршрут.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const DATA = fixtureIteration('medium');
const READY = (() => {
    const state = routeFixtures('medium')?.states.ready ?? null;
    if (state?.snapshot == null) {
        throw new Error('фикстуре medium нужен готовый снапшот маршрута');
    }
    return state;
})();

const VIEWPORT_WIDTH = 900;
const VIEWPORT_HEIGHT = 700;

// В jsdom нет ни раскладки, ни ResizeObserver, ни воркеров: без заглушек ни виртуализатор,
// ни фоновый разбор патчей не доедут до разметки, которую проверяет тест.
class NoopResizeObserver {
    observe(): void {
        // Ширина в jsdom не меняется.
    }
    unobserve(): void {
        // См. `observe`.
    }
    disconnect(): void {
        // См. `observe`.
    }
}
(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= NoopResizeObserver;

/** Дифф-воркер приложения: тот же парсер, только без отдельного потока. */
class FakeDiffWorker {
    private readonly listeners = new Map<string, ((event: unknown) => void)[]>();

    addEventListener(type: string, listener: (event: unknown) => void): void {
        this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
    }

    postMessage(message: DiffParseMessage): void {
        const reply: DiffParseReply = { id: message.id, ok: true, model: parseFileDiff(message.file) };
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
(globalThis as { Worker?: unknown }).Worker ??= FakeDiffWorker;

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
HTMLElement.prototype.scrollIntoView = function noopScrollIntoView(): void {
    // В jsdom прокрутки нет.
};

const cleanups: (() => void)[] = [];

afterEach(() => {
    for (const cleanup of cleanups.splice(0)) {
        cleanup();
    }
});

/**
 * Виртуализатор показывает только то, что помещается во вьюпорт, а в jsdom все прямоугольники
 * одинаковые: чтобы дотянуться до карточки конкретного файла, дифф сужается до него.
 */
function mountApp(
    view: 'overview' | 'route' | 'diff',
    paths?: readonly string[],
): { readonly host: HTMLElement; readonly settle: () => Promise<void> } {
    const diff =
        paths === undefined
            ? DATA.diff
            : { ...DATA.diff, files: DATA.diff.files.filter((file) => paths.includes(file.path)) };
    const originalFetch = globalThis.fetch;
    const json = (body: unknown): Response =>
        new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    globalThis.fetch = (input: RequestInfo | URL): Promise<Response> => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        const query = new URLSearchParams(url.split('?')[1] ?? '');
        switch (url.split('?')[0] ?? '') {
            case UI_ENDPOINTS.reviewDiff:
                return Promise.resolve(json({ diff }));
            case UI_ENDPOINTS.reviewLenses:
                return Promise.resolve(json({ ownership: DATA.ownership, extra: DATA.extraLenses, ownershipSource: 'CODEOWNERS' }));
            case UI_ENDPOINTS.reviewThreads:
                return Promise.resolve(json({ threads: DATA.threads }));
            case UI_ENDPOINTS.reviewProgress:
                return Promise.resolve(json({ diffId: query.get('diffId') ?? diff.diffId, files: [], stops: [], progressRevision: 1 }));
            case UI_ENDPOINTS.reviewRoute:
                return Promise.resolve(json({ route: READY, routeRevision: 1 }));
            case UI_ENDPOINTS.reviewChat:
                return Promise.resolve(json({ exchanges: [], notes: [], chatRevision: 1 }));
            default:
                return Promise.resolve(json({}));
        }
    };

    const state: UiState = {
        prKey: 'fixture-medium',
        worker: {
            kind: 'connected',
            workerId: 'worker-1',
            harness: 'claude-code',
            model: 'opus-5',
            registeredAt: '2026-09-01T09:00:00.000Z',
            lastSeenAt: '2026-09-01T10:00:00.000Z',
        },
        tasks: [],
        reviewHost: 'fixture',
        pr: DATA.pr,
        feedback: { available: false, reason: 'Тестовый канал фидбека недоступен.' },
        iterations: [],
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
    const session = createSessionStore({ initial: { view, filter: 'all' }, viewPinned: true });

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
    });

    // Загрузка данных, отложенный фоновый разбор патчей и разрешение его промисов.
    const settle = async (): Promise<void> => {
        for (let step = 0; step < 6; step += 1) {
            await act(async () => {
                await new Promise((resolve) => setTimeout(resolve, 100));
            });
        }
    };
    return { host, settle };
}

function buttonWith(host: HTMLElement, selector: string, label: string): HTMLButtonElement {
    const button = [...host.querySelectorAll<HTMLButtonElement>(selector)].find(
        (candidate) => candidate.textContent === label,
    );
    if (button === undefined) {
        throw new Error(`на экране нет кнопки «${label}»`);
    }
    return button;
}

function composerText(host: HTMLElement): string {
    const textarea = host.querySelector<HTMLTextAreaElement>('.chat-panel__textarea');
    if (textarea === null) {
        throw new Error('чат не открылся: нет композера');
    }
    return textarea.value;
}

describe('точки входа Ask AI в приложении', () => {
    it('«Прочее» открывает чат с перечнем диапазонов и без якоря', async () => {
        const mounted = mountApp('route');
        await mounted.settle();

        const button = buttonWith(mounted.host, '.route-other__action', 'Попросить агента разложить их');
        expect(button.disabled).toBe(false);
        act(() => {
            button.click();
        });

        const text = composerText(mounted.host);
        expect(text).toContain('Разложи по остановкам маршрута диапазоны, которые модель не разместила: ');
        expect(text).toMatch(/[\w/.-]+:\d+/);
        expect(text).toContain('Для каждого — к какой остановке он относится и почему');
        // Якорь у вопроса один, а диапазонов много: чипа диапазона в композере быть не должно.
        expect(mounted.host.querySelector('.chat-panel__context--anchor')).toBeNull();
    });

    it('штрихованная полоса Full diff открывает чат с якорем на свой диапазон', async () => {
        // Оба файла не размещены ни в одной остановке — их строки целиком уходят в штриховку.
        const mounted = mountApp('diff', ['.github/CODEOWNERS', '.github/workflows/ci.yml']);
        await mounted.settle();

        const strip = mounted.host.querySelector('.route-strip');
        if (strip === null) {
            throw new Error('в полном диффе нет штрихованной полосы');
        }
        const label = strip.querySelector('.route-strip__text')?.textContent ?? '';
        const numbers = /(\d+)(?:–(\d+))?/.exec(label);
        const button = strip.querySelector<HTMLButtonElement>('.route-strip__action');
        expect(button?.disabled).toBe(false);
        act(() => {
            button?.click();
        });

        const text = composerText(mounted.host);
        expect(text).toContain('К какой остановке маршрута относ');
        expect(text).toContain('Модель ');
        const anchorChip = mounted.host.querySelector('.chat-panel__context--anchor');
        expect(anchorChip).not.toBeNull();
        expect(anchorChip?.textContent).toContain(numbers?.[1] ?? 'нет номера');
    });
});

describe('«Прочее» вне вью маршрута', () => {
    it('Обзор до первого захода в маршрут называет то же число остановок, что и после', async () => {
        const mounted = mountApp('overview');
        const title = (): string => mounted.host.querySelector('.gen-card__title')?.textContent ?? '';
        await mounted.settle();

        // В фикстуре medium модель оставила непокрытые строки: «Прочее» — седьмая остановка.
        expect(title()).toBe('Маршрут готов · 7 остановок');
        expect(mounted.host.querySelector('.gen-plan')?.textContent).toContain('Прочее');
    });
});

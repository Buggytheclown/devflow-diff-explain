// @vitest-environment jsdom
import { fixtureIteration, routeFixtures } from '@sherpa/fixtures';
import type {
    RouteSnapshot,
    UiFileProgress,
    UiPrStatePatch,
    UiSeenRange,
    UiStopProgress,
    UiStopSeenRange,
} from '@sherpa/protocol';
import { UI_ENDPOINTS } from '@sherpa/protocol';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { App } from '../app.tsx';
import { parseFileDiff } from '../diff/parse.js';
import { PrStateProvider } from '../pr-state/context.tsx';
import type { UiPrStateStore } from '../pr-state/pr-state-store.js';
import { createUiPrStateStore } from '../pr-state/pr-state-store.js';
import type { SessionStore } from '../session/session-store.js';
import { createSessionStore } from '../session/session-store.js';
import { ShortcutsProvider } from '../shortcuts/context.tsx';
import { createShortcutRegistry } from '../shortcuts/registry.js';
import type { Store, StoreSnapshot } from '../store.js';

/**
 * Сквозной путь отметки остановки: клик по тоглу шапки → запись
 * seen-диапазонов ручкой → перечитка снимка прогресса → коробки прочитанности файлов в общем
 * сторе. Собирается всё приложение целиком: перечитку ведёт App, и на отдельном вью её не
 * проверить — терялась отметка именно на стыке вью и App.
 *
 * Сервер здесь — карта в памяти с семантикой `ProgressStore`, канал событий — подменённый
 * `Store`: так воспроизводится и случай, когда событие прогресса до вкладки ещё не доехало.
 */

const DATA = fixtureIteration('medium');
const SNAPSHOT: RouteSnapshot = (() => {
    const snapshot = routeFixtures('medium')?.states.ready?.snapshot ?? null;
    if (snapshot === null) {
        throw new Error('фикстуре medium нужен готовый снапшот маршрута');
    }
    return snapshot;
})();

// React 19 требует явного признания среды: без него каждый `act` пишет предупреждение.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

interface FakeProgress {
    readonly revision: number;
    readonly stopWrites: readonly { stopId: string; viewed: boolean }[];
    readonly fileWrites: readonly { fileId: string; viewed: boolean }[];
    readonly stopFileWrites: readonly StopFileWrite[];
    readonly read: () => UiFileProgress[];
    readonly readStops: () => UiStopProgress[];
    readonly rangesForStop: (stopId: string) => readonly UiStopSeenRange[];
    readonly setStopViewed: (stopId: string, viewed: boolean, ranges: readonly UiStopSeenRange[]) => number;
    readonly setFileViewed: (fileId: string, viewed: boolean) => number;
    readonly setStopFileViewed: (write: StopFileWrite) => number;
    /** Перезапуск сервера: данные в БД переживают его, счётчик ревизий начинается заново. */
    readonly restart: () => void;
}

interface StopFileWrite {
    readonly stopId: string;
    readonly fileId: string;
    readonly viewed: boolean;
    readonly ranges: readonly UiSeenRange[];
}

/** Прогресс PR в памяти: те же правила чтения, что у серверного `ProgressStore`. */
function fakeProgress(): FakeProgress {
    const files = new Map<string, boolean>();
    const stops = new Map<string, boolean>();
    const ranges = new Map<string, readonly UiStopSeenRange[]>();
    const stopWrites: { stopId: string; viewed: boolean }[] = [];
    const fileWrites: { fileId: string; viewed: boolean }[] = [];
    const stopFileWrites: StopFileWrite[] = [];
    let revision = 0;
    return {
        get revision() {
            return revision;
        },
        stopWrites,
        fileWrites,
        stopFileWrites,
        read: () => {
            const byFile = new Map<string, UiFileProgress>();
            for (const [fileId, viewed] of files) {
                byFile.set(fileId, { fileId, viewed, seenRanges: [] });
            }
            for (const list of ranges.values()) {
                for (const range of list) {
                    const record = byFile.get(range.fileId) ?? {
                        fileId: range.fileId,
                        viewed: null,
                        seenRanges: [],
                    };
                    byFile.set(range.fileId, {
                        ...record,
                        seenRanges: [...record.seenRanges, { side: range.side, start: range.start, end: range.end }],
                    });
                }
            }
            return [...byFile.values()];
        },
        readStops: () => [...stops].map(([stopId, viewed]) => ({ stopId, viewed })),
        rangesForStop: (stopId) => ranges.get(stopId) ?? [],
        setStopViewed: (stopId, viewed, next) => {
            stopWrites.push({ stopId, viewed });
            stops.set(stopId, viewed);
            ranges.set(stopId, viewed ? next : []);
            revision += 1;
            return revision;
        },
        setFileViewed: (fileId, viewed) => {
            fileWrites.push({ fileId, viewed });
            files.set(fileId, viewed);
            if (!viewed) {
                const affected = [...ranges]
                    .filter(([, list]) => list.some((range) => range.fileId === fileId))
                    .map(([stopId]) => stopId);
                for (const stopId of affected) {
                    stops.set(stopId, false);
                    ranges.set(stopId, []);
                }
            }
            revision += 1;
            return revision;
        },
        setStopFileViewed: (write) => {
            stopFileWrites.push(write);
            const kept = (ranges.get(write.stopId) ?? []).filter((range) => range.fileId !== write.fileId);
            ranges.set(
                write.stopId,
                write.viewed ? [...kept, ...write.ranges.map((range) => ({ ...range, fileId: write.fileId }))] : kept,
            );
            if (!write.viewed && stops.get(write.stopId) === true) {
                stops.set(write.stopId, false);
            }
            revision += 1;
            return revision;
        },
        restart: () => {
            revision = 0;
        },
    };
}

interface Mounted {
    readonly host: HTMLElement;
    /** Состояние PR этой вкладки и уехавшие на сервер патчи: свёртки пишет App. */
    readonly prState: UiPrStateStore;
    readonly prStatePatches: UiPrStatePatch[];
    /** Перезапуск сервера вместе с событием канала о его новой (нулевой) ревизии. */
    readonly restartServer: () => void;
    readonly session: SessionStore;
    readonly progress: FakeProgress;
    /** Та же файловая ручка, которую вызывает общий writer из Полного диффа. */
    readonly setFileViewedDirect: (fileId: string, viewed: boolean) => Promise<void>;
    /** Прокрутить время: загрузки, разбор диффа и перечитка прогресса доезжают по кадрам. */
    readonly settle: () => Promise<void>;
}

const cleanups: (() => void)[] = [];
afterEach(() => {
    for (const cleanup of cleanups.splice(0)) {
        cleanup();
    }
    vi.restoreAllMocks();
});

interface MountOptions {
    /** Событие прогресса до вкладки не доезжает: ревизия из канала остаётся неизвестной. */
    readonly silentProgressEvents?: boolean;
    /** Файлы, разбор которых воркер завалит. */
    readonly failParse?: ReadonlySet<string>;
}

function mount(options: MountOptions = {}): Mounted {
    const progress = fakeProgress();
    const originalFetch = globalThis.fetch;
    const globals = globalThis as { Worker?: unknown; ResizeObserver?: unknown };
    const originalWorker = globals.Worker;

    // Настоящего воркера в jsdom нет: разбираем тем же парсером в том же потоке.
    class FakeWorker {
        private readonly listeners = new Map<string, ((event: unknown) => void)[]>();
        addEventListener(type: string, listener: (event: unknown) => void): void {
            this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
        }
        postMessage(message: { id: number; file: Parameters<typeof parseFileDiff>[0] }): void {
            const failed = options.failParse?.has(message.file.fileId) === true;
            const reply = failed
                ? { id: message.id, ok: false, error: 'патч не разобрался' }
                : { id: message.id, ok: true, model: parseFileDiff(message.file) };
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
            // Раскладки в jsdom нет — наблюдать нечего.
        }
        unobserve(): void {
            // Раскладки в jsdom нет — наблюдать нечего.
        }
        disconnect(): void {
            // Раскладки в jsdom нет — наблюдать нечего.
        }
    };

    const json = (body: unknown): Response =>
        new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

    globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        const path = url.split('?')[0] ?? '';
        const body: Record<string, unknown> =
            typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : {};
        switch (path) {
            case UI_ENDPOINTS.reviewDiff:
                return Promise.resolve(json({ diff: DATA.diff }));
            case UI_ENDPOINTS.reviewLenses:
                return Promise.resolve(json({ ownership: DATA.ownership, extra: DATA.extraLenses, ownershipSource: 'CODEOWNERS' }));
            case UI_ENDPOINTS.reviewThreads:
                return Promise.resolve(json({ threads: DATA.threads }));
            case UI_ENDPOINTS.reviewRoute:
                return Promise.resolve(
                    json({
                        route: { phase: 'ready', smallPr: false, snapshot: SNAPSHOT, failure: null, stale: null },
                        routeRevision: 1,
                    }),
                );
            case UI_ENDPOINTS.reviewProgress:
                return Promise.resolve(
                    json({
                        diffId: DATA.diff.diffId,
                        files: progress.read(),
                        stops: progress.readStops(),
                        progressRevision: progress.revision,
                    }),
                );
            case UI_ENDPOINTS.reviewStopViewed: {
                const revision = progress.setStopViewed(
                    body.stopId as string,
                    body.viewed as boolean,
                    body.ranges as readonly UiStopSeenRange[],
                );
                pushProgressEvent(revision);
                return Promise.resolve(json({ progressRevision: revision }));
            }
            case UI_ENDPOINTS.reviewStopFileViewed: {
                const revision = progress.setStopFileViewed({
                    stopId: body.stopId as string,
                    fileId: body.fileId as string,
                    viewed: body.viewed as boolean,
                    ranges: body.ranges as readonly UiSeenRange[],
                });
                pushProgressEvent(revision);
                return Promise.resolve(json({ progressRevision: revision }));
            }
            case UI_ENDPOINTS.reviewFileViewed: {
                const revision = progress.setFileViewed(body.fileId as string, body.viewed as boolean);
                pushProgressEvent(revision);
                return Promise.resolve(json({ progressRevision: revision }));
            }
            default:
                return Promise.resolve(json({}));
        }
    };

    let snapshot: StoreSnapshot = {
        connection: 'online',
        state: {
            prKey: 'fixture/medium',
            worker: { kind: 'never' },
            tasks: [],
            reviewHost: 'fixture',
            pr: DATA.pr,
            feedback: { available: false, reason: 'Тестовый канал фидбека недоступен.' },
            iterations: [],
            update: null,
            generationCap: null,
        },
        error: null,
        progressRevision: null,
        threadsRevision: 1,
        routeRevision: 1,
        chatRevision: null,
    };
    const listeners = new Set<() => void>();
    const pushProgressEvent = (revision: number): void => {
        if (options.silentProgressEvents === true) {
            return;
        }
        snapshot = { ...snapshot, progressRevision: revision };
        for (const listener of [...listeners]) {
            listener();
        }
    };
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

    const session = createSessionStore({ initial: { view: 'route', filter: 'all' } });
    const prStatePatches: UiPrStatePatch[] = [];
    const prState = createUiPrStateStore({
        send: (patch) => {
            prStatePatches.push(patch);
            return Promise.resolve(prState.getSnapshot());
        },
    });
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    act(() => {
        root.render(
            <ShortcutsProvider registry={createShortcutRegistry()}>
                <PrStateProvider store={prState}>
                    <App store={store} session={session} token="токен" />
                </PrStateProvider>
            </ShortcutsProvider>,
        );
    });
    cleanups.push(() => {
        act(() => {
            root.unmount();
        });
        host.remove();
        globalThis.fetch = originalFetch;
        globals.Worker = originalWorker;
    });

    const settle = async (): Promise<void> => {
        for (let step = 0; step < 12; step += 1) {
            await act(async () => {
                await new Promise((resolve) => setTimeout(resolve, 20));
            });
        }
    };

    return {
        host,
        prState,
        prStatePatches,
        session,
        progress,
        settle,
        setFileViewedDirect: async (fileId, viewed) => {
            await globalThis.fetch(UI_ENDPOINTS.reviewFileViewed, {
                method: 'POST',
                body: JSON.stringify({ fileId, viewed }),
            });
        },
        restartServer: () => {
            progress.restart();
            pushProgressEvent(0);
        },
    };
}

function stopSection(host: HTMLElement, stopId: string): HTMLElement {
    const section = host.querySelector<HTMLElement>(`[data-stop="${stopId}"]`);
    if (section === null) {
        throw new Error(`в разметке нет остановки ${stopId}`);
    }
    return section;
}

function viewedToggle(section: HTMLElement): HTMLButtonElement {
    const toggle = section.querySelector<HTMLButtonElement>('.route-stop__viewed');
    if (toggle === null) {
        throw new Error('в шапке остановки нет тогла просмотра');
    }
    return toggle;
}

function fileViewedToggles(section: HTMLElement): HTMLButtonElement[] {
    return [...section.querySelectorAll<HTMLButtonElement>('.file-card__viewed')];
}

function fileViewedToggle(section: HTMLElement, fileId: string): HTMLButtonElement {
    const card = [...section.querySelectorAll<HTMLElement>('article[data-file]')].find(
        (candidate) => candidate.dataset.file === fileId,
    );
    const toggle = card?.querySelector<HTMLButtonElement>('.file-card__viewed') ?? null;
    if (toggle === null) {
        throw new Error(`в остановке нет тогла файла ${fileId}`);
    }
    return toggle;
}

/** Сколько файлов диффа читалка считает прочитанными: то же число, что рисует панель действий. */
function filesRead(host: HTMLElement): string {
    return host.querySelector('.review-action-bar__progress')?.textContent ?? '';
}

describe('персист свёртки на уровне App', () => {
    it('пишет только при изменении collapsePreferences', async () => {
        const view = mount();
        await view.settle();
        view.prStatePatches.length = 0;

        const mode = view.host.querySelector<HTMLButtonElement>('.diff-mode-toggle');
        const card = stopSection(view.host, 's01').querySelector<HTMLElement>('.file-card');
        const name = card?.querySelector<HTMLElement>('.file-card__name');
        const fileId = card?.dataset.file;
        if (mode === null || name === null || name === undefined || fileId === undefined) {
            throw new Error('маршруту нужны тогл режима и карточка файла');
        }

        // Смена режима диффа — не свёртка: состоянию PR о ней сообщать нечего.
        act(() => {
            mode.click();
        });
        await act(async () => {
            view.prState.flush();
            await Promise.resolve();
        });
        expect(view.prStatePatches).toEqual([]);

        act(() => {
            name.click();
        });
        await act(async () => {
            view.prState.flush();
            await Promise.resolve();
        });
        expect(view.prStatePatches).toEqual([{ diffCollapsed: { [fileId]: true } }]);
    });

    it('опоздавшее состояние PR доливается в стор диффа и не теряется первой же свёрткой', async () => {
        const view = mount();
        await view.settle();
        view.prStatePatches.length = 0;

        const cards = [...stopSection(view.host, 's01').querySelectorAll<HTMLElement>('.file-card')];
        const saved = cards[0]?.dataset.file;
        const target = cards[1];
        const name = target?.querySelector<HTMLElement>('.file-card__name');
        if (saved === undefined || target === undefined || name === null || name === undefined) {
            throw new Error('остановке нужны две карточки файлов');
        }

        // Boot-GET опоздал за таймаут: стор диффа создан на пустой карте, ответ приезжает сейчас.
        await act(async () => {
            await view.prState.load(() =>
                Promise.resolve({ treeCollapsed: {}, diffCollapsed: { [saved]: true }, paletteRecent: [] }),
            );
        });

        expect(view.host.querySelector(`[data-file="${saved}"] .file-card__collapsed--file`)).not.toBeNull();
        expect(view.prStatePatches).toEqual([]);

        act(() => {
            name.click();
        });
        await act(async () => {
            view.prState.flush();
            await Promise.resolve();
        });

        // Патч заменяет поле целиком: в нём обязаны быть обе карточки, а не только новая.
        const collapsed = target.dataset.file ?? '';
        expect(view.prStatePatches).toEqual([{ diffCollapsed: { [saved]: true, [collapsed]: true } }]);
    });
});

describe('отметка остановки красит коробки прочитанности её файлов', () => {
    it('без перезагрузки: диапазоны уехали и снимок прогресса доехал до стора файлов', async () => {
        const view = mount();
        await view.settle();
        expect(filesRead(view.host)).toBe('4 / 21 файлов');

        act(() => {
            viewedToggle(stopSection(view.host, 's01')).click();
        });
        await view.settle();

        // Остановка 01 объясняет два файла целиком — её собственная запись и обязана их покрыть.
        expect(new Set(view.progress.rangesForStop('s01').map((range) => range.fileId)).size).toBe(2);
        expect(filesRead(view.host)).toBe('6 / 21 файлов');
    });

    it.each([
        ['s03', 'services/orders/src/payments/generated/psp-schema.ts', '8 / 21 файлов'],
        ['s06', 'pnpm-lock.yaml', '4 / 21 файлов'],
    ])('seen-only прогресс %s не снимает generated-дефолт', async (stopId, path, expectedFilesRead) => {
        const view = mount();
        await view.settle();
        expect(filesRead(view.host)).toBe('4 / 21 файлов');

        act(() => {
            viewedToggle(stopSection(view.host, stopId)).click();
        });
        await view.settle();

        const fileId = DATA.diff.files.find((file) => file.path === path)?.fileId;
        if (fileId === undefined) {
            throw new Error(`в фикстуре medium нет generated-файла ${path}`);
        }
        const record = view.progress.read().find((candidate) => candidate.fileId === fileId);
        expect(record?.viewed).toBeNull();
        expect(record?.seenRanges.length).toBeGreaterThan(0);
        expect(filesRead(view.host)).toBe(expectedFilesRead);

        const section = stopSection(view.host, stopId);
        const summary = section.querySelector<HTMLButtonElement>('.route-collapsed--viewed');
        if (summary === null) {
            throw new Error(`просмотренная остановка ${stopId} не свернулась`);
        }
        act(() => {
            summary.click();
        });
        await view.settle();

        expect(fileViewedToggle(stopSection(view.host, stopId), fileId).title).toContain(
            'сгенерированный файл — по умолчанию прочитан',
        );
    });

    it('перечитка не ждёт события прогресса из канала', async () => {
        const view = mount({ silentProgressEvents: true });
        await view.settle();
        expect(filesRead(view.host)).toBe('4 / 21 файлов');

        act(() => {
            viewedToggle(stopSection(view.host, 's01')).click();
        });
        await view.settle();

        expect(filesRead(view.host)).toBe('6 / 21 файлов');
    });

    it('снятие отметки возвращает файлы в непрочитанные', async () => {
        const view = mount();
        await view.settle();

        act(() => {
            viewedToggle(stopSection(view.host, 's01')).click();
        });
        await view.settle();
        act(() => {
            viewedToggle(stopSection(view.host, 's01')).click();
        });
        await view.settle();

        expect(view.progress.rangesForStop('s01')).toEqual([]);
        expect(filesRead(view.host)).toBe('4 / 21 файлов');
    });

    it('перезапуск сервера обнуляет ревизию, а перечитка всё равно доезжает', async () => {
        const view = mount();
        await view.settle();

        // Несколько отметок до перезапуска: серверная ревизия уходит вперёд нуля.
        for (let round = 0; round < 2; round += 1) {
            act(() => {
                viewedToggle(stopSection(view.host, 's01')).click();
            });
            await view.settle();
            act(() => {
                viewedToggle(stopSection(view.host, 's01')).click();
            });
            await view.settle();
        }
        expect(filesRead(view.host)).toBe('4 / 21 файлов');

        view.restartServer();
        act(() => {
            viewedToggle(stopSection(view.host, 's01')).click();
        });
        await view.settle();

        expect(filesRead(view.host)).toBe('6 / 21 файлов');
    });

    it('последние отмеченные файлы автоотмечают и сворачивают остановку без повторных записей', async () => {
        const view = mount();
        await view.settle();
        const section = stopSection(view.host, 's01');
        const toggles = fileViewedToggles(section);
        expect(toggles.length).toBeGreaterThan(0);

        act(() => {
            for (const toggle of toggles) {
                toggle.click();
            }
        });
        await view.settle();

        expect(view.progress.readStops()).toContainEqual({ stopId: 's01', viewed: true });
        expect(stopSection(view.host, 's01').querySelector('.route-collapsed--viewed')).not.toBeNull();
        expect(view.progress.stopWrites.filter((write) => write.stopId === 's01' && write.viewed)).toHaveLength(1);
        // Карточки пишут свои строки, а не пин файла.
        expect(view.progress.fileWrites).toEqual([]);
        await view.settle();
        expect(view.progress.stopWrites.filter((write) => write.stopId === 's01' && write.viewed)).toHaveLength(1);

        act(() => {
            stopSection(view.host, 's01')
                .querySelector<HTMLButtonElement>('.route-collapsed--viewed')
                ?.click();
        });
        const firstFile = fileViewedToggles(stopSection(view.host, 's01'))[0];
        const firstFileId = firstFile?.closest<HTMLElement>('article[data-file]')?.dataset.file;
        if (firstFile === undefined || firstFileId === undefined) {
            throw new Error('после раскрытия просмотренной остановки должна вернуться карточка файла');
        }
        act(() => {
            firstFile.click();
        });
        await view.settle();

        // Снятие карточки снимает остановку и убирает только её строки этого файла.
        expect(view.progress.readStops()).toContainEqual({ stopId: 's01', viewed: false });
        const left = view.progress.rangesForStop('s01');
        expect(left.some((range) => range.fileId === firstFileId)).toBe(false);
        expect(left.length).toBeGreaterThan(0);
        expect(stopSection(view.host, 's01').querySelector('.route-collapsed--viewed')).toBeNull();
        expect(fileViewedToggles(stopSection(view.host, 's01')).length).toBeGreaterThan(0);
    });

    it('ручное снятие не откатывается, пока покрытие не соберётся заново', async () => {
        const view = mount();
        await view.settle();
        const markAllCards = (): void => {
            act(() => {
                for (const toggle of fileViewedToggles(stopSection(view.host, 's01'))) {
                    toggle.click();
                }
            });
        };
        const viewedWrites = (): number =>
            view.progress.stopWrites.filter((write) => write.stopId === 's01' && write.viewed).length;

        markAllCards();
        await view.settle();
        expect(viewedWrites()).toBe(1);

        act(() => {
            viewedToggle(stopSection(view.host, 's01')).click();
        });
        await view.settle();
        await view.settle();

        // Снятие остановки уносит и строки её карточек — автоотметке нечего возвращать.
        expect(view.progress.readStops()).toContainEqual({ stopId: 's01', viewed: false });
        expect(view.progress.rangesForStop('s01')).toEqual([]);
        expect(viewedWrites()).toBe(1);

        markAllCards();
        await view.settle();

        expect(view.progress.readStops()).toContainEqual({ stopId: 's01', viewed: true });
        expect(viewedWrites()).toBe(2);
    });

    it('прямая файловая запись, как из Полного диффа, разотмечает остановку', async () => {
        const view = mount();
        await view.settle();
        act(() => {
            viewedToggle(stopSection(view.host, 's01')).click();
        });
        await view.settle();
        const fileId = view.progress.rangesForStop('s01')[0]?.fileId;
        if (fileId === undefined) {
            throw new Error('остановка s01 должна записать хотя бы один диапазон файла');
        }

        await act(async () => {
            await view.setFileViewedDirect(fileId, false);
        });
        await view.settle();

        expect(view.progress.readStops()).toContainEqual({ stopId: 's01', viewed: false });
        expect(view.progress.rangesForStop('s01')).toEqual([]);
        expect(stopSection(view.host, 's01').querySelector('.route-collapsed--viewed')).toBeNull();
    });

    it('файл со сорвавшимся разбором не даёт отметить остановку молча', async () => {
        const failing = SNAPSHOT.stops.find((stop) => stop.id === 's01')?.anchors[0]?.fileId ?? '';
        expect(failing).not.toBe('');
        const view = mount({ failParse: new Set([failing]) });
        await view.settle();

        const toggle = viewedToggle(stopSection(view.host, 's01'));
        expect(toggle.disabled).toBe(true);
        expect(toggle.title).toBe('Часть файлов остановки не разобралась — повторите разбор');

        act(() => {
            toggle.click();
        });
        await view.settle();

        // Ни отметки, ни половинчатого набора диапазонов s01: писать было бы неправдой.
        expect(view.progress.stopWrites.some((write) => write.stopId === 's01')).toBe(false);
        expect(view.progress.rangesForStop('s01')).toEqual([]);
    });
});

describe('отметка файла внутри остановки', () => {
    const SHARED = 'services/orders/docs/edit-window.md';
    const sharedId = (): string => {
        const fileId = DATA.diff.files.find((file) => file.path === SHARED)?.fileId;
        if (fileId === undefined) {
            throw new Error(`в фикстуре medium нет файла ${SHARED}`);
        }
        return fileId;
    };
    const pressed = (toggle: HTMLButtonElement): string | null => toggle.getAttribute('aria-pressed');

    it('отмечает только строки своей карточки: файл в другой остановке и в диффе остаётся непрочитанным', async () => {
        const view = mount();
        await view.settle();
        // Файл лежит в s03 (строки 1–52) и в low-остановке s05 (53–115): её раскрываем.
        act(() => {
            view.session.setStopExpanded('s05', true);
        });
        await view.settle();
        const fileId = sharedId();

        act(() => {
            fileViewedToggle(stopSection(view.host, 's03'), fileId).click();
        });
        await view.settle();

        expect(view.progress.fileWrites).toEqual([]);
        expect(view.progress.stopFileWrites).toEqual([
            { stopId: 's03', fileId, viewed: true, ranges: [{ side: 'new', start: 1, end: 52 }] },
        ]);
        expect(pressed(fileViewedToggle(stopSection(view.host, 's03'), fileId))).toBe('true');
        expect(fileViewedToggle(stopSection(view.host, 's03'), fileId).title).toBe(
            '52 из 52 изменённых строк просмотрено',
        );
        expect(pressed(fileViewedToggle(stopSection(view.host, 's05'), fileId))).toBe('false');
        // Глобально файл прочитан частично: число прочитанных файлов не выросло.
        expect(filesRead(view.host)).toBe('4 / 21 файлов');
        expect(view.progress.read().find((record) => record.fileId === fileId)).toEqual({
            fileId,
            viewed: null,
            seenRanges: [{ side: 'new', start: 1, end: 52 }],
        });

        act(() => {
            fileViewedToggle(stopSection(view.host, 's05'), fileId).click();
        });
        await view.settle();

        expect(pressed(fileViewedToggle(stopSection(view.host, 's05'), fileId))).toBe('true');
        expect(filesRead(view.host)).toBe('5 / 21 файлов');

        act(() => {
            fileViewedToggle(stopSection(view.host, 's03'), fileId).click();
        });
        await view.settle();

        expect(view.progress.stopFileWrites.at(-1)).toEqual({ stopId: 's03', fileId, viewed: false, ranges: [] });
        expect(pressed(fileViewedToggle(stopSection(view.host, 's03'), fileId))).toBe('false');
        expect(pressed(fileViewedToggle(stopSection(view.host, 's05'), fileId))).toBe('true');
        expect(filesRead(view.host)).toBe('4 / 21 файлов');
        expect(view.progress.fileWrites).toEqual([]);
    });

    it('у запиненного файла снятие в карточке снимает пин целиком', async () => {
        const pinned = DATA.diff.files.find((file) => file.viewed === true);
        const stopId = SNAPSHOT.stops.find((stop) =>
            stop.anchors.some((anchor) => anchor.fileId === pinned?.fileId),
        )?.id;
        if (pinned === undefined || stopId === undefined) {
            throw new Error('фикстуре medium нужен отмеченный хостом файл в маршруте');
        }
        const view = mount();
        await view.settle();
        act(() => {
            view.session.setStopExpanded(stopId, true);
        });
        await view.settle();
        expect(pressed(fileViewedToggle(stopSection(view.host, stopId), pinned.fileId))).toBe('true');

        act(() => {
            fileViewedToggle(stopSection(view.host, stopId), pinned.fileId).click();
        });
        await view.settle();

        expect(view.progress.fileWrites).toEqual([{ fileId: pinned.fileId, viewed: false }]);
        expect(view.progress.stopFileWrites).toEqual([]);
        expect(pressed(fileViewedToggle(stopSection(view.host, stopId), pinned.fileId))).toBe('false');
    });
});

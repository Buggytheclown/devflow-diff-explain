// @vitest-environment jsdom
import { fixtureIteration } from '@sherpa/fixtures';
import type { FileDiff, Thread } from '@sherpa/protocol';
import type { ReactNode, RefObject } from 'react';
import { act, createRef } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DiffFileModel } from '../diff/model.js';
import { toParseRequest } from '../diff/model.js';
import { parseFileDiff } from '../diff/parse.js';
import { createT } from '../i18n/index.js';
import { createSessionStore } from '../session/session-store.js';
import { SettingsProvider } from '../settings/context.tsx';
import type { UiSettingsStore } from '../settings/settings-store.js';
import { createUiSettingsStore } from '../settings/settings-store.js';
import type { ThreadStore } from '../threads/store.js';
import { createThreadStore } from '../threads/store.js';
import { COLLAPSE_THRESHOLD } from './file-card.tsx';
import type { DiffListHandle } from './file-list.tsx';
import { DiffFileList } from './file-list.tsx';
import type { DiffViewStore } from './store.js';
import { createDiffViewStore } from './store.js';

/**
 * DOM-контракт списка карточек и его императивной ручки (`DiffListHandle`). Всё, что упирается
 * в настоящую геометрию — якорь при сворачивании, `scrollMargin`, липкие шапки, — проверяется
 * e2e (`scroll-stability.spec.ts`, `sticky-file-header.spec.ts`, `route-file-collapse.spec.ts`):
 * в jsdom прямоугольники нулевые, и подделанная раскладка проверяла бы заглушку, а не список.
 * Чистые хелперы прокрутки живут в `file-list-scroll.test.ts`.
 */

/**
 * Виртуализатор в jsdom мерить нечего, поэтому он заменён фейком с фиксированной высотой
 * карточки: список получает все `count` элементов разом, а `scrollOffset` тест двигает руками.
 * Инстанс один на монтирование — эффекты списка держат его в зависимостях.
 */
const virtual = vi.hoisted(() => {
    const ITEM_HEIGHT = 100;

    interface FakeItem {
        readonly index: number;
        readonly key: number;
        readonly start: number;
        readonly size: number;
        readonly end: number;
        readonly lane: number;
    }

    interface FakeVirtualizer {
        count: number;
        scrollOffset: number;
        scrollAdjustments: number;
        measurementsCache: readonly FakeItem[];
        shouldAdjustScrollPositionOnItemSizeChange?: unknown;
        readonly scrollToIndex: ReturnType<typeof vi.fn>;
        readonly resizeItem: ReturnType<typeof vi.fn>;
        readonly measureElement: () => void;
        readonly measure: ReturnType<typeof vi.fn>;
        readonly elementsCache: Map<string, HTMLElement>;
        estimateSize: (index: number) => number;
        readonly getTotalSize: () => number;
        readonly getVirtualItems: () => readonly FakeItem[];
        readonly setCount: (count: number) => void;
    }

    let current: FakeVirtualizer | null = null;

    const create = (): FakeVirtualizer => {
        let items: readonly FakeItem[] = [];
        const fake: FakeVirtualizer = {
            count: 0,
            scrollOffset: 0,
            scrollAdjustments: 0,
            measurementsCache: [],
            scrollToIndex: vi.fn(),
            resizeItem: vi.fn(),
            measureElement: () => undefined,
            measure: vi.fn(),
            elementsCache: new Map(),
            estimateSize: () => ITEM_HEIGHT,
            getTotalSize: () => fake.count * ITEM_HEIGHT,
            // Набор элементов держится стабильным: он лежит в зависимостях эффекта разбора,
            // и новый массив на каждый кадр гонял бы эффект вхолостую.
            getVirtualItems: () => items,
            setCount: (count) => {
                if (count === fake.count) {
                    return;
                }
                fake.count = count;
                items = Array.from({ length: count }, (_, index) => ({
                    index,
                    key: index,
                    start: index * ITEM_HEIGHT,
                    size: ITEM_HEIGHT,
                    end: (index + 1) * ITEM_HEIGHT,
                    lane: 0,
                }));
                fake.measurementsCache = items;
            },
        };
        return fake;
    };

    return {
        ITEM_HEIGHT,
        reset: (): void => {
            current = null;
        },
        use: (count: number, estimateSize: (index: number) => number): FakeVirtualizer => {
            current ??= create();
            current.estimateSize = estimateSize;
            current.setCount(count);
            return current;
        },
        instance: (): FakeVirtualizer => {
            if (current === null) {
                throw new Error('виртуализатор ещё не создан: список не смонтирован');
            }
            return current;
        },
    };
});

vi.mock('@tanstack/react-virtual', () => ({
    useVirtualizer: ({ count, estimateSize }: { count: number; estimateSize: (index: number) => number }) =>
        virtual.use(count, estimateSize),
}));

const t = createT('ru');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** ResizeObserver в jsdom нет; список заводит два — на раскладку и на свою ширину. */
class TestResizeObserver {
    static instances: TestResizeObserver[] = [];
    readonly disconnect = vi.fn();

    constructor() {
        TestResizeObserver.instances.push(this);
    }

    observe(): void {
        // Размеров в jsdom нет — наблюдать нечего.
    }

    unobserve(): void {
        // См. `observe`.
    }
}
(globalThis as { ResizeObserver?: unknown }).ResizeObserver = TestResizeObserver;

const MEDIUM = fixtureIteration('medium');
const HUGE = fixtureIteration('huge');
const EMPTY = fixtureIteration('empty');

function pickFile(files: readonly FileDiff[], predicate: (file: FileDiff) => boolean, what: string): FileDiff {
    const file = files.find(predicate);
    if (file === undefined) {
        throw new Error(`фикстуре нужен ${what}`);
    }
    return file;
}

/** Обычный текстовый файл: не машинный, не двоичный, не отмеченный хостом просмотренным. */
const isPlain = (file: FileDiff): boolean =>
    !file.generated && !file.binary && file.patch !== null && file.viewed !== true;

function plainFiles(count: number): FileDiff[] {
    const files = MEDIUM.diff.files.filter(isPlain).slice(0, count);
    if (files.length < count) {
        throw new Error(`фикстуре medium нужно ${String(count)} обычных текстовых файлов`);
    }
    return files;
}

const GENERATED = pickFile(MEDIUM.diff.files, (file) => file.generated, 'машинный файл');

interface MountOptions {
    readonly settings?: UiSettingsStore;
    readonly scrollElement?: HTMLDivElement;
    readonly files?: readonly FileDiff[];
    readonly store?: DiffViewStore;
    readonly parse?: (file: FileDiff) => Promise<DiffFileModel>;
    readonly threadStore?: ThreadStore;
    readonly threadVisible?: (thread: Thread) => boolean;
    readonly onTopFileChange?: (fileId: string | null) => void;
    readonly outsideThreads?: ReactNode;
}

interface Mounted {
    readonly host: HTMLElement;
    /** Файлы, которые список заказал разобрать, в порядке обращений и с повторами. */
    readonly parsed: string[];
    readonly handle: RefObject<DiffListHandle | null>;
    /** Типы событий, чьи слушатели прямо сейчас висят на скролл-контейнере. */
    readonly liveEvents: () => string[];
    readonly rerender: (files: readonly FileDiff[]) => void;
    readonly unmount: () => void;
}

const mounted: (() => void)[] = [];

beforeEach(() => {
    virtual.reset();
    TestResizeObserver.instances = [];
});

afterEach(() => {
    for (const unmount of mounted.splice(0)) {
        unmount();
    }
});

function mount(options: MountOptions = {}): Mounted {
    const files = options.files ?? plainFiles(2);
    const store = options.store ?? createDiffViewStore({ files });
    const host = document.createElement('div');
    const scrollElement = options.scrollElement ?? document.createElement('div');
    const settings = options.settings ?? createUiSettingsStore({ loaded: true });
    document.body.append(scrollElement, host);
    // Учёт слушателей ведём парами «тип + сам колбэк»: снятие с другой ссылкой оставляет
    // настоящий обработчик висеть, и по одному типу события это не видно.
    const liveListeners: { type: string; listener: EventListenerOrEventListenerObject; capture: boolean }[] = [];
    const captureOf = (listenerOptions?: boolean | EventListenerOptions): boolean =>
        typeof listenerOptions === 'boolean' ? listenerOptions : (listenerOptions?.capture ?? false);
    const nativeAdd = scrollElement.addEventListener.bind(scrollElement);
    const nativeRemove = scrollElement.removeEventListener.bind(scrollElement);
    scrollElement.addEventListener = (
        type: string,
        listener: EventListenerOrEventListenerObject,
        listenerOptions?: boolean | AddEventListenerOptions,
    ): void => {
        liveListeners.push({ type, listener, capture: captureOf(listenerOptions) });
        nativeAdd(type, listener, listenerOptions);
    };
    scrollElement.removeEventListener = (
        type: string,
        listener: EventListenerOrEventListenerObject,
        listenerOptions?: boolean | EventListenerOptions,
    ): void => {
        const capture = captureOf(listenerOptions);
        const index = liveListeners.findIndex(
            (entry) => entry.type === type && entry.listener === listener && entry.capture === capture,
        );
        if (index >= 0) {
            liveListeners.splice(index, 1);
        }
        nativeRemove(type, listener, listenerOptions);
    };
    const parsed: string[] = [];
    const model = options.parse ?? ((file: FileDiff) => Promise.resolve(parseFileDiff(toParseRequest(file))));
    const parse = (file: FileDiff): Promise<DiffFileModel> => {
        parsed.push(file.fileId);
        return model(file);
    };
    const session = createSessionStore({ initial: { view: 'diff', filter: 'all' } });
    const handle = createRef<DiffListHandle>();
    const root = createRoot(host);
    const reportTop = options.onTopFileChange;

    const render = (next: readonly FileDiff[]): void => {
        act(() => {
            root.render(
                <SettingsProvider store={settings}>
                    <DiffFileList
                        ref={handle}
                        scrollElement={scrollElement}
                        scrollPaddingStart={0}
                        files={next}
                        store={store}
                        contentAvailable={false}
                        parse={parse}
                        loadContent={() => Promise.resolve(null)}
                        onViewed={() => Promise.resolve(null)}
                        session={session}
                        {...(options.threadStore === undefined ? {} : { threadStore: options.threadStore })}
                        {...(options.threadVisible === undefined ? {} : { threadVisible: options.threadVisible })}
                        {...(reportTop === undefined
                            ? {}
                            : {
                                  // Новая ссылка на каждый рендер: повторы гасит собственный страж
                                  // списка, а не стабильные зависимости эффекта.
                                  onTopFileChange: (fileId: string | null) => {
                                      reportTop(fileId);
                                  },
                              })}
                        {...(options.outsideThreads === undefined ? {} : { outsideThreads: options.outsideThreads })}
                    />
                </SettingsProvider>,
            );
        });
    };
    render(files);

    let live = true;
    const unmount = (): void => {
        if (!live) {
            return;
        }
        live = false;
        act(() => {
            root.unmount();
        });
        host.remove();
        scrollElement.remove();
    };
    mounted.push(unmount);

    return {
        host,
        parsed,
        handle,
        liveEvents: () => liveListeners.map((entry) => entry.type),
        rerender: render,
        unmount,
    };
}

/** Дождаться разрешения промисов разбора и вызванной ими перерисовки. */
async function settle(): Promise<void> {
    await act(async () => {
        await Promise.resolve();
    });
}

/** Прокрутить время на несколько кадров: доводке нужно два подряд плюс кадр на снятие флага. */
async function frames(count = 4): Promise<void> {
    await act(async () => {
        for (let index = 0; index < count; index += 1) {
            await new Promise<void>((resolve) => {
                requestAnimationFrame(() => {
                    resolve();
                });
            });
        }
    });
}

function listHandle(view: Mounted): DiffListHandle {
    const handle = view.handle.current;
    if (handle === null) {
        throw new Error('ручка списка не смонтировалась');
    }
    return handle;
}

function listElement(view: Mounted): HTMLElement {
    const list = view.host.querySelector<HTMLElement>('.diff-list');
    if (list === null) {
        throw new Error('список не отрисовался');
    }
    return list;
}

/** Стор с подменённым `revealFile`: раскрытие цели — часть контракта `scrollToFile`. */
function storeWithRevealSpy(files: readonly FileDiff[]): {
    readonly store: DiffViewStore;
    readonly revealFile: ReturnType<typeof vi.fn>;
} {
    const real = createDiffViewStore({ files });
    const revealFile = vi.fn((fileId: string) => {
        real.revealFile(fileId);
    });
    return { store: { ...real, revealFile }, revealFile };
}

describe('список карточек диффа', () => {
    it('заказывает разбор по одному разу на видимый файл и обходит свёрнутые', async () => {
        const [first, second] = plainFiles(2);
        if (first === undefined || second === undefined) {
            throw new Error('фикстуре medium нужны два обычных файла');
        }
        const files = [first, second, GENERATED];
        const store = createDiffViewStore({ files });
        const view = mount({ files, store });
        await settle();

        expect(view.parsed).toEqual([first.fileId, second.fileId]);

        // Раскрытие машинного файла — единственный поздний разбор, и ровно один.
        await act(async () => {
            store.revealFile(GENERATED.fileId);
            await Promise.resolve();
        });

        expect(view.parsed).toEqual([first.fileId, second.fileId, GENERATED.fileId]);
    });

    it('провал разбора доезжает до карточки, «Повторить» заказывает разбор заново', async () => {
        const file = plainFiles(1)[0];
        if (file === undefined) {
            throw new Error('фикстуре medium нужен обычный файл');
        }
        let attempt = 0;
        const view = mount({
            files: [file],
            parse: (candidate) => {
                attempt += 1;
                return attempt === 1
                    ? Promise.reject(new Error('воркер упал'))
                    : Promise.resolve(parseFileDiff(toParseRequest(candidate)));
            },
        });
        await settle();

        const notice = view.host.querySelector<HTMLElement>('.file-card__notice');
        expect(notice?.textContent).toContain(t('diff.file.parseFailed', 'воркер упал'));
        expect(view.host.querySelectorAll('.diff-row')).toHaveLength(0);

        const retry = notice?.querySelector<HTMLButtonElement>('.file-card__action');
        expect(retry?.textContent).toBe(t('diff.file.retryParse'));
        await act(async () => {
            retry?.click();
            await Promise.resolve();
        });
        await settle();

        expect(view.parsed).toEqual([file.fileId, file.fileId]);
        expect(view.host.querySelector('.file-card__notice')).toBeNull();
        expect(view.host.querySelectorAll('.diff-row').length).toBeGreaterThan(0);
    });

    it('scrollToFile неизвестного файла отвечает false и никого не двигает', async () => {
        const files = plainFiles(2);
        const { store, revealFile } = storeWithRevealSpy(files);
        const view = mount({ files, store });
        await settle();
        virtual.instance().scrollToIndex.mockClear();

        await expect(listHandle(view).scrollToFile('нет такого файла')).resolves.toBe(false);
        await frames();

        expect(revealFile).not.toHaveBeenCalled();
        expect(virtual.instance().scrollToIndex).not.toHaveBeenCalled();
    });

    it('scrollToFile с reveal: false доводит прокрутку, но карточку не раскрывает', async () => {
        const files = plainFiles(2);
        const target = files[1];
        if (target === undefined) {
            throw new Error('фикстуре medium нужны два обычных файла');
        }
        const { store, revealFile } = storeWithRevealSpy(files);
        const view = mount({ files, store });
        await settle();
        virtual.instance().scrollToIndex.mockClear();

        const quiet = listHandle(view).scrollToFile(target.fileId, { reveal: false });
        await frames();
        await expect(quiet).resolves.toBe(true);

        expect(revealFile).not.toHaveBeenCalled();
        expect(virtual.instance().scrollToIndex).toHaveBeenCalledWith(1, { align: 'start' });

        // Умолчание — противоположное: переход из дерева обязан раскрыть цель.
        const loud = listHandle(view).scrollToFile(target.fileId);
        await frames();
        await expect(loud).resolves.toBe(true);

        expect(revealFile).toHaveBeenCalledWith(target.fileId);
    });

    it('о верхнем файле сообщает только при его смене', async () => {
        const files = plainFiles(3);
        const [first, second] = files;
        if (first === undefined || second === undefined) {
            throw new Error('фикстуре medium нужны три обычных файла');
        }
        const onTopFileChange = vi.fn<(fileId: string | null) => void>();
        const view = mount({ files, onTopFileChange });
        await settle();

        expect(onTopFileChange.mock.calls).toEqual([[first.fileId]]);

        // Первая карточка уехала за верхнюю кромку: верхней стала вторая.
        virtual.instance().scrollOffset = virtual.ITEM_HEIGHT + 50;
        view.rerender(files);
        await settle();

        expect(onTopFileChange.mock.calls).toEqual([[first.fileId], [second.fileId]]);

        view.rerender(files);
        await settle();

        expect(onTopFileChange.mock.calls).toEqual([[first.fileId], [second.fileId]]);
    });

    it('считает свёрнутые файлы, машинные — отдельным счётчиком', async () => {
        const [first, second] = plainFiles(2);
        if (first === undefined || second === undefined) {
            throw new Error('фикстуре medium нужны два обычных файла');
        }
        const files = [first, second, GENERATED];
        const store = createDiffViewStore({ files });
        const view = mount({ files, store });
        await settle();
        const list = listElement(view);

        expect(list.dataset.collapsedFiles).toBe('1');
        expect(list.dataset.generatedCollapsedFiles).toBe('1');

        await act(async () => {
            store.toggleFileCollapse(first.fileId);
            await Promise.resolve();
        });

        expect(list.dataset.collapsedFiles).toBe('2');
        expect(list.dataset.generatedCollapsedFiles).toBe('1');

        await act(async () => {
            store.toggleFileCollapse(GENERATED.fileId);
            await Promise.resolve();
        });

        expect(list.dataset.collapsedFiles).toBe('1');
        expect(list.dataset.generatedCollapsedFiles).toBe('0');
    });

    it('тред, скрытый линзой, остаётся в карточке, пока он kept', async () => {
        const withThread = pickFile(
            MEDIUM.diff.files,
            (file) => MEDIUM.threads.some((candidate) => candidate.anchor?.fileId === file.fileId) && isPlain(file),
            'файл с тредом',
        );
        const kept = MEDIUM.threads.find((candidate) => candidate.anchor?.fileId === withThread.fileId);
        if (kept === undefined) {
            throw new Error('у выбранного файла пропал тред');
        }
        const files = [withThread];
        const threadStore = createThreadStore(MEDIUM.threads, new Set(files.map((file) => file.fileId)));
        const view = mount({ files, threadStore, threadVisible: () => false });
        await settle();

        expect(view.host.querySelectorAll('[data-thread-id]')).toHaveLength(0);

        await act(async () => {
            threadStore.keepVisible(kept.id);
            await Promise.resolve();
        });

        expect(view.host.querySelector('[data-thread-id]')?.getAttribute('data-thread-id')).toBe(kept.id);
    });

    it('файл выше порога свёртки строк не рисует, пока его не открыли', async () => {
        const big = pickFile(
            HUGE.diff.files,
            (file) => !file.generated && file.viewed !== true && file.additions + file.deletions > COLLAPSE_THRESHOLD,
            'файл выше порога свёртки',
        );
        const files = [big];
        const store = createDiffViewStore({ files });
        const view = mount({ files, store });
        await settle();

        expect(view.host.querySelector('.file-card__collapsed')?.textContent).toBe(
            t('diff.file.sizeCollapsed', big.additions + big.deletions),
        );
        expect(view.host.querySelectorAll('.diff-row')).toHaveLength(0);

        await act(async () => {
            store.openFile(big.fileId);
            await Promise.resolve();
        });

        expect(view.host.querySelector('.file-card__collapsed')).toBeNull();
        expect(view.host.querySelectorAll('.diff-row').length).toBeGreaterThan(0);
    });

    it('пустой дифф — пустой список; верхний файл обнуляется при уходе последнего', async () => {
        const files = plainFiles(2);
        const store = createDiffViewStore({ files });
        const onTopFileChange = vi.fn<(fileId: string | null) => void>();
        const view = mount({ files: EMPTY.diff.files, store, onTopFileChange });
        await settle();

        expect(EMPTY.diff.files).toHaveLength(0);
        expect(view.host.querySelectorAll('.diff-list__item')).toHaveLength(0);
        // Верхнего файла не было и нет — сообщать не о чем.
        expect(onTopFileChange).not.toHaveBeenCalled();

        view.rerender(files);
        await settle();
        onTopFileChange.mockClear();

        view.rerender(EMPTY.diff.files);
        await settle();

        expect(view.host.querySelectorAll('.diff-list__item')).toHaveLength(0);
        expect(onTopFileChange.mock.calls).toEqual([[null]]);
    });

    it('без стора тредов монтируется на заглушках и тредов не рисует', async () => {
        const withThread = pickFile(
            MEDIUM.diff.files,
            (file) => MEDIUM.threads.some((candidate) => candidate.anchor?.fileId === file.fileId) && isPlain(file),
            'файл с тредом',
        );
        const view = mount({ files: [withThread] });
        await settle();

        expect(view.host.querySelectorAll('.file-card')).toHaveLength(1);
        expect(view.host.querySelectorAll('[data-thread-id]')).toHaveLength(0);
        expect(view.host.querySelectorAll('.thread-list')).toHaveLength(0);
    });

    it('треды вне файлов стоят за виртуальным полотном', async () => {
        const view = mount({ outsideThreads: <p data-outside="1">вне файлов</p> });
        await settle();

        expect(view.host.querySelector('.diff-list__inner [data-outside]')).toBeNull();
        expect(view.host.querySelector('.diff-list > [data-outside]')?.textContent).toBe('вне файлов');
    });

    it('размонтирование снимает наблюдателей и слушатели прокрутки', async () => {
        const view = mount();
        await settle();

        expect(TestResizeObserver.instances.length).toBeGreaterThanOrEqual(2);
        expect(TestResizeObserver.instances.every((observer) => observer.disconnect.mock.calls.length === 0)).toBe(
            true,
        );
        expect(view.liveEvents()).toEqual(expect.arrayContaining(['scroll', 'wheel', 'touchmove']));

        view.unmount();

        expect(TestResizeObserver.instances.every((observer) => observer.disconnect.mock.calls.length > 0)).toBe(true);
        // Пусто, а не «сняли такой тип»: снятие с чужой ссылкой оставило бы запись на месте.
        expect(view.liveEvents()).toEqual([]);
    });
});

describe('оценки высоты из CSS скролл-контейнера', () => {
    it.each([false, true])('смена только палитры сохраняет измеренные высоты (Arcanum: %s)', async (arcanum) => {
        const scrollElement = document.createElement('div');
        scrollElement.style.setProperty('--line-height-code', '17px');
        scrollElement.style.setProperty('--diff-card-estimate-chrome-height', '46px');
        scrollElement.setAttribute('data-theme', arcanum ? 'arcanum-dark' : 'dark');
        const settings = createUiSettingsStore({ loaded: true, initial: { theme: 'dark', arcanum } });
        const file = pickFile(MEDIUM.diff.files, isPlain, 'обычный текстовый файл');
        mount({ files: [file], settings, scrollElement, parse: () => new Promise(() => undefined) });
        const estimate = virtual.instance().estimateSize(0);
        virtual.instance().measure.mockClear();

        await act(async () => {
            settings.update({ theme: 'light' });
            scrollElement.setAttribute('data-theme', arcanum ? 'arcanum-light' : 'light');
            await Promise.resolve();
        });

        expect(virtual.instance().estimateSize(0)).toBe(estimate);
        expect(virtual.instance().measure).not.toHaveBeenCalled();
    });

    it('берёт CSS вместо настроек и обновляет высоту скелетона и оценку при смене поддерева', async () => {
        const style = document.createElement('style');
        style.textContent = `
            .geometry { --line-height-code: 13px; --diff-card-estimate-chrome-height: 41px; }
            .geometry[data-theme="light"] { --line-height-code: 31px; --diff-card-estimate-chrome-height: 59px; }
        `;
        document.head.append(style);
        mounted.push(() => {
            style.remove();
        });
        const scrollElement = document.createElement('div');
        scrollElement.className = 'geometry';
        scrollElement.setAttribute('data-theme', 'arcanum-light');
        const settings = createUiSettingsStore({ loaded: true, initial: { arcanum: false } });
        const file = {
            ...pickFile(MEDIUM.diff.files, isPlain, 'обычный текстовый файл'),
            changeType: 'add' as const,
            additions: 10,
            deletions: 0,
        };
        const { host } = mount({ files: [file], settings, scrollElement, parse: () => new Promise(() => undefined) });

        expect(virtual.instance().estimateSize(0)).toBe(171);
        expect(host.querySelector<HTMLElement>('.file-card__loading')?.style.minHeight).toBe('130px');
        virtual.instance().measure.mockClear();
        await act(async () => {
            scrollElement.setAttribute('data-theme', 'light');
            await Promise.resolve();
        });
        expect(virtual.instance().estimateSize(0)).toBe(369);
        expect(host.querySelector<HTMLElement>('.file-card__loading')?.style.minHeight).toBe('310px');
        expect(virtual.instance().measure).toHaveBeenCalled();

        virtual.instance().measure.mockClear();
        act(() => {
            settings.update({ textSize: 'l' });
        });
        expect(virtual.instance().measure).toHaveBeenCalled();
    });
});

/**
 * Свёртка файла убирает только строки: тред у строки в свёрнутой карточке — маркер на кромке.
 * Раскрытый тред стоит под шапкой со своим маркером, свёрнутые после последнего раскрытого — у сводки.
 */
describe('треды свёрнутой карточки', () => {
    const LINE_THREAD = (() => {
        const found = MEDIUM.threads.find((candidate) => {
            const file = MEDIUM.diff.files.find((item) => item.fileId === candidate.anchor?.fileId);
            return (
                candidate.anchor?.position != null &&
                !candidate.resolved &&
                !candidate.outdated &&
                file !== undefined &&
                isPlain(file) &&
                file.additions + file.deletions <= COLLAPSE_THRESHOLD
            );
        });
        if (found === undefined) {
            throw new Error('фикстуре medium нужен открытый тред у строки обычного файла');
        }
        return found;
    })();
    const FILE = pickFile(MEDIUM.diff.files, (file) => file.fileId === LINE_THREAD.anchor?.fileId, 'файл треда');

    async function mountWith(threads: readonly Thread[]) {
        const files = [FILE];
        const store = createDiffViewStore({ files });
        const threadStore = createThreadStore(threads, new Set([FILE.fileId]));
        const view = mount({ files, store, threadStore, threadVisible: () => true });
        await settle();
        const marker = (): HTMLButtonElement | null => view.host.querySelector<HTMLButtonElement>('.thread-marker');
        const summaryMarkers = (): HTMLButtonElement[] => [
            ...view.host.querySelectorAll<HTMLButtonElement>(
                '.file-card__collapsed-row > .file-card__collapsed-markers > .thread-marker',
            ),
        ];
        const summaryMarker = (): HTMLButtonElement | null => summaryMarkers()[0] ?? null;
        /** Маркер раскрытого треда под шапкой свёрнутой карточки. */
        const openMarker = (): HTMLButtonElement | null =>
            view.host.querySelector<HTMLButtonElement>('.file-card__marked-thread > .thread-marker');
        const shown = (id: string): boolean => view.host.querySelector(`[data-thread-id="${id}"]`) !== null;
        const toggleFile = async (): Promise<void> => {
            await act(async () => {
                store.toggleFileCollapse(FILE.fileId);
                await Promise.resolve();
            });
        };
        const click = async (button: HTMLButtonElement | null): Promise<void> => {
            await act(async () => {
                button?.click();
                await Promise.resolve();
            });
        };
        const cardCollapsed = (): boolean => view.host.querySelector('.file-card__collapsed') !== null;
        return {
            host: view.host,
            threadStore,
            marker,
            summaryMarker,
            summaryMarkers,
            openMarker,
            shown,
            toggleFile,
            click,
            cardCollapsed,
        };
    }

    it('маркер свёрнутой карточки переключает тред через стор, карточка остаётся свёрнутой, состояние доезжает до строки', async () => {
        const card = await mountWith([LINE_THREAD]);
        expect(card.marker()?.getAttribute('aria-expanded')).toBe('true');

        await card.click(card.marker());
        expect(card.shown(LINE_THREAD.id)).toBe(false);

        await card.toggleFile();
        expect(card.cardCollapsed()).toBe(true);
        expect(card.summaryMarker()?.getAttribute('aria-expanded')).toBe('false');
        expect(card.shown(LINE_THREAD.id)).toBe(false);

        await card.click(card.summaryMarker());
        expect(card.cardCollapsed()).toBe(true);
        expect(card.threadStore.getSnapshot().openThreads.has(LINE_THREAD.id)).toBe(true);
        // Раскрытый тред уходит от сводки под шапку вместе со своим маркером.
        expect(card.summaryMarker()).toBeNull();
        expect(card.openMarker()?.classList.contains('is-open')).toBe(true);
        expect(card.shown(LINE_THREAD.id)).toBe(true);

        await card.toggleFile();
        expect(card.cardCollapsed()).toBe(false);
        expect(card.openMarker()).toBeNull();
        expect(card.summaryMarker()).toBeNull();
        expect(card.marker()?.getAttribute('aria-expanded')).toBe('true');
        expect(card.shown(LINE_THREAD.id)).toBe(true);

        await card.toggleFile();
        await card.click(card.openMarker());
        expect(card.cardCollapsed()).toBe(true);
        expect(card.shown(LINE_THREAD.id)).toBe(false);
        expect(card.summaryMarker()?.getAttribute('aria-expanded')).toBe('false');

        await card.toggleFile();
        expect(card.marker()?.getAttribute('aria-expanded')).toBe('false');
        expect(card.shown(LINE_THREAD.id)).toBe(false);
    });

    it('resolved-тред, раскрытый вручную, раскрыт и в свёрнутой карточке', async () => {
        const card = await mountWith([{ ...LINE_THREAD, resolved: true }]);
        // Дефолт resolved-треда — свёрнут.
        expect(card.marker()?.getAttribute('aria-expanded')).toBe('false');
        expect(card.shown(LINE_THREAD.id)).toBe(false);

        await card.click(card.marker());
        expect(card.shown(LINE_THREAD.id)).toBe(true);

        await card.toggleFile();
        expect(card.cardCollapsed()).toBe(true);
        expect(card.openMarker()?.getAttribute('aria-expanded')).toBe('true');
        expect(card.summaryMarker()).toBeNull();
        expect(card.shown(LINE_THREAD.id)).toBe(true);

        await card.toggleFile();
        expect(card.marker()?.getAttribute('aria-expanded')).toBe('true');
        expect(card.shown(LINE_THREAD.id)).toBe(true);
    });

    it('тред без позиции стоит под шапкой свёрнутой карточки без маркера', async () => {
        const general: Thread = {
            ...LINE_THREAD,
            id: `${LINE_THREAD.id}-general`,
            anchor: LINE_THREAD.anchor === null ? null : { ...LINE_THREAD.anchor, position: null },
        };
        const card = await mountWith([general, LINE_THREAD]);

        await card.toggleFile();
        expect(card.cardCollapsed()).toBe(true);
        expect(card.shown(general.id)).toBe(true);
        // Маркер один — у треда с позицией; тред без позиции стоит отдельно, вне блока с маркером.
        expect(card.host.querySelectorAll('.thread-marker')).toHaveLength(1);
        expect(card.openMarker()?.parentElement?.querySelector(`[data-thread-id="${LINE_THREAD.id}"]`)).not.toBeNull();
        expect(
            card.host.querySelector(`[data-thread-id="${general.id}"]`)?.closest('.file-card__marked-thread'),
        ).toBeNull();
    });

    it('раскрытый тред встаёт среди маркеров по порядку строк: выше — над ним, ниже — под ним', async () => {
        const atLine = (line: number, name: string): Thread => ({
            ...LINE_THREAD,
            id: `${LINE_THREAD.id}-${String(line)}`,
            anchor:
                LINE_THREAD.anchor === null
                    ? null
                    : { ...LINE_THREAD.anchor, position: { side: 'new', line, size: 1 } },
            root: {
                ...LINE_THREAD.root,
                author: { ...LINE_THREAD.root.author, login: name.toLowerCase(), displayName: name },
            },
        });
        // Инициалы авторов — метки маркеров: A — строка 46, B — 52, C — 58.
        const t46 = atLine(46, 'Ann');
        const t52 = atLine(52, 'Bob');
        const t58 = atLine(58, 'Cid');
        const threads = [t58, t46, t52];
        const card = await mountWith(threads);
        act(() => {
            card.threadStore.setThreadsOpen(
                threads.map((item) => item.id),
                false,
            );
        });
        await card.toggleFile();
        expect(card.cardCollapsed()).toBe(true);

        const markerOf = (initial: string): HTMLButtonElement | null =>
            [...card.host.querySelectorAll<HTMLButtonElement>('.thread-marker')].find(
                (marker) => marker.querySelector('.thread-marker__avatar')?.textContent === initial,
            ) ?? null;
        /** Маркеры, тела тредов и сводка карточки в порядке документа. */
        const order = (): string[] =>
            [
                ...card.host.querySelectorAll<HTMLElement>('.thread-marker, [data-thread-id], .file-card__collapsed'),
            ].map((element) => {
                if (element.classList.contains('thread-marker')) {
                    const initial = element.querySelector('.thread-marker__avatar')?.textContent;
                    return `${initial ?? ''}:${element.getAttribute('aria-expanded') ?? ''}`;
                }
                return element.classList.contains('file-card__collapsed')
                    ? 'summary'
                    : `body:${element.dataset.threadId ?? ''}`;
            });
        const inSummaryRow = (initial: string): boolean =>
            markerOf(initial)?.closest('.file-card__collapsed-row') !== null;
        expect(order()).toEqual(['A:false', 'B:false', 'C:false', 'summary']);

        await card.click(markerOf('B'));
        expect(order()).toEqual(['A:false', 'B:true', `body:${t52.id}`, 'C:false', 'summary']);
        expect(inSummaryRow('A')).toBe(false);
        expect(inSummaryRow('C')).toBe(true);

        await card.click(markerOf('C'));
        expect(order()).toEqual(['A:false', 'B:true', `body:${t52.id}`, 'C:true', `body:${t58.id}`, 'summary']);
        expect(inSummaryRow('C')).toBe(false);

        await card.click(markerOf('B'));
        expect(order()).toEqual(['A:false', 'B:false', 'C:true', `body:${t58.id}`, 'summary']);
        // Свёрнутые выше раскрытого — одна стопка под шапкой.
        expect(markerOf('A')?.parentElement).toBe(markerOf('B')?.parentElement);
        expect(inSummaryRow('B')).toBe(false);
        expect(card.cardCollapsed()).toBe(true);
        expect(card.shown(t46.id)).toBe(false);
    });

    it('большой файл с провалом разбора показывает свёрнутый тред под шапкой, а не прячет его', async () => {
        const large: FileDiff = { ...FILE, additions: COLLAPSE_THRESHOLD + 1 };
        const resolved: Thread = { ...LINE_THREAD, resolved: true };
        const view = mount({
            files: [large],
            parse: () => Promise.reject(new Error('воркер упал')),
            threadStore: createThreadStore([resolved], new Set([large.fileId])),
            threadVisible: () => true,
        });
        await settle();

        expect(view.host.querySelector('.file-card__notice')?.textContent).toContain(
            t('diff.file.parseFailed', 'воркер упал'),
        );
        expect(view.host.querySelector(`[data-thread-id="${resolved.id}"]`)).not.toBeNull();
        expect(view.host.querySelector('.thread-marker')).toBeNull();
    });
});

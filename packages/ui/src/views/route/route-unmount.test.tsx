// @vitest-environment jsdom
import { fixtureIteration, routeFixtures } from '@sherpa/fixtures';
import type { RouteSnapshot } from '@sherpa/protocol';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { toParseRequest } from '../../diff/model.js';
import { parseFileDiff } from '../../diff/parse.js';
import { createDiffViewStore } from '../../diff-view/store.js';
import type { DiffViewStore } from '../../diff-view/store.js';
import { createSessionStore } from '../../session/session-store.js';
import type { SessionStore } from '../../session/session-store.js';
import { createThreadStore } from '../../threads/store.js';
import type { ThreadStore } from '../../threads/store.js';
import { openReply } from '../../threads/thread-list.tsx';
import { RouteWorkspace } from './route-workspace.tsx';

/**
 * Снятие колонки диффа далёкой остановки с DOM. В jsdom нет ни раскладки, ни
 * наблюдателей — оба подменяются: `IntersectionObserver` даёт тесту дёргать границы
 * гистерезиса руками, `offsetHeight` колонки — ненулевую высоту для плейсхолдера.
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

/**
 * Высота карточки файла: в jsdom все размеры нулевые, а плейсхолдеру нужна настоящая.
 * Колонка меряется как «столько-то карточек», поэтому по высоте плейсхолдера видно и то,
 * сколько карточек в остановке, и то, перемеряли ли её вообще.
 */
let cardHeight = 100;

/** Высота колонки: столько же, сколько намерил бы браузер по нарисованным карточкам. */
function columnHeight(cards: number): string {
    return `${String(cards * cardHeight)}px`;
}

/** Первая остановка плана: её колонку не снимают никогда. */
const FIRST_STOP = 's01';
/** Остановка на семь файлов, из них четыре в линзе «мои» и один с тредом. */
const WIDE_STOP = 's03';
/** Тред в файле `WIDE_STOP`: на нём проверяется ответ, который держит колонку. */
const WIDE_STOP_THREAD = '4820242';
const WIDE_STOP_FILES = 7;
/** Столько файлов `WIDE_STOP` остаётся под линзой «мои файлы». */
const WIDE_STOP_MINE_FILES = 4;

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

interface FakeObserver {
    readonly rootMargin: string;
    readonly callback: IntersectionObserverCallback;
    readonly elements: Set<Element>;
}

const observers: FakeObserver[] = [];

class FakeIntersectionObserver {
    private readonly record: FakeObserver;

    constructor(callback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
        this.record = { rootMargin: options?.rootMargin ?? '0px', callback, elements: new Set() };
        observers.push(this.record);
    }

    observe(element: Element): void {
        this.record.elements.add(element);
    }

    unobserve(element: Element): void {
        this.record.elements.delete(element);
    }

    disconnect(): void {
        const index = observers.indexOf(this.record);
        if (index >= 0) {
            observers.splice(index, 1);
        }
    }
}

/** Наблюдателям тулбара и колонки диффа хватает пустышки: раскладки в jsdom нет. */
class FakeResizeObserver {
    observe(): void {
        // Раскладки в jsdom нет — наблюдать нечего.
    }
    unobserve(): void {
        // Раскладки в jsdom нет — наблюдать нечего.
    }
    disconnect(): void {
        // Раскладки в jsdom нет — наблюдать нечего.
    }
}

beforeEach(() => {
    observers.length = 0;
    cardHeight = 100;
    (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver = FakeIntersectionObserver;
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver = FakeResizeObserver;
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
        configurable: true,
        get(this: HTMLElement) {
            return this.classList.contains('route-stop__diff')
                ? this.querySelectorAll('.file-card').length * cardHeight
                : 0;
        },
    });
});

const mounted: (() => void)[] = [];

afterEach(() => {
    for (const unmount of mounted.splice(0)) {
        unmount();
    }
    delete (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver;
    delete (globalThis as { ResizeObserver?: unknown }).ResizeObserver;
});

/** Сообщить наблюдателю с этой границей, что секция остановки её пересекает или нет. */
function report(section: Element, rootMargin: string, isIntersecting: boolean): void {
    for (const observer of [...observers]) {
        if (observer.rootMargin !== rootMargin || !observer.elements.has(section)) {
            continue;
        }
        observer.callback(
            [{ isIntersecting, target: section } as unknown as IntersectionObserverEntry],
            observer as unknown as IntersectionObserver,
        );
    }
}

/** Остановка побывала на экране и уехала за дальнюю границу — то, что делает проход маршрута. */
function passBy(section: Element): void {
    act(() => {
        report(section, '800px', true);
        report(section, '1200px', true);
    });
    act(() => {
        report(section, '2500px', false);
    });
}

function sections(host: HTMLElement): HTMLElement[] {
    return [...host.querySelectorAll<HTMLElement>('[data-stop]')];
}

function section(host: HTMLElement, stopId: string): HTMLElement {
    const found = host.querySelector<HTMLElement>(`[data-stop="${stopId}"]`);
    if (found === null) {
        throw new Error(`вью маршрута не нарисовала остановку ${stopId}`);
    }
    return found;
}

function placeholder(section: HTMLElement): HTMLElement | null {
    return section.querySelector<HTMLElement>('.route-stop__placeholder');
}

interface MountResult {
    readonly host: HTMLElement;
    readonly store: DiffViewStore;
    readonly session: SessionStore;
    readonly threadStore: ThreadStore;
}

/** `parsed: false` — ни одной разобранной модели: карточки стоят скелетонами разбора. */
function mount({ parsed = true }: { readonly parsed?: boolean } = {}): MountResult {
    const host = document.createElement('div');
    document.body.append(host);
    const store = createDiffViewStore({ files: DATA.diff.files });
    if (parsed) {
        for (const file of DATA.diff.files) {
            store.setModel(file.fileId, parseFileDiff(toParseRequest(file)));
        }
    }
    const session = createSessionStore({ initial: { view: 'route', filter: 'all' } });
    const threadStore = createThreadStore(DATA.threads, FILE_IDS);
    const root = createRoot(host);

    act(() => {
        root.render(
            <RouteWorkspace
                pr={DATA.pr}
                diff={DATA.diff}
                lenses={{ ownership: DATA.ownership, extra: [...DATA.extraLenses], ownershipSource: 'CODEOWNERS' }}
                snapshot={SNAPSHOT}
                session={session}
                store={store}
                threadStore={threadStore}
                progressLoaded
                threadNow={Date.parse('2026-08-24T12:00:00.000Z')}
                parse={
                    parsed
                        ? (file) => Promise.resolve(parseFileDiff(toParseRequest(file)))
                        : // Разбор, который не заканчивается: у карточек так и нет модели.
                          () => new Promise(() => undefined)
                }
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
    return { host, store, session, threadStore };
}

describe('колонка диффа остановки вне экрана', () => {
    it('уезжает с DOM, оставляя секцию и плейсхолдер измеренной высоты', () => {
        const { host } = mount();
        const wide = section(host, WIDE_STOP);
        const stopCount = sections(host).length;

        act(() => {
            report(wide, '800px', true);
        });
        const cards = wide.querySelectorAll('.file-card').length;
        expect(cards).toBeGreaterThan(0);
        act(() => {
            report(wide, '2500px', false);
        });

        expect(placeholder(wide)?.style.height).toBe(columnHeight(cards));
        expect(wide.querySelectorAll('.file-card')).toHaveLength(0);
        // Секции никуда не деваются: на них держатся прыжки, выбор верхней остановки и e2e.
        expect(sections(host)).toHaveLength(stopCount);
        expect(wide.querySelector('.route-stop__side')).not.toBeNull();

        act(() => {
            report(wide, '1200px', true);
        });
        expect(placeholder(wide)).toBeNull();
        expect(wide.querySelectorAll('.file-card').length).toBeGreaterThan(0);
    });

    it('первую остановку не снимает даже далеко за экраном', () => {
        const { host } = mount();
        const first = section(host, FIRST_STOP);
        const cards = first.querySelectorAll('.file-card').length;
        expect(cards).toBeGreaterThan(0);

        passBy(first);

        expect(placeholder(first)).toBeNull();
        expect(first.querySelectorAll('.file-card')).toHaveLength(cards);
    });

    it('остановку, которая не побывала на экране, не снимает: мерить нечего', () => {
        const { host } = mount();
        const wide = section(host, WIDE_STOP);

        // Ни разу не на экране — нарисована только голова списка карточек (`lazyCards`),
        // и её высота ничего не говорит о высоте полной колонки.
        act(() => {
            report(wide, '2500px', false);
        });

        expect(placeholder(wide)).toBeNull();
    });

    it('не мерит колонку, пока файлы остановки не разобраны', () => {
        const { host, store } = mount({ parsed: false });
        const wide = section(host, WIDE_STOP);

        passBy(wide);
        // Высота скелетонов разбора в кэш не попадает — иначе плейсхолдер соврал бы на всю карточку.
        expect(placeholder(wide)).toBeNull();

        act(() => {
            for (const file of DATA.diff.files) {
                store.setModel(file.fileId, parseFileDiff(toParseRequest(file)));
            }
        });

        // Разбор дошёл — высота померена по настоящим карточкам, и колонку можно снимать.
        expect(placeholder(wide)?.style.height).toBe(columnHeight(WIDE_STOP_FILES));
    });

    it('открытый ответ в треде держит колонку своей остановки', () => {
        const { host, threadStore } = mount();
        const wide = section(host, WIDE_STOP);
        passBy(wide);
        expect(placeholder(wide)).not.toBeNull();

        const thread = threadStore.getSnapshot().threads.find((item) => item.id === WIDE_STOP_THREAD);
        if (thread === undefined) {
            throw new Error(`фикстуре medium нужен тред ${WIDE_STOP_THREAD}`);
        }
        act(() => {
            // У ответа нет якоря: файл занят через тред, а не через раскладку строк.
            openReply(threadStore, thread, false);
        });

        expect(placeholder(wide)).toBeNull();
        expect(wide.querySelectorAll('.file-card').length).toBeGreaterThan(0);
    });

    it('смена линзы возвращает колонку остановки, у которой изменился состав файлов', () => {
        const { host, session } = mount();
        const wide = section(host, WIDE_STOP);
        passBy(wide);
        expect(placeholder(wide)).not.toBeNull();

        expect(placeholder(wide)?.style.height).toBe(columnHeight(WIDE_STOP_FILES));

        act(() => {
            // «Мои файлы» оставляют в этой остановке 4 файла из 7: старая высота соврала бы.
            session.setFilter('mine');
        });

        // Колонка вернулась на DOM, перемерилась под новый состав и снова ушла.
        expect(placeholder(wide)?.style.height).toBe(columnHeight(WIDE_STOP_MINE_FILES));
    });

    it('свёртка карточки в одной остановке не возвращает колонки остальных', () => {
        const { host, store } = mount();
        const wide = section(host, WIDE_STOP);
        passBy(wide);
        const height = placeholder(wide)?.style.height;
        expect(height).toBe(columnHeight(WIDE_STOP_FILES));

        // Перемер стал бы виден по высоте: карточки «выросли», пока остановка была снята.
        cardHeight = 200;
        const first = section(host, FIRST_STOP);
        const fileId = first.querySelector<HTMLElement>('.file-card[data-file]')?.dataset.file;
        if (fileId === undefined) {
            throw new Error('первой остановке нужна карточка файла');
        }
        act(() => {
            store.toggleFileCollapse(fileId);
        });

        // Метка раскладки считается по файлам самой остановки — чужая свёртка её не трогает.
        expect(placeholder(wide)?.style.height).toBe(height);
    });
});

describe('тред у кода на маршруте при свёртке карточки', () => {
    it('в свёрнутой карточке тред переключается маркером, состояние переживает развёртку и снятие колонки', () => {
        const { host, store, threadStore } = mount();
        const wide = section(host, WIDE_STOP);
        act(() => {
            report(wide, '800px', true);
        });
        const fileId = DATA.threads.find((thread) => thread.id === WIDE_STOP_THREAD)?.anchor?.fileId;
        if (fileId === undefined) {
            throw new Error(`у треда ${WIDE_STOP_THREAD} нужен файл`);
        }
        const card = (): HTMLElement | null => wide.querySelector<HTMLElement>(`.file-card[data-file="${fileId}"]`);
        const marker = (): HTMLButtonElement | null => card()?.querySelector<HTMLButtonElement>('.thread-marker') ?? null;
        const summaryMarkers = (): HTMLButtonElement[] => [
            ...(card()?.querySelectorAll<HTMLButtonElement>(
                '.file-card__collapsed-row > .file-card__collapsed-markers > .thread-marker',
            ) ?? []),
        ];
        const openMarker = (): HTMLButtonElement | null =>
            card()?.querySelector<HTMLButtonElement>('.file-card__marked-thread > .thread-marker') ?? null;
        const shown = (): boolean => wide.querySelector(`[data-thread-id="${WIDE_STOP_THREAD}"]`) !== null;
        const collapsed = (): boolean => card()?.querySelector('.file-card__collapsed') !== null;
        expect(shown()).toBe(true);

        act(() => {
            marker()?.click();
        });
        expect(shown()).toBe(false);

        act(() => {
            store.toggleFileCollapse(fileId);
        });
        expect(collapsed()).toBe(true);
        expect(shown()).toBe(false);
        expect(summaryMarkers()).toHaveLength(1);
        expect(summaryMarkers()[0]?.getAttribute('aria-expanded')).toBe('false');

        act(() => {
            summaryMarkers()[0]?.click();
        });
        expect(collapsed()).toBe(true);
        expect(threadStore.getSnapshot().openThreads.has(WIDE_STOP_THREAD)).toBe(true);
        expect(shown()).toBe(true);
        // Раскрытый тред со своим маркером переезжает под шапку.
        expect(summaryMarkers()).toHaveLength(0);
        expect(openMarker()?.getAttribute('aria-expanded')).toBe('true');
        act(() => {
            openMarker()?.click();
        });
        expect(shown()).toBe(false);
        expect(summaryMarkers()).toHaveLength(1);

        act(() => {
            store.toggleFileCollapse(fileId);
        });
        expect(marker()?.getAttribute('aria-expanded')).toBe('false');
        expect(shown()).toBe(false);

        act(() => {
            report(wide, '2500px', false);
        });
        expect(card()).toBeNull();
        act(() => {
            report(wide, '1200px', true);
        });
        expect(marker()?.getAttribute('aria-expanded')).toBe('false');
        expect(shown()).toBe(false);
    });
});

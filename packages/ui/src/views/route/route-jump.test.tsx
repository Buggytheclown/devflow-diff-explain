// @vitest-environment jsdom
import { fileContentOf, fixtureIteration, routeFixtures } from '@sherpa/fixtures';
import type { Lens, RouteSnapshot, UiFileProgress } from '@sherpa/protocol';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { toParseRequest } from '../../diff/model.js';
import { parseFileDiff } from '../../diff/parse.js';
import { expandAllGaps } from '../../diff-view/expand.js';
import { findLineRow } from '../../diff-view/line-target.js';
import type { DiffViewStore } from '../../diff-view/store.js';
import { createDiffViewStore } from '../../diff-view/store.js';
import { buildRouteModel } from '../../route/route-model.js';
import type { SessionStore } from '../../session/session-store.js';
import { createSessionStore } from '../../session/session-store.js';
import { createThreadStore } from '../../threads/store.js';
import type * as RouteScroll from './scroll.js';
import { RouteWorkspace } from './route-workspace.tsx';
import { nextCardInStop } from './stop-dom.js';
import { stopFileShownModel } from './stop-file-card.tsx';

/**
 * Живые клики по маршруту в jsdom: раскрытие тест-кода, флеш найденной строки и переход
 * к следующей остановке после отметки. Прямоугольников в jsdom нет, поэтому саму прокрутку
 * наблюдаем по флеш-классу цели, который ставит та же requestJump-механика.
 *
 * Контейнер в jsdom не едет: все прямоугольники нулевые. Наблюдаемое — выбор цели прыжка:
 * флеш встал на нужную остановку или строку; линза и свёртки проверяются по сторам и разметке.
 */

/**
 * Прокрутка прыжка наблюдается по вызовам `animateScrollTo`: прямоугольников в jsdom нет, и сам
 * `scrollTop` никуда не едет — а вот сколько раз прыжок целился, видно точно.
 */
const scrollAims = vi.hoisted(() => [] as number[]);
vi.mock('./scroll.js', async (importOriginal) => {
    const actual = await importOriginal<typeof RouteScroll>();
    return {
        ...actual,
        animateScrollTo: (container: HTMLElement, to: number, duration?: number) => {
            scrollAims.push(to);
            return actual.animateScrollTo(container, to, duration);
        },
    };
});

const DATA = fixtureIteration('medium');
const SNAPSHOT: RouteSnapshot = (() => {
    const snapshot = routeFixtures('medium')?.states.ready?.snapshot ?? null;
    if (snapshot === null) {
        throw new Error('фикстуре medium нужен готовый снапшот маршрута');
    }
    return snapshot;
})();
const FILE_IDS = new Set(DATA.diff.files.map((file) => file.fileId));
const MODELS = new Map(DATA.diff.files.map((file) => [file.fileId, parseFileDiff(toParseRequest(file))]));

// React 19 требует явного признания среды: без него каждый `act` пишет предупреждение.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Тулбар меряет свою высоту наблюдателем, которого в jsdom нет; раскладки тут всё равно нет.
(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class {
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

/**
 * Линза, которая оставляет дайджест-остановку на экране, но прячет один её тест-файл: в фикстуре
 * такой нет (все три файла s04 лежат в «Моих»), а именно на ней ломается сброс фильтра по якорю.
 */
const PARTIAL_LENS: Lens = {
    id: 'partial',
    label: 'Половина остановки',
    paths: DATA.diff.files
        .map((file) => file.path)
        .filter((path) => !path.endsWith('__tests__/edit-window.test.ts')),
    available: true,
    note: null,
    zones: null,
};
const GENERATED_FILE = DATA.diff.files.find((file) => file.path === 'pnpm-lock.yaml');
if (GENERATED_FILE === undefined) {
    throw new Error('фикстуре medium нужен generated-файл pnpm-lock.yaml');
}
const WITHOUT_GENERATED_LENS: Lens = {
    id: 'without-generated',
    label: 'Без generated-файла',
    paths: DATA.diff.files.filter((file) => file.fileId !== GENERATED_FILE.fileId).map((file) => file.path),
    available: true,
    note: null,
    zones: null,
};
const DIGEST_NON_TEST_ANCHOR = (() => {
    const anchor = SNAPSHOT.stops.find((stop) => stop.id === 's01')?.anchors[0];
    if (anchor === undefined) {
        throw new Error('у остановки s01 нужен якорь нетестового файла');
    }
    return anchor;
})();
const DIGEST_NON_TEST_LENS: Lens = {
    id: 'digest-non-test',
    label: 'Только нетестовый файл дайджеста',
    paths: [DIGEST_NON_TEST_ANCHOR.path],
    available: true,
    note: null,
    zones: null,
};

/** Добавляет в s04 нетестовый файл: линза может оставить остановку, спрятав весь её тест-код. */
function digestHiddenByLensSnapshot(): RouteSnapshot {
    return {
        ...SNAPSHOT,
        stops: SNAPSHOT.stops.map((stop) =>
            stop.id === 's04' ? { ...stop, anchors: [...stop.anchors, DIGEST_NON_TEST_ANCHOR] } : stop,
        ),
    };
}

/** Якоря утверждений дайджеста ведут в s01, не меняя состав файлов самой s04. */
function digestOutsideStopSnapshot(): RouteSnapshot {
    const target = SNAPSHOT.stops.find((stop) => stop.id === 's01')?.anchors[0];
    if (target === undefined) {
        throw new Error('у остановки s01 нужен якорь для производного снапшота');
    }
    return {
        ...SNAPSHOT,
        stops: SNAPSHOT.stops.map((stop) =>
            stop.id !== 's04'
                ? stop
                : {
                      ...stop,
                      tests: stop.tests.map((claim) =>
                          claim.kind === 'uncovered'
                              ? claim
                              : {
                                    ...claim,
                                    anchor: { fileId: target.fileId, path: target.path, line: target.start },
                                },
                      ),
                  },
        ),
    };
}

function hiddenExpandedRouteLine(): { readonly stopId: string; readonly fileId: string; readonly line: number } {
    const route = buildRouteModel({ snapshot: SNAPSHOT, files: DATA.diff.files, models: MODELS });
    for (const entry of route.entries) {
        if (entry.kind !== 'stop') {
            continue;
        }
        for (const group of entry.view.files) {
            const raw = MODELS.get(group.fileId);
            const content = fileContentOf(group.file);
            if (raw === undefined || content === null) {
                continue;
            }
            const base = stopFileShownModel(group, raw, content, new Map(), true);
            const expanded = stopFileShownModel(group, raw, content, expandAllGaps(raw, new Map()), true);
            if (expanded?.content.kind !== 'text') {
                continue;
            }
            for (const block of expanded.content.blocks) {
                if (block.kind !== 'hunk') {
                    continue;
                }
                for (const candidate of block.lines) {
                    const line = candidate.newLine;
                    if (
                        line !== null &&
                        !hasModelLine(base, 'new', line) &&
                        !routeOwnsLine(route.entries, group.fileId, 'new', line)
                    ) {
                        return { stopId: entry.view.stop.id, fileId: group.fileId, line };
                    }
                }
            }
        }
    }
    throw new Error('фикстуре нужна строка, видимая только после раскрытия контекста маршрута');
}

function hasModelLine(model: ReturnType<typeof stopFileShownModel>, side: 'old' | 'new', line: number): boolean {
    return (
        model?.content.kind === 'text' &&
        model.content.blocks.some(
            (block) =>
                block.kind === 'hunk' &&
                block.lines.some((candidate) => (side === 'old' ? candidate.oldLine : candidate.newLine) === line),
        )
    );
}

function routeOwnsLine(
    entries: ReturnType<typeof buildRouteModel>['entries'],
    fileId: string,
    side: 'old' | 'new',
    line: number,
): boolean {
    return entries.some((entry) => {
        const group = entry.view.files.find((file) => file.fileId === fileId);
        if (group === undefined) {
            return false;
        }
        const visible =
            group.anchors.some((anchor) => anchor.side === side && line >= anchor.start && line <= anchor.end) ||
            (side === 'old' ? group.contextLines.old.has(line) : group.contextLines.new.has(line));
        const collapsed =
            entry.kind === 'stop' &&
            (entry.view.files.find((file) => file.fileId === fileId)?.collapsedAnchors.some(
                (anchor) => anchor.side === side && line >= anchor.start && line <= anchor.end,
            ) ?? false);
        return visible || collapsed;
    });
}

interface Mounted {
    readonly host: HTMLElement;
    readonly session: SessionStore;
    readonly store: DiffViewStore;
    /** Остановки, для которых вью просило записать отметку «просмотрено». */
    readonly stopWrites: string[];
    /** Применить первый серверный снимок после уже смонтированного маршрута. */
    readonly applyProgress: (progress: readonly UiFileProgress[]) => void;
    /** Прокрутить время: карточки дорисовываются и прыжок доезжает по кадрам. */
    readonly settle: () => Promise<void>;
    /** Остановки, которые зажигали флеш прыжка с момента монтирования. */
    readonly flashedStops: () => ReadonlySet<string>;
}

const mounted: (() => void)[] = [];

afterEach(() => {
    for (const unmount of mounted.splice(0)) {
        unmount();
    }
});

function mount(
    options: {
        snapshot?: RouteSnapshot;
        filter?: string;
        extraLenses?: readonly Lens[];
        progress?: readonly UiFileProgress[];
        progressLoaded?: boolean;
        selectionTarget?: { readonly fileId: string; readonly side: 'old' | 'new'; readonly start: number };
        fileContent?: boolean;
    } = {},
): Mounted {
    const host = document.createElement('div');
    document.body.append(host);
    const flashedStops = watchStopFlashes(host);
    const store = createDiffViewStore({ files: DATA.diff.files, progress: options.progress ?? [] });
    for (const file of DATA.diff.files) {
        store.setModel(file.fileId, parseFileDiff(toParseRequest(file)));
    }
    const session = createSessionStore({
        initial: { view: 'route', filter: options.filter ?? 'all' },
    });
    const stopWrites: string[] = [];
    const threadStore = createThreadStore(DATA.threads, FILE_IDS);
    const root = createRoot(host);
    let progressLoaded = options.progressLoaded ?? true;
    const render = (): void => {
        root.render(
            <RouteWorkspace
                pr={DATA.pr}
                diff={DATA.diff}
                lenses={{ ownership: DATA.ownership, extra: [...(options.extraLenses ?? DATA.extraLenses)], ownershipSource: 'CODEOWNERS' }}
                snapshot={options.snapshot ?? SNAPSHOT}
                session={session}
                store={store}
                threadStore={threadStore}
                progressLoaded={progressLoaded}
                threadNow={Date.parse('2026-08-24T12:00:00.000Z')}
                parse={(file) => Promise.resolve(parseFileDiff(toParseRequest(file)))}
                loadContent={(fileId) => {
                    const file = DATA.diff.files.find((candidate) => candidate.fileId === fileId);
                    return Promise.resolve(options.fileContent && file !== undefined ? fileContentOf(file) : null);
                }}
                onSetViewed={() => Promise.resolve(0)}
                initialSelectionTarget={options.selectionTarget ?? null}
                onSetStopViewed={(stopId) => {
                    stopWrites.push(stopId);
                    return Promise.resolve(0);
                }}
                onSetStopFileViewed={() => Promise.resolve(0)}
            />,
        );
    };

    act(render);
    mounted.push(() => {
        act(() => {
            root.unmount();
        });
        host.remove();
    });

    const settle = async (): Promise<void> => {
        // Прыжок ищет цель покадрово: пары кадров хватает на раскрытие и на поиск строки.
        for (let step = 0; step < 6; step += 1) {
            await act(async () => {
                await new Promise((resolve) => setTimeout(resolve, 20));
            });
        }
    };

    return {
        host,
        session,
        store,
        stopWrites,
        applyProgress: (progress) => {
            act(() => {
                store.setProgress(progress);
                progressLoaded = true;
                render();
            });
        },
        settle,
        flashedStops,
    };
}

/**
 * Какие остановки зажигали флеш прыжка. Класс живёт `FLASH_MS`, а пауза теста меряется
 * перерисовками: на загруженной машине флеш успевает погаснуть до проверки, и «горит ли сейчас»
 * ловило бы скорость машины. Наблюдатель видит само появление.
 */
function watchStopFlashes(host: HTMLElement): () => ReadonlySet<string> {
    const seen = new Set<string>();
    const scan = (): void => {
        for (const flash of host.querySelectorAll<HTMLElement>('.route-stop__flash')) {
            const stopId = flash.closest<HTMLElement>('[data-stop]')?.dataset.stop;
            if (stopId !== undefined) {
                seen.add(stopId);
            }
        }
    };
    const observer = new MutationObserver(scan);
    observer.observe(host, { subtree: true, childList: true });
    mounted.push(() => {
        observer.disconnect();
    });
    return () => {
        scan();
        return seen;
    };
}

function stopSection(host: HTMLElement, stopId: string): HTMLElement {
    const section = host.querySelector<HTMLElement>(`[data-stop="${stopId}"]`);
    if (section === null) {
        throw new Error(`в разметке нет остановки ${stopId}`);
    }
    return section;
}

function viewedToggle(host: HTMLElement, stopId: string): HTMLButtonElement {
    const toggle = stopSection(host, stopId).querySelector<HTMLButtonElement>('.route-stop__viewed');
    if (toggle === null) {
        throw new Error(`у остановки ${stopId} нет тогла просмотра`);
    }
    return toggle;
}

/** Кнопка по точному тексту: клики в тестах ходят тем же путём, что и ревьюер. */
function button(scope: HTMLElement, text: string): HTMLElement {
    const found = [...scope.querySelectorAll<HTMLElement>('button')].find(
        (element) => element.textContent.trim() === text,
    );
    if (found === undefined) {
        throw new Error(`кнопки «${text}» в разметке нет`);
    }
    return found;
}

function click(element: HTMLElement): void {
    act(() => {
        element.click();
    });
}

function flashed(host: HTMLElement): HTMLElement | null {
    return host.querySelector<HTMLElement>('.diff-row--palette-target');
}

/** Прокрутить прыжок на `count` кадров: прицеливание идёт по requestAnimationFrame. */
async function jumpFrames(count: number): Promise<void> {
    await act(async () => {
        for (let step = 0; step < count; step += 1) {
            await new Promise<void>((resolve) => {
                requestAnimationFrame(() => {
                    resolve();
                });
            });
        }
    });
}

/**
 * Дождаться `count`-го прицеливания, считая кадры, а не миллисекунды: на загруженной машине кадр
 * растягивается, и фиксированная пауза мерила бы её скорость, а не поведение прыжка. Не дождались
 * за `limit` кадров — возвращаем что есть, дальше падает утверждение теста.
 */
async function aimsAtLeast(count: number, limit = 60): Promise<number> {
    for (let step = 0; step < limit && scrollAims.length < count; step += 1) {
        await jumpFrames(1);
    }
    return scrollAims.length;
}

describe('сворачивание карточек файлов маршрута', () => {
    it('клик по шапке сворачивает карточку и строка-сводка раскрывает её обратно', () => {
        const view = mount();
        const card = stopSection(view.host, 's01').querySelector<HTMLElement>('.file-card');
        const name = card?.querySelector<HTMLElement>('.file-card__name');
        if (card === null || name === null || name === undefined) {
            throw new Error('в первой остановке нужна карточка файла');
        }

        click(name);
        expect(card.querySelector('.file-card__collapsed--file')?.textContent).toContain('свёрнуто вручную');

        const summary = card.querySelector<HTMLElement>('.file-card__collapsed--file');
        if (summary === null) {
            throw new Error('после клика нужна строка-сводка');
        }
        click(summary);
        expect(card.querySelector('.file-card__collapsed--file')).toBeNull();
    });

    it('позиционные треды свёрнутой карточки остаются под шапкой', () => {
        const view = mount();
        const card = [...stopSection(view.host, 's01').querySelectorAll<HTMLElement>('.file-card')].find(
            (candidate) => candidate.querySelector('.file-card__name')?.textContent === 'edit-window.ts',
        );
        const name = card?.querySelector<HTMLElement>('.file-card__name');
        if (card === undefined || name === null || name === undefined) {
            throw new Error('в остановке s01 нужна карточка edit-window.ts');
        }
        const before = [...card.querySelectorAll<HTMLElement>('.thread')].map((thread) => thread.dataset.threadId);
        expect(before.length).toBeGreaterThan(0);

        click(name);

        expect(card.querySelector('.file-card__collapsed--file')).not.toBeNull();
        expect([...card.querySelectorAll<HTMLElement>('.thread')].map((thread) => thread.dataset.threadId)).toEqual(
            before,
        );
        // Каждый раскрытый тред — свой блок с маркером прямо в рамке карточки, первый сразу за шапкой,
        // все выше строки-сводки.
        const marked = [...card.querySelectorAll<HTMLElement>('.file-card__marked-thread')];
        const frame = card.querySelector('.file-card__frame');
        const summary = card.querySelector('.file-card__collapsed--file');
        expect(marked.map((block) => block.querySelector<HTMLElement>('.thread')?.dataset.threadId)).toEqual(before);
        expect(marked.every((block) => block.parentElement === frame)).toBe(true);
        expect(marked.every((block) => block.querySelector(':scope > .thread-marker') !== null)).toBe(true);
        expect(marked[0]?.previousElementSibling?.classList.contains('file-card__header')).toBe(true);
        const aboveSummary = (block: HTMLElement): boolean =>
            summary !== null && (block.compareDocumentPosition(summary) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
        expect(marked.every(aboveSummary)).toBe(true);
    });

    it('отметка просмотра сворачивает карточку, снятие возвращает развёртку', () => {
        const view = mount();
        const card = stopSection(view.host, 's01').querySelector<HTMLElement>('.file-card');
        const viewed = card?.querySelector<HTMLElement>('.file-card__viewed');
        if (card === null || viewed === null || viewed === undefined) {
            throw new Error('в первой остановке нужна карточка с тоглом просмотра');
        }

        click(viewed);
        expect(card.querySelector('.file-card__collapsed--file')?.textContent).toContain('просмотрено');

        click(viewed);
        expect(card.querySelector('.file-card__collapsed--file')).toBeNull();
    });

    it('переход по чипу сначала раскрывает свёрнутую карточку', async () => {
        const view = mount();
        const stop = stopSection(view.host, 's01');
        const card = stop.querySelector<HTMLElement>('.file-card');
        const name = card?.querySelector<HTMLElement>('.file-card__name');
        const fileId = card?.dataset.file;
        if (card === null || name === null || name === undefined || fileId === undefined) {
            throw new Error('в первой остановке нужна карточка файла');
        }
        const chip = [...stop.querySelectorAll<HTMLElement>('.route-chip')].find((candidate) => {
            const candidateName = candidate.querySelector('.route-chip__name')?.textContent;
            return candidateName === name.textContent;
        });
        if (chip === undefined) {
            throw new Error(`для файла ${fileId} нужен чип перехода`);
        }

        click(name);
        expect(card.querySelector('.file-card__collapsed--file')).not.toBeNull();
        click(chip);
        await view.settle();

        expect(card.querySelector('.file-card__collapsed--file')).toBeNull();
    });
});

describe('переход к скрытой строке маршрута', () => {
    it('раскрывает контекст и доезжает с ограниченным покадровым поиском', async () => {
        const target = hiddenExpandedRouteLine();
        const view = mount({
            selectionTarget: { fileId: target.fileId, side: 'new', start: target.line },
            fileContent: true,
        });

        await view.settle();

        expect(view.store.getSnapshot().expansion.get(target.fileId)?.size).toBeGreaterThan(0);
        expect(findLineRow(stopSection(view.host, target.stopId), 'new', target.line)).not.toBeNull();
    });
});

describe('отметка остановки: переход к следующей видимой', () => {
    it('первый уже покрытый снимок задаёт baseline без автоотметки и прыжка', async () => {
        const progress = DATA.diff.files.map(
            (file): UiFileProgress => ({ fileId: file.fileId, viewed: true, seenRanges: [] }),
        );
        const view = mount({ progress });

        await view.settle();

        expect(view.stopWrites).toEqual([]);
        expect(view.host.querySelector('.route-stop__flash')).toBeNull();
        expect(view.host.querySelector('[role="status"]')?.textContent).toBe('');
    });

    it('приехавший после маунта первый серверный снимок остаётся baseline', async () => {
        const view = mount({ progressLoaded: false });
        await view.settle();
        const progress = DATA.diff.files.map(
            (file): UiFileProgress => ({ fileId: file.fileId, viewed: true, seenRanges: [] }),
        );

        view.applyProgress(progress);
        await view.settle();

        expect(view.stopWrites).toEqual([]);
        expect(view.host.querySelector('.route-stop__flash')).toBeNull();
        expect(view.host.querySelector('[role="status"]')?.textContent).toBe('');
    });

    it('generated-дефолт не автоотмечает s06 и не запускает прыжок на маунте', async () => {
        const view = mount();

        await view.settle();

        expect(view.stopWrites).not.toContain('s06');
        expect(viewedToggle(view.host, 's06').getAttribute('aria-pressed')).toBe('false');
        expect(view.host.querySelector('.route-stop__flash')).toBeNull();
    });

    it('скрытая линзой автоотметка пишет прогресс без прыжка и aria-объявления', async () => {
        const view = mount({ filter: WITHOUT_GENERATED_LENS.id, extraLenses: [WITHOUT_GENERATED_LENS] });
        await view.settle();
        expect(view.host.querySelector('[data-stop="s06"]')).toBeNull();

        act(() => {
            view.store.markViewed(GENERATED_FILE.fileId, true);
        });
        await view.settle();

        expect(view.stopWrites).toContain('s06');
        expect(view.host.querySelector('.route-stop__flash')).toBeNull();
        expect(view.host.querySelector('[role="status"]')?.textContent).toBe('');
    });

    it('ручная отметка прыгает к следующей, не сбрасывая линзу и не раскрывая low', async () => {
        const view = mount({ filter: PARTIAL_LENS.id, extraLenses: [PARTIAL_LENS] });

        click(viewedToggle(view.host, 's04'));
        await view.settle();

        expect(view.session.getSnapshot().filter).toBe(PARTIAL_LENS.id);
        expect([...view.flashedStops()]).toContain('s05');
        expect(stopSection(view.host, 's05').querySelector('.route-collapsed')).not.toBeNull();
    });

    it('прыжок доводится ещё дважды: следующим кадром и после settle', async () => {
        const view = mount({ filter: PARTIAL_LENS.id, extraLenses: [PARTIAL_LENS] });
        await view.settle();
        scrollAims.length = 0;

        click(viewedToggle(view.host, 's04'));
        // Первый кадр целится в найденную секцию, следующий — уже в ужавшуюся разметку.
        await aimsAtLeast(1);
        await jumpFrames(2);
        const afterJump = scrollAims.length;
        expect(afterJump).toBeGreaterThanOrEqual(2);

        // Третий раз — после ANCHOR_SETTLE: к этому моменту сворачивание уже улеглось.
        expect(await aimsAtLeast(afterJump + 1)).toBeGreaterThan(afterJump);
    });

    it('автоотметка через последний файл прыгает к следующей остановке', async () => {
        const view = mount();
        const toggles = [...stopSection(view.host, 's01').querySelectorAll<HTMLButtonElement>('.file-card__viewed')];
        expect(toggles.length).toBeGreaterThan(0);

        act(() => {
            for (const toggle of toggles) {
                toggle.click();
            }
        });
        await view.settle();

        expect(stopSection(view.host, 's01').querySelector('.route-collapsed--viewed')).not.toBeNull();
        expect([...view.flashedStops()]).toContain('s02');
    });

    it('отметка последнего «Прочего» не запускает прыжок', async () => {
        const view = mount();
        await view.settle();
        await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 950));
        });
        expect(view.host.querySelector('.route-stop__flash')).toBeNull();
        expect(viewedToggle(view.host, 'other').getAttribute('aria-pressed')).toBe('false');

        click(viewedToggle(view.host, 'other'));
        await view.settle();

        expect(view.host.querySelector('.route-stop__flash')).toBeNull();
    });

    it('переход внутри остановки метит в ближайшую развёрнутую карточку', () => {
        const view = mount();
        const section = [...view.host.querySelectorAll<HTMLElement>('[data-stop]')].find(
            (candidate) => candidate.querySelectorAll('.file-card[data-file]').length >= 3,
        );
        if (section === undefined) {
            throw new Error('фикстуре нужна остановка минимум с тремя карточками');
        }
        const cards = [...section.querySelectorAll<HTMLElement>('.file-card[data-file]')];
        const [first, second, third] = cards;
        const stopId = section.dataset.stop;
        const fileId = first?.dataset.file;
        if (stopId === undefined || fileId === undefined || second === undefined || third === undefined) {
            throw new Error('карточкам остановки нужны id файлов');
        }
        const collapse = (card: HTMLElement): void => {
            const name = card.querySelector<HTMLElement>('.file-card__name');
            if (name === null) {
                throw new Error('в шапке карточки нужно имя файла');
            }
            // Клик по шапке — тогл: уже свёрнутую (машинный файл) он бы раскрыл.
            if (card.querySelector('.file-card__collapsed--file') === null) {
                click(name);
            }
        };

        expect(nextCardInStop(view.host, stopId, fileId)).toBe(second.dataset.file);

        // Свёрнутая карточка — уже прочитанная однострочка: переход целится мимо неё.
        collapse(second);
        expect(nextCardInStop(view.host, stopId, fileId)).toBe(third.dataset.file);

        // Ниже всё свёрнуто — тогда просто следующая, как и в полном диффе.
        for (const card of cards.slice(2)) {
            collapse(card);
        }
        expect(nextCardInStop(view.host, stopId, fileId)).toBe(second.dataset.file);
    });

    it('снятие отметки не запускает новый прыжок', async () => {
        const view = mount();
        click(viewedToggle(view.host, 's04'));
        await view.settle();
        await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 950));
        });
        expect(view.host.querySelector('.route-stop__flash')).toBeNull();

        click(viewedToggle(view.host, 's04'));
        await view.settle();

        expect(view.host.querySelector('.route-stop__flash')).toBeNull();
    });
});

describe('дайджест тестов: живые клики', () => {
    it('тогл раскрывает и прячет тест-код, ничего не записывая в прогресс', () => {
        const view = mount();

        expect(stopSection(view.host, 's04').querySelector('.file-card')).toBeNull();

        click(button(stopSection(view.host, 's04'), 'Показать тест-код'));
        expect(stopSection(view.host, 's04').querySelectorAll('.file-card')).toHaveLength(3);
        expect(view.session.getSnapshot().stops.testCode.has('s04')).toBe(true);

        click(button(stopSection(view.host, 's04'), 'Скрыть тест-код'));
        expect(stopSection(view.host, 's04').querySelector('.file-card')).toBeNull();
        expect(view.stopWrites).toEqual([]);
    });

    it('чип спрятанного тест-файла раскрывает тест-код и доезжает до карточки', async () => {
        const view = mount();
        const chip = [...stopSection(view.host, 's04').querySelectorAll<HTMLElement>('button')].find((element) =>
            element.textContent.includes('edit-window.test.ts'),
        );
        if (chip === undefined) {
            throw new Error('в шапке остановки должен быть чип тест-файла');
        }

        click(chip);
        await view.settle();

        // Клик по чипу больше не ведёт в пустоту: карточка файла появилась в разметке.
        expect(stopSection(view.host, 's04').querySelectorAll('.file-card').length).toBeGreaterThan(0);
        expect(view.session.getSnapshot().stops.testCode.has('s04')).toBe(true);
    });

    it('якорь утверждения раскрывает тест-код и подсвечивает свою строку', async () => {
        const view = mount();
        const anchor = [...stopSection(view.host, 's04').querySelectorAll<HTMLElement>('button.digest__anchor')].find(
            (element) => element.textContent === 'edit-window.test.ts:17',
        );
        if (anchor === undefined) {
            throw new Error('у первых утверждений дайджеста должны быть живые якоря');
        }

        click(anchor);
        await view.settle();

        const row = flashed(view.host);
        expect(row).not.toBeNull();
        // Подсвечена именно 17-я строка новой стороны, а не соседка с тем же номером старой.
        expect(row?.dataset.key).toBe('a17');
        expect(stopSection(view.host, 's04').contains(row)).toBe(true);
    });

    it('якорь uncovered уводит в чужую остановку и не роняет вью', async () => {
        const view = mount();
        const anchor = [...stopSection(view.host, 's04').querySelectorAll<HTMLElement>('button.digest__anchor')].find(
            (element) => element.textContent === 'edit-window.ts:92',
        );
        if (anchor === undefined) {
            throw new Error('у якоря uncovered на код должна быть живая ссылка');
        }

        click(anchor);
        await view.settle();

        const row = flashed(view.host);
        expect(row).not.toBeNull();
        // Строка 92 объяснена остановкой 01 — туда прыжок и уезжает, а не остаётся в дайджесте.
        expect(stopSection(view.host, 's01').contains(row)).toBe(true);
    });

    it('честная строка при пустом пересечении уводит в чужую остановку', async () => {
        const view = mount({ snapshot: digestOutsideStopSnapshot() });
        const location = button(stopSection(view.host, 's04'), 'тест-код — в остановке 01');

        click(location);
        await view.settle();

        const row = flashed(view.host);
        expect(row).not.toBeNull();
        expect(stopSection(view.host, 's01').contains(row)).toBe(true);
    });

    it('строка «скрыт линзой» сбрасывает линзу и раскрывает тест-код своей остановки', async () => {
        const view = mount({
            snapshot: digestHiddenByLensSnapshot(),
            filter: DIGEST_NON_TEST_LENS.id,
            extraLenses: [DIGEST_NON_TEST_LENS],
        });
        const stop = stopSection(view.host, 's04');
        expect(view.session.getSnapshot().filter).toBe(DIGEST_NON_TEST_LENS.id);
        expect(stop.querySelectorAll('.file-card')).toHaveLength(1);

        click(button(stop, 'тест-код скрыт линзой'));
        await view.settle();

        expect(view.session.getSnapshot().filter).toBe('all');
        expect(view.session.getSnapshot().stops.testCode.has('s04')).toBe(true);
        expect(stopSection(view.host, 's04').querySelectorAll('.file-card')).toHaveLength(4);
        const row = flashed(view.host);
        expect(row).not.toBeNull();
        expect(stopSection(view.host, 's04').contains(row)).toBe(true);
    });

    it('линза, спрятавшая файл якоря, сбрасывается — иначе приземляться некуда', async () => {
        const view = mount({ filter: PARTIAL_LENS.id, extraLenses: [PARTIAL_LENS] });
        expect(view.session.getSnapshot().filter).toBe(PARTIAL_LENS.id);

        const anchor = [...stopSection(view.host, 's04').querySelectorAll<HTMLElement>('button.digest__anchor')].find(
            (element) => element.textContent === 'edit-window.test.ts:17',
        );
        if (anchor === undefined) {
            throw new Error('дайджест печатает утверждения независимо от линзы');
        }

        click(anchor);
        await view.settle();

        expect(view.session.getSnapshot().filter).toBe('all');
        expect(flashed(view.host)).not.toBeNull();
    });
});

/** Снапшот, в описании первой остановки которого стоят обе внутренние ссылки словаря §2. */
function linkedParagraphSnapshot(path: string): RouteSnapshot {
    return {
        ...SNAPSHOT,
        stops: SNAPSHOT.stops.map((stop) =>
            stop.id === 's01'
                ? { ...stop, paragraph: `Подробности — [остановка 3](#stop-3) и [файл](#file-${path}).` }
                : stop,
        ),
    };
}

describe('внутренние ссылки описания остановки', () => {
    it('ссылка на файл ведёт туда же, куда чип: свёрнутая карточка сперва раскрывается', async () => {
        const path = SNAPSHOT.stops.find((stop) => stop.id === 's01')?.anchors[0]?.path;
        if (path === undefined) {
            throw new Error('у остановки s01 нужен якорь с путём');
        }
        const view = mount({ snapshot: linkedParagraphSnapshot(path) });
        const stop = stopSection(view.host, 's01');
        const card = stop.querySelector<HTMLElement>('.file-card');
        const name = card?.querySelector<HTMLElement>('.file-card__name');
        const link = stop.querySelector<HTMLElement>(`.route-stop__paragraph a[href="#file-${path}"]`);
        if (card === null || name === null || name === undefined || link === null) {
            throw new Error('в первой остановке нужны карточка файла и ссылка на неё');
        }

        click(name);
        expect(card.querySelector('.file-card__collapsed--file')).not.toBeNull();
        click(link);
        await view.settle();

        expect(card.querySelector('.file-card__collapsed--file')).toBeNull();
    });

    it('ссылка на остановку плана прыгает к ней и подсвечивает её', async () => {
        const view = mount({ snapshot: linkedParagraphSnapshot('нет/такого/файла.ts') });
        const link = stopSection(view.host, 's01').querySelector<HTMLElement>(
            '.route-stop__paragraph a[href="#stop-3"]',
        );
        if (link === null) {
            throw new Error('в описании первой остановки нужна ссылка на остановку 3');
        }

        click(link);
        await view.settle();

        expect([...view.flashedStops()]).toContain('s03');
    });

    it('ссылка в никуда не делает ничего: файла с таким путём на маршруте нет', async () => {
        const view = mount({ snapshot: linkedParagraphSnapshot('нет/такого/файла.ts') });
        const link = stopSection(view.host, 's01').querySelector<HTMLElement>(
            '.route-stop__paragraph a[href="#file-нет/такого/файла.ts"]',
        );
        if (link === null) {
            throw new Error('в описании первой остановки нужна ссылка на несуществующий файл');
        }

        click(link);
        await view.settle();

        expect(view.host.querySelector('.route-stop__flash')).toBeNull();
    });
});

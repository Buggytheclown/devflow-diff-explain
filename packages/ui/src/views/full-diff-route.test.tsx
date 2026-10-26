// @vitest-environment jsdom
import { fixtureIteration, routeFixtures } from '@sherpa/fixtures';
import type { FileDiff, RouteSnapshot } from '@sherpa/protocol';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';

import { toParseRequest } from '../diff/model.js';
import { parseFileDiff } from '../diff/parse.js';
import { COLLAPSE_THRESHOLD } from '../diff-view/file-card.tsx';
import { createDiffViewStore } from '../diff-view/store.js';
import { PrStateProvider } from '../pr-state/context.tsx';
import type { UiPrStateStore } from '../pr-state/pr-state-store.js';
import { createUiPrStateStore } from '../pr-state/pr-state-store.js';
import { createSessionStore } from '../session/session-store.js';
import { createThreadStore } from '../threads/store.js';
import type { ThreadStore } from '../threads/store.js';
import { DiffWorkspace } from './full-diff.tsx';

/**
 * Маршрут на полях полного диффа живьём: бейджи в дереве и в шапках карточек, футер-нота
 * с вычисленными числами, штрихованные полосы под непокрытыми диапазонами и клик, уводящий
 * к остановке. Без маршрута ридер обязан остаться ровно таким же, каким был до его появления.
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
/** Resolved-тред у строки `logging.ts` в фикстуре medium. */
const LOGGING_THREAD = '4820109';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const VIEWPORT_WIDTH = 900;
const VIEWPORT_HEIGHT = 700;

// В jsdom нет ни ResizeObserver, ни раскладки: список меряет свою ширину, и без заглушки
// монтирование падает ещё до первого бейджа. Наблюдаемое здесь — разметка, а не геометрия.
class NoopResizeObserver {
    observe(): void {
        // Ширина в jsdom не меняется никогда.
    }
    unobserve(): void {
        // См. `observe`.
    }
    disconnect(): void {
        // См. `observe`.
    }
}
(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= NoopResizeObserver;

// Виртуализатор рисует то, что помещается во вьюпорт, а в jsdom все прямоугольники нулевые:
// без размера в DOM не попала бы ни одна строка дерева и ни одна карточка.
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

// Размер прокручиваемого контейнера виртуализатор берёт из `offsetWidth`/`offsetHeight`.
for (const [name, value] of [
    ['offsetWidth', VIEWPORT_WIDTH],
    ['offsetHeight', VIEWPORT_HEIGHT],
] as const) {
    Object.defineProperty(HTMLElement.prototype, name, { configurable: true, get: () => value });
}

interface Mounted {
    readonly host: HTMLElement;
    /** Остановки, к которым вью просило перейти. */
    readonly jumps: string[];
    /** Файлы, которые вью просило разобрать (в порядке обращений, с повторами). */
    readonly parsed: string[];
    /** Перерисовать с другим диффом — как при обновлении PR. */
    readonly rerender: (files: readonly FileDiff[]) => void;
    readonly threadStore: ThreadStore;
}

const mounted: (() => void)[] = [];

afterEach(() => {
    for (const unmount of mounted.splice(0)) {
        unmount();
    }
});

function mount(
    options: {
        route?: boolean;
        paths?: readonly string[];
        files?: readonly FileDiff[];
        ownStore?: boolean;
        /** Общий стор состояния PR: им два монтирования делят серверную свёрнутость. */
        prState?: UiPrStateStore;
    } = {},
): Mounted {
    const host = document.createElement('div');
    document.body.append(host);
    // Виртуализация показывает только то, что помещается во вьюпорт: чтобы дотянуться до
    // карточки конкретного файла, дифф сужается до неё. Якоря остановок от этого не меняются.
    const initialFiles =
        options.files ??
        (options.paths === undefined
            ? DATA.diff.files
            : DATA.diff.files.filter((file) => options.paths?.includes(file.path) === true));
    // `ownStore` — вью само заводит стор по диффу: так проверяется фоновый разбор, а не заранее
    // разложенные по стору модели.
    const store = options.ownStore === true ? null : createDiffViewStore({ files: initialFiles });
    for (const file of store === null ? [] : initialFiles) {
        store?.setModel(file.fileId, parseFileDiff(toParseRequest(file)));
    }
    const session = createSessionStore({
        initial: {
            view: 'diff',
            filter: 'all',
        },
    });
    const jumps: string[] = [];
    const parsed: string[] = [];
    const threadStore = createThreadStore(DATA.threads, FILE_IDS);
    const root = createRoot(host);

    // Без провайдера палитра и дерево берут общий запасной стор модуля — тесту нужен свой.
    const prState = options.prState ?? createUiPrStateStore();

    const render = (files: readonly FileDiff[]): void => {
        act(() => {
            root.render(
                <PrStateProvider store={prState}>
                <DiffWorkspace
                    pr={DATA.pr}
                    diff={{ ...DATA.diff, files: [...files] }}
                    lenses={{ ownership: DATA.ownership, extra: DATA.extraLenses, ownershipSource: 'CODEOWNERS' }}
                    prKey="fixture-medium"
                    session={session}
                    {...(store === null ? {} : { store })}
                    threadStore={threadStore}
                    threadNow={Date.parse('2026-08-24T12:00:00.000Z')}
                    parse={(file) => {
                        parsed.push(file.fileId);
                        return Promise.resolve(parseFileDiff(toParseRequest(file)));
                    }}
                    loadContent={() => Promise.resolve(null)}
                    onSetViewed={() => Promise.resolve(0)}
                    {...(options.route === false ? {} : { routeSnapshot: SNAPSHOT })}
                    onJumpToStop={(stopId) => {
                        jumps.push(stopId);
                    }}
                />
                </PrStateProvider>,
            );
        });
    };
    render(initialFiles);
    mounted.push(() => {
        act(() => {
            root.unmount();
        });
        host.remove();
    });

    return { host, jumps, parsed, rerender: render, threadStore };
}

/** Дождаться фонового разбора: отложенный запуск плюс разрешение промисов `parse`. */
async function settleBackgroundParse(): Promise<void> {
    await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, BACKGROUND_PARSE_DELAY + 50));
    });
}

const BACKGROUND_PARSE_DELAY = 300;

function badges(host: HTMLElement, scope: 'tree' | 'card'): HTMLElement[] {
    return [...host.querySelectorAll<HTMLElement>(`.route-badge--${scope}`)];
}

function planLabelOf(path: string): string {
    const file = DATA.diff.files.find((candidate) => candidate.path === path);
    const stop = SNAPSHOT.stops.find(
        (candidate) =>
            candidate.tier !== 'other' && candidate.anchors.some((anchor) => anchor.fileId === file?.fileId),
    );
    if (stop === undefined) {
        throw new Error(`у файла ${path} нет остановки в фикстурном снапшоте`);
    }
    return String(stop.planIndex).padStart(2, '0');
}

describe('маршрут на полях полного диффа', () => {
    it('дерево несёт бейджи остановок и штриховку «вне маршрута»', () => {
        const { host } = mount();
        const labels = badges(host, 'tree').map((badge) => badge.textContent);

        expect(labels.length).toBeGreaterThan(0);
        expect(labels).toContain(planLabelOf('services/orders/src/api/handlers.ts'));
        // «Вне маршрута» в дереве — метка без текста: причина живёт в тултипе.
        expect(labels).toContain('');
        const hatched = badges(host, 'tree').filter((badge) => badge.classList.contains('route-badge--hatched'));
        expect(hatched.length).toBeGreaterThan(0);
        expect(hatched[0]?.getAttribute('title')).toContain('Без остановки маршрута');
    });

    it('футер-нота панели считает строки и файлы фикстуры', () => {
        const { host } = mount();
        const footer = host.querySelector('.file-panel__footer');

        expect(footer?.textContent).toBe(
            'Штриховка — у диапазона нет остановки маршрута. 38 строк в 4 файлах.',
        );
    });

    it('карточка получает бейдж «объяснено в NN · заголовок» и переход по клику', () => {
        const { host, jumps } = mount();
        const badge = badges(host, 'card')[0];

        expect(badge?.textContent).toMatch(/^объяснено в \d\d( \+\d)? · /);
        act(() => {
            badge?.click();
        });
        expect(jumps).toEqual([expect.stringMatching(/^s\d\d$/)]);
    });

    it('клик по штриховке в дереве уводит к «Прочему»', () => {
        const { host, jumps } = mount();
        const hatched = badges(host, 'tree').find((badge) => badge.classList.contains('route-badge--hatched'));

        act(() => {
            hatched?.click();
        });
        const other = SNAPSHOT.stops.find((stop) => stop.tier === 'other');
        expect(jumps).toEqual([other?.id]);
    });

    it('непокрытый диапазон закрыт штрихованной полосой с номерами строк', () => {
        // Файл частично покрыт: хвост `psp-schema.ts` — те самые 17 строк без остановки.
        const { host } = mount({ paths: ['services/orders/src/payments/generated/psp-schema.ts'] });
        act(() => {
            host.querySelector<HTMLElement>('.file-card__collapsed--file')?.click();
        });
        const strips = [...host.querySelectorAll<HTMLElement>('.route-strip__text')].map(
            (strip) => strip.textContent,
        );

        expect(strips.length).toBeGreaterThan(0);
        for (const text of strips) {
            expect(text).toMatch(/^(удалённ\S+ )?строк\S* \d+(–\d+)? без остановки маршрута$/);
        }
        expect(host.querySelector('.route-badge--card')?.textContent).toMatch(/^объяснено в /);
    });

    it('свёрнутая просмотренная карточка держит тред маркером, под шапкой — только раскрытым', () => {
        // Resolved-тред по умолчанию свёрнут в маркер.
        const { host, threadStore } = mount({ paths: ['services/orders/src/infra/logging.ts'], route: false });
        const marker = (): Element | null => host.querySelector('.file-card .thread-marker');

        expect(host.querySelector('.file-card__collapsed--file')?.textContent).toContain('просмотрено');
        expect(host.querySelector('.file-card__collapsed-hint')?.textContent).toBe('нажмите, чтобы раскрыть строки');
        expect(marker()?.getAttribute('aria-expanded')).toBe('false');
        expect(marker()?.closest('.file-card__collapsed-row')).not.toBeNull();
        expect(host.querySelector('.thread')).toBeNull();

        act(() => {
            threadStore.setThreadsOpen([LOGGING_THREAD], true);
        });
        expect(marker()?.getAttribute('aria-expanded')).toBe('true');
        expect(marker()?.closest('.file-card__marked-thread')?.querySelector('.thread')?.textContent).toContain(
            'process.env.DEBUG',
        );
        expect(host.querySelector('.file-card__collapsed-row')).toBeNull();
    });

    it('после смены диффа файлы разбираются заново — нота не виснет на «Считаю строки…»', async () => {
        // Обновление PR: новый объект диффа с теми же fileId (неизменившиеся файлы сохраняют id).
        // Стор вью пересоздаёт, значит и «уже разбирали» обязано обнулиться вместе с ним — иначе
        // файлы вне вьюпорта (карточки их не разбирают) остаются без моделей навсегда.
        const fileIds = new Set(DATA.diff.files.map((file) => file.fileId));
        const { host, parsed, rerender } = mount({ ownStore: true });
        await settleBackgroundParse();
        const note = host.querySelector('.file-panel__footer')?.textContent;
        expect(note).toBe('Штриховка — у диапазона нет остановки маршрута. 38 строк в 4 файлах.');

        parsed.length = 0;
        rerender(DATA.diff.files);
        await settleBackgroundParse();

        expect(new Set(parsed)).toEqual(fileIds);
        expect(host.querySelector('.file-panel__footer')?.textContent).toBe(note);
    });

    it('ручная свёртка переживает повторное монтирование того же PR', async () => {
        const path = 'services/orders/src/domain/order.ts';
        // Один стор состояния PR на два монтирования — то же, что перезагрузка вкладки:
        // свёрнутость приезжает не из памяти компонента, а из состояния PR.
        const prState = createUiPrStateStore();
        const first = mount({ paths: [path], ownStore: true, route: false, prState });

        await act(async () => {
            first.host.querySelector<HTMLElement>('.file-card__name')?.click();
            await Promise.resolve();
        });
        expect(first.host.querySelector('.file-card__collapsed--file')?.textContent).toContain('свёрнуто вручную');
        const fileId = first.host.querySelector<HTMLElement>('.file-card')?.dataset.file ?? '';
        expect(prState.getSnapshot().diffCollapsed).toEqual({ [fileId]: true });

        const second = mount({ paths: [path], ownStore: true, route: false, prState });
        expect(second.host.querySelector('.file-card__collapsed--file')?.textContent).toContain('свёрнуто вручную');
    });

    it('выделение пути мышью не сворачивает карточку', () => {
        const { host } = mount({ paths: ['services/orders/src/domain/order.ts'], route: false });
        const name = host.querySelector<HTMLElement>('.file-card__name');
        const selection = window.getSelection();
        const range = document.createRange();
        if (name === null || selection === null) {
            throw new Error('карточка и Selection API нужны этому тесту');
        }
        range.selectNodeContents(name);
        selection.removeAllRanges();
        selection.addRange(range);

        act(() => {
            name.click();
        });

        expect(host.querySelector('.file-card__collapsed--file')).toBeNull();
        selection.removeAllRanges();
    });

    it('свёрнутая карточка не заказывает разбор, раскрытие заказывает его', async () => {
        const path = 'services/orders/src/payments/generated/psp-schema.ts';
        const file = DATA.diff.files.find((candidate) => candidate.path === path);
        const { host, parsed } = mount({ paths: [path], ownStore: true, route: false });

        expect(file).toBeDefined();
        expect(parsed).toEqual([]);
        expect(host.querySelector('.file-card__collapsed--file')?.textContent).toContain('машинный файл');

        await act(async () => {
            host.querySelector<HTMLElement>('.file-card__collapsed--file')?.click();
            await Promise.resolve();
        });

        expect(parsed).toContain(file?.fileId);
    });

    it('свёрнутый по размеру файл по-прежнему заказывает разбор', async () => {
        const source = DATA.diff.files.find((file) => file.path === 'services/orders/src/domain/order.ts');
        if (source === undefined) {
            throw new Error('фикстуре medium нужен order.ts');
        }
        const big = { ...source, additions: COLLAPSE_THRESHOLD + 1 };
        const { parsed } = mount({ files: [big], ownStore: true, route: false });

        await act(async () => {
            await Promise.resolve();
        });

        expect(parsed).toContain(big.fileId);
    });

    it('без маршрута полей нет вовсе: ни бейджей, ни полос, ни ноты', () => {
        const { host } = mount({ route: false });

        expect(host.querySelector('.route-badge')).toBeNull();
        expect(host.querySelector('.route-strip')).toBeNull();
        expect(host.querySelector('.file-panel__footer')).toBeNull();
    });
});

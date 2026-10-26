// @vitest-environment jsdom
import type { Iteration, UiSnapshotSummary } from '@sherpa/protocol';
import { act } from 'react';
import type { ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';

import { createT } from '../i18n/index.js';
import { ShortcutsProvider } from '../shortcuts/context.tsx';
import { attachShortcuts, createShortcutRegistry } from '../shortcuts/registry.js';

import { rowText, SnapshotPill, SnapshotsCard } from './snapshot-picker.tsx';
import type { Viewing, ViewingLabel } from './viewing.js';
import { pickerRows, VIEWING_CURRENT } from './viewing.js';

/**
 * Срез в пикере выбирается в два шага: Shift+клик (Shift+⏎) по первой итерации, клик по второй.
 * Здесь же — превью диапазона, подсказка внизу меню, отметка активного среза и то же самое
 * в карточке «Снапшоты» на Обзоре.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const OLD_COMMIT = '9f3c1ab6d4e2705c8a1b3f9d6e4c2a08b7d5f316';
const GONE_COMMIT = 'b0d3f77a1c8e4562d0a9b8c7f6e5d4c3b2a10088';
const NEW_COMMIT = 'a71d4e2c9b8f5301d6e4a2c7b09f8e3d5a4c6b21';
const NOW = Date.parse('2026-08-31T12:00:00.000Z');

const SNAPSHOT: UiSnapshotSummary = {
    snapshotId: 'route-new',
    diffId: '182801',
    commit: NEW_COMMIT,
    baseCommit: 'base',
    createdAt: '2026-08-31T09:30:00.000Z',
    provenance: { harness: 'claude-code', model: 'sonnet-5', locale: null },
    previousSnapshotId: null,
    status: 'current',
};

function iteration(patch: Partial<Iteration>): Iteration {
    return {
        diffId: '182801',
        baseCommit: 'base',
        headCommit: NEW_COMMIT,
        createdAt: '2026-08-31T09:00:00.000Z',
        status: 'active',
        ...patch,
    };
}

const ITERATIONS: readonly Iteration[] = [
    iteration({ diffId: '182799', headCommit: GONE_COMMIT, status: 'gone' }),
    iteration({ diffId: '182800', headCommit: OLD_COMMIT, status: 'previous' }),
    iteration({}),
];

const LABEL: ViewingLabel = { kind: 'snapshot', commit: NEW_COMMIT, status: 'current' };
const SLICE_LABEL: ViewingLabel = {
    kind: 'slice',
    commit: NEW_COMMIT,
    baseCommit: OLD_COMMIT,
    status: 'slice',
};

const mounted: (() => void)[] = [];

afterEach(() => {
    for (const cleanup of mounted.splice(0)) {
        cleanup();
    }
});

interface Rendered {
    readonly host: HTMLElement;
    readonly chosen: Viewing[];
}

/** Монтирует под реестром команд: Esc ходит по лестнице слоёв, как в App. */
function mount(element: ReactNode): HTMLElement {
    const host = document.createElement('div');
    document.body.append(host);
    const registry = createShortcutRegistry();
    const detach = attachShortcuts(window, registry);
    const root = createRoot(host);
    act(() => {
        root.render(<ShortcutsProvider registry={registry}>{element}</ShortcutsProvider>);
    });
    mounted.push(() => {
        act(() => {
            root.unmount();
        });
        detach();
        host.remove();
    });
    return host;
}

function render(options: {
    readonly interdiff?: boolean;
    readonly snapshots?: readonly UiSnapshotSummary[];
    readonly iterations?: readonly Iteration[];
    readonly viewing?: Viewing;
    readonly label?: ViewingLabel;
}): Rendered {
    const rows = pickerRows({
        snapshots: options.snapshots ?? [SNAPSHOT],
        iterations: options.iterations ?? ITERATIONS,
        activeIteration: { diffId: '182801', commit: NEW_COMMIT },
        ...(options.interdiff === undefined ? {} : { interdiff: options.interdiff }),
    });
    const chosen: Viewing[] = [];
    const host = mount(
        <SnapshotPill
            label={options.label ?? LABEL}
            menu={{
                rows,
                viewing: options.viewing ?? VIEWING_CURRENT,
                now: NOW,
                onSelect: (viewing) => chosen.push(viewing),
                initialOpen: true,
            }}
        />,
    );
    return { host, chosen };
}

function sections(host: HTMLElement): string[] {
    return [...host.querySelectorAll('.snapshot-picker__section')].map((node) => node.textContent);
}

function hint(host: HTMLElement, selector = '.snapshot-picker__hint'): string | null {
    return host.querySelector(selector)?.textContent ?? null;
}

function menuOpen(host: HTMLElement): boolean {
    return host.querySelector('.snapshot-picker__menu') !== null;
}

function click(node: Element | null, shiftKey = false): void {
    act(() => {
        node?.dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey }));
    });
}

function shiftClick(node: Element | null): void {
    click(node, true);
}

function hover(node: Element | null): void {
    act(() => {
        node?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    });
}

function press(host: HTMLElement, key: string, shiftKey = false): void {
    const menu = host.querySelector<HTMLElement>('.snapshot-picker__menu');
    act(() => {
        menu?.dispatchEvent(new KeyboardEvent('keydown', { key, shiftKey, bubbles: true }));
    });
}

function escape(): void {
    act(() => {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
}

/** Отметки диапазона: id строки → край или внутренность. */
function sliceParts(host: HTMLElement, rowSelector: string): string[] {
    return [...host.querySelectorAll(rowSelector)].map((node) => {
        const id = node.getAttribute('data-snapshot') ?? node.getAttribute('data-diff') ?? '';
        const part = node.classList.contains('is-slice-edge')
            ? 'edge'
            : node.classList.contains('is-slice-inside')
              ? 'inside'
              : '-';
        return `${id}:${part}`;
    });
}

const PREVIOUS = '[data-diff="182800"]';
const OLDER = '[data-diff="182799"]';
const GONE = OLDER;
const ACTIVE_SNAPSHOT = '[data-snapshot="route-new"]';
const ROW = '.snapshot-picker__row';

/** Три годные итерации: между краями 182799 и активной лежит 182800. */
const THREE: readonly Iteration[] = [
    iteration({ diffId: '182799', headCommit: GONE_COMMIT, status: 'previous' }),
    iteration({ diffId: '182800', headCommit: OLD_COMMIT, status: 'previous' }),
    iteration({}),
];

const HINT_IDLE = 'Shift+клик по двум итерациям — срез между ними';
const HINT_SECOND = 'Выберите вторую итерацию · Esc или клик по первой ещё раз — отмена';

describe('срез в меню пикера', () => {
    it('в меню один раздел — хронология', () => {
        const { host } = render({ interdiff: true });

        expect(sections(host)).toEqual(['Снапшоты и итерации']);
        expect([...host.querySelectorAll(ROW)]).toHaveLength(3);
    });

    it('первый Shift+клик ставит край: меню открыто, выбора нет, подсказка про второй шаг', () => {
        const { host, chosen } = render({ interdiff: true });

        shiftClick(host.querySelector(PREVIOUS));

        expect(chosen).toEqual([]);
        expect(menuOpen(host)).toBe(true);
        expect(sliceParts(host, ROW)).toEqual(['route-new:-', '182800:edge', '182799:-']);
        expect(hint(host)).toBe(HINT_SECOND);
    });

    it('второй клик без Shift строит срез и закрывает меню', () => {
        const { host, chosen } = render({ interdiff: true });

        shiftClick(host.querySelector(PREVIOUS));
        click(host.querySelector(ACTIVE_SNAPSHOT));

        expect(chosen).toEqual([{ kind: 'slice', base: '182800', head: '182801' }]);
        expect(menuOpen(host)).toBe(false);
    });

    it('второй клик с Shift — тоже срез; порядок краёв не важен, активная годится в край', () => {
        const { host, chosen } = render({ interdiff: true, iterations: THREE });

        shiftClick(host.querySelector(ACTIVE_SNAPSHOT));
        shiftClick(host.querySelector(OLDER));

        expect(chosen).toEqual([{ kind: 'slice', base: '182799', head: '182801' }]);
    });

    it('повторный клик по краю снимает его, меню остаётся открытым', () => {
        const { host, chosen } = render({ interdiff: true });

        shiftClick(host.querySelector(PREVIOUS));
        click(host.querySelector(PREVIOUS));

        expect(chosen).toEqual([]);
        expect(menuOpen(host)).toBe(true);
        expect(sliceParts(host, ROW)).toEqual(['route-new:-', '182800:-', '182799:-']);
        expect(hint(host)).toBe(HINT_IDLE);

        // Режим снят: обычный клик снова — обычный выбор.
        click(host.querySelector(PREVIOUS));
        expect(chosen).toEqual([{ kind: 'diff', diffId: '182800' }]);
    });

    it('Esc снимает край, следующий Esc закрывает меню', () => {
        const { host, chosen } = render({ interdiff: true });

        shiftClick(host.querySelector(PREVIOUS));
        escape();

        expect(menuOpen(host)).toBe(true);
        expect(hint(host)).toBe(HINT_IDLE);
        expect(sliceParts(host, ROW)).toEqual(['route-new:-', '182800:-', '182799:-']);

        escape();
        expect(menuOpen(host)).toBe(false);
        expect(chosen).toEqual([]);
    });

    it('закрытие меню сбрасывает край', () => {
        const { host } = render({ interdiff: true });

        shiftClick(host.querySelector(PREVIOUS));
        press(host, 'Tab');
        act(() => {
            host.querySelector<HTMLButtonElement>('button.snapshot-pill--button')?.click();
        });

        expect(hint(host)).toBe(HINT_IDLE);
        expect(host.querySelector('.is-slice-edge')).toBeNull();
    });

    it('клавиатура: Shift+⏎ ставит край, ⏎ на другой строке строит срез', () => {
        const { host, chosen } = render({ interdiff: true });

        press(host, 'ArrowDown');
        press(host, 'Enter', true);
        expect(chosen).toEqual([]);
        expect(hint(host)).toBe(HINT_SECOND);

        press(host, 'ArrowUp');
        press(host, 'Enter');
        expect(chosen).toEqual([{ kind: 'slice', base: '182800', head: '182801' }]);
    });

    it('пробел на другой строке тоже строит срез', () => {
        const { host, chosen } = render({ interdiff: true });

        press(host, 'ArrowDown');
        press(host, 'Enter', true);
        press(host, 'ArrowUp');
        press(host, ' ');

        expect(chosen).toEqual([{ kind: 'slice', base: '182800', head: '182801' }]);
    });

    it('обычный клик и ⏎ без режима — обычный выбор', () => {
        const clicked = render({ interdiff: true });
        click(clicked.host.querySelector(PREVIOUS));
        expect(clicked.chosen).toEqual([{ kind: 'diff', diffId: '182800' }]);

        const pressed = render({ interdiff: true });
        press(pressed.host, 'ArrowDown');
        press(pressed.host, 'Enter');
        expect(pressed.chosen).toEqual([{ kind: 'diff', diffId: '182800' }]);
    });

    it('Shift+клик по ушедшей итерации и без срезов у хоста — обычный выбор', () => {
        const onGone = render({ interdiff: true });
        shiftClick(onGone.host.querySelector(GONE));
        expect(onGone.chosen).toEqual([{ kind: 'diff', diffId: '182799' }]);

        const noInterdiff = render({});
        shiftClick(noInterdiff.host.querySelector(PREVIOUS));
        expect(noInterdiff.chosen).toEqual([{ kind: 'diff', diffId: '182800' }]);
    });

    it('наведение на другую итерацию показывает превью диапазона, на край — только край', () => {
        const { host } = render({ interdiff: true, iterations: THREE });

        shiftClick(host.querySelector(OLDER));
        hover(host.querySelector(ACTIVE_SNAPSHOT));
        expect(sliceParts(host, ROW)).toEqual(['route-new:edge', '182800:inside', '182799:edge']);

        hover(host.querySelector(OLDER));
        expect(sliceParts(host, ROW)).toEqual(['route-new:-', '182800:-', '182799:edge']);
    });

    it('в срезе: строка «Сейчас: срез …», края с подписями, между ними — диапазон', () => {
        const { host } = render({
            interdiff: true,
            iterations: THREE,
            viewing: { kind: 'slice', base: '182799', head: '182801' },
            label: { ...SLICE_LABEL, baseCommit: GONE_COMMIT },
        });

        expect(host.querySelector('.snapshot-picker__now')?.textContent).toBe(
            `Сейчас: срез ${GONE_COMMIT.slice(0, 7)} → ${NEW_COMMIT.slice(0, 7)}`,
        );
        expect(sliceParts(host, ROW)).toEqual(['route-new:edge', '182800:inside', '182799:edge']);
        expect([...host.querySelectorAll('.snapshot-picker__role')].map((node) => node.textContent)).toEqual([
            'голова',
            'база',
        ]);
    });

    it('вне среза строки «Сейчас» и подписей нет', () => {
        const { host } = render({ interdiff: true });

        expect(host.querySelector('.snapshot-picker__now')).toBeNull();
        expect(host.querySelector('.snapshot-picker__role')).toBeNull();
    });

    it('превью нового среза заменяет подсветку активного', () => {
        const { host } = render({
            interdiff: true,
            iterations: THREE,
            viewing: { kind: 'slice', base: '182799', head: '182801' },
            label: SLICE_LABEL,
        });

        shiftClick(host.querySelector(PREVIOUS));
        hover(host.querySelector(OLDER));

        expect(sliceParts(host, ROW)).toEqual(['route-new:-', '182800:edge', '182799:edge']);
        expect(host.querySelector('.snapshot-picker__role')).toBeNull();
    });

    it('в срезе отмечены оба края, а индикатор называет обе стороны', () => {
        const { host } = render({
            interdiff: true,
            viewing: { kind: 'slice', base: '182800', head: '182801' },
            label: SLICE_LABEL,
        });

        expect(host.querySelector('.snapshot-pill')?.textContent).toContain(
            `срез ${OLD_COMMIT.slice(0, 7)} → ${NEW_COMMIT.slice(0, 7)}`,
        );
        expect(host.querySelector<HTMLElement>('.snapshot-pill')?.title).toBe(
            `Срез между итерациями ${OLD_COMMIT} → ${NEW_COMMIT}`,
        );
        const checked = [...host.querySelectorAll('[aria-checked="true"]')];
        expect(checked.map((node) => node.getAttribute('data-snapshot') ?? node.getAttribute('data-diff'))).toEqual([
            'route-new',
            '182800',
        ]);
    });

    it('у итерации с несколькими снапшотами отмечен верхний, промежуточные итерации не отмечены', () => {
        const { host } = render({
            interdiff: true,
            snapshots: [{ ...SNAPSHOT, snapshotId: 'route-new-1', status: 'stale' }, SNAPSHOT],
            iterations: THREE,
            viewing: { kind: 'slice', base: '182799', head: '182801' },
            label: SLICE_LABEL,
        });

        const checked = [...host.querySelectorAll('[aria-checked="true"]')];
        expect(checked.map((node) => node.getAttribute('data-snapshot') ?? node.getAttribute('data-diff'))).toEqual([
            'route-new',
            '182799',
        ]);
    });

    it('подсказка про Shift+клик есть, только когда хост умеет срезы и сравнить есть что', () => {
        expect(hint(render({ interdiff: true }).host)).toBe(HINT_IDLE);
        expect(hint(render({}).host)).toBeNull();
        expect(hint(render({ interdiff: true, iterations: [iteration({})] }).host)).toBeNull();
        // Ушедшую сравнить нельзя: с одной активной сравнивать нечего.
        expect(
            hint(
                render({
                    interdiff: true,
                    iterations: [iteration({ diffId: '182799', headCommit: GONE_COMMIT, status: 'gone' }), iteration({})],
                }).host,
            ),
        ).toBeNull();
    });

    it('подсказка — не пункт меню: стрелки на неё не встают', () => {
        const { host, chosen } = render({ interdiff: true });
        expect(host.querySelector('.snapshot-picker__hint')?.getAttribute('role')).toBeNull();

        for (let step = 0; step < 5; step += 1) {
            press(host, 'ArrowDown');
        }
        press(host, 'Enter');

        expect(chosen).toEqual([{ kind: 'diff', diffId: '182799' }]);
    });
});

describe('срез в карточке «Снапшоты» на Обзоре', () => {
    const CARD_ROW = '.snapshot-list__row';

    function renderCard(viewing: Viewing = VIEWING_CURRENT, iterations: readonly Iteration[] = ITERATIONS): Rendered {
        const rows = pickerRows({
            snapshots: [SNAPSHOT],
            iterations,
            activeIteration: { diffId: '182801', commit: NEW_COMMIT },
            interdiff: true,
        });
        const chosen: Viewing[] = [];
        const host = mount(
            <SnapshotsCard rows={rows} viewing={viewing} now={NOW} onSelect={(next) => chosen.push(next)} />,
        );
        return { host, chosen };
    }

    it('Shift+клик ставит край, клик по другой итерации строит срез', () => {
        const { host, chosen } = renderCard();

        shiftClick(host.querySelector(PREVIOUS));
        expect(chosen).toEqual([]);
        expect(sliceParts(host, CARD_ROW)).toEqual(['route-new:-', '182800:edge', '182799:-']);
        expect(hint(host, '.snapshot-list__hint')).toBe(HINT_SECOND);

        click(host.querySelector(ACTIVE_SNAPSHOT));
        expect(chosen).toEqual([{ kind: 'slice', base: '182800', head: '182801' }]);
        expect(host.querySelector('.is-slice-edge')).toBeNull();
        expect(hint(host, '.snapshot-list__hint')).toBe(HINT_IDLE);
    });

    it('обычный клик — обычный выбор, Shift+клик по ушедшей — тоже', () => {
        const { host, chosen } = renderCard();

        click(host.querySelector(PREVIOUS));
        shiftClick(host.querySelector(GONE));

        expect(chosen).toEqual([
            { kind: 'diff', diffId: '182800' },
            { kind: 'diff', diffId: '182799' },
        ]);
    });

    it('повторный клик по краю и Esc снимают его', () => {
        const { host, chosen } = renderCard();

        shiftClick(host.querySelector(PREVIOUS));
        click(host.querySelector(PREVIOUS));
        expect(host.querySelector('.is-slice-edge')).toBeNull();

        shiftClick(host.querySelector(PREVIOUS));
        escape();
        expect(host.querySelector('.is-slice-edge')).toBeNull();
        expect(chosen).toEqual([]);
    });

    it('наведение и фокус на другой итерации показывают превью диапазона', () => {
        const { host } = renderCard(VIEWING_CURRENT, THREE);

        shiftClick(host.querySelector(OLDER));
        hover(host.querySelector(ACTIVE_SNAPSHOT));
        expect(sliceParts(host, CARD_ROW)).toEqual(['route-new:edge', '182800:inside', '182799:edge']);

        act(() => {
            host.querySelector(ACTIVE_SNAPSHOT)?.dispatchEvent(new MouseEvent('mouseout', { bubbles: true }));
        });
        expect(sliceParts(host, CARD_ROW)).toEqual(['route-new:-', '182800:-', '182799:edge']);

        act(() => {
            host.querySelector<HTMLElement>(PREVIOUS)?.focus();
        });
        expect(sliceParts(host, CARD_ROW)).toEqual(['route-new:-', '182800:edge', '182799:edge']);
    });

    it('уход мыши со строки под фокусом не гасит превью', () => {
        const { host } = renderCard(VIEWING_CURRENT, THREE);

        shiftClick(host.querySelector(OLDER));
        act(() => {
            host.querySelector<HTMLElement>(ACTIVE_SNAPSHOT)?.focus();
        });
        hover(host.querySelector(ACTIVE_SNAPSHOT));
        act(() => {
            host.querySelector(ACTIVE_SNAPSHOT)?.dispatchEvent(new MouseEvent('mouseout', { bubbles: true }));
        });
        expect(sliceParts(host, CARD_ROW)).toEqual(['route-new:edge', '182800:inside', '182799:edge']);
    });

    it('в срезе отмечены оба края с подписями и диапазон между ними', () => {
        const { host } = renderCard({ kind: 'slice', base: '182799', head: '182801' }, THREE);

        const pressed = [...host.querySelectorAll('[aria-pressed="true"]')];
        expect(pressed.map((node) => node.getAttribute('data-snapshot') ?? node.getAttribute('data-diff'))).toEqual([
            'route-new',
            '182799',
        ]);
        expect(sliceParts(host, CARD_ROW)).toEqual(['route-new:edge', '182800:inside', '182799:edge']);
        expect([...host.querySelectorAll('.snapshot-list__role')].map((node) => node.textContent)).toEqual([
            'голова',
            'база',
        ]);
    });
});

describe('строки меню с неразличимым коммитом', () => {
    it('две итерации одного коммита печатают точное время, а не «6 ч назад»', () => {
        const rows = pickerRows({
            snapshots: [],
            iterations: [
                iteration({ diffId: '182799', status: 'previous', createdAt: '2026-08-31T09:00:00.000Z' }),
                iteration({ diffId: '182800', status: 'previous', createdAt: '2026-08-31T10:30:00.000Z' }),
            ],
            activeIteration: null,
        });
        const t = createT('ru');
        const texts = rows.iterations.map((row) => rowText(row, NOW, t, 'ru'));

        expect(new Set(texts).size).toBe(2);
        for (const text of texts) {
            expect(text).not.toContain('назад');
        }
    });

    it('коммиты в меню различаются — время остаётся округлённым', () => {
        const rows = pickerRows({
            snapshots: [],
            iterations: [
                iteration({ diffId: '182800', headCommit: OLD_COMMIT, status: 'previous' }),
                iteration({}),
            ],
            activeIteration: null,
        });
        const t = createT('ru');

        expect(rows.iterations.map((row) => rowText(row, NOW, t, 'ru'))).toEqual([
            `${NEW_COMMIT.slice(0, 7)} · активная итерация · без маршрута`,
            `${OLD_COMMIT.slice(0, 7)} · прошлая итерация · без маршрута`,
        ]);
    });
});

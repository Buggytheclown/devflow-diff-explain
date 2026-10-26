import type { Locator, Page } from '@playwright/test';

import { expect, test } from './sherpa-fixture.js';

interface GapGeometry {
    readonly upLeft: number;
    readonly downLeft: number;
    readonly counterLeft: number;
    readonly upWidth: number;
    readonly upHeight: number;
    readonly gapHeight: number;
    /** Верх и низ счётчика от верхней кромки ряда: вылет наружу — счётчик уехал в другую строку сетки. */
    readonly counterTop: number;
    readonly counterBottom: number;
}

/** Подпись «N строк скрыто» с русским согласованием — как в словаре UI. */
function hiddenLabel(count: number): string {
    const mod10 = count % 10;
    const mod100 = count % 100;
    if (mod10 === 1 && mod100 !== 11) {
        return `${String(count)} строка скрыта`;
    }
    if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) {
        return `${String(count)} строки скрыты`;
    }
    return `${String(count)} строк скрыто`;
}

for (const mode of ['unified', 'split'] as const) {
    test(`перемычка направленно раскрывает контекст без сдвига сетки и скролла: ${mode}`, async ({
        page,
        launchSherpa,
    }) => {
        const server = await launchSherpa('fixture-medium');
        await page.goto(server.url);
        await openFullDiff(page, mode);
        await checkDirection(page, mode, 'up');

        await page.reload();
        await openFullDiff(page, mode);
        await checkDirection(page, mode, 'down');
    });
}

async function openFullDiff(page: Page, mode: 'unified' | 'split'): Promise<void> {
    await page.getByRole('tab', { name: 'Полный дифф', exact: true }).click();
    // Режим диффа глобальный и переживает перезагрузку, поэтому смотрим на то,
    // что нарисовано, а не на выбор из хранилища.
    await expect(page.locator('.diff-rows').first()).toBeVisible();
    if ((await page.locator(`.diff-rows--${mode}`).count()) === 0) {
        await page.locator('.diff-mode-toggle').click();
    }
    await expect(page.locator(`.diff-rows--${mode}`).first()).toBeVisible();
    await expect.poll(() => page.locator('.diff-gap[data-edge="inner"]').count()).toBeGreaterThan(0);
}

async function checkDirection(page: Page, mode: 'unified' | 'split', direction: 'up' | 'down'): Promise<void> {
    const gap = await findInnerGap(page, 21);
    await gap.scrollIntoViewIfNeeded();
    await expect(gap).toBeVisible();

    const initialHidden = Number(await gap.getAttribute('data-hidden'));
    const adjacent = await adjacentNewLine(gap, direction === 'up' ? 'previous' : 'next');
    const beforeGeometry = await gapGeometry(gap);
    // Счётчик стоит в одной строке сетки с мишенями: у split его колонка левее мишени «вниз»,
    // и авто-размещение однажды уронило его на вторую строку — из ряда торчал обрезанный текст.
    expect(beforeGeometry.counterTop).toBeGreaterThanOrEqual(0);
    expect(beforeGeometry.counterBottom).toBeLessThanOrEqual(beforeGeometry.gapHeight);
    const beforeScroll = await page.locator('.full-diff').evaluate((element) => element.scrollTop);
    const target = gap.locator(`button[data-direction="${direction}"]`);

    await expect(target).toHaveAttribute(
        'aria-label',
        `догрузить 20 строк ${direction === 'up' ? 'вверх' : 'вниз'}, ${hiddenLabel(initialHidden)}`,
    );
    // Мишень — полоса во всю колонку номеров, а ширина колонки идёт от разрядности номеров карточки:
    // сверяем с колонкой соседнего ряда кода, а не с числом.
    const widths = await targetAndGutterWidth(target, mode, direction);
    expect(widths.target).toBeCloseTo(widths.gutter, 1);
    expect(widths.target).toBeGreaterThanOrEqual(24);
    await expect(target).toHaveCSS('height', '24px');
    if (direction === 'up') {
        await gap.focus();
        await page.keyboard.press('ArrowRight');
        const down = gap.locator('button[data-direction="down"]');
        await expect(down).toHaveClass(/is-active/);
        await expect(down).toHaveAttribute('aria-checked', 'true');
        await expect(gap).toHaveAttribute('aria-activedescendant', await down.getAttribute('id') ?? '');
        await page.keyboard.press('ArrowLeft');
        await expect(target).toHaveClass(/is-active/);
        await expect(target).toHaveAttribute('aria-checked', 'true');
    }
    await target.hover();
    await expect(gap.locator('.diff-gap__counter')).toContainText(
        new RegExp(`\\+20 строк ${direction === 'up' ? 'вверх' : 'вниз'} · ${String(initialHidden)} неизмен`),
    );
    // Ховер меняет только поверхность мишени (SPEC-changes-2026-09-20.md §5): счётчик рядом
    // остаётся своим `--text-dim-strong` тёмной темы (packages/ui/src/styles/tokens.css).
    await expect(gap.locator('.diff-gap__counter')).toHaveCSS('color', 'rgb(218, 228, 243)');
    if (direction === 'down') {
        // Ховер не двигает клавиатурный выбор — стрелку переключает только ←/→.
        await gap.focus();
        await page.keyboard.press('ArrowRight');
        await expect(target).toHaveClass(/is-active/);
        await page.keyboard.press('Enter');
    } else {
        await target.click();
    }

    const remaining = initialHidden - 20;
    await expect(gap).toHaveAttribute('data-hidden', String(remaining));
    const revealed = await immediateContextNewLine(gap, direction === 'up' ? 'previous' : 'next');
    expect(revealed).toBe(direction === 'up' ? adjacent + 20 : adjacent - 20);
    expect(await page.locator('.full-diff').evaluate((element) => element.scrollTop)).toBe(beforeScroll);
    expect(await gapGeometry(gap)).toEqual(beforeGeometry);
    await expect(gap.locator('.diff-gap__counter')).toHaveText(`${String(remaining)} неизменённых строк`);
    await expect(gap.locator('.diff-gap__counter')).toHaveCSS('pointer-events', 'none');
}

/**
 * Ширина мишени и колонки номеров, в которой она стоит, у ряда кода той же карточки:
 * «вверх» — первая колонка, «вниз» — колонка новых номеров (unified) или номеров правой половины (split).
 */
async function targetAndGutterWidth(
    target: Locator,
    mode: 'unified' | 'split',
    direction: 'up' | 'down',
): Promise<{ readonly target: number; readonly gutter: number }> {
    const column = direction === 'up' ? 0 : mode === 'unified' ? 1 : 3;
    return target.evaluate((element, index) => {
        const row = element.closest('.diff-rows')?.querySelector('.diff-row');
        if (row === null || row === undefined) {
            throw new Error('Рядом с перемычкой нет ряда кода');
        }
        const tracks = getComputedStyle(row).gridTemplateColumns.split(' ').map(Number.parseFloat);
        const gutter = tracks[index];
        if (gutter === undefined) {
            throw new Error(`У ряда кода нет колонки ${String(index)}`);
        }
        return { target: element.getBoundingClientRect().width, gutter };
    }, column);
}

async function findInnerGap(page: Page, minimumHidden: number): Promise<Locator> {
    const key = await page.locator('.diff-gap[data-edge="inner"]').evaluateAll((elements, minimum) => {
        const candidate = elements.find((element) => Number(element.getAttribute('data-hidden')) >= minimum);
        return candidate?.getAttribute('data-gap-key') ?? null;
    }, minimumHidden);
    if (key === null) {
        const hidden = await page.locator('.diff-gap[data-edge="inner"]').evaluateAll((elements) =>
            elements.map((element) => element.getAttribute('data-hidden')),
        );
        throw new Error(
            `Не найдена видимая внутренняя перемычка с остатком >= ${String(minimumHidden)}; видны ${hidden.join(', ')}`,
        );
    }
    return page.locator(`.diff-gap[data-gap-key="${key}"]`).first();
}

async function adjacentNewLine(gap: Locator, direction: 'previous' | 'next'): Promise<number> {
    return gap.evaluate((element, side) => {
        const parseNewLine = (key: string | null): number | null => {
            if (key === null) {
                return null;
            }
            if (key.startsWith('c')) {
                return Number(key.slice(1).split(':')[1]);
            }
            return key.startsWith('a') ? Number(key.slice(1)) : null;
        };
        let current = side === 'previous' ? element.previousElementSibling : element.nextElementSibling;
        while (current !== null) {
            const keys = [current.getAttribute('data-key'), ...[...current.querySelectorAll('[data-key]')].map((node) => node.getAttribute('data-key'))];
            const value = keys.map(parseNewLine).find((candidate) => candidate !== null) ?? null;
            if (value !== null) {
                return value;
            }
            current = side === 'previous' ? current.previousElementSibling : current.nextElementSibling;
        }
        throw new Error(`Не найдена строка ${side === 'previous' ? 'выше' : 'ниже'} перемычки`);
    }, direction);
}

async function immediateContextNewLine(gap: Locator, direction: 'previous' | 'next'): Promise<number> {
    return gap.evaluate((element, side) => {
        const sibling = side === 'previous' ? element.previousElementSibling : element.nextElementSibling;
        const context = sibling?.matches('[data-key^="c"]') === true
            ? sibling
            : sibling?.querySelector('[data-key^="c"]');
        const key = context?.getAttribute('data-key') ?? null;
        if (key === null) {
            throw new Error('Рядом с перемычкой ожидалась контекстная строка');
        }
        const value = Number(key.slice(1).split(':')[1]);
        if (!Number.isFinite(value)) {
            throw new Error(`У контекстной строки нет нового номера: ${key}`);
        }
        return value;
    }, direction);
}

async function gapGeometry(gap: Locator): Promise<GapGeometry> {
    return gap.evaluate((element) => {
        const up = element.querySelector<HTMLElement>('.diff-gap__slot--up');
        const down = element.querySelector<HTMLElement>('.diff-gap__slot--down');
        const counter = element.querySelector<HTMLElement>('.diff-gap__counter');
        if (up === null || down === null || counter === null) {
            throw new Error('Не удалось измерить колонки перемычки');
        }
        const gapRect = element.getBoundingClientRect();
        const upRect = up.getBoundingClientRect();
        const downRect = down.getBoundingClientRect();
        const counterRect = counter.getBoundingClientRect();
        return {
            upLeft: upRect.left,
            downLeft: downRect.left,
            counterLeft: counterRect.left,
            upWidth: upRect.width,
            upHeight: upRect.height,
            gapHeight: gapRect.height,
            counterTop: counterRect.top - gapRect.top,
            counterBottom: counterRect.bottom - gapRect.top,
        };
    });
}

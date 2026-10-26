import type { Locator, Page } from '@playwright/test';

import { expect, test } from './sherpa-fixture.js';

/**
 * Выделение строк при уже активном выделении (docs/design/SPEC-elements.md §2.14): живой диапазон
 * тянет только протяжка, начатая в гаттере. Зажатое движение над строками из колонки кода
 * или с поповера — чужое выделение текста, диапазон строк оно не трогает.
 */
test('активное выделение переживает выделение текста и заменяется новой протяжкой по гаттеру', async ({
    page,
    launchSherpa,
}) => {
    const server = await launchSherpa('fixture-medium');
    await page.goto(server.url);
    await page.getByRole('tab', { name: 'Полный дифф', exact: true }).click();
    await expect(card(page).locator('.diff-row[data-key="a18"]')).toBeAttached();
    // Карточка стоит не первой: без этого протяжки ниже прокручивают список, а прокрутка
    // мимо выделения его закрывает — шаги проверяли бы не то.
    await card(page).evaluate((element) => {
        element.scrollIntoView({ block: 'start' });
    });

    await test.step('протяжка по гаттеру выделяет диапазон', async () => {
        await dragBetween(page, gutter(page, 'a3'), gutter(page, 'a6'));
        await expect(page.locator('.selection-popover__count')).toBeVisible();
        expect(await selectedKeys(page)).toEqual(['a3', 'a4', 'a5', 'a6']);
    });

    await test.step('выделение текста в коде через несколько строк диапазон не тянет', async () => {
        await dragBetween(page, code(page, 'a16'), code(page, 'a18'));
        expect(await page.evaluate(() => String(getSelection()).length)).toBeGreaterThan(0);
        expect(await selectedKeys(page)).toEqual(['a3', 'a4', 'a5', 'a6']);
        await expect(page.locator('.selection-popover__count')).toBeVisible();
    });

    await test.step('протяжка, начатая на поповере и ушедшая на строки, диапазон не тянет', async () => {
        await dragBetween(page, page.locator('.selection-popover__count'), gutter(page, 'a20'));
        expect(await selectedKeys(page)).toEqual(['a3', 'a4', 'a5', 'a6']);
        await expect(page.locator('.selection-popover__count')).toBeVisible();
    });

    await test.step('новая протяжка по гаттеру заменяет диапазон', async () => {
        await dragBetween(page, gutter(page, 'a10'), gutter(page, 'a12'));
        expect(await selectedKeys(page)).toEqual(['a10', 'a11', 'a12']);
        await expect(page.locator('.selection-popover__count')).toHaveText('3 строки выделены');
    });
});

function card(page: Page): Locator {
    return page.locator('.file-card').filter({ has: page.locator('.diff-row[data-key="a18"]') }).first();
}

function gutter(page: Page, key: string): Locator {
    return card(page).locator(`.diff-row[data-key="${key}"] .diff-row__gutter`).first();
}

function code(page: Page, key: string): Locator {
    return card(page).locator(`.diff-row[data-key="${key}"] .diff-row__code`);
}

function selectedKeys(page: Page): Promise<string[]> {
    return card(page)
        .locator('.diff-row.is-selected')
        .evaluateAll((rows) => rows.map((row) => row.getAttribute('data-key') ?? ''));
}

async function dragBetween(page: Page, from: Locator, to: Locator): Promise<void> {
    await from.scrollIntoViewIfNeeded();
    const start = await from.boundingBox();
    const end = await to.boundingBox();
    if (start === null || end === null) {
        throw new Error('элементы для протяжки не отрисованы');
    }
    // Колонка кода: старт и финиш внутри текста, а не на левой кромке. Координаты округляются:
    // боковые поля страницы во vw ставят колонку на дробный x, и из субпиксельной точки Chromium
    // протяжку-выделение не начинает вовсе.
    await page.mouse.move(Math.round(start.x + Math.min(start.width / 2, 40)), Math.round(start.y + start.height / 2));
    await page.mouse.down();
    await page.mouse.move(Math.round(end.x + Math.min(end.width / 2, 60)), Math.round(end.y + end.height / 2), {
        steps: 6,
    });
    await page.mouse.up();
}

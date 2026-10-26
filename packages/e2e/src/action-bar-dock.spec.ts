import type { Locator, Page } from '@playwright/test';

import { expect, test } from './sherpa-fixture.js';

/**
 * Плавающая панель действий центрируется по колонке контента, а не по окну. При
 * пристыкованном чате (≥1280) она не пересекается с ним по X; в оверлейном режиме (<1280)
 * уходит под скрим, и терминальные действия ждут выхода из чата — включая хоткеи, которые
 * скрим сам по себе не остановил бы.
 */

/** Ширина пристыкованного чата — `components/chat-panel.css`. */
const CHAT_WIDTH = 392;
/** Ручка вердикта — `protocol/ui.ts`, `UI_ENDPOINTS.reviewPublish`. */
const PUBLISH_ENDPOINT = '/api/ui/review/publish';

test('панель действий уступает место пристыкованному чату на 1440', async ({ page, launchSherpa }) => {
    const server = await launchSherpa('fixture-medium');
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(server.url);
    // Индикатор открывает чат только у подключённого агента; маршрут для этого строить не нужно.
    expect((await server.worker.register('claude-code')).code).toBe(0);

    const bar = page.locator('.review-action-bar');
    await expect(bar).toBeVisible();
    const closedCenter = await centerX(bar);
    expect(closedCenter).toBeCloseTo(1440 / 2, 0);

    await page.locator('.agent-pill').click();
    const chat = page.locator('.chat-panel');
    await expect(chat).toBeVisible();

    // Переезд плавный: ждём конечную точку, а не первый кадр после открытия чата.
    await expect
        .poll(() => centerX(bar), { message: 'панель по центру колонки контента' })
        .toBeCloseTo((1440 - CHAT_WIDTH) / 2, 0);

    const barBox = await box(bar);
    const chatBox = await box(chat);
    expect(barBox.x + barBox.width, 'правый край панели левее чата').toBeLessThanOrEqual(chatBox.x);

    // Закрытие возвращает панель в центр окна: переезд плавный, но конечная точка та же.
    await page.locator('.agent-pill').click();
    await expect(chat).toHaveCount(0);
    await expect.poll(() => centerX(bar)).toBeCloseTo(1440 / 2, 0);
});

test('панель действий уходит под скрим чата-оверлея на 1024', async ({ page, launchSherpa }) => {
    const server = await launchSherpa('fixture-medium');
    await page.setViewportSize({ width: 1024, height: 768 });
    await page.goto(server.url);
    expect((await server.worker.register('claude-code')).code).toBe(0);

    const bar = page.locator('.review-action-bar');
    await expect(bar).toBeVisible();

    await page.locator('.agent-pill').click();
    await expect(page.locator('.chat-panel')).toBeVisible();
    await expect(page.locator('.chat-panel-scrim')).toBeVisible();

    const barBox = await box(bar);
    const point: [number, number] = [barBox.x + barBox.width / 2, barBox.y + barBox.height / 2];
    // В центре панели ловит клик скрим: слой панели переставляет тот же класс на корне.
    await expect
        .poll(() => elementAt(page, point), { message: 'в центре панели оказалась сама панель' })
        .toContain('chat-panel-scrim');

    // Мышь скрим удержит, а клавиатуру — нет: хоткеи публикации выключены тем же признаком.
    // Фокус уводим из композера — в чате его снимает любой клик по переписке.
    const publishRequests: string[] = [];
    page.on('request', (request) => {
        if (request.url().includes(PUBLISH_ENDPOINT)) {
            publishRequests.push(request.url());
        }
    });
    await page.evaluate(() => {
        (document.activeElement as HTMLElement | null)?.blur();
    });

    await page.keyboard.press('ControlOrMeta+Shift+Enter');
    await page.keyboard.press('ControlOrMeta+Enter');
    // Проверка отрицательная: и запрос публикации, и меню ушли бы в тот же кадр, что и нажатие,
    // поэтому ждём фиксированное окно, а не первое совпадение авторетрая.
    await page.waitForTimeout(1000);
    expect(publishRequests, 'вердикт ушёл в обход накрытой панели').toEqual([]);
    await expect(page.locator('.review-complete')).toHaveCount(0);
    await expect(page.locator('.review-action-menu')).toHaveCount(0);

    // Контроль: та же клавиша после закрытия чата работает — глушится режим, а не хоткеи вообще.
    await page.locator('.chat-panel-scrim').click();
    await expect(page.locator('.chat-panel')).toHaveCount(0);
    await page.keyboard.press('ControlOrMeta+Enter');
    await expect(page.locator('.review-action-menu')).toBeVisible();
});

test('пристыкованный чат хоткеи панели не трогает', async ({ page, launchSherpa }) => {
    const server = await launchSherpa('fixture-medium');
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(server.url);
    expect((await server.worker.register('claude-code')).code).toBe(0);

    await expect(page.locator('.review-action-bar')).toBeVisible();
    await page.locator('.agent-pill').click();
    await expect(page.locator('.chat-panel')).toBeVisible();

    await page.evaluate(() => {
        (document.activeElement as HTMLElement | null)?.blur();
    });
    await page.keyboard.press('ControlOrMeta+Enter');
    await expect(page.locator('.review-action-menu')).toBeVisible();
});

/** Классы верхнего элемента в точке: чем накрыта плавающая панель, видно только хит-тестом. */
function elementAt(page: Page, point: readonly [number, number]): Promise<string> {
    return page.evaluate(([x, y]) => {
        const element = document.elementFromPoint(x, y);
        return element === null ? 'ничего' : `${element.tagName} ${element.getAttribute('class') ?? ''}`;
    }, point);
}

async function box(locator: Locator): Promise<{ x: number; y: number; width: number; height: number }> {
    const found = await locator.boundingBox();
    if (found === null) {
        throw new Error('элемент без геометрии');
    }
    return found;
}

async function centerX(locator: Locator): Promise<number> {
    const found = await box(locator);
    return found.x + found.width / 2;
}

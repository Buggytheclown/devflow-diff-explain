import type { Locator, Page } from '@playwright/test';

import { expect, test } from './sherpa-fixture.js';

/**
 * Модалка «Комментарии к PR» (docs/design/SPEC-changes-2026-09-20.md §4, чеклист §7 пп. 8–10):
 * ширина растёт вместе с окном, список ограничен, тело комментария — 760, ответ пишется
 * на месте, Esc сначала гасит композер и только потом закрывает модалку.
 */

const MODAL = '.pr-comments-modal';
const OPEN_BUTTON = 'Комментарий к PR';

test('ширина модалки идёт за окном: 1440 → 979, 1920 → 1120', async ({ page, launchSherpa }) => {
    const server = await launchSherpa('fixture-medium');
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(server.url);
    await openModal(page);

    const modal = page.locator(MODAL);
    expect(await widthOf(modal)).toBeCloseTo(979, 0);

    await page.setViewportSize({ width: 1920, height: 1080 });
    await expect.poll(() => widthOf(modal)).toBeCloseTo(1120, 0);

    // Список прокручивается сам, шапка и композер прибиты; тело комментария не шире 760.
    const list = await box(page.locator('.pr-comments-modal__list'));
    expect(list.height).toBeLessThanOrEqual(640);
    const body = await box(page.locator('.thread__body').first());
    expect(body.width).toBeLessThanOrEqual(760);
});

test('тред PR: ответы видны сразу, ответ пишется на месте, Esc гасит композер', async ({
    page,
    launchSherpa,
}) => {
    const server = await launchSherpa('fixture-medium');
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(server.url);
    await openModal(page);

    const thread = page.locator(`${MODAL} [data-thread-id]`).first();
    // Фикстура medium держит один PR-level тред: корень и ответ автора PR.
    await expect(thread.locator('.thread__row')).toHaveCount(2);
    await expect(thread).toContainText('Added to the migration section of the doc.');

    const reply = thread.locator('.thread__row').nth(1);
    await reply.getByRole('button', { name: 'Ответить', exact: true }).click();

    const composer = reply.locator('.thread-composer');
    await expect(composer).toHaveCount(1);
    await expect(thread.locator('.thread__row').first().locator('.thread-composer')).toHaveCount(0);
    await expect(composer.getByRole('switch', { name: /Открыть issue/ })).toBeVisible();

    // Esc при открытом композере гасит его, а модалку — только следующий (чеклист §7.10).
    await composer.getByRole('textbox').press('Escape');
    await expect(composer).toHaveCount(0);
    await expect(page.locator(MODAL)).toBeVisible();
    await expect(thread).not.toHaveClass(/is-collapsed/);

    // Набранный ответ модалка молча не отпускает: ✕ сперва спрашивает про сброс — иначе гард
    // публикации держал бы текст, которого не видно на экране.
    await reply.getByRole('button', { name: 'Ответить', exact: true }).click();
    await composer.getByRole('textbox').fill('Ещё пишу.');
    await page.getByRole('button', { name: 'Закрыть комментарии к PR' }).click();
    await expect(page.locator(MODAL)).toBeVisible();
    await expect(composer).toContainText('Удалить черновик?');
    await composer.getByRole('button', { name: 'Удалить', exact: true }).click();
    await expect(composer).toHaveCount(0);

    await page.locator(`${MODAL} h2`).click();
    await page.keyboard.press('Escape');
    await expect(page.locator(MODAL)).toHaveCount(0);
});

async function openModal(page: Page): Promise<void> {
    await expect(page.locator('.review-action-bar')).toBeVisible();
    await page.getByRole('button', { name: OPEN_BUTTON, exact: true }).click();
    await expect(page.locator(MODAL)).toBeVisible();
}

async function widthOf(locator: Locator): Promise<number> {
    return (await box(locator)).width;
}

async function box(locator: Locator): Promise<{ x: number; y: number; width: number; height: number }> {
    const found = await locator.boundingBox();
    if (found === null) {
        throw new Error('элемент без геометрии');
    }
    return found;
}

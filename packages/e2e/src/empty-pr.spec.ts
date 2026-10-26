import { expect, test } from './sherpa-fixture.js';

/**
 * Пустой PR (docs/design/SPEC-elements.md §4.1): изменений относительно базы нет вовсе.
 * Оба вью честно об этом говорят вместо пустых списков, а шип остаётся доступным — одобрять пустоту ревьюеру никто не мешает.
 */

test('пустой PR: «Нечего ревьюить» на обоих вью, шип доступен', async ({ page, launchSherpa }) => {
    const server = await launchSherpa('fixture-empty');
    await page.goto(server.url);

    await test.step('Обзор открывается экраном вместо карточек', async () => {
        await expect(page.locator('#view-overview')).toContainText('Нечего ревьюить');
        await expect(page.locator('#view-overview')).toContainText('В этом PR нет изменений относительно базы.');
        await expect(page.locator('.ownership-card')).toHaveCount(0);
    });

    await test.step('Полный дифф говорит то же самое', async () => {
        await page.getByRole('tab', { name: 'Полный дифф', exact: true }).click();
        const zero = page.locator('.full-diff__zero--empty-pr');
        await expect(zero).toContainText('Нечего ревьюить');
        await expect(zero).toContainText('В этом PR нет изменений относительно базы.');
        await expect(page.locator('.file-card')).toHaveCount(0);
    });

    await test.step('панель действий на месте, Ship доступен и без гардрейла', async () => {
        const bar = page.locator('.review-action-bar');
        await expect(bar).toContainText('0 / 0 файлов');
        const ship = bar.locator('.review-action-bar__ship-primary');
        await expect(ship).toBeEnabled();

        await bar.locator('.review-action-bar__ship-caret').click();
        await expect(page.locator('.review-action-menu__guard')).toHaveCount(0);
    });
});

import type { Page } from '@playwright/test';

import { expect, test } from './sherpa-fixture.js';

/**
 * Состояние UI этого PR живёт в его SQLite, а не в `localStorage`: сервер слушает
 * случайный порт, и у нового порта браузерное хранилище пустое.
 */

test('свёрнутые каталог дерева и карточка файла переживают перезагрузку', async ({ page, launchSherpa }) => {
    const server = await launchSherpa('fixture-medium');
    await openFullDiff(page, server.url);

    const dir = page.locator('.file-tree__row--dir').first();
    const dirLabel = (await dir.textContent()) ?? '';
    // Машинная карточка свёрнута с самого начала, ручная свёртка проверяется на обычной.
    const card = page.locator('.file-card:not(.file-card--generated)').first();
    const cardPath = (await card.locator('.file-card__name').textContent()) ?? '';
    await expect(dir).toHaveAttribute('aria-expanded', 'true');

    await savingPrState(page, async () => {
        await dir.click();
    });
    await expect(dir).toHaveAttribute('aria-expanded', 'false');

    await savingPrState(page, async () => {
        await card.locator('.file-card__name').click();
    });
    await expect(card.locator('.file-card__collapsed--file')).toContainText('свёрнуто вручную');

    await page.reload();
    await openFullDiff(page, server.url, { reloaded: true });

    const reloadedDir = page.locator('.file-tree__row--dir').first();
    await expect(reloadedDir).toHaveText(dirLabel);
    await expect(reloadedDir).toHaveAttribute('aria-expanded', 'false');
    const reloadedCard = page.locator('.file-card:not(.file-card--generated)').first();
    await expect(reloadedCard.locator('.file-card__name')).toHaveText(cardPath);
    await expect(reloadedCard.locator('.file-card__collapsed--file')).toContainText('свёрнуто вручную');
});

async function openFullDiff(page: Page, url: string, options: { reloaded?: boolean } = {}): Promise<void> {
    if (options.reloaded !== true) {
        await page.goto(url);
    }
    await page.getByRole('tab', { name: 'Полный дифф', exact: true }).click();
}

/** Запись состояния уходит с задержкой до затишья — ждём сам PATCH, иначе перезагрузка обгонит его. */
async function savingPrState(page: Page, action: () => Promise<void>): Promise<void> {
    const saved = page.waitForResponse(
        (response) => response.url().includes('/api/ui/pr-state') && response.request().method() === 'PATCH',
    );
    await action();
    await saved;
}

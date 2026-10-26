import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { Page } from '@playwright/test';

import { expect, test } from './sherpa-fixture.js';

/**
 * Глобальные настройки UI живут в `<sherpaDir>/settings.json`, а не в `localStorage`:
 * сервер каждого PR слушает случайный порт, и хранилище браузера у нового порта пустое.
 */

test('режим диффа переживает перезагрузку страницы', async ({ page, launchSherpa }) => {
    const server = await launchSherpa('fixture-medium');
    await openFullDiff(page, server.url);
    await expect(page.locator('.diff-rows--unified').first()).toBeVisible();

    await toggleDiffMode(page);
    await expect(page.locator('.diff-rows--split').first()).toBeVisible();

    await page.reload();
    await openFullDiff(page, server.url, { reloaded: true });

    await expect(page.locator('.diff-rows--split').first()).toBeVisible();
    await expect(page.locator('.diff-mode-toggle')).toHaveText('бок о бок');
});

test('второй PR открывается в том же режиме', async ({ page, launchSherpa }) => {
    // Общий корень стейта — это и есть «один пользователь»: два сервера, один settings.json.
    const sherpaDir = await mkdtemp(path.join(tmpdir(), 'sherpa-e2e-settings-'));
    try {
        const first = await launchSherpa('fixture-medium', { sherpaDir });
        const second = await launchSherpa('fixture-large', { sherpaDir });

        await openFullDiff(page, first.url);
        await toggleDiffMode(page);
        await expect(page.locator('.diff-rows--split').first()).toBeVisible();

        await openFullDiff(page, second.url);

        await expect(page.locator('.diff-rows--split').first()).toBeVisible();
        await expect(page.locator('.diff-mode-toggle')).toHaveText('бок о бок');
    } finally {
        await rm(sherpaDir, { recursive: true, force: true });
    }
});

async function openFullDiff(page: Page, url: string, options: { reloaded?: boolean } = {}): Promise<void> {
    if (options.reloaded !== true) {
        await page.goto(url);
    }
    await page.getByRole('tab', { name: 'Полный дифф', exact: true }).click();
}

/** Ждём саму запись настройки: перезагрузка не должна оборвать PATCH на полпути. */
async function toggleDiffMode(page: Page): Promise<void> {
    const saved = page.waitForResponse(
        (response) => response.url().includes('/api/ui/settings') && response.request().method() === 'PATCH',
    );
    await page.locator('.diff-mode-toggle').click();
    await saved;
}

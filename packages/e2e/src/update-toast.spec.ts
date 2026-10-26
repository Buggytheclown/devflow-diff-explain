import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { announceUpdate, expect, test } from './sherpa-fixture.js';

/**
 * Тост «Доступна новая версия». Живого Арканума здесь нет: на фикстурном хосте проверка
 * версии выключена, а «новую версию» подставляет дев-ручка — ровно как в галерее.
 */

/** Каталог с хвостом чекаута Аркадии: от него зависит команда обновления в тосте. */
const CHECKOUT_DIR = '/tmp/fake/junk/alice/sherpa/skill';

const VERSION = '9.9.9';
const WHATS_NEW = 'Тост обновления и читшит шорткатов.';

test('тост приходит по дев-ручке и показывает команду обновления', async ({ page, launchSherpa }) => {
    const server = await launchSherpa('fixture-medium', { installDir: CHECKOUT_DIR });
    await page.goto(server.url);
    await expect(page.locator('.top-bar')).toBeVisible();

    await announceUpdate(page, server, { version: VERSION, whatsNew: WHATS_NEW, releasedAt: null });

    const toast = page.locator('.update-toast');
    await expect(toast).toBeVisible({ timeout: 2000 });
    await expect(toast).toHaveAttribute('role', 'status');
    await expect(toast).toContainText(`Шерпа ${VERSION} доступна`);
    await expect(toast).toContainText(WHATS_NEW);

    await toast.getByRole('button', { name: 'Как обновить' }).click();

    await expect(toast.locator('.command-box__command')).toHaveValue("cd '/tmp/fake' && arc pull");
});

test('«Не напоминать» переживает перезапуск сервера', async ({ page, launchSherpa }) => {
    // Общий корень стейта — тот же «один пользователь»: настройки лежат в нём, а не в браузере.
    const sherpaDir = await mkdtemp(path.join(tmpdir(), 'sherpa-e2e-update-'));
    try {
        const first = await launchSherpa('fixture-medium', { sherpaDir, installDir: CHECKOUT_DIR });
        await page.goto(first.url);
        await announceUpdate(page, first, { version: VERSION, whatsNew: WHATS_NEW, releasedAt: null });

        const toast = page.locator('.update-toast');
        await expect(toast).toBeVisible({ timeout: 2000 });

        const saved = page.waitForResponse(
            (response) => response.url().includes('/api/ui/settings') && response.request().method() === 'PATCH',
        );
        await toast.getByRole('button', { name: `Не напоминать про ${VERSION}` }).click();
        await saved;
        // Сервер после патча отдаёт `update: null` — тост и точка исчезают сами.
        await expect(toast).toBeHidden();

        await first.stop();
        const second = await launchSherpa('fixture-medium', { sherpaDir, installDir: CHECKOUT_DIR });
        await page.goto(second.url);
        await expect(page.locator('.top-bar')).toBeVisible();
        await announceUpdate(page, second, { version: VERSION, whatsNew: WHATS_NEW, releasedAt: null });

        await expect(page.locator('.update-toast')).toHaveCount(0, { timeout: 3000 });
        await expect(page.locator('.top-bar__version--update')).toHaveCount(0);
    } finally {
        await rm(sherpaDir, { recursive: true, force: true });
    }
});

test('команда палитры отвечает строкой статуса', async ({ page, launchSherpa }) => {
    const server = await launchSherpa('fixture-medium');
    await page.goto(server.url);
    await expect(page.locator('.top-bar')).toBeVisible();

    await page.locator('.search-button').click();
    await page.locator('.command-palette__query').fill('Проверить обновления');
    await page.locator('.command-palette__item').first().click();

    // Палитра осталась открытой ради ответа: на фикстуре проверка выключена, обновления нет.
    await expect(page.locator('.command-palette')).toBeVisible();
    await expect(page.locator('.command-palette__notice')).toContainText('Обновлений нет');
});

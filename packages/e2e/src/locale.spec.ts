import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { Page } from '@playwright/test';

import { expect, test } from './sherpa-fixture.js';

/**
 * Лестница языка интерфейса: явная настройка → метка `--lang` сессии
 * агента → язык браузера. Спека проходит её целиком на одном каталоге стейта: настройка живёт
 * в `<sherpaDir>/settings.json`, метка сессии — в базе PR, и обе переживают перезапуск сервера.
 */

/** Браузер приходит на английском: без агента и без настройки это и есть выбор UI. */
test.use({ locale: 'en-US' });

const MOD_KEY = process.platform === 'darwin' ? 'Meta' : 'Control';

test('язык: настройка перебивает агента, агент — браузер', async ({ page, launchSherpa }) => {
    const sherpaDir = await mkdtemp(path.join(tmpdir(), 'sherpa-e2e-locale-'));
    try {
        const first = await launchSherpa('fixture-medium', { sherpaDir });

        await test.step('без агента язык берётся из браузера', async () => {
            await page.goto(first.url);
            await expectLocale(page, 'en');
            await expect(page.getByRole('tab', { name: 'Full diff', exact: true })).toBeVisible();
        });

        await test.step('регистрация сессии с --lang ru переключает UI по SSE', async () => {
            const registered = await first.worker.register('claude-code', 'ru');
            expect(registered.code, registered.stderr).toBe(0);

            // Ни перезагрузки, ни перехода: новость о метке приезжает тем же потоком, что и статус.
            await expectLocale(page, 'ru');
            await expect(page.getByRole('tab', { name: 'Полный дифф', exact: true })).toBeVisible();
        });

        await test.step('команда палитры «English» перебивает агента', async () => {
            await pickLocaleCommand(page, 'Язык интерфейса: английский');

            await expectLocale(page, 'en');
            await expect(page.getByRole('tab', { name: 'Full diff', exact: true })).toBeVisible();
        });

        await first.stop();

        const second = await launchSherpa('fixture-medium', { sherpaDir });

        await test.step('после перезапуска сервера выбор остаётся английским', async () => {
            await page.goto(second.url);
            await expectLocale(page, 'en');
            await expect(page.getByRole('tab', { name: 'Full diff', exact: true })).toBeVisible();
        });

        await test.step('«авто» возвращает язык агента', async () => {
            await pickLocaleCommand(page, 'Language: auto (from the agent or the browser)');

            await expectLocale(page, 'ru');
            await expect(page.getByRole('tab', { name: 'Полный дифф', exact: true })).toBeVisible();
        });
    } finally {
        await rm(sherpaDir, { recursive: true, force: true });
    }
});

async function expectLocale(page: Page, locale: 'ru' | 'en'): Promise<void> {
    await expect(page.locator('html')).toHaveAttribute('lang', locale);
}

/** Выбор языка живёт только в палитре: своего поповера настроек в дизайне нет. */
async function pickLocaleCommand(page: Page, label: string): Promise<void> {
    // Ждём саму запись настройки: следующий шаг может перезапустить сервер.
    const saved = page.waitForResponse(
        (response) => response.url().includes('/api/ui/settings') && response.request().method() === 'PATCH',
    );
    await page.keyboard.press(`${MOD_KEY}+KeyK`);
    const palette = page.getByRole('dialog');
    await expect(palette).toBeVisible();
    await palette.getByRole('textbox').fill(label);
    await palette.getByRole('option', { name: label }).first().click();
    await saved;
}

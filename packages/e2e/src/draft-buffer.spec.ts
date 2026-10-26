import type { Locator, Page } from '@playwright/test';

import type { SherpaServerHandle } from './sherpa-fixture.js';
import { expect, sherpaAuth, test } from './sherpa-fixture.js';

/**
 * Черновик не теряется, когда хост отказал. Отказ включается дев-ручкой фикстурного
 * хоста; текст ложится в буфер сервера, переживает перезагрузку вкладки и уезжает по повтору.
 */

const COMMENT = 'E2E: этот черновик обязан пережить падение хоста.';
const SEARCH_TEXT = 'Retention is 13 months';
const MOD_KEY = process.platform === 'darwin' ? 'Meta' : 'Control';

test('буфер черновиков: отказ хоста → текст в буфере → перезагрузка → повтор', async ({ page, launchSherpa }) => {
    const server = await launchSherpa('fixture-medium');

    await test.step('хост отказывается принимать черновики', async () => {
        await page.goto(server.url);
        await page.getByRole('tab', { name: 'Полный дифф', exact: true }).click();
        await expect(page.locator('.full-diff')).toBeVisible();
        await failDraftWrites(page, server, true);
    });

    await test.step('черновик уходит в буфер: статус обещает довезти, ship заблокирован', async () => {
        await openPciAuditBySearch(page);
        const card = pciAuditCard(page);
        const button = card.getByRole('button', { name: /Комментировать строку \d+/ }).first();
        await button.locator('..').hover();
        await button.click();

        const composer = page.getByRole('textbox', { name: 'Новый комментарий' });
        await composer.fill(COMMENT);
        await page.getByRole('button', { name: 'Сохранить черновик', exact: true }).click();

        await expect(page.locator('.thread-composer__status')).toContainText('сохраним, когда связь вернётся');
        // Текст остался в поле: композер редактируемый, а не запертый статусом.
        await expect(composer).toContainText(COMMENT);
        await expect(page.locator('.review-action-bar')).toContainText('1 ещё не отправлен');
        await expect(page.locator('.review-action-bar__ship-primary')).toBeDisabled();
        await expect(page.locator('.review-action-bar__ship-primary')).toHaveAttribute(
            'title',
            '1 черновик ещё не отправлен — ship недоступен, пока не сохранится',
        );
    });

    await test.step('перезагрузка вкладки возвращает текст на ту же строку', async () => {
        await page.reload();
        await page.getByRole('tab', { name: 'Полный дифф', exact: true }).click();
        await openPciAuditBySearch(page);

        await expect(page.getByRole('textbox', { name: 'Новый комментарий' })).toContainText(COMMENT);
        await expect(pciAuditCard(page).locator('.thread-composer')).toHaveCount(1);
        await expect(page.locator('.thread-composer__status')).toContainText('сохраним, когда связь вернётся');
    });

    await test.step('хост ожил, повтор довозит черновик в тред', async () => {
        await failDraftWrites(page, server, false);
        await page.locator('.thread-composer__status').getByRole('button', { name: 'повторить' }).click();

        await expect(page.getByText(COMMENT, { exact: true })).toBeVisible();
        await expect(page.locator('.review-action-bar')).toContainText('1 черновик уйдёт при публикации');
        await expect(page.locator('.review-action-bar')).not.toContainText('ещё не отправлен');
        await expect(page.locator('.review-action-bar__ship-primary')).toBeEnabled();
        expect(await draftBufferEntries(page, server)).toEqual([]);
    });
});

/** Дев-ручка фикстурного хоста: записи черновиков начинают (или перестают) падать. */
async function failDraftWrites(page: Page, server: SherpaServerHandle, fail: boolean): Promise<void> {
    const url = new URL('/api/dev/fixture/fail-draft-writes', server.url).href;
    const response = await page.request.post(url, { headers: sherpaAuth(server), data: { fail } });
    expect(response.status(), await response.text()).toBe(200);
}

/** Буфер черновиков мимо UI: им проверяется, что запись действительно уехала. */
async function draftBufferEntries(page: Page, server: SherpaServerHandle): Promise<readonly { id: string }[]> {
    const url = new URL('/api/ui/review/draft-buffer', server.url).href;
    const response = await page.request.get(url, { headers: sherpaAuth(server) });
    expect(response.status(), await response.text()).toBe(200);
    const body = (await response.json()) as { readonly entries: readonly { id: string }[] };
    return body.entries;
}

function pciAuditCard(page: Page): Locator {
    return page.locator('.file-card').filter({ hasText: 'pci-audit.ts' });
}

async function openPciAuditBySearch(page: Page): Promise<void> {
    await page.keyboard.press(`${MOD_KEY}+KeyK`);
    const palette = page.getByRole('dialog', { name: 'Палитра команд' });
    await expect(palette).toBeVisible();
    await palette.getByRole('textbox').fill(`/${SEARCH_TEXT}`);
    await expect(palette.getByRole('option', { name: /pci-audit\.ts:\d+/ })).toBeVisible();
    await page.keyboard.press('Enter');
    await expect(pciAuditCard(page).getByText(/Retention is 13 months/)).toBeVisible();
}

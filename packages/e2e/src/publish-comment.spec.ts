import type { Page } from '@playwright/test';

import type { SherpaServerHandle } from './sherpa-fixture.js';
import { expect, test } from './sherpa-fixture.js';

/**
 * Публикация без вердикта (`comment`) — третий режим меню Ship: черновик уходит в хост, PR никто
 * не одобряет и не возвращает, экран итога называет это публикацией комментариев, а главная
 * часть кнопки после перезагрузки помнит выбранный режим.
 */

const DRAFT = 'E2E: замечание без вердикта.';

test('Comment из меню Ship уносит черновик без вердикта и запоминается', async ({ page, launchSherpa }) => {
    const server = await launchSherpa('fixture-medium');
    await page.goto(server.url);
    const bar = page.locator('.review-action-bar');
    const comment = page.locator('#review-ship-option-2');
    await expect(bar).toContainText('нет неопубликованных комментариев');

    await test.step('без черновиков строка Comment выключена', async () => {
        await bar.locator('.review-action-bar__ship-caret').click();
        await expect(comment).toContainText('Comment');
        await expect(comment).toHaveAttribute('aria-disabled', 'true');
        await expect(comment).toHaveAttribute('title', 'нет неопубликованных комментариев');
        await page.keyboard.press('Escape');
        await expect(page.locator('.review-action-menu')).toHaveCount(0);
    });

    await test.step('черновик появляется в счётчике и в строке Comment', async () => {
        await saveDraft(page, server, DRAFT);
        await expect(bar).toContainText('1 черновик уйдёт при публикации');
        await bar.locator('.review-action-bar__ship-caret').click();
        await expect(comment).toHaveAttribute('aria-disabled', 'false');
        await expect(comment).toContainText('Опубликует 1 черновик без вердикта');
    });

    await test.step('публикация: итог без вердикта, черновик опубликован', async () => {
        const saved = page.waitForResponse(
            (response) => response.url().includes('/api/ui/settings') && response.request().method() === 'PATCH',
        );
        await comment.click();

        await expect(page.getByRole('heading', { name: 'Комментарии опубликованы · PR 4821', exact: true })).toBeVisible();
        await expect(page.locator('.review-complete__provenance')).toHaveText(/^comment · [0-9a-f]{7}$/);
        await expect(page.getByText('1 комментарий опубликован одним пакетом', { exact: true })).toBeVisible();
        expect((await saved).ok()).toBe(true);

        const published = (await threads(page, server)).find((thread) => thread.root.body === DRAFT);
        expect(published?.root.draft).toBe(false);
    });

    await test.step('после перезагрузки главная часть помнит Comment', async () => {
        await page.reload();
        const primary = page.locator('.review-action-bar__ship-primary');
        await expect(primary).toHaveText('Comment');
        // Черновиков больше нет — Comment публиковать нечего, но каретка открывает меню.
        await expect(primary).toBeDisabled();
        await expect(page.locator('.review-action-bar__ship-caret')).toBeEnabled();
    });
});

interface HostThread {
    readonly root: { readonly body: string; readonly draft: boolean };
}

function authOf(server: SherpaServerHandle): { readonly origin: string; readonly headers: Record<string, string> } {
    const url = new URL(server.url);
    const token = new URLSearchParams(url.hash.slice(1)).get('t') ?? '';
    return { origin: url.origin, headers: { Authorization: `Bearer ${token}` } };
}

/** Черновик уровня PR через ту же ручку, которой пишет композер. */
async function saveDraft(page: Page, server: SherpaServerHandle, body: string): Promise<void> {
    const { origin, headers } = authOf(server);
    const response = await page.request.post(new URL('/api/ui/review/draft', origin).href, {
        headers,
        data: { draft: { body, parentId: null, anchor: null }, clientKey: 'e2e-publish-comment' },
    });
    expect(response.status(), await response.text()).toBe(200);
}

async function threads(page: Page, server: SherpaServerHandle): Promise<readonly HostThread[]> {
    const { origin, headers } = authOf(server);
    const response = await page.request.get(new URL('/api/ui/review/threads', origin).href, { headers });
    expect(response.status(), await response.text()).toBe(200);
    return ((await response.json()) as { readonly threads: readonly HostThread[] }).threads;
}

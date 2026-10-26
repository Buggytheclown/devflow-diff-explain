import type { Locator, Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { answerChat, buildRoute, takeTask } from './route-worker.js';
import { expect, test } from './sherpa-fixture.js';

const PATH = 'services/orders/docs/edit-window.md';
const QUOTE = 'domain concept';

async function selectWords(page: Page, card: Locator) {
    const line = card.locator('.markdown-review__source [data-source-line="4"]');
    await line.scrollIntoViewIfNeeded();
    await line.evaluate((element, quote) => {
        const node = element.firstChild;
        if (node === null) throw new Error('нет текста');
        const start = (node.textContent ?? '').indexOf(quote);
        if (start < 0) throw new Error('нет цитаты');
        const selection = window.getSelection();
        selection?.setBaseAndExtent(node, start, node, start + quote.length);
        element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    }, QUOTE);
    await expect(page.locator('.selection-popover__count')).toBeVisible();
}

test('Markdown: точная цитата агенту и один комментарий в документе и коде', async ({ page, launchSherpa }) => {
    const server = await launchSherpa('fixture-medium');
    await page.goto(server.url);
    expect((await server.worker.register('codex')).code).toBe(0);
    await buildRoute(server.worker);
    await page.getByRole('tab', { name: 'Полный дифф', exact: true }).click();
    await page.locator('.file-tree__row--file').filter({ hasText: 'edit-window.md' }).click();
    const card = page.locator('.file-card').filter({ has: page.locator(`.file-card__path[title="${PATH}"]`) });
    await card.getByRole('button', { name: 'Markdown', exact: true }).click();
    await expect(card.getByRole('heading', { name: 'The 30-minute edit window', exact: true })).toBeVisible();
    await selectWords(page, card);
    await page.getByRole('button', { name: 'Спросить агента', exact: true }).click();
    await expect(page.locator('.chat-panel__selection-quote')).toHaveText(QUOTE);
    const question = page.getByRole('textbox', { name: 'Вопрос агенту' });
    await expect(question).toHaveValue('');
    await question.fill('Что здесь значит domain concept?');
    await question.press('Enter');
    const task = await takeTask(server.worker, 'chat');
    const contextFiles = task.stdout.match(/\/[^\n]*question\.md/g) ?? [];
    expect(contextFiles.length).toBeGreaterThan(0);
    expect(readFileSync(contextFiles[0] ?? '', 'utf8')).toContain(JSON.stringify(QUOTE));
    await answerChat(server.worker, task.taskId, 'Это правило предметной области.');
    await expect(page.locator('.chat-message--agent')).toContainText('Это правило предметной области.');
    await page.getByRole('button', { name: 'Закрыть чат', exact: true }).click();
    await selectWords(page, card);
    await page.getByRole('button', { name: 'Комментировать', exact: true }).click();
    const comment = 'Уточнить определение предметной области.';
    await page.getByRole('textbox', { name: 'Новый комментарий' }).fill(comment);
    await page.getByRole('button', { name: 'Сохранить черновик', exact: true }).click();
    await expect(card.getByText(comment, { exact: true })).toBeVisible();
    await expect(card.getByText(comment, { exact: true })).toHaveCount(1);
    await card.getByRole('button', { name: 'Код', exact: true }).click();
    await expect(card.getByText(comment, { exact: true })).toBeVisible();
    await expect(card.locator('.agent-note')).toHaveCount(1);
    await card.getByRole('button', { name: 'Markdown', exact: true }).click();
    await expect(card.getByText(comment, { exact: true })).toBeVisible();
    await expect(card.getByText(comment, { exact: true })).toHaveCount(1);
    await expect(card.locator('.agent-note')).toHaveCount(1);
    await page.reload();
    await page.getByRole('tab', { name: 'Полный дифф', exact: true }).click();
    await page.locator('.file-tree__row--file').filter({ hasText: 'edit-window.md' }).click();
    await card.getByRole('button', { name: 'Markdown', exact: true }).click();
    await expect(card.getByText(comment, { exact: true })).toBeVisible();
});

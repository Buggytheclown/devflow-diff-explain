import fs from 'node:fs/promises';

import { architectureStoryFixture, fixtureIteration } from '@sherpa/fixtures';

import { currentStory } from './story-support.js';
import { test, expect, advanceIteration, openBlocks, sherpaAuth } from './sherpa-fixture.js';

const fixture = architectureStoryFixture();

function contextPath(stdout: string, name: string): string {
    const marker = name === 'question.md' ? 'Full reviewer question and scope (' : 'Saved explanation shown with this question (';
    const line = stdout.split('\n').find((entry) => entry.includes(marker) && entry.includes('): '));
    if (line === undefined) throw new Error(`Missing ${name} in worker task`);
    return JSON.parse(line.slice(line.indexOf('): ') + 3)) as string;
}

test('вложение A и черновик переживают B; отправка и повтор читают исходную версию', async ({ page, launchSherpa }) => {
    const server = await launchSherpa('fixture-medium');
    await page.goto(server.url);
    expect((await server.worker.register('codex', 'ru')).code).toBe(0);

    const overviewA = await server.worker.next();
    expect((await server.worker.complete(overviewA.taskId ?? 0, JSON.stringify(fixture.outline))).stdout).not.toContain('rejected');
    const filesA = await server.worker.next();
    expect((await server.worker.complete(filesA.taskId ?? 0, JSON.stringify(fixture.body))).stdout).not.toContain('rejected');
    await openBlocks(page);
    await page.locator('.story-nav').getByRole('button', { name: fixture.first.path, exact: true }).click();
    const row = page.locator(`[data-reading-file="${fixture.first.fileId}"] .diff-row[data-key="${fixture.anchor.side === 'old' ? 'd' : 'a'}${String(fixture.anchor.start)}"]`);
    await row.click();
    await page.getByRole('button', { name: 'Чат', exact: true }).click();
    const quote = page.locator('.chat-panel__selection-quote');
    await expect(quote).not.toBeEmpty();
    const selectedText = await quote.textContent();
    if (selectedText === null || selectedText.trim() === '') throw new Error('Missing selected text');
    const input = page.getByRole('textbox', { name: 'Вопрос агенту' });
    await input.fill('Как это условие влияет на сохранение?');
    await page.getByRole('button', { name: 'Закрыть чат', exact: true }).click();

    await advanceIteration(page, server);
    await page.getByRole('button', { name: 'Обновить рассказ', exact: true }).click();
    const diffB = fixtureIteration('medium', 1).diff;
    const newStory = currentStory(diffB);
    const overviewB = await server.worker.next();
    expect((await server.worker.complete(overviewB.taskId ?? 0, JSON.stringify(newStory.outline))).stdout).not.toContain('rejected');
    const firstB = newStory.body.files[0];
    if (firstB === undefined) throw new Error('Missing B file');
    const partialB = await server.worker.next();
    expect(partialB.type).toBe('route.prepare');
    expect((await server.worker.complete(partialB.taskId ?? 0, JSON.stringify({ contractVersion: 6, files: [firstB] }))).stdout).not.toContain('rejected');
    await page.getByRole('button', { name: 'Открыть новый разбор', exact: true }).click();
    await page.getByRole('button', { name: 'Чат', exact: true }).click();
    await expect(input).toHaveValue('Как это условие влияет на сохранение?');
    await expect(quote).toHaveText(selectedText);
    await expect(page.locator('.chat-panel__contexts')).toContainText(fixture.first.path);
    await input.press('Enter');

    const question = await server.worker.next();
    expect(question.type).toBe('chat');
    expect(question.stdout).toContain(fixture.diff.diffId);
    const originalPayload = await fs.readFile(contextPath(question.stdout, 'question.md'), 'utf8');
    expect(originalPayload).toContain(fixture.first.path);
    expect(originalPayload).toContain(JSON.stringify(selectedText));
    const originalContext = await fs.readFile(contextPath(question.stdout, 'route-context.md'), 'utf8');
    expect(originalContext).toContain(fixture.outline.summary);
    await server.worker.fail(question.taskId ?? 0, 'Test failure before answer');
    await expect(page.locator('.chat-message--failed')).toBeVisible();

    const response = await page.request.get(new URL('/api/ui/review/chat', server.url).href, { headers: sherpaAuth(server) });
    expect(response.status()).toBe(200);
    const stored = await response.json() as { exchanges: { id: number; question: string; anchor: { diffId: string; fileId: string; selectedText?: string } | null; explanation?: { diffId: string; snapshotId: string | null; text: string } }[] };
    expect(stored.exchanges[0]?.question).toBe('Как это условие влияет на сохранение?');
    expect(stored.exchanges[0]?.anchor).toMatchObject({ diffId: fixture.diff.diffId, fileId: fixture.first.fileId, selectedText });
    expect(stored.exchanges[0]?.explanation).toMatchObject({ diffId: fixture.diff.diffId, text: expect.stringContaining(fixture.outline.summary) });

    await page.getByRole('button', { name: 'Повторить', exact: true }).click();
    const retry = await server.worker.next();
    expect(retry.type).toBe('chat');
    expect(retry.stdout).toContain(fixture.diff.diffId);
    const retryPayload = await fs.readFile(contextPath(retry.stdout, 'question.md'), 'utf8');
    expect(retryPayload).toBe(originalPayload);
    expect(await fs.readFile(contextPath(retry.stdout, 'route-context.md'), 'utf8')).toBe(originalContext);
    expect((await server.worker.complete(retry.taskId ?? 0, 'Условие не даёт сохранить недопустимый заказ.')).stdout).not.toContain('rejected');
    await expect(page.locator('.chat-message--agent')).toContainText('Условие не даёт сохранить');
});

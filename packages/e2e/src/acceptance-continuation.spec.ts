import { architectureStoryFixture } from '@sherpa/fixtures';

import { test, expect, openBlocks } from './sherpa-fixture.js';

const fixture = architectureStoryFixture();

test('часть разбора → вопрос в приоритете → только оставшиеся файлы без потери готового', async ({ page, launchSherpa }) => {
    const server = await launchSherpa('fixture-medium');
    await page.goto(server.url);
    expect((await server.worker.register('codex', 'ru')).code).toBe(0);

    const overview = await server.worker.next();
    expect(overview.type).toBe('route.prepare');
    expect((await server.worker.complete(overview.taskId ?? 0, JSON.stringify(fixture.outline))).stdout).not.toContain('rejected');

    const allFiles = fixture.body.stops.flatMap((stop) => stop.files);
    const first = allFiles[0];
    if (first === undefined || allFiles.length < 2) throw new Error('Need several files');
    const partial = await server.worker.next();
    expect(partial.type).toBe('route.prepare');
    expect((await server.worker.complete(partial.taskId ?? 0, JSON.stringify({ contractVersion: 6, files: [first] }))).stdout).not.toContain('rejected');

    await openBlocks(page);
    const readyFile = page.locator(`[data-reading-file="${fixture.first.fileId}"]`);
    await expect(readyFile.locator('.story-file-description')).toContainText(first.explanation);
    await expect(page.locator('[role=progressbar]')).not.toHaveAttribute('aria-valuenow', '100');

    await page.getByRole('button', { name: 'Чат', exact: true }).click();
    await page.getByRole('textbox', { name: 'Вопрос агенту' }).fill('Как связаны готовый файл и остальные изменения?');
    await page.getByRole('button', { name: 'Отправить', exact: true }).click();
    await expect(page.locator('.chat-message--you')).toContainText('Как связаны готовый файл');

    const question = await server.worker.next();
    expect(question.type).toBe('chat');
    expect((await server.worker.complete(question.taskId ?? 0, 'Готовый файл задаёт правило; остальные подключают его и проверяют.')).stdout).not.toContain('rejected');
    await expect(page.locator('.chat-message--agent')).toContainText('Готовый файл задаёт правило');
    await expect(readyFile.locator('.story-file-description')).toContainText(first.explanation);

    const remaining = await server.worker.next();
    expect(remaining.type).toBe('route.prepare');
    expect((await server.worker.complete(remaining.taskId ?? 0, JSON.stringify({ contractVersion: 6, files: allFiles.slice(1) }))).stdout).not.toContain('rejected');
    await expect(page.locator('[role=progressbar]')).toHaveAttribute('aria-valuenow', '100');
    await expect(readyFile.locator('.story-file-description')).toContainText(first.explanation);
    await expect(page.locator('.story-file-description')).toHaveCount(allFiles.length);
    await expect(page.locator('.chat-message--agent')).toContainText('Готовый файл задаёт правило');
});

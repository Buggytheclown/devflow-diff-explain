import { architectureStoryFixture } from '@sherpa/fixtures';
import { openBlocks, test, expect } from './sherpa-fixture.js';

const fixture = architectureStoryFixture();
test('пояснение и пример → полный дифф; источники и архитектура в обычном окне', async ({ page, launchSherpa }) => {
    const server = await launchSherpa('fixture-medium');
    const file = page.locator(`[data-reading-file="${fixture.first.fileId}"]`);
    await page.goto(server.url); await server.worker.register('codex', 'ru');
    const plan = await server.worker.next();
    expect((await server.worker.complete(plan.taskId ?? 0, JSON.stringify(fixture.outline))).stdout).not.toContain('rejected');
    await expect(page.locator('.story-overview h2').first()).toHaveText('Описание ПРа');
    await expect(page.locator('[data-architecture-node]')).not.toHaveCount(0);
    const section = await server.worker.next(); expect(section.type).toBe('route.prepare');
    expect((await server.worker.complete(section.taskId ?? 0, JSON.stringify(fixture.body))).stdout).not.toContain('rejected');
    await openBlocks(page);
    await page.locator('.story-nav').getByRole('button', { name: fixture.first.path, exact: true }).click();
    await expect(file.locator('.story-file-description .md-blocks').first()).toContainText(fixture.body.stops[0]?.files[0]?.explanation ?? '');
    await expect(file.locator('.story-example')).toContainText(fixture.example.text);
    await expect(page.locator('.story-nav-file[aria-current=page]')).toHaveAttribute('aria-label', fixture.first.path);
    await expect(file.locator('.diff-row').first()).toBeVisible();
    await expect(file.locator('.diff-row--add, .diff-row--del')).toHaveCount(fixture.first.additions + fixture.first.deletions);
    await page.screenshot({ path: test.info().outputPath('readable-file-current.png') });
});

test('изначально недоступная схема восстанавливается со связями, готовые файлы сохраняются', async ({ page, launchSherpa }) => {
    const server = await launchSherpa('fixture-medium'); await page.goto(server.url); await server.worker.register('codex', 'ru');
    const plan = await server.worker.next();
    const outline = { ...fixture.outline, flow: { status: 'unavailable', reason: 'Источники схемы ещё не изучены.' }, stops: fixture.outline.stops.map((block) => ({ ...block, nodeIds: [] })) };
    await server.worker.complete(plan.taskId ?? 0, JSON.stringify(outline));
    const files = await server.worker.next(); await server.worker.complete(files.taskId ?? 0, JSON.stringify(fixture.body));
    await expect(page.locator('.story-preparation')).toContainText('Разбор подготовлен частично');
    await page.getByRole('button', { name: 'Повторить схему', exact: true }).click();
    const retry = await server.worker.next(); expect(retry.type).toBe('route.diagram');
    const result = { contractVersion: 6, update: { flow: fixture.outline.flow,
        blocks: fixture.outline.stops.map((block, i) => ({ id: `s${String(i + 1).padStart(2, '0')}`, nodeIds: block.nodeIds })) } };
    expect((await server.worker.complete(retry.taskId ?? 0, JSON.stringify(result))).stdout).not.toContain('rejected');
    await expect(page.locator('[role=progressbar]')).toHaveAttribute('aria-valuenow', '100');
    await expect(page.locator('[data-architecture-node]')).not.toHaveCount(0);
    await openBlocks(page);
    const file = page.locator(`[data-reading-file="${fixture.first.fileId}"]`);
    await expect(file.locator('.story-file-description .md-blocks').first()).toContainText(fixture.body.stops[0]?.files[0]?.explanation ?? '');
    await expect(file.locator('.story-example')).toBeVisible();
});

import { readableStoryFixture } from '@sherpa/fixtures';
import { test, expect } from './sherpa-fixture.js';

const fixture = readableStoryFixture();
test.setTimeout(90_000);

test('краткое пояснение и пример → полный дифф; схема достраивается отдельно, источники в обычном окне', async ({ page, launchSherpa }) => {
    const server = await launchSherpa('fixture-medium');
    await page.goto(server.url); await server.worker.register('codex', 'ru');
    const plan = await server.worker.next();
    expect((await server.worker.complete(plan.taskId ?? 0, JSON.stringify(fixture.outline))).stdout).not.toContain('rejected');
    await expect(page.locator('.story-guided h2')).toHaveText('Описание ПРа');
    await expect(page.locator('.story-main')).toContainText('Готовлю схему потока');
    await expect(page.locator('.story-nav')).toBeHidden();
    await expect(page.locator('.story-overview-route')).toBeVisible();
    await page.getByRole('button', { name: 'Стиль Arcanum', exact: true }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'arcanum-dark');
    const section = await server.worker.next(); expect(section.type).toBe('route.section');
    expect((await server.worker.complete(section.taskId ?? 0, JSON.stringify(fixture.body))).stdout).not.toContain('rejected');
    await page.locator('.story-topbar').getByRole('button', { name: 'Разбор по блокам', exact: true }).click();
    await expect(page.locator('.story-file-list .md-blocks').first()).toContainText(fixture.body.stops[0]?.files[0]?.explanation ?? '');
    if (await page.getByRole('button', { name: 'Стиль Arcanum', exact: true }).getAttribute('aria-pressed') === 'true') await page.screenshot({ path: test.info().outputPath('sherpa-arcanum-block.png') });
    await page.locator('.story-nav').getByRole('button', { name: fixture.first.path, exact: true }).click();
    await expect(page.locator('.story-example')).toContainText(fixture.example.text);
    await expect(page.locator('.story-topbar button[aria-current=page]')).toHaveText('Разбор по блокам');
    await expect(page.locator('.story-main .diff-row').first()).toBeVisible();
    const rows = await page.locator('.story-main .diff-row').allTextContents(); expect(rows.length).toBeGreaterThan(0);
    await page.screenshot({ path: test.info().outputPath('sherpa-readable-file.png') });
    await page.locator('.story-main .diff-row').nth(20).scrollIntoViewIfNeeded();
    const row = page.locator('.story-main .diff-row').nth(20);
    const y = (await row.boundingBox())?.y ?? 0;
    await page.getByRole('button', { name: 'Стиль Arcanum', exact: true }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await page.getByRole('button', { name: 'Стиль Arcanum', exact: true }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'arcanum-dark');
    await expect(async () => { expect(Math.abs(((await row.boundingBox())?.y ?? 9999) - y)).toBeLessThan(3); }).toPass();
    const diagram = await server.worker.next(); expect(diagram.type).toBe('route.diagram');
    expect((await server.worker.complete(diagram.taskId ?? 0, JSON.stringify({ contextRequests: [{ path: 'missing-context.ts', start: 1, end: 5 }], diagram: null, reason: null }))).stdout).not.toContain('rejected');
    const second = await server.worker.next(); expect(second.type).toBe('route.diagram');
    expect((await server.worker.complete(second.taskId ?? 0, JSON.stringify({ contextRequests: [], diagram: fixture.diagram, reason: null }))).stdout).not.toContain('rejected');
    expect(await page.locator('.story-main .diff-row').allTextContents()).toEqual(rows);
    await page.locator('.story-nav').getByRole('button', { name: 'Описание ПРа', exact: true }).click();
    await expect(page.locator('.story-flow h3')).toHaveText(fixture.diagram.title);
    await expect(page.locator('.story-flow-arrow')).toHaveCount(2);
    await page.locator('.story-flow-sources summary').click();
    await expect(page.locator('.story-flow-sources')).toContainText(fixture.anchor.path);
    await page.locator('.story-flow-sources summary').click();
    await page.screenshot({ path: test.info().outputPath('sherpa-readable-flow.png'), fullPage: true });

});

test('сбой схемы сохраняет готовое описание, блоки и полный дифф', async ({ page, launchSherpa }) => {
    const server = await launchSherpa('fixture-medium');
    await page.goto(server.url); await server.worker.register('codex', 'ru');
    const plan = await server.worker.next(); await server.worker.complete(plan.taskId ?? 0, JSON.stringify(fixture.outline));
    const section = await server.worker.next(); await server.worker.complete(section.taskId ?? 0, JSON.stringify(fixture.body));
    const diagram = await server.worker.next(); await server.worker.fail(diagram.taskId ?? 0, 'Synthetic diagram failure');
    await expect(page.locator('.story-main')).toContainText('Схема недоступна');
    await expect(page.locator('.story-main')).toContainText(fixture.outline.summary);
    await page.locator('.story-topbar').getByRole('button', { name: 'Разбор по блокам', exact: true }).click();
    await expect(page.locator('.story-file-list .md-blocks').first()).toContainText(fixture.body.stops[0]?.files[0]?.explanation ?? '');
    if (await page.getByRole('button', { name: 'Стиль Arcanum', exact: true }).getAttribute('aria-pressed') === 'true') await page.screenshot({ path: test.info().outputPath('sherpa-arcanum-block.png') });
    await page.locator('.story-nav').getByRole('button', { name: fixture.first.path, exact: true }).click();
    await expect(page.locator('.story-example')).toBeVisible();
    await expect(page.locator('.story-main .diff-row--add, .story-main .diff-row--del')).toHaveCount(fixture.first.additions + fixture.first.deletions);
});

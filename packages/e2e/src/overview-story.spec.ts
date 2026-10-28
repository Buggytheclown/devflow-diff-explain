import { overviewStoryFixture } from '@sherpa/fixtures';
import { test, expect } from './sherpa-fixture.js';

const fixture = overviewStoryFixture();
test('обзор первым → ссылки на полный дифф → локальный повтор схемы → перезагрузка и новая подготовка', async ({ page, launchSherpa }) => {
    const server = await launchSherpa('fixture-medium'); await page.goto(server.url);
    await expect(page.locator('[role=progressbar]')).toBeVisible();
    await expect(page.locator('.story-overview-content')).toBeVisible();
    await server.worker.register('codex', 'ru');
    const plan = await server.worker.next();
    const summary = fixture.outline.summary;
    const outline = { ...fixture.outline, evidence: { claims: [{ quote: summary, sources: [{ kind: 'lines', path: fixture.anchor.path, side: fixture.anchor.side, start: fixture.anchor.start, end: fixture.anchor.start }], limitation: null }] } };
    expect((await server.worker.complete(plan.taskId ?? 0, JSON.stringify(outline))).stdout).not.toContain('rejected');
    await expect(page.locator('[role=progressbar]')).toHaveAttribute('aria-valuenow', String(Math.floor(100 / (4 + fixture.diff.files.length))));
    await page.locator('.story-source-links summary').click();
    await expect(page.locator('.story-evidence-toggle')).toHaveCount(0);
    await page.locator('.story-source-links button').first().click();
    await expect(page.locator('.story-main .diff-row').first()).toBeVisible();
    await expect(page.locator('.story-main .story-return')).toHaveText('← Описание ПРа');
    await page.locator('.story-main .story-return').click();
    const diagram = await server.worker.next(); expect(diagram.type).toBe('route.diagram');
    await server.worker.fail(diagram.taskId ?? 0, 'Synthetic diagram failure');
    for (const part of fixture.parts) { const task = await server.worker.next(); expect(task.type).toBe('route.section'); expect((await server.worker.complete(task.taskId ?? 0, JSON.stringify(part))).stdout).not.toContain('rejected'); }
    await expect(page.locator('.story-preparation')).toContainText('Разбор подготовлен частично');
    await page.getByRole('button', { name: 'Повторить схему', exact: true }).click();
    const retry = await server.worker.next(); expect(retry.type).toBe('route.diagram');
    await server.worker.complete(retry.taskId ?? 0, JSON.stringify({ contextRequests: [], diagram: fixture.diagram, reason: null }));
    await expect(page.locator('[role=progressbar]')).toHaveAttribute('aria-valuenow', '100');
    await page.screenshot({ path: test.info().outputPath('overview-ready.png'), fullPage: true });
    await page.locator('.story-topbar').getByRole('button', { name: 'Разбор по блокам', exact: true }).click();
    await page.locator('.story-nav').getByRole('button', { name: fixture.first.path, exact: true }).click();
    await expect(page.locator('.story-example')).toBeVisible();
    await page.locator('.story-main .diff-row').nth(20).scrollIntoViewIfNeeded();
    const row = page.locator('.story-main .diff-row').nth(20);
    await page.locator('.story-topbar').getByRole('button', { name: 'Спросить в чате', exact: true }).click();
    const composer = page.locator('.chat-panel textarea'); await composer.fill('Почему здесь такое условие?');
    const y = (await row.boundingBox())?.y ?? 0;
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.locator('.story-guided h2')).toHaveText(fixture.first.path);
    await expect(async () => { expect(Math.abs(((await row.boundingBox())?.y ?? 9999) - y)).toBeLessThan(4); }).toPass({ timeout: 10_000 });
    await page.locator('.story-topbar').getByRole('button', { name: 'Спросить в чате', exact: true }).click();
    await expect(composer).toHaveValue('Почему здесь такое условие?');
    // Новая подготовка не подменяет выбранный файл даже после приёмки нового плана.
    await page.evaluate(async () => {
        const token = new URLSearchParams(location.hash.slice(1)).get('t') ?? '';
        const response = await fetch('/api/ui/review/route/generate', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ locale: 'ru' }) });
        if (!response.ok) throw new Error('Could not start generation');
    });
    await expect(page.locator('.story-preparation')).toContainText('Предыдущий разбор');
    const newer = await server.worker.next(); await server.worker.complete(newer.taskId ?? 0, JSON.stringify(outline));
    await expect(page.getByRole('button', { name: 'Открыть новый разбор', exact: true })).toBeVisible();
    await expect(page.locator('.story-guided h2')).toHaveText(fixture.first.path);
    await page.reload(); await expect(page.locator('.story-guided h2')).toHaveText(fixture.first.path);
    await page.getByRole('button', { name: 'Открыть новый разбор', exact: true }).click();
    await expect(page.locator('.story-guided h2')).toHaveText('Описание ПРа');
});

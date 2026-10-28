import { architectureStoryFixture } from '@sherpa/fixtures';
import { test, expect } from './sherpa-fixture.js';

const fixture = architectureStoryFixture();
test('единая лента от первого до последнего файла; подсветка при прокрутке, reload и возврат из обзора', async ({ page, launchSherpa }) => {
    const server = await launchSherpa('fixture-medium');
    await page.goto(server.url); await server.worker.register('codex', 'ru');
    const overview = await server.worker.next(); await server.worker.complete(overview.taskId ?? 0, JSON.stringify(fixture.outline));
    const files = await server.worker.next(); await server.worker.complete(files.taskId ?? 0, JSON.stringify(fixture.body));
    await expect(page.locator('.story-preparation--ready')).toBeVisible();
    await expect(page.locator('.story-source-hint,.story-source-links,.story-flow-sources,.story-guide-pager')).toHaveCount(0);
    await page.locator('.story-topbar').getByRole('button', { name: 'Разбор по блокам', exact: true }).click();
    await expect(page.locator('.story-code')).toHaveCount(fixture.diff.files.length);
    await expect(page.locator('.story-main h1,.story-breadcrumb,.story-guide-pager')).toHaveCount(0);
    const expected = fixture.snapshot.tourOrder.flatMap((id) => fixture.snapshot.stops.find((stop) => stop.id === id)?.guidedFiles?.map((file) => file.path) ?? []);
    await expect(page.locator('.story-code > header code')).toHaveText(expected);
    await expect(page.locator('.story-code > .story-file-description')).toHaveCount(expected.length);
    const ordered = fixture.snapshot.tourOrder.flatMap((id) => fixture.snapshot.stops.find((stop) => stop.id === id)?.guidedFiles ?? []);
    for (const file of ordered) {
        const card = page.locator(`[data-reading-file="${file.fileId}"]`);
        // Только прокрутка: не вызываем переход по оглавлению.
        await card.evaluate((element) => { const top = (document.querySelector('.story-preparation')?.getBoundingClientRect().bottom ?? 0) + 12; window.scrollBy(0, element.getBoundingClientRect().top - top); });
        await expect(page.locator('.story-nav-file[aria-current=page]')).toHaveAttribute('aria-label', file.path);
        await expect(card.locator('header')).toBeInViewport();
        await expect(page.locator('.story-nav-file[aria-current=page]')).toBeInViewport();
    }
    const target = ordered[1]; if (target === undefined) throw new Error('Need multiple files');
    const card = page.locator(`[data-reading-file="${target.fileId}"]`);
    await page.locator('.story-nav').getByRole('button', { name: target.path, exact: true }).click();
    await expect(card.locator('header')).toBeInViewport();
    const row = card.locator('.diff-row[data-key]').first();
    await row.click();
    await page.getByRole('button', { name: 'Спросить в чате', exact: true }).click();
    const input = page.getByRole('textbox', { name: 'Вопрос агенту' }); await input.fill('Поясни эту строку');
    const key = await row.getAttribute('data-key'); if (key === null) throw new Error('Missing row key');
    await expect(page.locator('.story-nav-file[aria-current=page]')).toHaveAttribute('aria-label', target.path);
    const y = (await row.boundingBox())?.y ?? -1;
    await page.locator('.story-topbar').getByRole('button', { name: 'Описание ПРа', exact: true }).click();
    await page.locator('.story-topbar').getByRole('button', { name: 'Разбор по блокам', exact: true }).click();
    await expect(async () => { expect(Math.abs(((await row.boundingBox())?.y ?? 9999) - y)).toBeLessThan(4); }).toPass();
    await page.reload();
    const restored = card.locator(`.diff-row[data-key="${key}"]`);
    await expect(restored).toHaveClass(/is-selected/);
    await expect(input).toHaveValue('Поясни эту строку');
    await expect(page.locator('.chat-panel__contexts')).toContainText(target.path);
    await expect(page.locator('.story-nav-file[aria-current=page]')).toHaveAttribute('aria-label', target.path);
    await expect(async () => { expect(Math.abs(((await restored.boundingBox())?.y ?? 9999) - y)).toBeLessThan(4); }).toPass();
    await page.screenshot({ path: test.info().outputPath('continuous-file-chat.png') });
});

import { architectureStoryFixture } from '@sherpa/fixtures';
import { test, expect } from './sherpa-fixture.js';

const fixture = architectureStoryFixture();
test('описание → схема → все блоки и файлы обычным скроллом; один номер, возврат вверх и reload', async ({ page, launchSherpa }) => {
    const server = await launchSherpa('fixture-medium');
    await page.goto(server.url); await server.worker.register('codex', 'ru');
    const numbered = { ...fixture.outline, stops: fixture.outline.stops.map((block, index) => ({ ...block, title: `${String(index + 1)}. ${block.title}` })) };
    const outline = await server.worker.next(); await server.worker.complete(outline.taskId ?? 0, JSON.stringify(numbered));
    const body = await server.worker.next(); await server.worker.complete(body.taskId ?? 0, JSON.stringify(fixture.body));
    await expect(page.locator('.story-preparation--ready')).toBeVisible();
    const nav = page.locator('.story-nav');
    await expect(page.getByRole('button', { name: 'Все изменения', exact: true })).toHaveCount(0);
    await expect(nav.locator('.story-block-toggle[aria-expanded=true]')).toHaveCount(0);
    const titles = fixture.outline.stops.map((block, index) => `${String(index + 1)}. ${block.title}`);
    await expect(nav.locator('.story-block-visit > span')).toHaveText(titles);
    await expect(page.locator('.story-continuous-block > h2')).toHaveText(titles);
    await expect(nav.locator('.story-nav-overview')).toHaveAttribute('aria-current', 'page');
    const overview = page.locator('.story-overview');
    const instance = await overview.evaluate((element) => { element.setAttribute('data-instance', 'same'); return 'same'; });
    // Без единого клика в содержании, от описания до последнего файла.
    const ordered = fixture.snapshot.tourOrder.flatMap((id) => fixture.snapshot.stops.find((block) => block.id === id)?.guidedFiles ?? []);
    for (const file of ordered) {
        const card = page.locator(`[data-reading-file="${file.fileId}"]`);
        const delta = await card.evaluate((element) => element.getBoundingClientRect().top - Math.max(document.querySelector('.story-topbar')?.getBoundingClientRect().bottom ?? 0, document.querySelector('.story-preparation')?.getBoundingClientRect().bottom ?? 0) - 12);
        await page.mouse.move(800, 300); await page.mouse.wheel(0, delta);
        await expect(nav.locator('.story-nav-file[aria-current=page]')).toHaveAttribute('aria-label', file.path);
        await expect(nav.locator('.story-nav-file[aria-current=page]')).toBeInViewport();
        await expect(overview).toHaveAttribute('data-instance', instance);
    }
    const last = ordered.at(-1); if (last === undefined) throw Error('Missing file');
    await page.reload();
    await expect(nav.locator('.story-nav-file[aria-current=page]')).toHaveAttribute('aria-label', last.path);
    await expect(page.locator(`[data-reading-file="${last.fileId}"] header`)).toBeInViewport();
    // Память прежнего отдельного списка переводится на тот же общий холст.
    await page.evaluate(({ diffId, fileId }) => {
        const reader = JSON.parse(localStorage.getItem('devflow:reader') ?? '{}') as { navigation: { address: unknown } };
        reader.navigation.address = { kind: 'diff', diffId, fileId };
        localStorage.setItem('devflow:reader', JSON.stringify(reader));
        const positions = JSON.parse(localStorage.getItem('devflow:positions') ?? '[]') as [string, unknown][];
        const canvas = positions.find(([key]) => key.endsWith(':canvas'));
        if (canvas !== undefined) positions.push([`diff:${diffId}:${fileId}`, canvas[1]]);
        localStorage.setItem('devflow:positions', JSON.stringify(positions));
        const params = new URLSearchParams(location.hash.slice(1)); params.set('view', 'diff');
        history.replaceState(null, '', '#' + params.toString());
    }, { diffId: fixture.diff.diffId, fileId: last.fileId });
    await page.reload();
    await expect(page.locator('.story-code')).toHaveCount(fixture.diff.files.length);
    await expect(nav.locator('.story-nav-file[aria-current=page]')).toHaveAttribute('aria-label', last.path);
    await page.mouse.move(800, 300); await page.mouse.wheel(0, -100000);
    await expect(nav.locator('.story-nav-overview')).toHaveAttribute('aria-current', 'page');
    await expect(page.locator('.story-overview h2').first()).toBeInViewport();
    await expect(nav.locator('.story-block-toggle[aria-expanded=true]')).toHaveCount(1);
    await expect(nav.locator('.story-nav-overview')).toBeInViewport();
    await page.keyboard.press('2');
    await expect(page.locator('.story-code')).toHaveCount(fixture.diff.files.length);
    await expect(nav.locator('.story-nav-overview')).toHaveAttribute('aria-current', 'page');
    await expect(async () => { expect((await page.locator('.story-topbar').boundingBox())?.y).toBe(0); }).toPass();
    await page.screenshot({ path: test.info().outputPath('continuous-overview.png') });
});

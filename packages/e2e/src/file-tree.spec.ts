import { architectureStoryFixture } from '@sherpa/fixtures';
import { openBlocks, test, expect } from './sherpa-fixture.js';

test('заголовки блоков и настоящее дерево: порядок, строки, пояснения и шапки диффа', async ({ page, launchSherpa }) => {
    const server = await launchSherpa('fixture-medium');
    const fixture = architectureStoryFixture();
    await page.goto(server.url); await server.worker.register('codex', 'ru');
    const outline = await server.worker.next(); await server.worker.complete(outline.taskId ?? 0, JSON.stringify(fixture.outline));
    await openBlocks(page);
    const nav = page.locator('.story-nav');
    const firstLink = nav.getByRole('button', { name: fixture.first.path, exact: true });
    await expect(firstLink.locator('.story-tree-explanations')).toBeEmpty();
    const body = await server.worker.next(); await server.worker.complete(body.taskId ?? 0, JSON.stringify(fixture.body));
    await expect(page.locator('.story-preparation--ready')).toBeVisible();
    await nav.getByRole('button', { name: 'Развернуть всё', exact: true }).click();
    const blocks = fixture.snapshot.tourOrder.flatMap((id) => fixture.snapshot.stops.filter((block) => block.id === id));
    await expect(nav.locator('.story-nav-block .story-block-visit > span')).toHaveText(blocks.map((block, index) => `${String(index + 1)}. ${block.title}`));
    await expect(nav.locator('.story-nav-block h3 svg,.story-file-status')).toHaveCount(0);
    for (const [index, block] of blocks.entries()) {
        const group = nav.locator('.story-nav-block').nth(index);
        expect(await group.locator('.story-nav-file').evaluateAll((rows) => rows.map((row) => row.getAttribute('aria-label')))).toEqual((block.guidedFiles ?? []).map((file) => file.path));
        for (const file of block.guidedFiles ?? []) {
            const actual = fixture.diff.files.find((entry) => entry.fileId === file.fileId);
            if (actual === undefined) throw new Error('Missing file');
            const row = group.getByRole('button', { name: file.path, exact: true });
            await expect(row).toHaveAttribute('type', 'button');
            await expect(row.locator('.story-file-added')).toHaveText(`+${String(actual.additions)}`);
            await expect(row.locator('.story-file-deleted')).toHaveText(`−${String(actual.deletions)}`);
            await expect(row.locator('.story-file-glyph')).toHaveAttribute('data-change', actual.changeType);
            const count = (file.explanation === null ? 0 : 1) + file.annotations.length;
            await expect(row.locator('.story-tree-explanations')).toHaveText(count === 0 ? '' : String(count));
            await expect(row.locator('.story-tree-explanations')).toHaveAttribute('title', `Пояснений ЛЛМ: ${String(count)}`);
        }
    }
    await firstLink.click();
    const card = page.locator(`[data-reading-file="${fixture.first.fileId}"]`);
    await expect(card.locator('header code')).toHaveText(fixture.first.path);
    await expect(card.locator('header .story-file-status')).toBeVisible();
    await expect(card.locator('.diff-hunk-header').first()).toHaveText(/^@@ -\d+,\d+ \+\d+,\d+ @@$/);
    await expect(card.locator('.diff-row--add,.diff-row--del')).toHaveCount(fixture.first.additions + fixture.first.deletions);
    const added = fixture.diff.files.find((file) => file.changeType === 'add' && file.patch?.includes('@@'));
    if (added === undefined) throw new Error('Missing added file');
    await nav.getByRole('button', { name: added.path, exact: true }).click();
    const addedCard = page.locator(`[data-reading-file="${added.fileId}"]`);
    const addedRow = addedCard.locator('.diff-row--add').first();
    await expect(addedCard.locator('header .story-file-status')).toHaveText('A');
    await expect(addedRow.locator('.diff-row__gutter').first()).toBeHidden();
    await expect(addedRow.locator('.diff-row__gutter--code')).toBeVisible();
    await expect(addedRow.locator('.diff-row__sign')).toHaveText('+');
    await page.screenshot({ path: test.info().outputPath('arcanum-files-tree.png') });
    await expect(page.getByRole('button', { name: 'Все изменения', exact: true })).toHaveCount(0);
});

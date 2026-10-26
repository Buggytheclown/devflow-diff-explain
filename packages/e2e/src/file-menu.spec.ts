import { expect, test } from './sherpa-fixture.js';

/**
 * Контекстное меню файла (docs/design/SPEC-elements.md §2.11 с поправками 2026-09-03):
 * правый клик по строке дерева и кнопка «⋯» в шапке карточки дают одно меню; путь уезжает в буфер обмена, отметка просмотра
 * идёт той же цепочкой, что коробка прочитанности, а Esc закрывает меню и ничего сверх этого.
 */

test('меню файла: правый клик в дереве, «⋯» в шапке карточки, буфер и отметка', async ({
    page,
    context,
    launchSherpa,
}) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    const server = await launchSherpa('fixture-medium');
    await page.goto(server.url);
    await page.getByRole('tab', { name: 'Полный дифф', exact: true }).click();

    const menu = page.getByRole('menu');
    // Машинный файл уже считается просмотренным, поэтому берётся первый обычный.
    const row = page.locator('.file-tree__row--file:not(.is-generated)').first();

    await test.step('правый клик по строке дерева открывает меню', async () => {
        await row.click({ button: 'right' });
        await expect(menu.getByRole('menuitem')).toHaveText([
            'Скопировать путь',
            'Скопировать ссылку на файл',
            'Открыть в вебе',
            'Просмотрено',
        ]);
    });

    await test.step('«Скопировать путь» кладёт путь файла в буфер', async () => {
        // `title` строки — «путь · прогресс чтения»: буфер сверяется с первой половиной.
        const path = (await row.getAttribute('title'))?.split(' · ')[0];
        await menu.getByRole('menuitem', { name: 'Скопировать путь', exact: true }).click();

        await expect(menu).toHaveCount(0);
        expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(path);
    });

    await test.step('«⋯» в шапке карточки отмечает файл просмотренным', async () => {
        const card = page.locator('.file-card:not(.file-card--generated)').first();
        const fileId = await card.getAttribute('data-file');
        const path = await card.locator('.file-card__path').getAttribute('title');
        // Строка дерева этого же файла: её коробка прочитанности и обязана поменяться.
        const rowId = `tree-row-${encodeURIComponent(`file:${String(path)}`)}`;
        const box = page.locator(`[id="${rowId}"] .file-tree__read`);
        await expect(box).toHaveAttribute('aria-pressed', 'false');

        await card.getByRole('button', { name: 'Действия с файлом', exact: true }).click();
        await menu.getByRole('menuitem', { name: 'Просмотрено', exact: true }).click();

        await expect(menu).toHaveCount(0);
        await expect(box).toHaveAttribute('aria-pressed', 'true');
        await expect(page.locator(`.file-card[data-file="${String(fileId)}"] .file-card__collapsed--file`)).toContainText(
            'просмотрено',
        );
    });

    await test.step('Esc закрывает меню и больше ничего', async () => {
        await row.click({ button: 'right' });
        await expect(menu).toHaveCount(1);

        await page.keyboard.press('Escape');

        await expect(menu).toHaveCount(0);
        // Вью на месте: лестница Esc отдала нажатие меню и дальше его не понесла.
        await expect(page.getByRole('tab', { name: 'Полный дифф', exact: true })).toHaveAttribute(
            'aria-selected',
            'true',
        );
    });
});

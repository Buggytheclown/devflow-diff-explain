import { asRawText, mediumRawResults, sectionFor, submit, takeTask } from './route-worker.js';
import { expect, test } from './sherpa-fixture.js';

const MOD_KEY = process.platform === 'darwin' ? 'Meta' : 'Control';

test('маршрут: сгенерировать → перегенерировать → ready', async ({ page, launchSherpa }) => {
    const server = await launchSherpa('fixture-medium');
    const worker = server.worker;
    const raw = mediumRawResults();

    await page.goto(server.url);
    expect((await worker.register('claude-code')).code).toBe(0);
    await page.getByRole('tab', { name: 'Маршрут', exact: true }).click();

    await test.step('первая генерация доходит до ready', async () => {
        const skeleton = await takeTask(worker, 'route.skeleton');
        await submit(worker, skeleton.taskId, raw.skeleton);
        for (let index = 0; index < 6; index += 1) {
            const section = await takeTask(worker, 'route.section');
            await submit(worker, section.taskId, sectionFor(section.planIndexes));
        }

        await expect(page.locator('.route-skeleton-card')).toHaveCount(0);
        await expect(page.locator('[data-stop]')).toHaveCount(7);
    });

    await test.step('перестройка сохраняет старый маршрут и отметки до нового плана', async () => {
        const firstStop = page.locator('[data-stop="s01"]');
        const viewed = firstStop.locator('button.route-stop__viewed');
        await expect(viewed).toHaveAccessibleName('Отметить просмотренным');
        await viewed.click();
        await expect(viewed).toHaveAccessibleName('Просмотрено');

        await page.keyboard.press(`${MOD_KEY}+KeyK`);
        const palette = page.getByRole('dialog', { name: 'Палитра команд' });
        await palette.getByRole('textbox').fill('Перегенерировать маршрут');
        await expect(palette.getByRole('option', { name: /Перегенерировать маршрут/ })).toBeVisible();
        await page.keyboard.press('Enter');

        await expect(page.getByText('Строю новый маршрут — отметки остановок уйдут, когда он приедет')).toBeVisible();
        await expect(page.locator('[data-stop]')).toHaveCount(7);
        await expect(viewed).toHaveAccessibleName('Просмотрено');
    });

    await test.step('новый план заменяет старый и маршрут снова доходит до ready', async () => {
        const skeleton = await takeTask(worker, 'route.skeleton');
        const complete = await worker.complete(skeleton.taskId, asRawText(raw.skeleton));
        expect(complete.code, `${complete.stdout}${complete.stderr}`).toBe(0);
        expect(complete.stdout).not.toContain('was rejected');

        await expect(page.locator('.route-skeleton-card')).toHaveCount(6);
        await expect(page.locator('[data-stop="s01"] button.route-stop__viewed')).toHaveAccessibleName(
            'Отметить просмотренным',
        );

        for (let index = 0; index < 6; index += 1) {
            const section = await takeTask(worker, 'route.section');
            await submit(worker, section.taskId, sectionFor(section.planIndexes));
        }

        await expect(page.locator('.route-skeleton-card')).toHaveCount(0);
        await expect(page.locator('.coverage__legend-text')).toHaveText(
            '866 изменённых строк · 95% объяснено · 38 строк не объяснено',
        );
    });
});

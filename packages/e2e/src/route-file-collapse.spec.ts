import { mediumRawResults, sectionFor, submit, takeTask } from './route-worker.js';
import { expect, test } from './sherpa-fixture.js';

test('маршрут: просмотр и ручная свёртка карточки файла', async ({ page, launchSherpa }) => {
    const server = await launchSherpa('fixture-medium');
    const raw = mediumRawResults();

    await page.goto(server.url);
    await page.getByRole('tab', { name: 'Маршрут', exact: true }).click();
    expect((await server.worker.register('claude-code')).code).toBe(0);
    const skeleton = await takeTask(server.worker, 'route.skeleton');
    await submit(server.worker, skeleton.taskId, raw.skeleton);
    for (const sectionIndex of raw.sections.keys()) {
        const section = await takeTask(server.worker, 'route.section');
        expect(section.planIndexes, `секция ${String(sectionIndex + 1)}`).toHaveLength(1);
        await submit(server.worker, section.taskId, sectionFor(section.planIndexes));
    }
    await expect(page.locator('.route-skeleton-card')).toHaveCount(0);

    const stop = page.locator('[data-stop="s01"]');
    const card = stop.locator('.file-card').first();
    const viewed = card.getByRole('button', { name: 'Отметить просмотренным', exact: true });

    await test.step('отметка просмотра сворачивает, снятие возвращает развёртку', async () => {
        await viewed.click();
        await expect(card.locator('.file-card__collapsed--file')).toContainText('просмотрено');

        await card.getByRole('button', { name: 'Просмотрено', exact: true }).click();
        await expect(card.locator('.file-card__collapsed--file')).toHaveCount(0);
    });

    await test.step('ручная свёртка переживает перезагрузку без открытия Полного диффа', async () => {
        await card.locator('.file-card__name').click();
        await expect(card.locator('.file-card__collapsed--file')).toContainText('свёрнуто вручную');

        await page.reload();
        await page.getByRole('tab', { name: 'Маршрут', exact: true }).click();
        const reloadedCard = page.locator('[data-stop="s01"] .file-card').first();
        await expect(reloadedCard.locator('.file-card__collapsed--file')).toContainText('свёрнуто вручную');
    });
});

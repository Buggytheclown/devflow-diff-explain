import { mediumRawResults, sectionFor, submit, takeTask } from './route-worker.js';
import { expect, test } from './sherpa-fixture.js';

test('маршрут: failed-стоп дозаполняется без полной перегенерации', async ({ page, launchSherpa }) => {
    const server = await launchSherpa('fixture-medium');
    const worker = server.worker;
    const raw = mediumRawResults();

    await page.goto(server.url);
    expect((await worker.register('claude-code')).code).toBe(0);
    await page.getByRole('tab', { name: 'Маршрут', exact: true }).click();

    const skeleton = await takeTask(worker, 'route.skeleton');
    await submit(worker, skeleton.taskId, raw.skeleton);

    const failed = await takeTask(worker, 'route.section');
    expect(failed.planIndexes).toEqual([1]);
    const failure = await worker.fail(failed.taskId, 'агент остановился раньше');
    expect(failure.code, `${failure.stdout}${failure.stderr}`).toBe(0);

    for (let index = 0; index < 5; index += 1) {
        const section = await takeTask(worker, 'route.section');
        await submit(worker, section.taskId, sectionFor(section.planIndexes));
    }

    const firstStop = page.locator('[data-stop="s01"]');
    const fill = firstStop.getByRole('button', { name: 'Дозаполнить' });
    await expect(fill).toBeVisible();
    await fill.click();

    const refill = await takeTask(worker, 'route.section');
    expect(refill.planIndexes).toEqual([1]);
    await submit(worker, refill.taskId, sectionFor(refill.planIndexes));

    await expect(fill).toHaveCount(0);
    await expect(firstStop.locator('.route-stop__badge--queued')).toHaveCount(0);
    await expect(firstStop).toContainText('Появился класс EditWindow');
    await expect(page.locator('.route-skeleton-card')).toHaveCount(0);
});

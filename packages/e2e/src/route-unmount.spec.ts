import type { Locator } from '@playwright/test';

import { mediumRawResults, sectionFor, submit, takeTask } from './route-worker.js';
import { expect, test } from './sherpa-fixture.js';

/**
 * Колонка диффа далёкой остановки снимается с DOM. Проверяется то, что от этого
 * могло сломаться: секция остаётся на месте, документ не съёживается (плейсхолдер держит
 * измеренную высоту), а прыжок из полосы покрытия доезжает до снятой остановки — лестница
 * «секция → карточка» дожидается, пока колонка вернётся.
 */
test('маршрут: снятая с DOM остановка держит место и принимает прыжок', async ({ page, launchSherpa }) => {
    const server = await launchSherpa('fixture-medium');
    const raw = mediumRawResults();

    await page.goto(server.url);
    await page.getByRole('tab', { name: 'Маршрут', exact: true }).click();
    expect((await server.worker.register('claude-code')).code).toBe(0);
    const skeleton = await takeTask(server.worker, 'route.skeleton');
    await submit(server.worker, skeleton.taskId, raw.skeleton);
    for (const _sectionIndex of raw.sections.keys()) {
        const section = await takeTask(server.worker, 'route.section');
        await submit(server.worker, section.taskId, sectionFor(section.planIndexes));
    }
    await expect(page.locator('.route-skeleton-card')).toHaveCount(0);

    const route = page.locator('main.route');
    const stops = await page.locator('[data-stop]').count();

    // Проход по маршруту: колонку снимают только у остановки, которая побывала на экране и
    // успела показать все свои карточки — по скелетонам и голове списка высоту не меряют.
    await passRoute(route);

    const target = page.locator('[data-stop]').filter({ has: page.locator('.route-stop__placeholder') }).first();
    let targetId = '';

    await test.step('колонка ушла, секция и высота документа остались', async () => {
        await expect(target).toHaveCount(1);
        targetId = (await target.getAttribute('data-stop')) ?? '';
        expect(targetId).not.toBe('');
        await expect(target.locator('.file-card')).toHaveCount(0);
        // Секции считает и выбор верхней остановки, и прыжки: их число не меняется.
        await expect(page.locator('[data-stop]')).toHaveCount(stops);
    });

    await test.step('колонка возвращается и уходит, не меняя высоту секции', async () => {
        const section = page.locator(`[data-stop="${targetId}"]`);
        await section.scrollIntoViewIfNeeded();
        await expect(section.locator('.file-card').first()).toBeAttached();
        const mountedHeight = (await section.boundingBox())?.height ?? 0;
        expect(mountedHeight).toBeGreaterThan(0);

        await route.evaluate((element) => {
            element.scrollTop = element.scrollHeight;
        });
        await expect(section.locator('.route-stop__placeholder')).toHaveCount(1);
        const unmountedHeight = (await section.boundingBox())?.height ?? 0;

        // Плейсхолдер держит ровно ту высоту, что была у колонки: документ под секцией не едет.
        expect(Math.abs(unmountedHeight - mountedHeight)).toBeLessThanOrEqual(2);
    });

    await test.step('прыжок из палитры возвращает колонку и доезжает до карточки', async () => {
        // Номер остановки в плане — из её липкой колонки: она на месте и у снятой колонки диффа.
        const number = (await target.locator('.route-stop__number').textContent()) ?? '';
        const label = number.split('/')[0]?.trim() ?? '';
        expect(label).not.toBe('');

        await page.locator('.search-button').click();
        await page.locator('.command-palette__query').fill(`Перейти к остановке ${label}`);
        await page.locator('.command-palette__item').first().click();

        const jumped = page.locator(`[data-stop="${targetId}"]`);
        await expect(jumped.locator('.route-stop__placeholder')).toHaveCount(0);
        await expect(jumped.locator('.file-card').first()).toBeVisible();
    });
});

/** Прокрутка по всему маршруту экран за экраном: так его и проходит ревьюер. */
async function passRoute(route: Locator): Promise<void> {
    await route.evaluate(async (element) => {
        const frame = (): Promise<unknown> =>
            new Promise((resolve) => {
                requestAnimationFrame(() => {
                    resolve(null);
                });
            });
        for (let top = 0; top <= element.scrollHeight; top += element.clientHeight) {
            element.scrollTop = top;
            // Два кадра: наблюдатель пересечений докладывает после кадра, рендер идёт следом.
            await frame();
            await frame();
        }
        element.scrollTop = element.scrollHeight;
        await frame();
        await frame();
    });
}

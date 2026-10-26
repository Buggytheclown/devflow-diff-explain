import { LONG_LINE_MARKER } from '@sherpa/fixtures';

import { mediumRawResults, sectionFor, submit, takeTask } from './route-worker.js';
import { expect, test } from './sherpa-fixture.js';

const POSITION_TOLERANCE_PX = 1;

test('шапка длинного файла остаётся под тулбаром полного диффа', async ({ page, launchSherpa }) => {
    const server = await launchSherpa('fixture-large');

    await page.goto(server.url);
    await page.getByRole('tab', { name: 'Полный дифф', exact: true }).click();
    const code = page.locator('.diff-row__code', { hasText: LONG_LINE_MARKER }).first();
    await code.scrollIntoViewIfNeeded();
    await expect(code).toBeVisible();
    await page.evaluate(() => document.fonts.ready.then(() => undefined));

    const card = code.locator('xpath=ancestor::article[contains(@class, "file-card")]');
    const header = card.locator('.file-card__header');
    const toolbar = page.locator('.full-diff__toolbar');
    const scroller = page.locator('.full-diff');

    await scroller.evaluate(async (element, marker) => {
        const nextFrame = (): Promise<void> =>
            new Promise<void>((resolve) => {
                requestAnimationFrame(() => {
                    resolve();
                });
            });
        const code = [...document.querySelectorAll<HTMLElement>('.diff-row__code')].find((candidate) =>
            candidate.textContent.includes(marker),
        );
        const card = code?.closest<HTMLElement>('.file-card') ?? null;
        const header = card?.querySelector<HTMLElement>('.file-card__header') ?? null;
        const toolbar = document.querySelector<HTMLElement>('.full-diff__toolbar');
        if (card === null || header === null || toolbar === null) {
            throw new Error('не удалось найти длинную карточку и липкий тулбар');
        }

        const cardRect = card.getBoundingClientRect();
        const headerRect = header.getBoundingClientRect();
        const toolbarBottom = toolbar.getBoundingClientRect().bottom;
        const depth = Math.min(240, cardRect.height - headerRect.height - 2);
        if (depth <= 0) {
            throw new Error('фикстура не дала карточку длиннее своей шапки');
        }
        element.scrollTop += cardRect.top - toolbarBottom + depth;
        await nextFrame();
        await nextFrame();
    }, LONG_LINE_MARKER);

    const [cardBox, headerBox, toolbarBox] = await Promise.all([
        card.boundingBox(),
        header.boundingBox(),
        toolbar.boundingBox(),
    ]);
    if (cardBox === null || headerBox === null || toolbarBox === null) {
        throw new Error('геометрия липкой шапки не измерилась');
    }
    const toolbarBottom = toolbarBox.y + toolbarBox.height;

    expect(cardBox.y).toBeLessThan(toolbarBottom);
    expect(cardBox.y + cardBox.height).toBeGreaterThan(headerBox.y + headerBox.height);
    expect(Math.abs(headerBox.y - toolbarBottom)).toBeLessThanOrEqual(POSITION_TOLERANCE_PX);
    await expect(header).toHaveCSS('position', 'sticky');
    await expect(header.getByRole('button', { name: 'Отметить просмотренным', exact: true })).toBeVisible();

    const layers = await page.evaluate(() => {
        const header = document.querySelector<HTMLElement>('.file-card__header');
        const toolbar = document.querySelector<HTMLElement>('.full-diff__toolbar');
        if (header === null || toolbar === null) {
            throw new Error('слои липкой шапки не измерились');
        }
        return {
            header: Number(getComputedStyle(header).zIndex),
            toolbar: Number(getComputedStyle(toolbar).zIndex),
        };
    });
    expect(layers.toolbar).toBeGreaterThan(layers.header);
});

test('шапка файла маршрута остаётся на уровне липкой колонки остановки', async ({ page, launchSherpa }) => {
    const server = await launchSherpa('fixture-medium');
    const raw = mediumRawResults();

    await page.goto(server.url);
    await page.getByRole('tab', { name: 'Маршрут', exact: true }).click();
    expect((await server.worker.register('claude-code')).code).toBe(0);
    const skeleton = await takeTask(server.worker, 'route.skeleton');
    await submit(server.worker, skeleton.taskId, raw.skeleton);
    for (const sectionIndex of raw.sections.keys()) {
        const task = await takeTask(server.worker, 'route.section');
        expect(task.planIndexes, `секция ${String(sectionIndex + 1)}`).toHaveLength(1);
        await submit(server.worker, task.taskId, sectionFor(task.planIndexes));
    }
    await expect(page.locator('.route-skeleton-card')).toHaveCount(0);
    await page.evaluate(() => document.fonts.ready.then(() => undefined));

    const geometry = await page.locator('.route').evaluate(async (scroller) => {
        const nextFrame = (): Promise<void> =>
            new Promise<void>((resolve) => {
                requestAnimationFrame(() => {
                    resolve();
                });
            });
        const toolbar = scroller.querySelector<HTMLElement>('.route-toolbar');
        const cards = [...scroller.querySelectorAll<HTMLElement>('.file-card')];
        const card = cards.sort((left, right) => right.getBoundingClientRect().height - left.getBoundingClientRect().height)[0];
        const header = card?.querySelector<HTMLElement>('.file-card__header') ?? null;
        const side = card?.closest<HTMLElement>('.route-stop')?.querySelector<HTMLElement>('.route-stop__side') ?? null;
        if (toolbar === null || card === undefined || header === null || side === null) {
            throw new Error('не удалось найти длинную карточку маршрута и её остановку');
        }

        const before = card.getBoundingClientRect();
        scroller.scrollTop += before.top - toolbar.getBoundingClientRect().bottom + 90;
        await nextFrame();
        await nextFrame();
        const style = getComputedStyle(scroller);
        const gap = Number.parseFloat(style.getPropertyValue('--space-inner'));
        scroller.scrollTop += card.getBoundingClientRect().top - (toolbar.getBoundingClientRect().bottom + gap) + 90;
        await nextFrame();
        await nextFrame();

        const cardRect = card.getBoundingClientRect();
        const headerRect = header.getBoundingClientRect();
        const sideRect = side.getBoundingClientRect();
        const toolbarRect = toolbar.getBoundingClientRect();
        return {
            cardTop: cardRect.top,
            cardBottom: cardRect.bottom,
            headerTop: headerRect.top,
            headerBottom: headerRect.bottom,
            sideTop: sideRect.top,
            toolbarBottom: toolbarRect.bottom,
            toolbarHeight: toolbarRect.height,
            measuredToolbarHeight: Number.parseFloat(style.getPropertyValue('--route-toolbar-height')),
            gap,
            headerPosition: getComputedStyle(header).position,
            headerZ: Number(getComputedStyle(header).zIndex),
            toolbarZ: Number(getComputedStyle(toolbar).zIndex),
        };
    });

    expect(geometry.cardTop).toBeLessThan(geometry.headerTop);
    expect(geometry.cardBottom).toBeGreaterThan(geometry.headerBottom);
    expect(Math.abs(geometry.headerTop - (geometry.toolbarBottom + geometry.gap))).toBeLessThanOrEqual(
        POSITION_TOLERANCE_PX,
    );
    expect(Math.abs(geometry.sideTop - geometry.headerTop)).toBeLessThanOrEqual(POSITION_TOLERANCE_PX);
    expect(Math.abs(geometry.measuredToolbarHeight - geometry.toolbarHeight)).toBeLessThanOrEqual(POSITION_TOLERANCE_PX);
    expect(geometry.headerPosition).toBe('sticky');
    expect(geometry.toolbarZ).toBeGreaterThan(geometry.headerZ);
});

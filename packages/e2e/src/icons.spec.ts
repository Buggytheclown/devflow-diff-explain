import { expect, test } from './sherpa-fixture.js';

const ICON_IDS = [
    'ic-search',
    'ic-chev-down',
    'ic-chev-right',
    'ic-thumb',
    'ic-pencil',
    'ic-check',
    'ic-cross',
    'ic-swap',
    'ic-arrow-up',
    'ic-arrow-down',
    'ic-updown',
    'ic-reply',
    'ic-bold',
    'ic-italic',
    'ic-link',
    'ic-code',
    'ic-codeblock',
    'ic-list',
    'ic-trash',
    'ic-sliders',
    'ic-dot',
];

const ICON_SIZES = [9, 11, 13, 14, 15];

test('production UI содержит один спрайт, несжимаемые SVG и кнопку комментария в гаттере', async ({
    page,
    launchSherpa,
}) => {
    const server = await launchSherpa('fixture-medium');
    await page.goto(server.url);

    await expect(page.locator('.review-action-bar__ship-primary')).toBeVisible();
    await expect(page.locator('.icon-sprite')).toHaveCount(1);
    expect(await page.locator('.icon-sprite symbol').evaluateAll((symbols) => symbols.map((symbol) => symbol.id))).toEqual(
        ICON_IDS,
    );

    const measurements = await page.locator('svg.icon').evaluateAll((icons) =>
        icons
            .map((icon) => {
                const rect = icon.getBoundingClientRect();
                return {
                    visible: rect.width > 0 && rect.height > 0,
                    attribute: Number(icon.getAttribute('width')),
                    width: rect.width,
                    height: rect.height,
                    viewBox: icon.getAttribute('viewBox'),
                    flexShrink: getComputedStyle(icon).flexShrink,
                };
            })
            .filter((measurement) => measurement.visible),
    );
    expect(measurements.length).toBeGreaterThan(0);
    for (const measurement of measurements) {
        expect(ICON_SIZES).toContain(measurement.attribute);
        expect(measurement.width).toBe(measurement.attribute);
        expect(measurement.height).toBe(measurement.attribute);
        expect(measurement.viewBox).toBe('0 0 16 16');
        expect(measurement.flexShrink).toBe('0');
    }

    await page.getByRole('tab', { name: 'Полный дифф', exact: true }).click();
    const row = page.locator('.diff-row:has(.diff-row__comment)').first();
    await expect(row).toBeVisible();
    await row.hover();

    const button = row.locator('.diff-row__comment');
    await expect(button).toBeVisible();
    expect(await button.evaluate((element) => element.parentElement === element.closest('.diff-row')?.children[1])).toBe(true);
    await expect(button).toHaveCSS('width', '23px');
    await expect(button).toHaveCSS('height', '23px');
    await expect(button).toHaveCSS('background-color', 'rgb(127, 140, 255)');
    expect(await button.evaluate((element) => getComputedStyle(element).boxShadow)).toContain('0px 1px 4px');

    const pencil = button.locator('svg[data-icon="pencil"]');
    await expect(pencil).toHaveAttribute('width', '15');
    expect((await pencil.boundingBox())?.width).toBe(15);

    await page.mouse.move(0, 0);
    await button.focus();
    await expect(button).toHaveCSS('opacity', '1');
});

for (const mode of ['unified', 'split'] as const) {
    test(`кнопка комментария не перекрывает номер и знак в режиме ${mode}`, async ({ page, launchSherpa }) => {
        const server = await launchSherpa('fixture-medium');
        await page.goto(server.url);
        await page.getByRole('tab', { name: 'Полный дифф', exact: true }).click();

        if (mode === 'split') {
            await page.locator('.diff-mode-toggle').click();
        }
        await expect(page.locator(`.diff-rows--${mode}`).first()).toBeVisible();

        // В split берётся строка с обеими половинами: вторая кнопка в ней не должна ловить наведение.
        const gutterSelector =
            mode === 'unified'
                ? '.diff-row__gutter--comment:has(.diff-row__comment)'
                : '.diff-row--pair:has(> .diff-side--del .diff-row__comment):has(> .diff-side--add .diff-row__comment) > .diff-row__gutter--comment:has(.diff-row__comment)';
        const gutter = page.locator(gutterSelector).filter({ hasText: /\d/ }).first();
        const row = gutter.locator('..');
        const button = gutter.locator('.diff-row__comment');

        await (mode === 'split' ? gutter : row).hover();
        await expect(button).toHaveCSS('pointer-events', 'auto');
        if (mode === 'split') {
            await expect(row.locator('.diff-row__comment').nth(1)).toHaveCSS('pointer-events', 'none');
        }
        const geometry = await gutter.evaluate((element) => {
            const comment = element.querySelector<HTMLElement>('.diff-row__comment');
            const sign = element.nextElementSibling as HTMLElement | null;
            const number = [...element.childNodes].find(
                (node) => node.nodeType === 3 && node.textContent?.trim() !== '',
            );
            if (comment === null || sign === null || number === undefined) {
                throw new Error('Не удалось измерить кнопку комментария');
            }

            const range = document.createRange();
            range.selectNodeContents(number);
            const numberRect = range.getBoundingClientRect();
            const buttonRect = comment.getBoundingClientRect();
            const gutterRect = element.getBoundingClientRect();
            const signRect = sign.getBoundingClientRect();
            const rowRect = element.parentElement?.getBoundingClientRect();
            if (rowRect === undefined) {
                throw new Error('Не удалось измерить строку диффа');
            }

            return {
                numberRight: numberRect.right,
                buttonLeft: buttonRect.left,
                buttonRight: buttonRect.right,
                gutterLeft: gutterRect.left,
                gutterRight: gutterRect.right,
                signLeft: signRect.left,
                signCenterX: signRect.left + signRect.width / 2,
                signCenterY: signRect.top + signRect.height / 2,
                belowButtonX: buttonRect.left + buttonRect.width / 2,
                belowRowY: rowRect.bottom + 1,
            };
        });

        expect(geometry.buttonLeft - geometry.numberRight).toBeGreaterThanOrEqual(1);
        expect(geometry.buttonLeft).toBeGreaterThanOrEqual(geometry.gutterLeft);
        expect(geometry.buttonRight).toBeLessThanOrEqual(geometry.gutterRight);
        expect(geometry.buttonRight).toBeLessThanOrEqual(geometry.signLeft);

        await page.mouse.move(0, 0);
        await expect(button).toHaveCSS('opacity', '0');
        await expect(button).toHaveCSS('pointer-events', 'none');
        expect(
            await page.evaluate(
                ({ signCenterX, signCenterY }) =>
                    document.elementFromPoint(signCenterX, signCenterY)?.classList.contains('diff-row__sign') ?? false,
                geometry,
            ),
        ).toBe(true);
        expect(
            await page.evaluate(
                ({ belowButtonX, belowRowY }) =>
                    document.elementFromPoint(belowButtonX, belowRowY)?.classList.contains('diff-row__comment') ?? false,
                geometry,
            ),
        ).toBe(false);

        await button.focus();
        await expect(button).toHaveCSS('pointer-events', 'auto');
        await page.keyboard.press('c');
        await expect(page.locator('.diff-line-composer')).toBeVisible();
        await page.locator('.diff-line-composer').getByRole('button', { name: 'Отмена', exact: true }).click();
        await expect(page.locator('.diff-line-composer')).toHaveCount(0);
        await button.evaluate((element) => {
            element.blur();
        });
        await page.mouse.move(0, 0);

        await page.mouse.click(geometry.signCenterX, geometry.signCenterY);
        await expect(mode === 'unified' ? row : gutter).toHaveClass(/is-selected/);
        await expect(page.locator('.thread-composer')).toHaveCount(0);
        await expect(button).toHaveClass(/is-selection-start/);
        await expect(button).toHaveCSS('pointer-events', 'auto');
        expect(
            await page.evaluate(
                ({ signCenterX, signCenterY }) =>
                    document.elementFromPoint(signCenterX, signCenterY)?.classList.contains('diff-row__sign') ?? false,
                geometry,
            ),
        ).toBe(true);

        await button.click();
        const lineComposer = page.locator('.diff-line-composer');
        await expect(lineComposer).toBeVisible();
        await expect(lineComposer).toHaveCSS('padding-left', '62px');
        await expect(lineComposer).toHaveCSS('background-color', 'rgb(13, 14, 16)');
        // `--border-hairline-soft` тёмной темы (packages/ui/src/styles/tokens.css).
        await expect(lineComposer).toHaveCSS('border-top-color', 'rgb(35, 39, 45)');
        await expect(lineComposer.locator('.thread-composer')).toHaveCSS('max-width', '620px');
        // Шапки у композера нет: первая строка — свитчер issue (SPEC-changes-2026-09-20 §1).
        await expect(lineComposer.locator('.thread-composer__context')).toHaveCount(0);
        await expect(lineComposer.locator('.thread-composer__issue-row')).toHaveCount(1);
    });
}

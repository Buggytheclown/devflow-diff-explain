import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { Page } from '@playwright/test';

import { expect, sherpaAuth, test } from './sherpa-fixture.js';

test('тема и Arcanum независимы, Auto следует за системой, выбор переживает перезагрузку и другой PR', async ({
    page,
    launchSherpa,
}) => {
    const sherpaDir = await mkdtemp(path.join(tmpdir(), 'sherpa-e2e-theme-'));
    try {
        const first = await launchSherpa('fixture-medium', { sherpaDir });
        const second = await launchSherpa('fixture-large', { sherpaDir });

        // Свежий корень стейта — режим Auto: тема берётся у системы и меняется без перезагрузки.
        await page.emulateMedia({ colorScheme: 'dark' });
        await page.goto(first.url);
        await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
        await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(13, 14, 16)');
        await page.emulateMedia({ colorScheme: 'light' });
        await expectLight(page);

        // Явный выбор системную тему больше не слушает.
        await page.emulateMedia({ colorScheme: 'dark' });
        await switchTheme(page, 'Светлая');
        await expectLight(page);
        await page.getByRole('tab', { name: 'Полный дифф', exact: true }).click();
        await expect(page.locator('.diff-rows--unified').first()).toBeVisible();
        // `--code-text` светлой темы (packages/ui/src/styles/tokens.css).
        await expect(page.locator('.diff-row--add .diff-row__code').first()).toHaveCSS('color', 'rgb(0, 0, 0)');

        // Первый кадр приходит уже светлым: тема стоит в самом документе, а не появляется с ответом ручки.
        const document = await page.request.get(first.url.split('#')[0] ?? first.url);
        expect(await document.text()).toContain('data-theme="light"');

        await page.reload();
        await expectLight(page);
        await page.goto(second.url);
        await expectLight(page);
        await page.getByRole('tab', { name: 'Полный дифф', exact: true }).click();

        // Arcanum сохраняет выбранную светлую тему; обе палитры используют одну геометрию.
        await toggleArcanum(page, true);
        await expectArcanum(page, 'light');
        await expectGeometry(page, true);
        await switchTheme(page, 'Тёмная');
        await expectArcanum(page, 'dark');
        await expectGeometry(page, true);
        const arcanumDocument = await page.request.get(second.url.split('#')[0] ?? second.url);
        expect(await arcanumDocument.text()).toContain('data-theme="arcanum-dark"');
        await page.emulateMedia({ colorScheme: 'light' });
        await page.reload();
        await expectArcanum(page, 'dark');
        await page.goto(first.url);
        await expectArcanum(page, 'dark');
        await page.getByRole('tab', { name: 'Полный дифф', exact: true }).click();

        // Переключение стиля на открытом диффе сохраняет режим темы и пересчитывает виртуальные позиции.
        await toggleArcanum(page, false);
        await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
        await expectGeometry(page, false);
        await toggleArcanum(page, true);
        await expectArcanum(page, 'dark');
        await expectGeometry(page, true);

        // Auto меняет только палитру, флаг Arcanum остаётся включённым.
        await switchTheme(page, 'Авто');
        await expectArcanum(page, 'light');
        await expectGeometry(page, true);
        await page.emulateMedia({ colorScheme: 'dark' });
        await expectArcanum(page, 'dark');
        await expectGeometry(page, true);
        await toggleArcanum(page, false);
        await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
        await expectGeometry(page, false);
        await page.emulateMedia({ colorScheme: 'light' });
        await expectLight(page);
        await expectGeometry(page, false);

        // Светлая Arcanum тоже сохраняется для первого HTML, перезагрузки и другого PR.
        await switchTheme(page, 'Светлая');
        await toggleArcanum(page, true);
        await expectArcanum(page, 'light');
        const lightArcanumDocument = await page.request.get(first.url.split('#')[0] ?? first.url);
        expect(await lightArcanumDocument.text()).toContain('data-theme="arcanum-light"');
        await page.emulateMedia({ colorScheme: 'dark' });
        await page.reload();
        await expectArcanum(page, 'light');
        await page.goto(second.url);
        await expectArcanum(page, 'light');
    } finally {
        await rm(sherpaDir, { recursive: true, force: true });
    }
});

test('вложенная тема задаёт геометрию и виртуальные позиции независимо от настроек', async ({ page, launchSherpa }) => {
    const server = await launchSherpa('fixture-large');
    await page.goto(`${server.url}&view=diff`);
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await expectGeometry(page, false);

    // Как в карточках галереи: меняем только тему поддерева, настройки остаются прежними.
    for (const theme of ['arcanum-light', 'light', 'arcanum-dark', 'dark']) {
        await page.locator('#root').evaluate((root, value) => { root.setAttribute('data-theme', value); }, theme);
        await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
        await expectGeometry(page, theme.startsWith('arcanum-'));
    }
});

for (const theme of ['dark', 'light'] as const) {
    for (const outcome of ['failed', 'pending'] as const) {
        test(`Arcanum ${theme}: первый HTML и геометрия при GET настроек ${outcome}`, async ({ page, launchSherpa }) => {
            const server = await launchSherpa('fixture-medium');
            const settingsUrl = new URL('/api/ui/settings', server.url).href;
            const saved = await page.request.patch(settingsUrl, {
                headers: sherpaAuth(server),
                data: { theme, arcanum: true, textSize: 'l' },
            });
            expect(saved.status()).toBe(200);

            let release = (): void => undefined;
            const pending = new Promise<void>((resolve) => { release = resolve; });
            await page.route('**/api/ui/settings', async (route) => {
                if (route.request().method() !== 'GET') {
                    await route.continue();
                } else if (outcome === 'failed') {
                    await route.abort();
                } else {
                    await pending;
                    await route.continue();
                }
            });
            try {
                await page.goto(`${server.url}&view=diff`);
                await expectArcanum(page, theme);
                await expect(page.locator('html')).toHaveAttribute('data-textsize', 'l');
                await expectGeometry(page, true);

                // Переключатель действует даже при отказе GET. Для светлой палитры проверяем
                // также, что поздний ответ не отменяет уже выбранный локально флаг Arcanum.
                const changedLocally = outcome === 'failed' || theme === 'light';
                if (changedLocally) {
                    await toggleArcanum(page, false);
                    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
                    await expectGeometry(page, false);
                }
                if (outcome === 'pending') {
                    const nextTheme = theme === 'dark' ? 'light' : 'dark';
                    const changed = await page.request.patch(settingsUrl, {
                        headers: sherpaAuth(server),
                        data: { theme: nextTheme, arcanum: changedLocally, textSize: 'm' },
                    });
                    expect(changed.status()).toBe(200);
                    release();
                    // Размер m подтверждает применение позднего ответа; локальный флаг при этом
                    // остаётся false, а нетронутые поля принимают новые значения с сервера.
                    await expect(page.locator('html')).toHaveAttribute('data-textsize', 'm');
                    await expect(page.locator('html')).toHaveAttribute('data-theme', nextTheme);
                    await expectGeometry(page, false);
                }
            } finally {
                release();
                await page.unrouteAll({ behavior: 'wait' });
            }
        });
    }
}

async function expectLight(page: Page): Promise<void> {
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await expect(page.locator('html')).toHaveCSS('color-scheme', 'light');
    // `--surface-app` светлой темы (packages/ui/src/styles/tokens.css).
    await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(246, 247, 249)');
    await expect(page.getByRole('button', { name: 'Настройки', exact: true })).toBeVisible();
}

async function expectArcanum(page: Page, theme: 'dark' | 'light'): Promise<void> {
    await expect(page.locator('html')).toHaveAttribute('data-theme', `arcanum-${theme}`);
    await expect(page.locator('html')).toHaveCSS('color-scheme', theme);
    await expect(page.locator('body')).toHaveCSS('background-color', theme === 'dark' ? 'rgb(45, 44, 51)' : 'rgb(255, 255, 255)');
    await expect(page.locator('body')).toHaveCSS('font-family', /YS Text/);
}

async function expectGeometry(page: Page, arcanum: boolean): Promise<void> {
    await expect(page.locator('.diff-row__code').first()).toHaveCSS('line-height', arcanum ? '17px' : '20px');
    await expect(page.locator('.file-tree__row').first()).toHaveCSS('height', arcanum ? '22px' : '26px');
    await expect(page.locator('.file-card__name').first()).toHaveCSS('font-family', arcanum ? /YS Text/ : /IBM Plex Mono/);
    await expectTreeSpacing(page, arcanum ? 22 : 26);
}

/** Независимый switch сохраняет стиль, не меняя сегмент темы. */
async function toggleArcanum(page: Page, enabled: boolean): Promise<void> {
    const saved = page.waitForResponse(
        (response) => response.url().includes('/api/ui/settings') && response.request().method() === 'PATCH',
    );
    await page.getByRole('button', { name: 'Настройки', exact: true }).click();
    const toggle = page.locator('.settings-menu__panel').getByRole('switch', { name: 'Стиль Arcanum', exact: true });
    await expect(toggle).toHaveAttribute('aria-checked', String(!enabled));
    await toggle.focus();
    await toggle.press('Enter');
    expect((await saved).status()).toBe(200);
    await expect(toggle).toHaveAttribute('aria-checked', String(enabled));
    await page.keyboard.press('Escape');
    await expect(page.locator('.settings-menu__panel')).toHaveCount(0);
}

/** Тема переключается сегментом в меню настроек; Esc закрывает меню, как любой поповер. */
async function switchTheme(page: Page, name: string): Promise<void> {
    const saved = page.waitForResponse(
        (response) => response.url().includes('/api/ui/settings') && response.request().method() === 'PATCH',
    );
    await page.getByRole('button', { name: 'Настройки', exact: true }).click();
    const segment = page.locator('.settings-menu__panel')
        .getByRole('group', { name: 'Тема', exact: true })
        .getByRole('button', { name, exact: true });
    await segment.focus();
    await segment.press('Enter');
    expect((await saved).status()).toBe(200);
    await expect(segment).toHaveAttribute('aria-pressed', 'true');
    await page.keyboard.press('Escape');
    await expect(page.locator('.settings-menu__panel')).toHaveCount(0);
}

/** Виртуальные позиции должны изменяться вместе с CSS-высотой, иначе строки перекрываются. */
async function expectTreeSpacing(page: Page, height: number): Promise<void> {
    await expect.poll(async () => page.locator('.file-tree__row').evaluateAll((rows) => {
        const first = rows[0];
        const second = rows[1];
        return first && second ? second.getBoundingClientRect().top - first.getBoundingClientRect().top : 0;
    })).toBe(height);
}

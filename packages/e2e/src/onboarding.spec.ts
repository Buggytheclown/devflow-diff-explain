import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { Locator, Page } from '@playwright/test';

import { fillSections, mediumRawResults, MEDIUM_SECTION_COUNT, sectionFor, submit, takeTask } from './route-worker.js';
import { expect, test } from './sherpa-fixture.js';

/**
 * Тур первого захода. Флаг прохождения и номер шага живут в `<sherpaDir>/settings.json`,
 * поэтому «второй заход» здесь — второй сервер с тем же корнем стейта, а не перезагрузка вкладки.
 *
 * Тур стартует сразу при первом открытии UI и не ждёт маршрута: пока его нет, цели шагов
 * подставляет каркас с заглушкой.
 */

const CARD = '.tour-card';
const COUNTER = '.tour-card__counter';
const RING = '.tour-ring';

test('первый заход: тур виден сразу на Маршруте, без агента счётчик / 07', async ({ page, launchSherpa }) => {
    const server = await launchSherpa('fixture-medium', { onboarding: 'pending' });
    await page.goto(server.url);

    // Стартовый вид непройденного тура — Маршрут, хотя умолчание вкладки — Обзор.
    await expect(page.getByRole('tab', { name: 'Маршрут', exact: true })).toHaveAttribute('aria-selected', 'true');

    await expect(page.locator(CARD)).toBeVisible();
    await expect(page.locator(COUNTER)).toHaveText('01 / 07');
    await expect(page.locator(CARD)).toContainText('Маршрут решает, что читать первым');
    // Маршрута нет — цель шага держит заглушка каркаса, и кольцо обводит именно её.
    await expect(page.locator('.tour-scaffold [data-tour="narrative"]')).toBeVisible();
    await expectRingAround(page, '[data-tour="narrative"]');
});

test('маршрут приехал посреди тура: кольцо переезжает на настоящую остановку', async ({ page, launchSherpa }) => {
    const server = await launchSherpa('fixture-medium', { onboarding: 'pending' });
    const worker = server.worker;
    await page.goto(server.url);
    await expect(page.locator(CARD)).toBeVisible();
    await expect(page.locator('.tour-scaffold')).toBeVisible();

    expect((await worker.register('claude-code')).code).toBe(0);
    const skeleton = await takeTask(worker, 'route.skeleton');
    await submit(worker, skeleton.taskId, mediumRawResults().skeleton);
    const section = await takeTask(worker, 'route.section');
    await submit(worker, section.taskId, sectionFor(section.planIndexes));

    // Каркас уступает место маршруту, цель шага переезжает на первую остановку.
    await expect(page.locator('.tour-scaffold')).toHaveCount(0);
    await expect(page.locator('[data-stop="s01"] [data-tour="narrative"]')).toBeVisible();
    await expectRingAround(page, '[data-tour="narrative"]');

    // Прокрутка принадлежит ревьюеру: остановки, приезжающие по SSE, дозамеряются без скролла (§3).
    await page.locator('#view-route').evaluate((element) => {
        element.scrollTop = 400;
    });
    await fillSections(worker, MEDIUM_SECTION_COUNT - 1);
    await expect(page.locator('.route-skeleton-card')).toHaveCount(0);
    expect(await routeScrollTop(page)).toBe(400);

    // Шаг 02 стоит на свёртке low-остановки далеко внизу: первый замер доводит до неё скроллом.
    await page.keyboard.press('ArrowRight');
    await expect(page.locator(COUNTER)).toHaveText('02 / 07');
    await expectRingAround(page, '[data-tour^="fold-"]');
    expect(await routeScrollTop(page)).toBeGreaterThan(0);

    await page.keyboard.press('ArrowRight');
    // Проход начинался без агента: подключившийся посреди тура шаг про чат не возвращает (§5).
    await expect(page.locator(COUNTER)).toHaveText('03 / 07');
    await expectRingAround(page, '[data-tour="stopdiff"]');
});

test('клик по интерфейсу и Esc тур не закрывают, Enter ведёт дальше', async ({ page, launchSherpa }) => {
    const server = await launchSherpa('fixture-medium', { onboarding: 'pending' });
    await page.goto(server.url);
    await expect(page.locator(COUNTER)).toHaveText('01 / 07');

    await page.keyboard.press('Enter');
    await expect(page.locator(COUNTER)).toHaveText('02 / 07');

    await page.locator('.tour-scaffold .route-stop__title').click();
    await expect(page.locator(CARD)).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator(CARD)).toBeVisible();
    await expect(page.locator(COUNTER)).toHaveText('02 / 07');

    // Табом ушли на «Пропустить» — Enter принадлежит кнопке, а не «Дальше» (§6, §7).
    await page.locator(CARD).focus();
    await page.keyboard.press('Tab');
    await expect(page.locator(CARD).getByRole('button', { name: 'Пропустить' })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.locator(CARD)).toHaveCount(0);
});

test('незавершённый тур продолжается с того же шага на новом сервере', async ({ page, launchSherpa }) => {
    const sherpaDir = await mkdtemp(path.join(tmpdir(), 'sherpa-e2e-tour-'));
    try {
        const first = await launchSherpa('fixture-medium', { sherpaDir, onboarding: 'pending' });
        await page.goto(first.url);
        await expect(page.locator(COUNTER)).toHaveText('01 / 07');

        for (let step = 0; step < 3; step += 1) {
            const saved = settingsSaved(page);
            await page.keyboard.press('ArrowRight');
            await saved;
        }
        await expect(page.locator(COUNTER)).toHaveText('04 / 07');

        await first.stop();
        const second = await launchSherpa('fixture-medium', { sherpaDir, onboarding: 'pending' });
        await page.goto(second.url);

        await expect(page.locator(COUNTER)).toHaveText('04 / 07');
        await expect(page.locator(CARD)).toContainText('Прогресс считает две разные вещи');
    } finally {
        await rm(sherpaDir, { recursive: true, force: true });
    }
});

test('«Пропустить» закрывает тур навсегда, палитра возвращает его с 01', async ({ page, launchSherpa }) => {
    const sherpaDir = await mkdtemp(path.join(tmpdir(), 'sherpa-e2e-tour-skip-'));
    try {
        const first = await launchSherpa('fixture-medium', { sherpaDir, onboarding: 'pending' });
        await page.goto(first.url);
        await expect(page.locator(CARD)).toBeVisible();

        const saved = settingsSaved(page);
        await page.locator(CARD).getByRole('button', { name: 'Пропустить' }).click();
        await saved;
        await expect(page.locator(CARD)).toHaveCount(0);

        await first.stop();
        const second = await launchSherpa('fixture-medium', { sherpaDir, onboarding: 'pending' });
        await page.goto(second.url);
        await expect(page.getByRole('tab', { name: 'Обзор', exact: true })).toHaveAttribute('aria-selected', 'true');
        await expect(page.locator(CARD)).toHaveCount(0);

        // Агент подключён — в новом проходе тура снова восемь шагов.
        expect((await second.worker.register('claude-code')).code).toBe(0);
        await expect(page.locator('.agent-pill__label')).not.toHaveText('Агент отключён');

        await replayFromPalette(page);
        await expect(page.locator(COUNTER)).toHaveText('01 / 08');
        await expect(page.locator(CARD)).toContainText('Маршрут решает, что читать первым');
    } finally {
        await rm(sherpaDir, { recursive: true, force: true });
    }
});

test('шаг про агента открывает панель чата, следующий её закрывает', async ({ page, launchSherpa }) => {
    const server = await launchSherpa('fixture-medium', { onboarding: 'pending' });
    await page.goto(server.url);
    await expect(page.locator(CARD)).toBeVisible();

    expect((await server.worker.register('claude-code')).code).toBe(0);
    await replayFromPalette(page);
    await expect(page.locator(COUNTER)).toHaveText('01 / 08');
    await expect(page.locator('.chat-panel')).toHaveCount(0);

    for (let step = 0; step < 5; step += 1) {
        await page.keyboard.press('ArrowRight');
    }
    await expect(page.locator(COUNTER)).toHaveText('06 / 08');
    await expect(page.locator('.chat-panel')).toBeVisible();
    await expectRingAround(page, '[data-tour="chat"]');

    await page.keyboard.press('ArrowRight');
    await expect(page.locator(COUNTER)).toHaveText('07 / 08');
    await expect(page.locator('.chat-panel')).toHaveCount(0);

    // Назад — тем же шагом: панель открывается снова.
    await page.keyboard.press('ArrowLeft');
    await expect(page.locator(COUNTER)).toHaveText('06 / 08');
    await expect(page.locator('.chat-panel')).toBeVisible();
});

/** Прокрутка вью маршрута: по ней видно, что первый замер шага доехал до цели. */
function routeScrollTop(page: Page): Promise<number> {
    return page.locator('#view-route').evaluate((element) => element.scrollTop);
}

/** Ждём саму запись настройки: следующий сервер читает уже сохранённый номер шага. */
function settingsSaved(page: Page): Promise<unknown> {
    return page.waitForResponse(
        (response) => response.url().includes('/api/ui/settings') && response.request().method() === 'PATCH',
    );
}

async function replayFromPalette(page: Page): Promise<void> {
    const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
    await page.keyboard.press(`${mod}+KeyK`);
    const palette = page.getByRole('dialog', { name: 'Палитра команд' });
    await expect(palette).toBeVisible();
    await palette.getByRole('textbox').fill('онбординг');
    await palette.getByRole('option', { name: /Показать онбординг заново/u }).first().click();
    await expect(palette).toHaveCount(0);
}

/** Кольцо обводит цель с зазором 5px (docs/design/SPEC-onboarding-2026-09-02.md §3). */
async function expectRingAround(page: Page, selector: string): Promise<void> {
    const ring: Locator = page.locator(RING);
    await expect(ring).toBeVisible();
    await expect
        .poll(async () => {
            const ringBox = await ring.boundingBox();
            const targetBox = await page.locator(selector).first().boundingBox();
            if (ringBox === null || targetBox === null) {
                return null;
            }
            return {
                left: Math.round(targetBox.x - ringBox.x),
                top: Math.round(targetBox.y - ringBox.y),
            };
        })
        .toEqual({ left: 5, top: 5 });
}

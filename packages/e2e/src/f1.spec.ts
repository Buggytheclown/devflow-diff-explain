import type { Locator, Page } from '@playwright/test';

import { asRawText, fillSections, mediumRawResults, sectionFor, submit, takeTask } from './route-worker.js';
import { expect, test } from './sherpa-fixture.js';

/**
 * F1 (docs/product.md §7): ревьюер запускает скилл, UI открывается сразу с диффом, маршрут достраивается
 * по мере генерации, ревьюер проходит high/medium-остановки, оставляет два черновика и шипает.
 *
 * Агент — тот же бандл CLI, которым ходит модель в харнесе; сдаёт он заготовленные выводы
 * фикстуры `medium`, поэтому числа на экране заранее известны и обязаны сходиться
 * (docs/design/SPEC-elements.md §8 п.3–4).
 *
 * Петля воркера живёт в тесте: `worker next` ждёт задачу без срока, поэтому зовётся
 * только тогда, когда сервер её заведомо поставил.
 */

/** Тиры фикстуры: 01–02 high, 03–04 medium, 05–06 low, 07 — синтетическое «Прочее». */
const IMPORTANT_STOPS = ['s01', 's02', 's03', 's04'] as const;
const LOW_STOPS = ['s05', 's06'] as const;
const PLAN_ORDER = ['s01', 's02', 's03', 's04', 's05', 's06', 'other'];
/** Пока маршрут строится, «Прочего» нет (docs/design/SPEC-elements.md §4.3). */
const FILLING_ORDER = PLAN_ORDER.filter((stopId) => stopId !== 'other');
const TOUR_ORDER = ['s03', 's01', 's02', 's05', 's06', 's04', 'other'];
const FIRST_DRAFT = 'E2E F1: окно считается в одном месте — это стоит вынести в доку.';
const SECOND_DRAFT = 'E2E F1: 409 против 400 — проверим на клиенте.';

test('F1: очередь → валидатор → снапшот → SSE → UI, до Review complete', async ({ page, launchSherpa }) => {
    const server = await launchSherpa('fixture-medium');
    const worker = server.worker;
    const raw = mediumRawResults();

    await test.step('UI открывается сразу: дифф и читалка не ждут агента', async () => {
        await page.goto(server.url);

        await expect(page.getByRole('tab', { name: 'Маршрут', exact: true })).toBeVisible();
        await expect(page.getByRole('button', { name: 'Агент отключён', exact: true })).toBeVisible();

        await page.getByRole('tab', { name: 'Полный дифф', exact: true }).click();
        await expect(page.locator('.full-diff')).toHaveAttribute('data-shown-files', '21');
        await expect(page.locator('.diff-row').first()).toBeVisible();
    });

    const skeletonTask = await test.step('агент на связи — сервер сам ставит скелет маршрута', async () => {
        expect((await worker.register('claude-code')).code).toBe(0);
        await page.getByRole('tab', { name: 'Маршрут', exact: true }).click();

        const task = await takeTask(worker, 'route.skeleton');
        expect(task.attempt).toBe(1);
        // Фаза чтения: плана ещё нет, поэтому у плейсхолдеров нет ни номеров, ни знаменателя.
        await expect(page.locator('.route-skeleton__note')).toContainText('План ещё строится');
        await expect(page.locator('.route-stop__number')).toHaveCount(3);
        await expect(page.locator('.route-stop__number').first()).toHaveText('— / ?');
        await expect(page.locator('.coverage__legend-text')).toHaveText('покрытие известно после плана');
        return task;
    });

    await test.step('план приехал — слоты и summary встали до заполнения', async () => {
        await submit(worker, skeletonTask.taskId, raw.skeleton);

        await expect(stopNumbers(page)).toHaveText(['01 / 6', '02 / 6', '03 / 6', '04 / 6', '05 / 6', '06 / 6']);
        expect(await stopOrder(page)).toEqual(FILLING_ORDER);
        // Заполнена пока ни одна: шесть скелетонов модели, «Прочего» до готовности нет.
        await expect(page.locator('.route-skeleton-card')).toHaveCount(6);
        await expect(page.locator('.coverage__legend-text')).toHaveText('покрытие известно после плана');

        // Прогрессивность F1 (docs/product.md §7): summary читается уже здесь, до первой секции.
        await page.getByRole('tab', { name: 'Обзор', exact: true }).click();
        await expectSummary(page);
        await page.getByRole('tab', { name: 'Маршрут', exact: true }).click();
    });

    await test.step('остановки заполняются по одной: готовое читается, остальное — скелетоны', async () => {
        for (let filled = 0; filled < 6; filled += 1) {
            const task = await takeTask(worker, 'route.section');
            expect(task.planIndexes).toHaveLength(1);

            if (filled === 3) {
                await expectHalfFilled(page);
            }
            await submit(worker, task.taskId, sectionFor(task.planIndexes));
        }
    });

    await test.step('маршрут готов: полоса покрытия и счётчик остановок сошлись', async () => {
        await expect(page.locator('.coverage__legend-text')).toHaveText(
            '866 изменённых строк · 95% объяснено · 38 строк не объяснено',
        );
        await expect(page.locator('.route-skeleton-card')).toHaveCount(0);
        await expect(page.locator('.coverage__stops')).toHaveText('просмотрено 0 из 7 остановок');
        // Те же 38 строк, что и в легенде: «Прочее» обещает ровно то, что раскроет.
        await expect(stop(page, 'other')).toContainText('Открыть 38 строк');
        // Сегменты полосы разложены по тирам фикстуры и в сумме дают её же 866 строк
        // (в патчах 868: две пустые строки вне якорей в статистику не входят).
        await expect(segment(page, 'high')).toHaveAttribute('aria-label', 'high · остановки 01–02 · 196 строк');
        await expect(segment(page, 'medium')).toHaveAttribute('aria-label', 'medium · остановки 03–04 · 327 строк');
        await expect(segment(page, 'low')).toHaveAttribute('aria-label', 'low · остановки 05–06 · 305 строк');
        await expect(segment(page, 'other')).toHaveAttribute('aria-label', 'не объяснено · 38 строк');

        await page.getByRole('tab', { name: 'Обзор', exact: true }).click();
        await expectSummary(page);
        await expect(page.locator('.gen-card__title')).toHaveText('Маршрут готов · 7 остановок');
        await page.getByRole('tab', { name: 'Маршрут', exact: true }).click();
    });

    await test.step('фокус строки + c открывает тот же композер, что карандаш', async () => {
        const firstLine = stop(page, 's01').locator('.diff-row[tabindex="0"]').first();
        await firstLine.focus();
        await page.keyboard.press('c');

        const composer = stop(page, 's01').locator('.diff-line-composer');
        await expect(composer).toBeVisible();
        // Шапки у композера нет: первая строка — свитчер issue, он включён по умолчанию (§1).
        await expect(composer.locator('.thread-composer__context')).toHaveCount(0);
        await expect(composer.locator('.thread-composer > :first-child')).toHaveClass(
            /thread-composer__issue-row/u,
        );
        const issue = composer.locator('.thread-composer__issue');
        await expect(issue).toHaveAttribute('aria-checked', 'true');
        await expect(composer.locator('.thread-composer__issue-row + .thread-composer__editor')).toHaveCount(1);
        await composer.getByRole('button', { name: 'Отмена', exact: true }).click();
        await expect(composer).toHaveCount(0);
    });

    await test.step('план-номера не зависят от пресета (SPEC-elements §8 п.4)', async () => {
        await page.keyboard.press('t');
        await expect(page.getByRole('button', { name: 'Полный тур', exact: true })).toHaveAttribute(
            'aria-pressed',
            'true',
        );
        expect(await stopOrder(page)).toEqual(TOUR_ORDER);
        // Первой едет остановка 03 — со своим планным номером, а не с «01».
        await expect(stopNumbers(page).first()).toHaveText('03 / 7');
        await expect(stop(page, 's01').locator('.route-stop__number')).toHaveText('01 / 7');

        await page.keyboard.press('t');
        await expect(page.getByRole('button', { name: 'Триаж', exact: true })).toHaveAttribute('aria-pressed', 'true');
        expect(await stopOrder(page)).toEqual(PLAN_ORDER);
    });

    await test.step('по дороге два черновика на разных остановках', async () => {
        await addDraft(page, 's01', FIRST_DRAFT);
        await expect(page.locator('.review-action-bar')).toContainText('1 черновик уйдёт при публикации');

        await addDraft(page, 's03', SECOND_DRAFT);
        await expect(page.locator('.review-action-bar')).toContainText('2 черновика уйдут при публикации');
    });

    await test.step('high и medium отмечены, low и «Прочее» остаются свёрнутыми', async () => {
        for (const [index, stopId] of IMPORTANT_STOPS.entries()) {
            await stop(page, stopId).locator('.route-stop__viewed').click();
            await expect(page.locator('.coverage__stops')).toHaveText(
                `просмотрено ${String(index + 1)} из 7 остановок`,
            );
        }

        for (const stopId of LOW_STOPS) {
            await expect(stop(page, stopId)).toContainText('низкая важность');
            await expect(stop(page, stopId).locator('.route-stop__viewed')).toHaveAttribute('aria-pressed', 'false');
        }
        await expect(stop(page, 'other').locator('.route-stop__viewed')).toHaveAttribute('aria-pressed', 'false');
    });

    await test.step('Ship: гардрейл считает остановки, публикация идёт пакетом', async () => {
        await page.locator('.review-action-bar__ship-caret').click();
        await expect(page.locator('.review-action-menu__guard')).toHaveText(
            '3 остановки не просмотрены — всё равно шипнуть?',
        );
        await page.locator('#review-ship-option-0').click();

        await expect(page.getByRole('heading', { name: 'Shipped · PR 4821', exact: true })).toBeVisible();
        await expect(page.getByText('2 комментария опубликованы одним пакетом', { exact: true })).toBeVisible();
        // Счётчики Review complete (docs/design/README.md §13) сходятся с тем, что делали руками.
        await expect(counter(page, 'Остановки просмотрены')).toHaveText('4 из 7');
        await expect(counter(page, 'Комментариев опубликовано')).toHaveText('2 (из них 0 ответов)');
        // 89% против старта — разницу записали ровно отметки четырёх остановок.
        // Generated-дефолт psp-schema.ts сохраняется после частичного покрытия остановкой s03.
        await expect(counter(page, 'Диффа увидено')).toHaveText('89% из 868 строк');
        // «Прочее» не отмечено — строки про чтение вне маршрута быть не должно.
        await expect(page.getByText('Из них прочитано вне маршрута', { exact: true })).toHaveCount(0);
    });

    await test.step('после шипа неопубликованного не осталось', async () => {
        await page.getByRole('button', { name: 'К полному диффу', exact: true }).click();

        await expect(page.locator('.full-diff')).toBeVisible();
        await expect(page.locator('.review-action-bar')).toContainText('нет неопубликованных комментариев');
    });
});

test('F1 негатив: битый план роняет генерацию, Retry доводит маршрут до готового', async ({
    page,
    launchSherpa,
}) => {
    const server = await launchSherpa('fixture-medium');
    const worker = server.worker;
    const raw = mediumRawResults();
    const broken = asRawText(raw.broken.skeletonTourOrderNotPermutation);

    await page.goto(server.url);
    await page.getByRole('tab', { name: 'Маршрут', exact: true }).click();
    expect((await worker.register('claude-code')).code).toBe(0);

    await test.step('три отклонения валидатора исчерпывают бюджет задачи', async () => {
        const task = await takeTask(worker, 'route.skeleton');

        for (let attempt = 1; attempt <= 3; attempt += 1) {
            const rejected = await worker.complete(task.taskId, broken);
            // Отказ — штатная часть петли: CLI завершается нулём и печатает, что чинить.
            expect(rejected.code, `попытка ${String(attempt)}: ${rejected.stderr}`).toBe(0);
            expect(rejected.stdout, `попытка ${String(attempt)}`).toContain('was rejected');
            expect(rejected.stdout).toContain('tourOrder');
        }
    });

    await test.step('фаза failed: причина и сырой вывод модели на экране (README §12)', async () => {
        await expect(page.locator('.gen-failed__title')).toHaveText('Маршрут не построился');
        await expect(page.locator('.gen-failed__reason')).toContainText('Агент не построил план маршрута');

        await page.getByRole('button', { name: 'Показать сырой вывод', exact: true }).click();
        await expect(page.locator('.gen-failed__raw')).toHaveText(broken);
    });

    await test.step('Retry ставит новую задачу плана, валидные результаты доводят до ready', async () => {
        await page.getByRole('button', { name: 'Повторить', exact: true }).click();

        const retried = await takeTask(worker, 'route.skeleton');
        expect(retried.taskId).not.toBe(0);
        await submit(worker, retried.taskId, raw.skeleton);
        await fillSections(worker);

        await expect(page.locator('.coverage__legend-text')).toHaveText(
            '866 изменённых строк · 95% объяснено · 38 строк не объяснено',
        );
        expect(await stopOrder(page)).toEqual(PLAN_ORDER);
    });
});

/** Половина маршрута заполнена: готовое читается, незаполненное честно показывает себя скелетоном. */
async function expectHalfFilled(page: Page): Promise<void> {
    // Три стопа сданы, четвёртый взят в аренду — заполняется; 05, 06 ещё в очереди.
    await expect(page.locator('.route-skeleton-card')).toHaveCount(3);
    // Бэктики модели съедает markdown-рендерер: на экране `EditWindow` — моно-код без бэктиков.
    await expect(stop(page, 's01')).toContainText('Появился класс EditWindow и инжектируемый источник времени');
    await expect(stop(page, 's01').locator('.route-stop__paragraph code.md-code').first()).toHaveText('EditWindow');
    await expect(stop(page, 's04')).toContainText('Агент ещё не заполнил эту остановку');
    await expect(page.locator('.coverage__legend-text')).toHaveText('покрытие известно после плана');

    // План-карточка Overview и маршрут говорят одними и теми же номерами (docs/design/SPEC-elements.md §8 п.4).
    await page.getByRole('tab', { name: 'Обзор', exact: true }).click();
    await expect(page.locator('.gen-plan__number')).toHaveText(['01', '02', '03', '04', '05', '06']);
    await expect(page.locator('.gen-card__counter')).toHaveText('3 из 6 готовы');
    await expectSummary(page);
    await page.getByRole('tab', { name: 'Маршрут', exact: true }).click();
}

/**
 * Summary целиком на вкладке «Обзор». Строка происхождения рендерится только при снапшоте,
 * поэтому она и отличает настоящее описание от заглушек «Маршрута ещё нет» / «Маршрут не построился».
 */
async function expectSummary(page: Page): Promise<void> {
    await expect(page.locator('.overview-card__text').first()).toContainText(
        'PR вводит 30-минутное окно редактирования',
    );
    await expect(page.locator('.summary-card__provenance')).toBeVisible();
}

/** Черновик на строке остановки: тот же композер, что и в полном диффе. */
async function addDraft(page: Page, stopId: string, text: string): Promise<void> {
    // Колонка диффа далёкой остановки снята с DOM — сначала подъезжаем к секции,
    // как это делает ревьюер: секция на месте всегда, карточки возвращаются рядом с экраном.
    await stop(page, stopId).scrollIntoViewIfNeeded();
    const button = stop(page, stopId).getByRole('button', { name: /Комментировать строку \d+/ }).first();
    await button.locator('..').hover();
    await button.click();
    const composer = stop(page, stopId).getByRole('textbox', { name: 'Новый комментарий' });
    await composer.fill(text);
    await stop(page, stopId).getByRole('button', { name: 'Сохранить черновик', exact: true }).click();
    await expect(composer).toHaveCount(0, { timeout: 6_000 });
    await expect(stop(page, stopId).getByText(text, { exact: true })).toBeVisible();
}

function stop(page: Page, stopId: string): Locator {
    return page.locator(`[data-stop="${stopId}"]`);
}

function segment(page: Page, tier: string): Locator {
    return page.locator(`.coverage__segment--${tier}`);
}

function stopNumbers(page: Page): Locator {
    return page.locator('[data-stop] .route-stop__number');
}

async function stopOrder(page: Page): Promise<string[]> {
    return page.locator('[data-stop]').evaluateAll((nodes) =>
        nodes.map((node) => node.getAttribute('data-stop') ?? ''),
    );
}

function counter(page: Page, label: string): Locator {
    return page.locator('.review-complete__counter').filter({ hasText: label }).locator('dd');
}

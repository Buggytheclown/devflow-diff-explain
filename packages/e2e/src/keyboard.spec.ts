import type { Locator, Page } from '@playwright/test';

import { buildRoute, buildRouteV2 } from './route-worker.js';
import { advanceIteration, expect, test } from './sherpa-fixture.js';

/**
 * Карта клавиш docs/design/SPEC-elements.md §5 целиком: по проверке на строку карты, плюс
 * аккорд с отменой и лестница Esc. Маршрут строится fake-воркером — без него половина карты недоступна.
 */

const MOD_KEY = process.platform === 'darwin' ? 'Meta' : 'Control';
const DRAFT = 'E2E клавиатура: черновик из-под клавиши c.';
const REPLY = 'E2E клавиатура: ответ из-под клавиши r.';

test('клавиатура: карта SPEC-elements §5 на fixture-medium', async ({ page, launchSherpa }) => {
    const server = await launchSherpa('fixture-medium');
    const worker = server.worker;

    await test.step('маршрут готов', async () => {
        await page.goto(server.url);
        await page.getByRole('tab', { name: 'Маршрут', exact: true }).click();
        expect((await worker.register('claude-code')).code).toBe(0);
        await buildRoute(worker);
        await expect(page.locator('.route-skeleton-card')).toHaveCount(0);
        await expect(page.locator('[data-stop]')).toHaveCount(7);
    });

    await test.step('⌘K открывает палитру, Esc закрывает', async () => {
        await page.keyboard.press(`${MOD_KEY}+KeyK`);
        await expect(palette(page)).toBeVisible();

        await page.keyboard.press('Escape');
        await expect(palette(page)).toHaveCount(0);
    });

    await test.step('1 / 2 / 3 переключают вью', async () => {
        await page.keyboard.press('3');
        await expectView(page, 'Полный дифф');

        await page.keyboard.press('1');
        await expectView(page, 'Обзор');

        await page.keyboard.press('2');
        await expectView(page, 'Маршрут');
    });

    await test.step('аккорды g o / g r / g d ведут по вью', async () => {
        await page.keyboard.press('g');
        await page.keyboard.press('d');
        await expectView(page, 'Полный дифф');

        await page.keyboard.press('g');
        await page.keyboard.press('o');
        await expectView(page, 'Обзор');

        await page.keyboard.press('g');
        await page.keyboard.press('r');
        await expectView(page, 'Маршрут');
    });

    await test.step('аккорд отменяется истёкшим окном и чужой клавишей', async () => {
        // Секунда ожидания вышла: `d` больше не вторая клавиша аккорда, а переключатель режима.
        await page.keyboard.press('g');
        await page.waitForTimeout(1300);
        await page.keyboard.press('3');
        await expectView(page, 'Полный дифф');
        await page.keyboard.press('2');
        await expectView(page, 'Маршрут');

        // Чужая клавиша отменяет аккорд и работает сама: `x` сворачивает остановку под фокусом.
        const stop = page.locator('[data-stop="s01"]');
        await stop.scrollIntoViewIfNeeded();
        await focusStop(page, 's01');
        await page.keyboard.press('g');
        await page.keyboard.press('x');
        await expect(stop.locator('.route-collapsed')).toHaveCount(1);
        await expectView(page, 'Маршрут');

        await focusStop(page, 's01');
        await page.keyboard.press('x');
        await expect(stop.locator('.route-collapsed')).toHaveCount(0);
    });

    await test.step('j / k ведут по остановкам маршрута', async () => {
        await scrollRouteToTop(page);

        await page.keyboard.press('j');
        const afterNext = await settledRouteScroll(page);
        expect(afterNext).toBeGreaterThan(0);

        await page.keyboard.press('k');
        expect(await settledRouteScroll(page)).toBeLessThan(afterNext);
    });

    await test.step('n / p ведут по непросмотренным остановкам', async () => {
        await scrollRouteToTop(page);

        await page.keyboard.press('n');
        const afterNext = await settledRouteScroll(page);
        expect(afterNext).toBeGreaterThan(0);

        await page.keyboard.press('p');
        expect(await settledRouteScroll(page)).toBeLessThan(afterNext);
    });

    await test.step('v отмечает остановку под фокусом', async () => {
        const toggle = page.locator('[data-stop="s02"] button.route-stop__viewed');
        await toggle.scrollIntoViewIfNeeded();
        await focusStop(page, 's02');
        await page.keyboard.press('v');
        await expect(toggle).toHaveAttribute('aria-pressed', 'true');

        await focusStop(page, 's02');
        await page.keyboard.press('v');
        await expect(toggle).toHaveAttribute('aria-pressed', 'false');
    });

    await test.step('v отмечает остановку под курсором мыши, без клика', async () => {
        const toggle = page.locator('[data-stop="s03"] button.route-stop__viewed');
        await hover(page.locator('[data-stop="s03"] .route-stop__title'));
        await page.keyboard.press('v');
        await expect(toggle).toHaveAttribute('aria-pressed', 'true');

        // Отметка сворачивает остановку и уводит прокрутку к следующей: наводимся, когда она встала.
        await settledRouteScroll(page);
        await hover(page.locator('[data-stop="s03"] .route-stop__title'));
        await page.keyboard.press('v');
        await expect(toggle).toHaveAttribute('aria-pressed', 'false');
    });

    await test.step('c комментирует строку под фокусом, ⌘⏎ сохраняет черновик', async () => {
        await scrollRouteToTop(page);
        const stop = page.locator('[data-stop="s01"]');
        const line = stop.locator('.diff-row[tabindex="0"]').first();
        await line.scrollIntoViewIfNeeded();
        await line.focus();
        await page.keyboard.press('c');

        const composer = stop.locator('.diff-line-composer');
        await expect(composer).toBeVisible();
        const textbox = stop.getByRole('textbox', { name: 'Новый комментарий' });
        await textbox.fill(DRAFT);
        await page.keyboard.press(`${MOD_KEY}+Enter`);
        await expect(textbox).toHaveCount(0, { timeout: 6_000 });
        await expect(stop.getByText(DRAFT, { exact: true })).toBeVisible();
    });

    await test.step('c комментирует строку под курсором мыши, без клика и фокуса', async () => {
        const stop = page.locator('[data-stop="s01"]');
        const line = stop.locator('.file-card .diff-row[data-key]').nth(1);
        await hover(line);
        await page.keyboard.press('c');

        const composer = stop.locator('.diff-line-composer');
        await expect(composer).toBeVisible();
        await composer.getByRole('button', { name: 'Отмена', exact: true }).click();
        await expect(composer).toHaveCount(0);
    });

    await test.step('r отвечает в тред под курсором мыши, без клика и фокуса', async () => {
        const thread = page
            .locator('[data-stop] .thread')
            .filter({ has: page.getByRole('button', { name: 'Ответить', exact: true }) })
            .first();
        const threadId = await thread.getAttribute('data-thread-id');
        const target = page.locator(`[data-stop] .thread[data-thread-id="${String(threadId)}"]`);
        await hover(target.locator('.thread__row').first());
        await page.keyboard.press('r');

        const reply = target.getByRole('textbox', { name: 'Ответ в тред' });
        await expect(reply).toBeVisible();
        await target.getByRole('button', { name: 'Отмена', exact: true }).click();
        await expect(reply).toHaveCount(0);
    });

    await test.step('r отвечает в тред под фокусом', async () => {
        // Свой неопубликованный черновик отвечать не даёт — берём чужой тред: «Ответить» стоит
        // ссылкой под каждым опубликованным сообщением (SPEC-changes-2026-09-20 §3).
        const repliable = page
            .locator('[data-stop] .thread')
            .filter({ has: page.getByRole('button', { name: 'Ответить', exact: true }) })
            .first();
        await repliable.scrollIntoViewIfNeeded();
        const threadId = await repliable.getAttribute('data-thread-id');
        const thread = page.locator(`[data-stop] .thread[data-thread-id="${String(threadId)}"]`);
        await thread.focus();
        await page.keyboard.press('r');

        const reply = thread.getByRole('textbox', { name: 'Ответ в тред' });
        await expect(reply).toBeVisible();
        await reply.fill(REPLY);
        await page.keyboard.press(`${MOD_KEY}+Enter`);
        await expect(reply).toHaveCount(0, { timeout: 6_000 });
        await expect(thread.getByText(REPLY, { exact: true })).toBeVisible();
    });

    await test.step('f на маршруте открывает палитру в режиме файлов', async () => {
        await page.locator('.route-toolbar').click();
        await page.keyboard.press('f');
        await expect(palette(page)).toBeVisible();
        await expect(palette(page).getByRole('textbox')).toHaveAttribute('placeholder', 'Файл…');

        await page.keyboard.press('Escape');
        await expect(palette(page)).toHaveCount(0);
    });

    await test.step('«Найти файл» из самой палитры не залипает режимом на следующее открытие', async () => {
        await page.keyboard.press(`${MOD_KEY}+KeyK`);
        await palette(page).getByRole('textbox').fill('Найти файл');
        await page.keyboard.press('Enter');
        await expect(palette(page).getByRole('textbox')).toHaveAttribute('placeholder', 'Файл…');

        await page.keyboard.press('Escape');
        await expect(palette(page)).toHaveCount(0);

        await page.keyboard.press(`${MOD_KEY}+KeyK`);
        await expect(palette(page).getByRole('textbox')).not.toHaveAttribute('placeholder', 'Файл…');
        await page.keyboard.press('Escape');
        await expect(palette(page)).toHaveCount(0);
    });

    await test.step('t переключает пресет', async () => {
        await page.keyboard.press('t');
        await expect(page.getByRole('button', { name: 'Полный тур', exact: true })).toHaveAttribute(
            'aria-pressed',
            'true',
        );
        await page.keyboard.press('t');
        await expect(page.getByRole('button', { name: 'Триаж', exact: true })).toHaveAttribute('aria-pressed', 'true');
    });

    await test.step('/ открывает палитру поиском по диффу', async () => {
        await page.keyboard.press('/');
        await expect(palette(page)).toBeVisible();
        await expect(palette(page).getByRole('textbox')).toHaveValue('/');

        await page.keyboard.press('Escape');
        await expect(palette(page)).toHaveCount(0);
    });

    await test.step('? открывает читшит, Esc закрывает', async () => {
        await page.keyboard.press('?');
        const cheatsheet = page.getByRole('dialog', { name: 'Горячие клавиши' });
        await expect(cheatsheet).toBeVisible();
        // Читшит собран из реестра активной области: строки маршрута есть, файловые — нет.
        await expect(cheatsheet).toContainText('Следующая остановка');
        await expect(cheatsheet).not.toContainText('Следующий файл');
        await expect(cheatsheet.locator('kbd').first()).toHaveText('⌘K');

        await page.keyboard.press('Escape');
        await expect(cheatsheet).toHaveCount(0);
    });

    await test.step('a без выделения открывает чат вопросом про PR', async () => {
        await page.keyboard.press('a');
        await expect(page.locator('.chat-panel')).toBeVisible();
        await expect(page.getByRole('textbox', { name: 'Вопрос агенту' })).toBeFocused();

        await page.getByRole('button', { name: 'Закрыть чат', exact: true }).click();
        await expect(page.locator('.chat-panel')).toHaveCount(0);
    });

    await test.step('j / k / n / p ведут по файлам полного диффа', async () => {
        await page.keyboard.press('3');
        await expectView(page, 'Полный дифф');
        await expect(page.locator('.file-card').first()).toBeVisible();
        await scrollDiffToTop(page);

        await page.keyboard.press('j');
        const afterNext = await settledDiffScroll(page);
        expect(afterNext).toBeGreaterThan(0);

        await page.keyboard.press('k');
        expect(await settledDiffScroll(page)).toBeLessThan(afterNext);

        await scrollDiffToTop(page);
        await page.keyboard.press('n');
        const afterUnread = await settledDiffScroll(page);
        expect(afterUnread).toBeGreaterThan(0);

        await page.keyboard.press('p');
        expect(await settledDiffScroll(page)).toBeLessThan(afterUnread);
    });

    await test.step('маркер треда: tab-стоп, Enter и Space, свёрнутый тред уходит из DOM', async () => {
        const marker = page.locator('.file-card .thread-marker').first();
        await marker.scrollIntoViewIfNeeded();
        await expect(marker).toBeVisible();
        const lines = page.locator('.file-card .thread-line');
        // Дефолт — раскрыт у всех, кроме закрытых тредов (docs/decisions.md, 2026-09-21).
        await expect(marker).toHaveAttribute('aria-expanded', 'true');
        const open = await lines.count();
        expect(open).toBeGreaterThan(0);

        await marker.focus();
        await expect(marker).toBeFocused();

        await page.keyboard.press('Enter');
        await expect(marker).toHaveAttribute('aria-expanded', 'false');
        await expect(lines).toHaveCount(open - 1);

        await page.keyboard.press('Space');
        await expect(marker).toHaveAttribute('aria-expanded', 'true');
        await expect(lines).toHaveCount(open);
    });

    await test.step('лестница Esc: палитра поверх выделения, потом само выделение', async () => {
        await scrollDiffToTop(page);
        await dragSelectFirstLines(page);
        await expect(page.locator('.selection-popover__count')).toBeVisible();

        await page.keyboard.press(`${MOD_KEY}+KeyK`);
        await expect(palette(page)).toBeVisible();

        await page.keyboard.press('Escape');
        await expect(palette(page)).toHaveCount(0);
        await expect(page.locator('.selection-popover__count')).toBeVisible();

        await page.keyboard.press('Escape');
        await expect(page.locator('.selection-popover__count')).toHaveCount(0);
    });

    await test.step('d переключает режим диффа', async () => {
        // Тумблер называет режим, в котором дифф нарисован прямо сейчас, — по нему и сверяем.
        const toggle = page.locator('.diff-mode-toggle');
        await expect(toggle).toBeEnabled();
        const before = await toggle.textContent();

        await page.keyboard.press('d');
        await expect.poll(() => toggle.textContent()).not.toBe(before);

        await page.keyboard.press('d');
        await expect.poll(() => toggle.textContent()).toBe(before);
    });

    await test.step('v в дереве отмечает файл под курсором просмотренным', async () => {
        const tree = page.getByRole('tree', { name: 'Дерево файлов' });
        // Машинный файл уже считается просмотренным: `v` на нём сняла бы отметку.
        const row = page.locator('.file-tree__row--file:not(.is-generated)').first();
        await row.click();
        await tree.focus();
        await page.keyboard.press('v');
        await expect(page.locator('.file-tree__row--file.is-cursor .file-tree__read')).toHaveAttribute(
            'aria-pressed',
            'true',
        );
    });

    await test.step('v отмечает карточку файла под курсором мыши, без клика', async () => {
        await scrollDiffToTop(page);
        // Карточка фиксируется по своему файлу: после отметки она выпадет из отбора «непросмотренные».
        const fileId = await page
            .locator('.file-card[data-file]')
            .filter({ has: page.locator('button.file-card__viewed[aria-pressed="false"]') })
            .first()
            .getAttribute('data-file');
        const card = page.locator(`.file-card[data-file="${String(fileId)}"]`);
        await hover(card.locator('.diff-row[data-key]').first());
        await page.keyboard.press('v');

        await expect(card.locator('button.file-card__viewed')).toHaveAttribute('aria-pressed', 'true');
    });

    await test.step('e раскрывает контекст ханка под фокусом', async () => {
        // Отметка файла в прошлом шаге свернула карточку и запустила доводку прокрутки:
        // пока список едет, виртуализатор выбрасывает найденные ряды из DOM.
        await settledDiffScroll(page);
        await scrollDiffToTop(page);
        await settledDiffScroll(page);

        const { file, key, hidden, rowKey } = await findInnerGap(page, 21);
        // Ряд адресуется своим ключом, а не соседством с перемычкой: локатор переживает
        // перерисовку списка, и Playwright на повторе находит актуальный элемент.
        const row = page.locator(`[data-file="${file}"] [data-key="${rowKey}"][tabindex="0"]`).first();
        await row.scrollIntoViewIfNeeded();
        await expect(row).toBeVisible();
        await row.focus();
        await page.keyboard.press('e');

        await expect.poll(() => gapHidden(page, file, key)).toBeLessThan(hidden);
    });

    await test.step('⌘⏎ открывает меню шипа, Esc закрывает', async () => {
        await page.keyboard.press(`${MOD_KEY}+Enter`);
        const menu = page.getByRole('listbox', { name: 'Режим шипа' });
        await expect(menu).toBeVisible();

        await page.keyboard.press('Escape');
        await expect(menu).toHaveCount(0);
    });

    await test.step('⌘⇧⏎ отправляет request changes', async () => {
        await page.keyboard.press(`${MOD_KEY}+Shift+Enter`);
        await expect(page.locator('.review-complete')).toBeVisible({ timeout: 20_000 });
    });
});

test('клавиатура: w переключает фильтр «что нового» на втором заходе', async ({ page, launchSherpa }) => {
    const server = await launchSherpa('fixture-medium');
    const worker = server.worker;

    await page.goto(server.url);
    await page.getByRole('tab', { name: 'Маршрут', exact: true }).click();
    expect((await worker.register('claude-code')).code).toBe(0);
    await buildRoute(worker);
    await expect(page.locator('[data-stop]')).toHaveCount(7);

    await advanceIteration(page, server);
    await page
        .locator('.iteration-banner[aria-label="Маршрут устарел"] button.iteration-banner__action')
        .click();
    await buildRouteV2(worker);
    await expect(page.locator('.route-skeleton-card')).toHaveCount(0);
    await expect(page.locator('[data-stop]')).toHaveCount(7);

    await page.locator('.route-toolbar').click();
    await page.keyboard.press('w');
    await expect(page.locator('.route-toolbar__filters button.route-change-chip')).toHaveText(
        'Показаны изменения с прошлого захода',
    );

    await page.keyboard.press('w');
    await expect(page.locator('.route-toolbar__filters button.route-change-chip')).toHaveCount(0);
});

function palette(page: Page): Locator {
    return page.getByRole('dialog', { name: 'Палитра команд' });
}

async function expectView(page: Page, label: string): Promise<void> {
    await expect(page.getByRole('tab', { name: label, exact: true })).toHaveAttribute('aria-selected', 'true');
}

/**
 * Навести мышь на элемент, не нажимая кнопку: цель команды — то, что под курсором, если мышь
 * двигалась после последней смены фокуса (docs/design/SPEC-elements.md §5). `hover` Playwright сам
 * доводит элемент до видимого места и проверяет, что курсор попал именно в него, — липкий
 * тулбар над целью тест бы не заметил.
 */
async function hover(locator: Locator): Promise<void> {
    await locator.scrollIntoViewIfNeeded();
    await locator.hover();
}

/** Фокус внутрь секции остановки: команды `v`/`x` смотрят на `[data-stop]` под фокусом. */
async function focusStop(page: Page, stopId: string): Promise<void> {
    await page.locator(`[data-stop="${stopId}"] button`).first().focus();
}

function routeScroller(page: Page): Locator {
    return page.locator('.route');
}

async function routeScrollTop(page: Page): Promise<number> {
    return routeScroller(page).evaluate((element) => element.scrollTop);
}

/** Возврат в начало: доводка предыдущего прыжка может тянуть контейнер обратно — повторяем. */
async function scrollRouteToTop(page: Page): Promise<void> {
    await expect
        .poll(async () => {
            await routeScroller(page).evaluate((element) => {
                element.scrollTop = 0;
            });
            return routeScrollTop(page);
        })
        .toBeLessThan(5);
}

/** Прокрутка после прыжка: доводка идёт кадрами, поэтому меряем, когда она встала. */
async function settled(read: () => Promise<number>): Promise<number> {
    let last = Number.NaN;
    for (let attempt = 0; attempt < 50; attempt += 1) {
        const value = await read();
        if (value === last) {
            return value;
        }
        last = value;
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return last;
}

async function settledRouteScroll(page: Page): Promise<number> {
    return settled(() => routeScrollTop(page));
}

async function settledDiffScroll(page: Page): Promise<number> {
    return settled(() => diffScrollTop(page));
}

async function diffScrollTop(page: Page): Promise<number> {
    return page.locator('.full-diff').evaluate((element) => element.scrollTop);
}

async function scrollDiffToTop(page: Page): Promise<void> {
    await expect
        .poll(async () => {
            await page.locator('.full-diff').evaluate((element) => {
                element.scrollTop = 0;
            });
            return diffScrollTop(page);
        })
        .toBeLessThan(5);
}

interface InnerGap {
    /** Ключи перемычек и строк уникальны только внутри файла — адрес всегда пара с ним. */
    readonly file: string;
    readonly key: string;
    readonly hidden: number;
    /** Ключ первой фокусируемой строки под перемычкой — она и попадёт под `e`. */
    readonly rowKey: string;
}

/**
 * Первая видимая внутренняя перемычка с остатком не меньше `minimumHidden` (как в F-спеке
 * контекста) и строка под ней. Список виртуализован и дорисовывается асинхронно, поэтому
 * поиск ждёт, а не читает DOM один раз.
 */
async function findInnerGap(page: Page, minimumHidden: number): Promise<InnerGap> {
    const probe = async (): Promise<InnerGap | null> =>
        page.locator('.full-diff').evaluate((root, minimum) => {
            for (const gap of root.querySelectorAll('.diff-gap[data-edge="inner"]')) {
                const hidden = Number(gap.getAttribute('data-hidden'));
                const file = gap.closest('[data-file]')?.getAttribute('data-file') ?? '';
                if (!(hidden >= minimum) || file === '') {
                    continue;
                }
                for (let node = gap.nextElementSibling; node !== null; node = node.nextElementSibling) {
                    const focusable = node.matches('[tabindex="0"][data-key]')
                        ? node
                        : node.querySelector('[tabindex="0"][data-key]');
                    if (focusable !== null) {
                        return {
                            file,
                            key: gap.getAttribute('data-gap-key') ?? '',
                            hidden,
                            rowKey: focusable.getAttribute('data-key') ?? '',
                        };
                    }
                }
            }
            return null;
        }, minimumHidden);

    await expect
        .poll(async () => (await probe()) !== null, {
            message: `нет видимой перемычки с остатком >= ${String(minimumHidden)}`,
        })
        .toBe(true);
    const found = await probe();
    if (found === null) {
        throw new Error(`перемычка с остатком >= ${String(minimumHidden)} исчезла из DOM`);
    }
    return found;
}

/** Остаток перемычки; исчезнувшая перемычка раскрыта целиком — это ноль, а не отсутствие числа. */
async function gapHidden(page: Page, file: string, key: string): Promise<number> {
    return page
        .locator(`[data-file="${file}"] .diff-gap[data-gap-key="${key}"]`)
        .evaluateAll((elements) => (elements[0] === undefined ? 0 : Number(elements[0].getAttribute('data-hidden'))));
}

/** Протяжка мышью по гаттеру трёх строк одной карточки — как в F2. */
async function dragSelectFirstLines(page: Page): Promise<void> {
    const card = page
        .locator('.file-card')
        .filter({ has: page.locator('.diff-row[data-key]') })
        .first();
    const rows = card.locator('.diff-row[data-key]');
    await rows.nth(0).scrollIntoViewIfNeeded();
    const from = await rows.nth(0).locator('.diff-row__gutter').first().boundingBox();
    const to = await rows.nth(2).locator('.diff-row__gutter').first().boundingBox();
    if (from === null || to === null) {
        throw new Error('строки для выделения не отрисованы');
    }
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 6 });
    await page.mouse.up();
}

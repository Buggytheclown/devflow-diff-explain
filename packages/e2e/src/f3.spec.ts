import type { Page } from '@playwright/test';
import { MEDIUM_DIFF_ID, MEDIUM_DIFF_ID_V2, MEDIUM_HEAD_COMMIT, MEDIUM_HEAD_COMMIT_V2 } from '@sherpa/fixtures';

import { answerChat, buildRoute, buildRouteV2, takeTask } from './route-worker.js';
import type { SherpaServerHandle } from './sherpa-fixture.js';
import {
    advanceIteration,
    diffOf,
    expect,
    fragmentParam,
    progressOf,
    sherpaAuth,
    test,
} from './sherpa-fixture.js';

/**
 * F3 (docs/product.md §7): автор дослал коммит, пока ревьюер читал. Маршрут честно объявляет себя
 * устаревшим, перестройка переносит прогресс, «что нового» показывает три пересобранные
 * остановки, заметки переезжают вместе с кодом (а одна честно теряет якорь), а разговор
 * на переписанных строках остаётся читаемым на старом коммите.
 *
 * Живая стыковка UI с сервером на фикстурах: две полные
 * генерации маршрута и три обмена чата через бандл CLI в штатные 120 с не укладываются.
 */
test.setTimeout(240_000);

const V1_SHORT = MEDIUM_HEAD_COMMIT.slice(0, 7);
const V2_SHORT = MEDIUM_HEAD_COMMIT_V2.slice(0, 7);

const EDIT_WINDOW = 'services/orders/src/domain/edit-window.ts';
const HANDLERS = 'services/orders/src/api/handlers.ts';

/**
 * Три вопроса с якорями. Первые два стоят в файле, которого второй пуш не касается, — их
 * заметки переезжают на новую итерацию с нулевым сдвигом. Третий стоит ровно на строках,
 * которые пуш переписал: у его заметки якоря на новой итерации нет.
 */
const QUESTIONS = [
    {
        path: EDIT_WINDOW,
        start: 24,
        end: 32,
        label: 'edit-window.ts:24–32',
        text: 'Почему окно закрывается диспатчем раньше дедлайна?',
        answer: 'Диспатч курьера закрывает окно даже внутри тридцати минут: заказ уже собран, менять состав поздно.',
    },
    {
        path: EDIT_WINDOW,
        start: 29,
        end: 38,
        label: 'edit-window.ts:29–38',
        text: 'Что вернёт remainingMs для закрытого окна?',
        answer: 'Для закрытого окна `remainingMs` возвращает ноль: состояние проверяется до вычитания времени.',
    },
    {
        path: HANDLERS,
        start: 48,
        end: 54,
        label: 'handlers.ts:48–54',
        text: 'Зачем remainingMs уходит в тело отказа на 409?',
        answer: 'Клиент показывает обратный отсчёт, поэтому остаток времени едет вместе с кодом отказа.',
    },
] as const;

/** Остановки, которые ревьюер отмечает до пуша: три пуш не трогает, s02 — трогает. */
const MARKED_STOPS = ['s01', 's02', 's04', 's05'] as const;
/** Их пуш пересобирает: 02 и 03 изменились, 06 собран заново (`route-medium-v2`). */
const CHANGED_STOPS = ['s02', 's03', 's06'] as const;
/** Тред, который модель назвала причиной изменения остановки 03. */
const CHANGE_THREAD = '4820242';
/** Бот-тред на `payments/card-token.ts` — файл ушёл из PR со вторым пушем. */
const DEPARTED_THREAD = '4820260';

test('F3: пуш во время чтения → маршрут устарел → перестройка с переносом прогресса и заметок', async ({
    page,
    launchSherpa,
}) => {
    const server = await launchSherpa('fixture-medium');
    const worker = server.worker;

    await test.step('маршрут первого захода построен на итерации 9f3c1ab', async () => {
        await page.goto(server.url);
        await page.getByRole('tab', { name: 'Маршрут', exact: true }).click();
        expect((await worker.register('claude-code')).code).toBe(0);
        await buildRoute(worker);

        await expect(page.locator('.route-skeleton-card')).toHaveCount(0);
        await expect(page.locator('[data-stop]')).toHaveCount(7);
    });

    await test.step('три вопроса с якорями превращаются в три заметки', async () => {
        for (const question of QUESTIONS) {
            const fileId = await fileIdOf(page, server, question.path);
            const asked = await page.request.post(new URL('/api/ui/review/chat/ask', server.url).href, {
                headers: sherpaAuth(server),
                data: {
                    text: question.text,
                    anchor: {
                        fileId,
                        path: question.path,
                        side: 'new',
                        start: question.start,
                        end: question.end,
                    },
                },
            });
            expect(asked.status(), await asked.text()).toBe(200);

            const task = await takeTask(worker, 'chat');
            await answerChat(worker, task.taskId, question.answer);
        }

        await page.locator('.agent-pill').click();
        await expect(page.locator('.chat-panel__notes')).toHaveText('Заметки 3');
        await page.getByRole('button', { name: 'Закрыть чат', exact: true }).click();
    });

    await test.step('ревьюер отмечает просмотренными четыре остановки из семи', async () => {
        for (const stopId of MARKED_STOPS) {
            const toggle = page.locator(`[data-stop="${stopId}"] button.route-stop__viewed`);
            await toggle.scrollIntoViewIfNeeded();
            await toggle.click();
            await expect(toggle).toHaveAccessibleName('Просмотрено');
        }
        await expect(page.locator('.coverage__stops')).toHaveText('просмотрено 4 из 7 остановок');
    });

    await test.step('автор пушит: баннер устаревания приезжает по SSE, без перезагрузки', async () => {
        await advanceIteration(page, server);

        const banner = page.locator('.banner-slot .iteration-banner[aria-label="Маршрут устарел"]');
        await expect(banner).toBeVisible();
        // `affectedStopIds` считаются после интердиффа и приезжают вторым уведомлением.
        await expect(banner.locator('.iteration-banner__line')).toHaveText(
            `Маршрут построен для ${V1_SHORT}, PR уже на ${V2_SHORT} — 1 новая итерация; ` +
                'затронуты остановки 02, 03 и 06',
        );
        await expect(banner.locator('button.iteration-banner__action')).toHaveText('Перестроить маршрут');
        await expect(banner.locator('button.iteration-banner__secondary')).toHaveText(
            `Открыть дифф ${V2_SHORT} без маршрута`,
        );

        // До перестройки вкладка живёт на итерации снапшота: дифф не подменяется, якоря
        // остановок не дрейфуют, отметки на месте.
        await expect(page.locator('.route-drift')).toHaveCount(0);
        await expect(page.locator('.coverage__stops')).toHaveText('просмотрено 4 из 7 остановок');

        // Перенос прогресса на новую итерацию идёт асинхронно; перестройка считает по нему.
        await expect
            .poll(async () => (await seenRangeCount(page, server)) > 0, { timeout: 30_000 })
            .toBe(true);
    });

    await test.step('«Перестроить маршрут» — агент сдаёт второй заход', async () => {
        await page.locator('.iteration-banner[aria-label="Маршрут устарел"] button.iteration-banner__action').click();
        await buildRouteV2(worker);

        await expect(page.locator('.route-skeleton-card')).toHaveCount(0);
        await expect(page.locator('[data-stop]')).toHaveCount(7);
    });

    await test.step('баннер второго захода: прогресс перенесён, затронутые остановки сняты', async () => {
        const banner = page.locator('.banner-slot .iteration-banner[aria-label="Маршрут перестроен"]');
        await expect(banner.locator('.iteration-banner__line')).toHaveText(`Маршрут перестроен для ${V2_SHORT}.`);
        await expect(banner.locator('.iteration-banner__note')).toHaveText(
            'Просмотренными остались 3 остановки из 6. ' +
                'Изменились 3 остановки; комментарии на изменившихся диапазонах закреплены за старым коммитом',
        );

        for (const stopId of ['s01', 's04', 's05']) {
            await expect(page.locator(`[data-stop="${stopId}"] button.route-stop__viewed`)).toHaveAttribute(
                'aria-pressed',
                'true',
            );
        }
        for (const stopId of CHANGED_STOPS) {
            await expect(page.locator(`[data-stop="${stopId}"] button.route-stop__viewed`)).toHaveAttribute(
                'aria-pressed',
                'false',
            );
        }
        await expect(page.locator('.coverage__stops')).toHaveText('просмотрено 3 из 7 остановок');
        // Дифф перечитан на новой итерации: якоря второго захода снова ложатся на её код.
        await expect(page.locator('.coverage__legend-text')).toHaveText(
            '877 изменённых строк · 94% объяснено · 47 строк не объяснено',
        );
        // Колонка диффа далёкой остановки снята с DOM: смотрим на неотмеченную
        // остановку, подъехав к ней, — карточки возвращаются рядом с экраном.
        const changed = page.locator(`[data-stop="${CHANGED_STOPS[0]}"]`);
        await changed.scrollIntoViewIfNeeded();
        await expect(changed.locator('.file-card[data-file]').first()).toBeVisible();
    });

    await test.step('«Что нового с прошлого захода» оставляет на экране три остановки', async () => {
        // Верхняя остановка экрана переживает фильтр с пометкой (docs/design/SPEC-elements.md §2.7): чтобы это была
        // именно 01, маршрут прокручивается к самому началу — автоотметки увели его к своей следующей.
        // Прокрутка именно в ноль, а не «показать 01»: доводка до видимости зависит от высоты
        // колонки остановки, и на длинном описании верхней оказывалась уже 02.
        await page.locator('#view-route').evaluate((element) => {
            element.scrollTop = 0;
        });
        await page
            .locator('.iteration-banner[aria-label="Маршрут перестроен"] button.iteration-banner__action')
            .click();

        await expect.poll(() => fragmentParam(page, 'routeFilter')).toBe('new');
        await expect(page.locator('.route-toolbar__filters button.route-change-chip')).toHaveText(
            'Показаны изменения с прошлого захода',
        );
        await expect(page.locator('section.route-stop[data-stop-change]')).toHaveCount(3);
        await expect(page.locator('[data-stop="s01"] .route-stop__kept')).toHaveText(
            'оставлена на экране — вне текущего фильтра',
        );
        for (const stopId of ['s04', 's05', 'other']) {
            await expect(page.locator(`[data-stop="${stopId}"]`)).toHaveCount(0);
        }

        await expect(page.locator('[data-stop="s02"] .route-stop__badge--changed')).toHaveText('изменилась');
        await expect(page.locator('[data-stop="s03"] .route-stop__badge--changed')).toHaveText('изменилась');
        await expect(page.locator('[data-stop="s06"] .route-stop__badge--new')).toHaveText('новая');
    });

    await test.step('у остановки 03 объяснение причины ведёт в тред, который её вызвал', async () => {
        const change = page.locator('[data-stop="s03"] .route-stop__change');
        await expect(change.locator('.route-stop__change-label')).toHaveText('почему изменилась остановка');
        await expect(change.locator('.route-stop__change-body')).toContainText(
            'остаток времени уехал в api/rejection-status.ts',
        );

        const link = change.locator('button.route-stop__change-thread');
        await expect(link).toHaveText('тред у строки 49');
        await link.click();

        await expect(page.getByRole('tab', { name: 'Полный дифф', exact: true })).toHaveAttribute(
            'aria-selected',
            'true',
        );
        await expect.poll(() => fragmentParam(page, 'thread')).toBe(CHANGE_THREAD);
        await expect(page.locator(`#thread-${CHANGE_THREAD}`)).toBeVisible();
    });

    await test.step('заметки: две переехали с кодом, третья честно потеряла якорь', async () => {
        await page.getByRole('tab', { name: 'Маршрут', exact: true }).click();
        await page.locator('.route-toolbar__filters button.route-change-chip').click();
        await expect(page.locator('.route-toolbar__filters')).toHaveCount(0);

        await page.locator('.agent-pill').click();
        const panel = page.locator('aside.chat-panel[aria-label="Чат с агентом"]');
        await expect(panel.locator('.chat-panel__notes')).toHaveText('Заметки 3');
        // `edit-window.ts` пуш не трогал: якоря переехали на новую итерацию с нулевым сдвигом,
        // и переход из чата к заметке доступен.
        for (const question of QUESTIONS.filter((entry) => entry.path === EDIT_WINDOW)) {
            const note = panel.locator('button.chat-message__note', { hasText: question.label });
            await expect(note).toHaveText(`◆ Закреплено заметкой у ${question.label}`);
            await expect(note).toBeEnabled();
        }
        await expect(panel.locator('span.chat-message__note-lost')).toHaveText(
            'якорь потерян после пуша · handlers.ts:48–54',
        );
        const lost = panel.locator('button.chat-message__note', { hasText: 'handlers.ts' });
        await expect(lost).toBeDisabled();
        await expect(lost).toHaveAttribute('title', 'якорь потерян — в коде этой итерации заметки нет');
    });

    await test.step('баннер потерянных заметок стоит под баннером второго захода', async () => {
        const more = page.locator('.banner-slot button.banner-slot__more');
        await expect(more).toHaveText('+1 уведомление');
        await more.click();

        const banner = page.locator('.banner-slot .iteration-banner[aria-label="Заметки потеряли якорь"]');
        await expect(banner.locator('.iteration-banner__line')).toHaveText(
            '1 заметка потеряла якорь после нового пуша',
        );
        await expect(banner.locator('button.iteration-banner__action')).toHaveText('Показать');
    });

    await test.step('устаревший тред читается на своём коммите и возвращается к текущему', async () => {
        await page.getByRole('tab', { name: 'Полный дифф', exact: true }).click();
        const thread = page.locator(`#thread-${CHANGE_THREAD}`);
        await thread.scrollIntoViewIfNeeded();
        await expect(thread.locator('span.thread__chip--pinned')).toHaveText(`закреплён за ${V1_SHORT}`);
        await expect(thread.locator('span.thread__chip--pinned')).toHaveAttribute('title', MEDIUM_HEAD_COMMIT);

        await thread.locator('button.thread__pin-action').click();

        await expect.poll(() => fragmentParam(page, 'diff')).toBe(MEDIUM_DIFF_ID);
        await expect.poll(() => fragmentParam(page, 'thread')).toBe(CHANGE_THREAD);
        const readOnly = page.locator('.banner-slot .iteration-banner[aria-label="Только чтение"]');
        await expect(readOnly.locator('.iteration-banner__line')).toHaveText(
            new RegExp(`^Вы смотрите прошлую итерацию ${V1_SHORT} · .+ · только чтение$`),
        );
        await expect(page.locator(`#thread-${CHANGE_THREAD}`)).toBeVisible();
        // Отметки живут в активной итерации: в прошлой контрол виден, но не нажимается.
        const viewed = page.locator('.file-card button.viewed-toggle').first();
        await expect(viewed).toBeDisabled();
        await expect(viewed).toHaveAttribute('title', 'только в активной итерации');
        // Карандаш выключен, но остаётся спрятанным до ховера: глобальное приглушение `[disabled]`
        // не должно раскрывать его в каждой строке.
        const pencilRow = page.locator('.diff-row:has(.diff-row__comment)').first();
        const pencil = pencilRow.locator('.diff-row__comment');
        await expect(pencil).toBeDisabled();
        await expect(pencil).toHaveCSS('opacity', '0');
        await pencilRow.hover();
        await expect(pencil).toHaveCSS('opacity', '0.45');
        await expect(pencil).toHaveAttribute('title', 'только в активной итерации');
        await page.mouse.move(0, 0);

        await readOnly.locator('button.iteration-banner__action').click();
        await expect.poll(() => fragmentParam(page, 'diff')).toBeNull();
        await expect(readOnly).toHaveCount(0);
    });

    await test.step('тред с ушедшего из PR файла собран в отдельную группу', async () => {
        // Фильтра источников больше нет (SPEC-changes-2026-09-20 §3): бот-тред виден сразу.
        const outside = page.locator('.thread-outside__toggle');
        await expect(outside).toHaveText('1 тред на файлах, которых больше нет в PR');
        await outside.click();
        await expect(page.locator(`#thread-${DEPARTED_THREAD}`)).toBeVisible();
    });
});

/**
 * Отметки просмотра в окне устаревания: пуш пришёл, маршрут ещё не перестроен, и вкладка
 * продолжает рисовать дифф итерации снапшота. Прогресс в этот момент читается про неё же —
 * иначе отметки на экране гасли бы от каждого события прогресса.
 *
 * Три файла, которых второй пуш не касался: отмечен до пуша, отмечен в окне и отмечен мимо UI
 * (чужая запись — ею и заводится перечитка прогресса во вкладке).
 */
const BEFORE_PUSH = EDIT_WINDOW;
const IN_WINDOW = 'services/orders/src/domain/order.ts';
const OUTSIDE_UI = 'services/orders/src/api/schemas.ts';

test('F3: отметки просмотра переживают новую итерацию без перезагрузки вкладки', async ({
    page,
    launchSherpa,
}) => {
    const server = await launchSherpa('fixture-medium');
    const worker = server.worker;

    await test.step('маршрут первого захода построен, открыт полный дифф итерации 9f3c1ab', async () => {
        await page.goto(server.url);
        await page.getByRole('tab', { name: 'Маршрут', exact: true }).click();
        expect((await worker.register('claude-code')).code).toBe(0);
        await buildRoute(worker);
        await expect(page.locator('[data-stop]')).toHaveCount(7);

        await page.getByRole('tab', { name: 'Полный дифф', exact: true }).click();
    });

    const v1 = new Map((await diffOf(page, server)).map((file) => [file.path, file.fileId]));

    await test.step('файл отмечен просмотренным до пуша', async () => {
        await markViewed(page, BEFORE_PUSH, v1.get(BEFORE_PUSH) ?? '');
    });

    await test.step('пуш: отметка остаётся на экране без перезагрузки вкладки', async () => {
        await advanceIteration(page, server);
        await expect(page.locator('.banner-slot .iteration-banner[aria-label="Маршрут устарел"]')).toBeVisible();

        await expectViewed(page, BEFORE_PUSH, v1.get(BEFORE_PUSH) ?? '');
    });

    await test.step('отметка в окне устаревания не откатывается чужим событием прогресса', async () => {
        // Перенос прогресса на новую итерацию идёт асинхронно: дожидаемся его, иначе отметка
        // окна уехала бы вместе с ним и проверять было бы нечего.
        const carried = new Map((await diffOf(page, server, MEDIUM_DIFF_ID_V2)).map((f) => [f.path, f.fileId]));
        await expect
            .poll(async () => viewedFileIds(await progressOf(page, server, MEDIUM_DIFF_ID_V2)), { timeout: 30_000 })
            .toContain(carried.get(BEFORE_PUSH) ?? '');

        await markViewed(page, IN_WINDOW, v1.get(IN_WINDOW) ?? '');

        // Чужая запись двигает ревизию прогресса — вкладка перечитывает снимок по SSE.
        const written = await page.request.post(new URL('/api/ui/review/file-viewed', server.url).href, {
            headers: sherpaAuth(server),
            data: { fileId: v1.get(OUTSIDE_UI) ?? '', viewed: true },
        });
        expect(written.status(), await written.text()).toBe(200);

        for (const path of [OUTSIDE_UI, IN_WINDOW, BEFORE_PUSH]) {
            await expectViewed(page, path, v1.get(path) ?? '');
        }
    });

    await test.step('перестройка маршрута: отметки переезжают на новую итерацию', async () => {
        await page.locator('.iteration-banner[aria-label="Маршрут устарел"] button.iteration-banner__action').click();
        await buildRouteV2(worker);
        // Снапшот переехал на новую итерацию: баннер устаревания ушёл, и вкладка перечитала дифф.
        await expect(page.locator('.iteration-banner[aria-label="Маршрут устарел"]')).toHaveCount(0);

        await page.getByRole('tab', { name: 'Полный дифф', exact: true }).click();
        const v2 = new Map((await diffOf(page, server)).map((file) => [file.path, file.fileId]));
        for (const path of [BEFORE_PUSH, IN_WINDOW, OUTSIDE_UI]) {
            await expectViewed(page, path, v2.get(path) ?? '');
        }
    });
});

/** Коробка «просмотрено» в шапке карточки файла. */
function viewedToggle(page: Page, fileId: string) {
    return page.locator(`.file-card[data-file="${fileId}"] button.file-card__viewed`);
}

/**
 * Довести полный дифф до файла: карточки виртуализированы, и надеяться, что нужная сама
 * окажется в DOM, нельзя — до неё доводит дерево файлов.
 */
async function openFile(page: Page, path: string): Promise<void> {
    const search = page.locator('.file-panel__input');
    await search.fill(path.split('/').at(-1) ?? path);
    // Путь файла — в `title` строки дерева, перед состоянием просмотра (SPEC-theming §6a).
    await page.locator(`.file-tree__row--file[title^="${path} · "]`).first().click();
    await search.fill('');
    await expect(page.locator(`.file-card[data-file]`).first()).toBeVisible();
}

async function markViewed(page: Page, path: string, fileId: string): Promise<void> {
    await openFile(page, path);
    await viewedToggle(page, fileId).click();
    await expect(viewedToggle(page, fileId)).toHaveAttribute('aria-pressed', 'true');
}

async function expectViewed(page: Page, path: string, fileId: string): Promise<void> {
    await openFile(page, path);
    await expect(viewedToggle(page, fileId)).toHaveAttribute('aria-pressed', 'true');
}

/** Файлы итерации с ручной отметкой «просмотрено». */
function viewedFileIds(progress: { readonly files: readonly { fileId: string; viewed: boolean | null }[] }): string[] {
    return progress.files.filter((file) => file.viewed === true).map((file) => file.fileId);
}

/** `fileId` файла в активной итерации: якорь вопроса адресует файл именно им (контракт чата). */
async function fileIdOf(page: Page, server: SherpaServerHandle, path: string): Promise<string> {
    const file = (await diffOf(page, server)).find((entry) => entry.path === path);
    if (file === undefined) {
        throw new Error(`в активной итерации нет файла ${path}`);
    }
    return file.fileId;
}

/** Сколько диапазонов прочитанного лежит на активной итерации: по ним видно, что перенос дошёл. */
async function seenRangeCount(page: Page, server: SherpaServerHandle): Promise<number> {
    const { files } = await progressOf(page, server);
    return files.reduce((total, file) => total + file.seenRanges.length, 0);
}

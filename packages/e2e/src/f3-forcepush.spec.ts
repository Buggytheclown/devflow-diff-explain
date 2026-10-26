import type { Page } from '@playwright/test';
import {
    MEDIUM_DIFF_ID,
    MEDIUM_DIFF_ID_V2,
    MEDIUM_DIFF_ID_V3,
    MEDIUM_HEAD_COMMIT,
    MEDIUM_HEAD_COMMIT_V2,
    MEDIUM_HEAD_COMMIT_V3,
} from '@sherpa/fixtures';

import { buildRoute, buildRouteV2 } from './route-worker.js';
import type { SherpaServerHandle } from './sherpa-fixture.js';
import {
    advanceIteration,
    diffOf,
    expect,
    fragmentParam,
    progressOf,
    seenRangeKeys,
    test,
} from './sherpa-fixture.js';

/**
 * F3, продолжение: второй пуш переписал первый — force-push. Итерация, на которой
 * построен маршрут, у хоста исчезает, и всё, что о ней знает Шерпа, — сохранённый локально
 * патч: маршрут по-прежнему читается, прогресс переезжает через голову исчезнувшей итерации,
 * а Shift+клик по ней срез не строит. После перестройки её снапшот уходит в режим чтения —
 * с пометкой, что коммита в PR больше нет.
 *
 * Живая стыковка через бандл CLI: две генерации маршрута в штатные 120 с не укладываются.
 */
test.setTimeout(240_000);

const V1_SHORT = MEDIUM_HEAD_COMMIT.slice(0, 7);
const V2_SHORT = MEDIUM_HEAD_COMMIT_V2.slice(0, 7);
const V3_SHORT = MEDIUM_HEAD_COMMIT_V3.slice(0, 7);

/** Остановки, которые ревьюер отмечает на первой итерации: s02 пуш трогает, остальные — нет. */
const MARKED_STOPS = ['s01', 's02', 's04', 's05'] as const;

/** Единственный файл, который переписал force-push: только его строки едут иначе, чем до него. */
const README = 'services/orders/README.md';

/** Прочитанные куски всех файлов, кроме переписанного force-push'ем. */
function outsideReadme(keys: readonly string[]): string[] {
    return keys.filter((key) => !key.startsWith(`${README}:`));
}

/**
 * Файлы среза v1 → v3 в порядке дерева (так их показывает UI): `SLICE_V1_V2` плюс README,
 * который переписал force-push.
 */
const SLICE_V1_V3_PATHS = [
    'services/orders/src/api/handlers.ts',
    'services/orders/src/api/rejection-status.ts',
    'services/orders/src/domain/policies/edit-policy.ts',
    'services/orders/src/payments/card-token.ts',
    README,
    'pnpm-lock.yaml',
];

test('F3 force-push: итерация маршрута исчезла — маршрут читается, прогресс едет через её голову', async ({
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

    await test.step('ревьюер отмечает просмотренными четыре остановки из семи', async () => {
        for (const stopId of MARKED_STOPS) {
            const toggle = page.locator(`[data-stop="${stopId}"] button.route-stop__viewed`);
            await toggle.scrollIntoViewIfNeeded();
            await toggle.click();
            await expect(toggle).toHaveAccessibleName('Просмотрено');
        }
        await expect(page.locator('.coverage__stops')).toHaveText('просмотрено 4 из 7 остановок');
    });

    let carriedToV2: string[] = [];
    await test.step('первый пуш: маршрут устарел, прогресс переехал на a71d4e2', async () => {
        await advanceIteration(page, server);

        const banner = page.locator('.banner-slot .iteration-banner[aria-label="Маршрут устарел"]');
        await expect(banner.locator('.iteration-banner__line')).toHaveText(
            `Маршрут построен для ${V1_SHORT}, PR уже на ${V2_SHORT} — 1 новая итерация; ` +
                'затронуты остановки 02, 03 и 06',
        );

        // Перенос идёт после того, как сервер добыл и сохранил патч новой итерации: дождаться
        // его обязательно — второй пуш до этого не оставил бы v2 в хранилище вовсе.
        await expect
            .poll(async () => (await seenRangeKeys(page, server, MEDIUM_DIFF_ID_V2)).length, { timeout: 30_000 })
            .toBeGreaterThan(0);
        carriedToV2 = await seenRangeKeys(page, server, MEDIUM_DIFF_ID_V2);
    });

    let markedOnV2: string[] = [];
    await test.step('перестройка на a71d4e2 и ещё одна отметка — уже на самой второй итерации', async () => {
        await page.locator('.iteration-banner[aria-label="Маршрут устарел"] button.iteration-banner__action').click();
        await buildRouteV2(worker);
        await expect(page.locator('.route-skeleton-card')).toHaveCount(0);
        await expect(page.locator('.coverage__stops')).toHaveText('просмотрено 3 из 7 остановок');

        const toggle = page.locator('[data-stop="s02"] button.route-stop__viewed');
        await toggle.scrollIntoViewIfNeeded();
        await toggle.click();
        await expect(toggle).toHaveAccessibleName('Просмотрено');
        await expect(page.locator('.coverage__stops')).toHaveText('просмотрено 4 из 7 остановок');

        const afterMark = await seenRangeKeys(page, server, MEDIUM_DIFF_ID_V2);
        markedOnV2 = afterMark.filter((key) => !carriedToV2.includes(key));
        expect(markedOnV2.length, 'отметка s02 обязана дописать диапазоны самой второй итерации').toBeGreaterThan(0);
    });

    await test.step('force-push: баннер называет обе стороны и молчит про остановки', async () => {
        await advanceIteration(page, server);

        const banner = page.locator('.banner-slot .iteration-banner[aria-label="Маршрут устарел"]');
        await expect(banner).toBeVisible();
        // Затронутые остановки считаются срезом a71d4e2 → c4f9b17, а этой итерации у хоста
        // больше нет: отказ окончательный, и список остановок в баннере не появится никогда.
        await expect(banner.locator('.iteration-banner__line')).toHaveText(
            `Маршрут построен для ${V2_SHORT}, PR уже на ${V3_SHORT} — 1 новая итерация`,
        );
        await expect(banner.locator('button.iteration-banner__secondary')).toHaveText(
            `Открыть дифф ${V3_SHORT} без маршрута`,
        );
    });

    await test.step('пикер: снапшот исчезнувшей итерации на месте, раздела срезов нет, внизу подсказка про Shift+клик', async () => {
        await page.locator('button.snapshot-pill--button[aria-haspopup="menu"]').click();
        const menu = page.locator('[role="menu"][aria-label="Снапшоты и итерации"]');
        await expect(menu.locator('.snapshot-picker__section')).toHaveText(['Снапшоты и итерации']);
        await expect(menu.locator('.snapshot-picker__hint')).toHaveText('Shift+клик по двум итерациям — срез между ними');

        // Первой строкой — активная итерация, даже без маршрута: её ревьюер ищет первой.
        await expect(menu.locator('.snapshot-picker__row').first()).toHaveText(
            `${V3_SHORT} · активная итерация · без маршрута`,
        );

        // Снапшот второго захода остаётся текущим маршрутом PR: его итерацию смёл force-push,
        // но перестраивать маршрут ревьюер не обязан — и до перестройки читает именно его.
        // PR ушёл вперёд, поэтому строка меню, как и индикатор, говорит «устарел».
        const snapshots = menu.locator('.snapshot-picker__row[data-snapshot]');
        await expect(snapshots).toHaveCount(2);
        await expect(snapshots.nth(0)).toHaveText(new RegExp(`^${V2_SHORT} · .* · устарел$`));
        await expect(snapshots.nth(0)).toHaveAttribute('aria-checked', 'true');
        await expect(snapshots.nth(1)).toHaveText(new RegExp(`^${V1_SHORT} · .* · устарел$`));

        await page.keyboard.press('Escape');
        await expect(menu).toHaveCount(0);
    });

    await test.step('маршрут исчезнувшей итерации читается: её патч лежит у сервера', async () => {
        await expect(page.locator('[data-stop]')).toHaveCount(7);
        await expect(page.locator('.file-card[data-file]').first()).toBeVisible();
        await expect(page.locator('.coverage__stops')).toHaveText('просмотрено 4 из 7 остановок');

        // Хост итерацию уже не отдаёт: дифф приходит из локального хранилища патчей
        // (docs/product.md §4a).
        const stored = await diffOf(page, server, MEDIUM_DIFF_ID_V2);
        expect(stored.length).toBeGreaterThan(0);
    });

    await test.step('прогресс переехал на c4f9b17 с первой итерации, а не с исчезнувшей', async () => {
        await expect
            .poll(async () => (await seenRangeKeys(page, server, MEDIUM_DIFF_ID_V3)).length, { timeout: 30_000 })
            .toBeGreaterThan(0);

        // Источник переноса — самая свежая итерация с прогрессом, то есть a71d4e2; срез с ней
        // хост отвергает окончательно, и перенос отступает к 9f3c1ab.
        // Отметки, сделанные на самой a71d4e2, при этом теряются — это цена force-push.
        const carriedToV3 = await seenRangeKeys(page, server, MEDIUM_DIFF_ID_V3);
        expect(outsideReadme(carriedToV3)).toEqual(outsideReadme(carriedToV2));
        for (const key of markedOnV2) {
            expect(carriedToV3, 'отметка второй итерации на третью не переезжает').not.toContain(key);
        }
        // Перенос считался по срезу 9f3c1ab → c4f9b17, а он включает и правку force-push:
        // прочитанный кусок README 43–52 разошёлся вокруг дописанной ею строки.
        expect(carriedToV3.filter((key) => key.startsWith(`${README}:new`))).toEqual([
            `${README}:new:25-27`,
            `${README}:new:43-47`,
            `${README}:new:50-53`,
        ]);
        expect(carriedToV2).toContain(`${README}:new:43-52`);

        // Отметки остановок ключуются снапшотом: маршрут на c4f9b17 не перестраивали, и текущий
        // снапшот по-прежнему a71d4e2 — его отметки и отдаются обеим итерациям. Спросить про
        // активную — то же самое, что спросить без параметра: вкладка на ней и рисует этот маршрут.
        const marked = [
            { stopId: 's01', viewed: true },
            { stopId: 's02', viewed: true },
            { stopId: 's04', viewed: true },
            { stopId: 's05', viewed: true },
        ];
        expect((await progressOf(page, server, MEDIUM_DIFF_ID_V3)).stops).toEqual(marked);
        expect((await progressOf(page, server)).stops).toEqual(marked);
        expect((await progressOf(page, server, MEDIUM_DIFF_ID_V2)).stops).toEqual(marked);
    });
});

test('F3 force-push: срез 9f3c1ab → c4f9b17 показывает изменения через голову исчезнувшей итерации', async ({
    page,
    launchSherpa,
}) => {
    const server = await launchSherpa('fixture-medium');
    const worker = server.worker;

    await test.step('маршрут построен на 9f3c1ab, одна остановка отмечена', async () => {
        await page.goto(server.url);
        await page.getByRole('tab', { name: 'Маршрут', exact: true }).click();
        expect((await worker.register('claude-code')).code).toBe(0);
        await buildRoute(worker);
        await expect(page.locator('[data-stop]')).toHaveCount(7);

        const toggle = page.locator('[data-stop="s01"] button.route-stop__viewed');
        await toggle.scrollIntoViewIfNeeded();
        await toggle.click();
        await expect(toggle).toHaveAccessibleName('Просмотрено');
    });

    await test.step('два пуша подряд: второй переписал первый', async () => {
        await advanceIteration(page, server);
        // Патч второй итерации обязан осесть в хранилище до force-push: иначе сервер о ней
        // вовсе не узнает и `gone` ставить будет нечему.
        await expect
            .poll(async () => (await seenRangeKeys(page, server, MEDIUM_DIFF_ID_V2)).length, { timeout: 30_000 })
            .toBeGreaterThan(0);

        await advanceIteration(page, server);
        await expect(
            page.locator('.banner-slot .iteration-banner[aria-label="Маршрут устарел"] .iteration-banner__line'),
        ).toHaveText(
            `Маршрут построен для ${V1_SHORT}, PR уже на ${V3_SHORT} — 1 новая итерация; ` +
                'затронуты остановки 02, 03, 05 и 06',
        );
    });

    await test.step('исчезнувшая итерация в пикере есть, срез от первой до активной — Shift+клик по первой, клик по активной', async () => {
        await page.locator('button.snapshot-pill--button[aria-haspopup="menu"]').click();
        const menu = page.locator('[role="menu"][aria-label="Снапшоты и итерации"]');
        await expect(menu.locator(`.snapshot-picker__row[data-diff="${MEDIUM_DIFF_ID_V2}"]`)).toHaveText(
            `${V2_SHORT} · коммита больше нет в PR · без маршрута`,
        );

        // Вкладка смотрит снапшот первой итерации — он отмечен галкой и становится базой среза.
        // Ушедшую итерацию Арканум не сравнивает: Shift+клик по ней открыл бы просто итерацию.
        await menu.locator('.snapshot-picker__row[aria-checked="true"]').click({ modifiers: ['Shift'] });
        await menu.locator(`.snapshot-picker__row[data-diff="${MEDIUM_DIFF_ID_V3}"]`).click();
        await expect.poll(() => fragmentParam(page, 'base')).toBe(MEDIUM_DIFF_ID);
        await expect.poll(() => fragmentParam(page, 'head')).toBe(MEDIUM_DIFF_ID_V3);
    });

    await test.step('вкладка «Маршрут» объясняет, что для среза маршрут не строится', async () => {
        // Экран среза без маршрута рисуется вместо всей рабочей области: ни шапки с индикатором,
        // ни слота баннеров у него нет — только объяснение и выход в читалку.
        const empty = page.locator('main.route-empty#view-route');
        await expect(empty.locator('.invitation-card__title')).toHaveText('Для среза маршрут не строится');
        await expect(empty.locator('button.invitation-card__primary')).toHaveText('К полному диффу');
        await empty.locator('button.invitation-card__primary').click();
    });

    await test.step('в читалке срез объявлен индикатором, баннером и файлами интердиффа', async () => {
        await expect(page.getByRole('tab', { name: 'Полный дифф', exact: true })).toHaveAttribute(
            'aria-selected',
            'true',
        );
        await expect(page.locator('button.snapshot-pill--button')).toHaveText(`срез ${V1_SHORT} → ${V3_SHORT}`);
        const banner = page.locator('.banner-slot .iteration-banner[aria-label="Только чтение"]');
        await expect(banner.locator('.iteration-banner__line')).toHaveText(
            `Вы смотрите срез между итерациями ${V1_SHORT} → ${V3_SHORT} · только чтение`,
        );
        await expect(banner.locator('button.iteration-banner__action')).toHaveText('К активной итерации');

        // Список карточек виртуализирован: на экране лежит начало среза, а весь его состав
        // называет счётчик фильтра «Все» в панели файлов.
        const visible = await page
            .locator('.file-card .file-card__path')
            .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('title')));
        expect(visible.length).toBeGreaterThan(0);
        expect(SLICE_V1_V3_PATHS.slice(0, visible.length)).toEqual(visible);
        await expect(
            page.locator('.file-panel__chip', { hasText: 'Все' }).locator('.file-panel__chip-count'),
        ).toHaveText(String(SLICE_V1_V3_PATHS.length));

        // README трогал только force-push: в срезе через голову исчезнувшей итерации он есть.
        // Путь файла живёт в `title` строки: в подписи стоит одно имя (SPEC-theming §6a).
        await page.locator('.file-panel__input').fill('README');
        const readmeRow = page.locator('.file-tree__row--file');
        await expect(readmeRow).toHaveCount(1);
        await expect(readmeRow).toHaveAttribute('title', new RegExp(`^${README.replaceAll('.', String.raw`\.`)} · `));
        await page.locator('.file-panel__input').fill('');
    });

    await test.step('вкладка «Обзор» объясняет, что для среза обзор не собирается', async () => {
        await page.getByRole('tab', { name: 'Обзор', exact: true }).click();
        const empty = page.locator('main.route-empty#view-overview');
        await expect(empty.locator('.invitation-card__title')).toHaveText('Для среза обзор не собирается');
        await empty.locator('button.invitation-card__primary').click();
    });

    await test.step('«К активной итерации» возвращает вкладку на c4f9b17', async () => {
        await page
            .locator('.banner-slot .iteration-banner[aria-label="Только чтение"] button.iteration-banner__action')
            .click();

        await expect.poll(() => fragmentParam(page, 'base')).toBeNull();
        await expect.poll(() => fragmentParam(page, 'head')).toBeNull();
        await expect(page.locator('.banner-slot .iteration-banner[aria-label="Только чтение"]')).toHaveCount(0);
        await expect(page.locator('button.snapshot-pill--button')).toHaveText(`снапшот ${V1_SHORT} · устарел`);
    });
});

test('F3 force-push: маршрут перестроен на c4f9b17 — снапшот исчезнувшей итерации остаётся только для чтения', async ({
    page,
    launchSherpa,
}) => {
    const server = await launchSherpa('fixture-medium');
    const worker = server.worker;

    await test.step('первый маршрут построен сразу на второй итерации', async () => {
        await page.goto(server.url);
        await page.getByRole('tab', { name: 'Маршрут', exact: true }).click();
        // Маршрута ещё нет, и первый пуш проходит молча: генерация стартует уже на a71d4e2,
        // и весь сценарий укладывается в две генерации вместо трёх.
        await advanceIteration(page, server);
        await waitForActiveIteration(page, server, MEDIUM_DIFF_ID_V2);

        expect((await worker.register('claude-code')).code).toBe(0);
        await buildRouteV2(worker);
        await expect(page.locator('.route-skeleton-card')).toHaveCount(0);
        await expect(page.locator('[data-stop]')).toHaveCount(7);
        await expect(page.locator('button.snapshot-pill--button')).toHaveText(`снапшот ${V2_SHORT} · текущий`);
    });

    await test.step('одна остановка отмечена просмотренной', async () => {
        const toggle = page.locator('[data-stop="s01"] button.route-stop__viewed');
        await toggle.scrollIntoViewIfNeeded();
        await toggle.click();
        await expect(toggle).toHaveAccessibleName('Просмотрено');
        await expect(page.locator('.coverage__stops')).toHaveText('просмотрено 1 из 7 остановок');
    });

    await test.step('force-push стирает итерацию маршрута, и маршрут перестроен на c4f9b17', async () => {
        await advanceIteration(page, server);
        const stale = page.locator('.banner-slot .iteration-banner[aria-label="Маршрут устарел"]');
        await expect(stale.locator('.iteration-banner__line')).toHaveText(
            `Маршрут построен для ${V2_SHORT}, PR уже на ${V3_SHORT} — 1 новая итерация`,
        );

        await stale.locator('button.iteration-banner__action').click();
        // Выводы второго захода валидны и на третьей итерации: force-push переписал только
        // README, а якорей в нём нет — стопы ложатся на те же строки тех же файлов.
        await buildRouteV2(worker);
        await expect(page.locator('.route-skeleton-card')).toHaveCount(0);
        await expect(page.locator('button.snapshot-pill--button')).toHaveText(`снапшот ${V3_SHORT} · текущий`);
    });

    await test.step('в пикере снапшот исчезнувшей итерации помечен «коммита больше нет в PR»', async () => {
        await page.locator('button.snapshot-pill--button[aria-haspopup="menu"]').click();
        const menu = page.locator('[role="menu"][aria-label="Снапшоты и итерации"]');
        const snapshots = menu.locator('.snapshot-picker__row[data-snapshot]');
        await expect(snapshots).toHaveCount(2);
        await expect(snapshots.nth(0)).toHaveText(new RegExp(`^${V3_SHORT} · .* · текущий$`));
        await expect(snapshots.nth(1)).toHaveText(new RegExp(`^${V2_SHORT} · .* · коммита больше нет в PR$`));

        await snapshots.nth(1).click();
        await expect(menu).toHaveCount(0);
    });

    await test.step('снапшот исчезнувшей итерации читается, но не правится', async () => {
        await expect.poll(() => fragmentParam(page, 'snapshot')).not.toBeNull();
        await expect(page.locator('button.snapshot-pill--button')).toHaveText(
            `снапшот ${V2_SHORT} · коммита больше нет в PR`,
        );

        const banner = page.locator('.banner-slot .iteration-banner[aria-label="Только чтение"]');
        await expect(banner.locator('.iteration-banner__line')).toHaveText(
            new RegExp(`^Вы смотрите снапшот ${V2_SHORT} · .+ · только чтение · коммита больше нет в PR$`),
        );

        // Итерации у хоста больше нет: и маршрут, и его дифф собраны из локального патча.
        await expect(page.locator('[data-stop]')).toHaveCount(7);
        await expect(page.locator('.file-card[data-file]').first()).toBeVisible();
        await expect(page.locator('.coverage__stops')).toHaveText('просмотрено 1 из 7 остановок');

        // Отметки живут в активной итерации: в исчезнувшей контрол виден, но не нажимается.
        const toggle = page.locator('[data-stop="s01"] button.route-stop__viewed');
        await expect(toggle).toHaveAccessibleName('Просмотрено');
        await expect(toggle).toBeDisabled();
        await expect(toggle).toHaveAttribute('title', 'только в активной итерации');
    });

    await test.step('«К текущему» возвращает на маршрут активной итерации', async () => {
        const banner = page.locator('.banner-slot .iteration-banner[aria-label="Только чтение"]');
        await expect(banner.locator('button.iteration-banner__action')).toHaveText('К текущему');
        await banner.locator('button.iteration-banner__action').click();

        await expect.poll(() => fragmentParam(page, 'snapshot')).toBeNull();
        await expect(banner).toHaveCount(0);
        await expect(page.locator('button.snapshot-pill--button')).toHaveText(`снапшот ${V3_SHORT} · текущий`);
        await expect(page.locator('[data-stop="s01"] button.route-stop__viewed')).toBeEnabled();
    });
});

/**
 * Ждёт, пока названная итерация станет активной у сервера. Пуш без маршрута вкладке сказать
 * нечем: индикатора снапшота ещё нет, и единственный наблюдаемый признак — `fileId` активного
 * диффа, а они у каждой итерации свои.
 */
async function waitForActiveIteration(page: Page, server: SherpaServerHandle, diffId: string): Promise<void> {
    const expected = (await diffOf(page, server, diffId)).map((file) => file.fileId).toSorted();
    await expect
        .poll(async () => (await diffOf(page, server)).map((file) => file.fileId).toSorted(), { timeout: 30_000 })
        .toEqual(expected);
}

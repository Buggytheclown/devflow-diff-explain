import type { Locator, Page } from '@playwright/test';

import { expect, test } from './sherpa-fixture.js';

const COMMENT = 'E2E: audit retention must stay explicit.';
const SEARCH_TEXT = 'Retention is 13 months';

/** Реестр UI трактует `mod` как Meta или Ctrl; Playwright посылает нативный модификатор платформы. */
const MOD_KEY = process.platform === 'darwin' ? 'Meta' : 'Control';

/**
 * Подписи, по которым спека находит элементы. Словарь UI сюда не импортируется намеренно:
 * тест обязан ломаться, когда подпись изменилась, а не переезжать вместе с ней.
 */
interface Strings {
    readonly overviewTab: string;
    readonly routeTab: string;
    readonly diffTab: string;
    readonly agentDisconnected: string;
    readonly commandBox: string;
    readonly fileTree: string;
    readonly allFiles: string;
    readonly myFiles: string;
    readonly filterFiles: string;
    readonly markViewed: string;
    readonly viewedCollapsed: string;
    readonly viewedToggle: string;
    readonly palette: string;
    readonly commentLine: RegExp;
    readonly newComment: string;
    readonly saveDraft: string;
    readonly draftChip: string;
    readonly draftsCounter: string;
    readonly progressBefore: string;
    readonly progressAfter: string;
    readonly shipped: string;
    readonly publishedBatch: string;
    readonly stopsOrFiles: string;
    readonly diffSeen: RegExp;
    readonly publishedWithReplies: string;
    readonly toFullDiff: string;
    readonly noDrafts: string;
    /** Относительное время меты треда: `Intl` даёт его на языке интерфейса. */
    readonly relativeTime: RegExp;
}

const RU: Strings = {
    overviewTab: 'Обзор',
    routeTab: 'Маршрут',
    diffTab: 'Полный дифф',
    agentDisconnected: 'Агент отключён',
    commandBox: 'Команда запуска Шерпы',
    fileTree: 'Дерево файлов',
    allFiles: 'Все 21',
    myFiles: 'Мои 12',
    filterFiles: 'Фильтр файлов по имени',
    markViewed: 'Отметить просмотренным',
    viewedCollapsed: 'просмотрено',
    viewedToggle: 'Просмотрено',
    palette: 'Палитра команд',
    commentLine: /Комментировать строку \d+/,
    newComment: 'Новый комментарий',
    saveDraft: 'Сохранить черновик',
    draftChip: 'draft',
    draftsCounter: '1 черновик уйдёт при публикации',
    progressBefore: '4 / 21 файлов',
    progressAfter: '5 / 21 файлов',
    shipped: 'Shipped · PR 4821',
    publishedBatch: '1 комментарий опубликован одним пакетом',
    stopsOrFiles: '5 из 21',
    diffSeen: /\d+% из 868 строк/,
    publishedWithReplies: '1 (из них 0 ответов)',
    toFullDiff: 'К полному диффу',
    noDrafts: 'нет неопубликованных комментариев',
    relativeTime: /назад|вчера|только что/u,
};

const EN: Strings = {
    overviewTab: 'Overview',
    routeTab: 'Route',
    diffTab: 'Full diff',
    agentDisconnected: 'Agent disconnected',
    commandBox: 'Sherpa launch command',
    fileTree: 'File tree',
    allFiles: 'All 21',
    myFiles: 'Mine 12',
    filterFiles: 'Filter files by name',
    markViewed: 'Mark viewed',
    viewedCollapsed: 'viewed',
    viewedToggle: 'Viewed',
    palette: 'Command palette',
    commentLine: /Comment on line \d+/,
    newComment: 'New comment',
    saveDraft: 'Save draft',
    draftChip: 'draft',
    draftsCounter: '1 draft goes out when you publish',
    progressBefore: '4 / 21 files',
    progressAfter: '5 / 21 files',
    shipped: 'Shipped · PR 4821',
    publishedBatch: '1 comment published as one batch',
    stopsOrFiles: '5 of 21',
    diffSeen: /\d+% of 868 lines/,
    publishedWithReplies: '1 (0 of them replies)',
    toFullDiff: 'To the full diff',
    noDrafts: 'no unpublished comments',
    relativeTime: /ago|yesterday|just now/u,
};

test.describe('локаль браузера ru-RU', () => {
    test.use({ locale: 'ru-RU' });
    fullReviewSpec('ru', RU);
});

/**
 * Тот же сценарий на английском. Каталог стейта у каждого теста свой, настройка языка в нём
 * дефолтная (`auto`), агента в F5 нет — язык берётся из браузера.
 */
test.describe('локаль браузера en-US', () => {
    test.use({ locale: 'en-US' });
    fullReviewSpec('en', EN);
});

function fullReviewSpec(locale: 'ru' | 'en', s: Strings): void {
    test(`F5: полноценное ревью fixture-medium без агента (${locale})`, async ({ page, launchSherpa }) => {
        // Даты комментариев фикстуры постоянны: локализация не должна зависеть от дня запуска.
        await page.clock.setFixedTime(new Date('2026-08-20T12:00:00.000Z'));
        const server = await launchSherpa('fixture-medium');

        await test.step('читалка и деградация без воркера', async () => {
            await page.goto(server.url);

            await expect(page.locator('html')).toHaveAttribute('lang', locale);
            await expect(page.getByRole('tab', { name: s.overviewTab, exact: true })).toBeVisible();
            await expect(page.getByRole('tab', { name: s.routeTab, exact: true })).toBeVisible();
            await expect(page.getByRole('tab', { name: s.diffTab, exact: true })).toBeVisible();
            await expect(page.getByRole('button', { name: s.agentDisconnected, exact: true })).toBeVisible();
            await expect(page.getByRole('textbox', { name: s.commandBox })).toHaveValue('/sherpa fixture-medium');

            await page.getByRole('tab', { name: s.diffTab, exact: true }).click();
            await expect(page.locator('.full-diff')).toBeVisible();
            await expect(page.getByRole('tree', { name: s.fileTree })).toBeVisible();
            await expect(page.getByRole('button', { name: s.allFiles, exact: true })).toBeVisible();
            await expect(page.locator('.full-diff')).toHaveAttribute('data-shown-files', '21');
            await expect(page.locator('.file-card').first()).toBeVisible();
            await expect(page.locator('.diff-row').first()).toBeVisible();
            // Относительное время меты треда идёт через `Intl` — на языке интерфейса.
            await expect(page.locator('.thread__meta').first()).toHaveText(s.relativeTime);
        });

        await test.step('линза и фильтр по имени файла', async () => {
            await page.getByRole('button', { name: s.myFiles, exact: true }).click();
            await expect(page.getByRole('button', { name: s.myFiles, exact: true })).toHaveAttribute(
                'aria-pressed',
                'true',
            );
            await expect(page.locator('.full-diff')).toHaveAttribute('data-shown-files', '12');

            await page.getByRole('button', { name: s.allFiles, exact: true }).click();
            await expect(page.locator('.full-diff')).toHaveAttribute('data-shown-files', '21');

            const filterInput = page.getByRole('searchbox', { name: s.filterFiles });
            // Путь файла — в `title` строки: в подписи стоит одно имя (SPEC-theming §6a).
            const pciAuditFile = page.locator(
                '.file-tree__row--file[title^="services/orders/src/payments/pci-audit.ts · "]',
            );
            const unrelatedFile = page.locator('.file-tree__row--file[title^=".github/CODEOWNERS · "]');
            await expect(pciAuditFile).toHaveCount(1);
            await expect(unrelatedFile).toHaveCount(1);

            await filterInput.fill('pci-audit');
            await expect(pciAuditFile).toHaveCount(1);
            await expect(unrelatedFile).toHaveCount(0);
            await filterInput.fill('');
        });

        await test.step('поиск по содержимому и доводка до строки', async () => {
            await openPciAuditBySearch(page, s);
        });

        await test.step('viewed сохраняется после перезагрузки', async () => {
            const bar = page.locator('.review-action-bar');
            await expect(bar).toContainText(s.progressBefore);

            const card = pciAuditCard(page);
            await card.getByRole('button', { name: s.markViewed, exact: true }).click();
            await expect(bar).toContainText(s.progressAfter);
            await expect(
                card.locator('.file-card__collapsed--file').filter({ hasText: s.viewedCollapsed }),
            ).toBeVisible();

            await page.reload();
            await expect(page.locator('.review-action-bar')).toContainText(s.progressAfter);
            const filterInput = page.getByRole('searchbox', { name: s.filterFiles });
            await filterInput.fill('pci-audit');
            await expect(
                page.getByRole('treeitem').filter({ hasText: 'pci-audit.ts' }).locator('svg[data-icon="check"]'),
            ).toBeVisible();
            await filterInput.fill('');
            // Переход к строке сначала временно раскрывает просмотренную карточку, затем доводит скролл.
            await openPciAuditBySearch(page, s);
            await expect(pciAuditCard(page).locator('.file-card__collapsed--file')).toHaveCount(0);
            await expect(
                pciAuditCard(page).getByRole('button', { name: s.viewedToggle, exact: true }),
            ).toHaveAttribute('aria-pressed', 'true');
        });

        await test.step('черновик сохраняется и попадает в пакет шипа', async () => {
            const card = pciAuditCard(page);
            const button = card.getByRole('button', { name: s.commentLine }).first();
            await button.locator('..').hover();
            await button.click();
            const composer = page.getByRole('textbox', { name: s.newComment });
            await composer.fill(COMMENT);
            await page.getByRole('button', { name: s.saveDraft, exact: true }).click();
            await expect(composer).toHaveCount(0, { timeout: 6_000 });
            await expect(card.getByText(COMMENT, { exact: true })).toBeVisible();
            // Единственный черновик: счётчик обязан встать в единственное число обоих языков.
            await expect(page.locator('.review-action-bar')).toContainText(s.draftsCounter);
            await expect(page.getByText(s.draftChip, { exact: true })).toBeVisible();
        });

        await test.step('Ship показывает итог и публикует тред', async () => {
            await page.getByRole('button', { name: 'Ship · 1', exact: true }).click();

            await expect(page.getByRole('heading', { name: s.shipped, exact: true })).toBeVisible();
            await expect(page.getByText(s.publishedBatch, { exact: true })).toBeVisible();
            await expect(page.getByText(s.stopsOrFiles, { exact: true })).toBeVisible();
            await expect(page.getByText(s.diffSeen)).toBeVisible();
            await expect(page.getByText(s.publishedWithReplies, { exact: true })).toBeVisible();

            await page.getByRole('button', { name: s.toFullDiff, exact: true }).click();
            await expect(page.locator('.full-diff')).toBeVisible();
            await expect(page.locator('.toolbar-right-cluster')).toBeVisible();
            await expect(page.locator('.review-action-bar')).toContainText(s.noDrafts);

            await openPciAuditBySearch(page, s);
            await expect(pciAuditCard(page).getByText(COMMENT, { exact: true })).toBeVisible();
            await expect(page.getByText(s.draftChip, { exact: true })).toHaveCount(0);
        });
    });
}

function pciAuditCard(page: Page): Locator {
    return page.locator('.file-card').filter({ hasText: 'pci-audit.ts' });
}

async function openPciAuditBySearch(page: Page, s: Strings): Promise<void> {
    await page.keyboard.press(`${MOD_KEY}+KeyK`);
    const palette = page.getByRole('dialog', { name: s.palette });
    await expect(palette).toBeVisible();
    await palette.getByRole('textbox').fill(`/${SEARCH_TEXT}`);
    await expect(palette.getByRole('option', { name: /pci-audit\.ts:\d+/ })).toBeVisible();
    await page.keyboard.press('Enter');

    const card = pciAuditCard(page);
    const targetLine = card.getByText(/Retention is 13 months/);
    await expect(card).toBeVisible();
    await expect(targetLine).toBeVisible();
    await expectInScrollViewport(page, targetLine);
}

async function expectInScrollViewport(page: Page, locator: Locator): Promise<void> {
    const inViewport = await locator.evaluate((element) => {
        const scroller = element.closest('.full-diff');
        if (!(scroller instanceof HTMLElement)) {
            return false;
        }
        const elementBox = element.getBoundingClientRect();
        const scrollerBox = scroller.getBoundingClientRect();
        const toolbarBottom = scroller.querySelector<HTMLElement>('.full-diff__toolbar')?.getBoundingClientRect().bottom;
        const viewportTop = Math.max(scrollerBox.top, toolbarBottom ?? 0);
        return elementBox.bottom > viewportTop && elementBox.top < scrollerBox.bottom;
    });
    expect(inViewport).toBe(true);
}

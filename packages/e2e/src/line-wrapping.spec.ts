import { LONG_LINE_MARKER } from '@sherpa/fixtures';
import type { Locator, Page } from '@playwright/test';

import { expect, test } from './sherpa-fixture.js';

const CODE_LINE_HEIGHT = 20;

test('unified переносит длинные строки без горизонтального скролла и сохраняет разметку', async ({
    page,
    launchSherpa,
}) => {
    const server = await launchSherpa('fixture-large');
    await openFullDiff(page, server.url, 'unified');

    const code = page.locator('.diff-row--add .diff-row__code', { hasText: LONG_LINE_MARKER }).first();
    await code.scrollIntoViewIfNeeded();
    await expect(code).toBeVisible();
    const row = code.locator('xpath=..');
    const card = code.locator('xpath=ancestor::article[contains(@class, "file-card")]');

    await expect(code).toHaveCSS('white-space', 'pre-wrap');
    await expect(code).toHaveCSS('overflow-wrap', 'anywhere');
    expect(await code.evaluate((element) => element.scrollWidth === element.clientWidth)).toBe(true);
    expect(await row.evaluate((element) => element.scrollWidth === element.clientWidth)).toBe(true);
    expect(await card.evaluate((element) => element.scrollWidth === element.clientWidth)).toBe(true);
    expect(await page.locator('.full-diff').evaluate((element) => element.scrollWidth === element.clientWidth)).toBe(true);

    const wrappedHeight = await row.evaluate((element) => element.getBoundingClientRect().height);
    const ordinaryHeight = await ordinaryRowHeight(card);
    expect(wrappedHeight).toBeGreaterThan(ordinaryHeight);
    expect(wrappedHeight).toBeGreaterThan(CODE_LINE_HEIGHT * 2);

    const wordRects = await code.locator('.diff-word').evaluateAll((elements) =>
        elements.reduce((maximum, element) => Math.max(maximum, element.getClientRects().length), 0),
    );
    expect(wordRects).toBeGreaterThan(1);

    const tabbed = card.locator('.diff-row__code[title="табы показаны четырьмя пробелами"]');
    await expect(tabbed).toHaveCount(1);
    expect((await tabbed.textContent())?.startsWith('        const tabbedTail')).toBe(true);
    await expect(card.locator('.diff-trailing')).toHaveText('   ');

    const normalRow = card.locator('.diff-row[data-key]').first();
    await normalRow.locator('.diff-row__gutter').last().click();
    await row.locator('.diff-row__gutter').last().click({ modifiers: ['Shift'] });
    await expect(row).toHaveClass(/is-selected/);
    const selectionGeometry = await row.evaluate((element) => {
        const gutter = element.firstElementChild as HTMLElement | null;
        if (gutter === null) {
            throw new Error('у выделенной строки нет гаттера');
        }
        return {
            rowHeight: element.getBoundingClientRect().height,
            gutterHeight: gutter.getBoundingClientRect().height,
            boxShadow: getComputedStyle(gutter).boxShadow,
        };
    });
    expect(selectionGeometry.gutterHeight).toBe(selectionGeometry.rowHeight);
    expect(selectionGeometry.boxShadow).not.toBe('none');

    await row.hover();
    const comment = row.locator('.diff-row__comment');
    await expect(comment).toHaveCSS('opacity', '1');
    const firstLine = await firstLineGeometry(row, comment);
    expect(Math.abs(firstLine.gutterCenter - firstLine.codeCenter)).toBeLessThanOrEqual(4);
    expect(Math.abs(firstLine.signCenter - firstLine.codeCenter)).toBeLessThanOrEqual(4);
    expect(Math.abs(firstLine.commentCenter - firstLine.codeCenter)).toBeLessThanOrEqual(4);
});

test('split растягивает короткую и пустую стороны до высоты перенесённой строки', async ({ page, launchSherpa }) => {
    const server = await launchSherpa('fixture-large');
    await openFullDiff(page, server.url, 'split');

    const pairedCode = page.locator('.diff-row__code', { hasText: LONG_LINE_MARKER }).first();
    await pairedCode.scrollIntoViewIfNeeded();
    const pairedRow = pairedCode.locator('xpath=..');
    await expect(pairedRow).toBeVisible();
    const pairedHeights = await cellHeights(pairedRow);
    expect(new Set(pairedHeights.cells)).toEqual(new Set([pairedHeights.row]));
    expect(pairedHeights.row).toBeGreaterThan(CODE_LINE_HEIGHT * 2);

    const emptyPairCode = page.locator('.diff-row__code', { hasText: 'minifiedPayload' }).first();
    const emptyPairRow = emptyPairCode.locator('xpath=..');
    await expect(emptyPairRow.locator('.diff-row__code--empty')).toHaveCount(1);
    const emptyPairHeights = await cellHeights(emptyPairRow);
    expect(new Set(emptyPairHeights.cells)).toEqual(new Set([emptyPairHeights.row]));
    expect(emptyPairHeights.row).toBeGreaterThan(CODE_LINE_HEIGHT * 2);

    const emptyBackground = await emptyPairRow.locator('.diff-row__code--empty').evaluate(
        (element) => getComputedStyle(element).backgroundColor,
    );
    expect(emptyBackground).not.toBe('rgba(0, 0, 0, 0)');
    expect(await page.locator('.full-diff').evaluate((element) => element.scrollWidth === element.clientWidth)).toBe(true);
});

async function openFullDiff(page: Page, url: string, mode: 'unified' | 'split'): Promise<void> {
    await page.goto(url);
    await page.getByRole('tab', { name: 'Полный дифф', exact: true }).click();
    if (mode === 'split') {
        await page.locator('.diff-mode-toggle').click();
    }
    await expect(page.locator(`.diff-rows--${mode}`).first()).toBeVisible();
    await page.evaluate(() => document.fonts.ready.then(() => undefined));
}

async function ordinaryRowHeight(card: Locator): Promise<number> {
    return card.locator('.diff-row[data-key]').evaluateAll((rows, marker) => {
        const ordinary = rows.find(
            (row) =>
                !row.textContent.includes(marker) &&
                (row.querySelector('.diff-row__code')?.textContent.length ?? 0) !== 0,
        );
        if (ordinary === undefined) {
            throw new Error('не найдена обычная строка для сравнения высоты');
        }
        return ordinary.getBoundingClientRect().height;
    }, LONG_LINE_MARKER);
}

async function firstLineGeometry(row: Locator, comment: Locator): Promise<{
    gutterCenter: number;
    signCenter: number;
    codeCenter: number;
    commentCenter: number;
}> {
    const commentBox = await comment.boundingBox();
    if (commentBox === null) {
        throw new Error('карандаш строки не измерился');
    }
    const centers = await row.evaluate((element) => {
        const textCenter = (target: Element): number => {
            const walker = document.createTreeWalker(target, NodeFilter.SHOW_TEXT);
            const text = walker.nextNode();
            if (!text?.textContent) {
                throw new Error('в ячейке нет текста для измерения первой строки');
            }
            const range = document.createRange();
            range.setStart(text, 0);
            range.setEnd(text, 1);
            const rect = range.getBoundingClientRect();
            return rect.top + rect.height / 2;
        };
        const gutters = element.querySelectorAll('.diff-row__gutter');
        const sign = element.querySelector('.diff-row__sign');
        const codeElement = element.querySelector('.diff-row__code');
        if (gutters[1] === undefined || sign === null || codeElement === null) {
            throw new Error('у unified-строки нет ожидаемых колонок');
        }
        return {
            gutterCenter: textCenter(gutters[1]),
            signCenter: textCenter(sign),
            codeCenter: textCenter(codeElement),
        };
    });
    return { ...centers, commentCenter: commentBox.y + commentBox.height / 2 };
}

function cellHeights(row: Locator): Promise<{ row: number; cells: number[] }> {
    return row.evaluate((element) => ({
        row: element.getBoundingClientRect().height,
        cells: [...element.children].map((child) => child.getBoundingClientRect().height),
    }));
}

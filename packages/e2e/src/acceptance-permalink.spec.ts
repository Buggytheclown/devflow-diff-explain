import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Page } from '@playwright/test';
import { architectureStoryFixture, fixtureIteration } from '@sherpa/fixtures';

import { startServer } from '../../server/src/server.js';
import { directoryAssets } from '../../server/src/static.js';
import { currentStory } from './story-support.js';
import { test, expect, advanceIteration, openBlocks } from './sherpa-fixture.js';
import type { SherpaServerHandle } from './sherpa-fixture.js';

const fixture = architectureStoryFixture();
const uiDist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../ui/dist');
const summaryB = 'Версия B меняет набор файлов после второго импорта.';

function pinnedUrl(serverUrl: string, href: string): URL {
    const url = new URL(href, serverUrl);
    const params = new URLSearchParams(url.hash.slice(1));
    expect(params.get('t')).toBeTruthy();
    expect(params.get('code')).toBeTruthy();
    return url;
}

async function publishB(page: Page, server: SherpaServerHandle): Promise<void> {
    await advanceIteration(page, server);
    await page.getByRole('button', { name: 'Обновить рассказ', exact: true }).click();
    const story = currentStory(fixtureIteration('medium', 1).diff);
    const overview = await server.worker.next();
    expect(overview.type).toBe('route.prepare');
    expect((await server.worker.complete(overview.taskId ?? 0, JSON.stringify({ ...story.outline, summary: summaryB }))).stdout).not.toContain('rejected');
    const files = await server.worker.next();
    expect(files.type).toBe('route.prepare');
    expect((await server.worker.complete(files.taskId ?? 0, JSON.stringify(story.body))).stdout).not.toContain('rejected');
}

test('ссылка A открывает A в чистом профиле и второй вкладке после B, затем на новом адресе сервера', async ({ page, browser, launchSherpa }) => {
    const sherpaDir = await mkdtemp(path.join(tmpdir(), 'sherpa-permalink-e2e-'));
    const server = await launchSherpa('fixture-medium', { sherpaDir });
    try {
        await page.goto(server.url);
        expect((await server.worker.register('codex', 'ru')).code).toBe(0);
        const overviewA = await server.worker.next();
        expect((await server.worker.complete(overviewA.taskId ?? 0, JSON.stringify(fixture.outline))).stdout).not.toContain('rejected');
        const filesA = await server.worker.next();
        expect((await server.worker.complete(filesA.taskId ?? 0, JSON.stringify(fixture.body))).stdout).not.toContain('rejected');
        await expect(page.locator('.story-preparation--ready')).toBeVisible();
        const aLink = pinnedUrl(server.url, await page.locator('.story-permalink a').getAttribute('href') ?? '');
        const aParams = new URLSearchParams(aLink.hash.slice(1));
        expect(aParams.get('review')).toBeTruthy();
        expect(aParams.get('view')).toBe('route');

        await publishB(page, server);
        await page.getByRole('button', { name: 'Открыть новый разбор', exact: true }).click();
        await expect(page.locator('.story-overview')).toContainText(summaryB);
        const bLink = pinnedUrl(server.url, await page.locator('.story-permalink a').getAttribute('href') ?? '');
        expect(new URLSearchParams(bLink.hash.slice(1)).get('code')).not.toBe(aParams.get('code'));

        // В той же вкладке браузер меняет только hash; приложение должно перечитать locator.
        await page.goto(aLink.href);
        await expect(page.locator('.story-overview')).toContainText(fixture.outline.summary);
        await expect(page.locator('.story-overview')).not.toContainText(summaryB);
        await page.goto(bLink.href);
        await expect(page.locator('.story-overview')).toContainText(summaryB);

        const clean = await browser.newContext();
        try {
            const fresh = await clean.newPage();
            await fresh.goto(aLink.href);
            await expect(fresh.locator('.story-overview')).toContainText(fixture.outline.summary);
            await expect(fresh.locator('.story-overview')).not.toContainText(summaryB);
            await openBlocks(fresh);
            await expect(fresh.locator(`[data-reading-file="${fixture.first.fileId}"] .story-file-description`)).toContainText(fixture.body.stops[0]?.files[0]?.explanation ?? 'missing');

            const secondTab = await page.context().newPage();
            try {
                await secondTab.goto(aLink.href);
                await expect(secondTab.locator('.story-overview')).toContainText(fixture.outline.summary);
                await expect(secondTab.locator('.story-overview')).not.toContainText(summaryB);
            } finally { await secondTab.close(); }

            await server.stop();
            const restarted = await startServer({ prKey: server.prKey, sherpaDir: server.sherpaDir, assets: directoryAssets(uiDist), idleSeconds: 0 });
            try {
                const newParams = new URLSearchParams(aParams);
                newParams.set('t', restarted.token);
                const freshUrl = `http://127.0.0.1:${String(restarted.port)}/#${newParams.toString()}`;
                await fresh.goto(freshUrl);
                await expect(fresh.locator('.story-overview')).toContainText(fixture.outline.summary);
                await expect(fresh.locator('.story-overview')).not.toContainText(summaryB);
                await openBlocks(fresh);
                await expect(fresh.locator(`[data-reading-file="${fixture.first.fileId}"] .story-file-description`)).toContainText(fixture.body.stops[0]?.files[0]?.explanation ?? 'missing');
            } finally { await restarted.close(); }
        } finally { await clean.close(); }
    } finally { await server.stop(); await rm(sherpaDir, { recursive: true, force: true }); }
});

test('code-only A до обзора принимает пояснения A и остаётся на A после публикации B', async ({ page, browser, launchSherpa }) => {
    const server = await launchSherpa('fixture-medium');
    await page.goto(server.url);
    const codeOnly = pinnedUrl(server.url, await page.locator('.story-permalink a').getAttribute('href') ?? '');
    const params = new URLSearchParams(codeOnly.hash.slice(1));
    expect(params.get('review')).toBeNull();
    expect(params.get('view')).toBe('diff');

    const clean = await browser.newContext();
    try {
        const pinned = await clean.newPage();
        await pinned.goto(codeOnly.href);
        await expect(pinned.locator('.story-code header code').first()).toBeVisible();
        expect((await server.worker.register('codex', 'ru')).code).toBe(0);
        const overviewA = await server.worker.next();
        expect((await server.worker.complete(overviewA.taskId ?? 0, JSON.stringify(fixture.outline))).stdout).not.toContain('rejected');
        await expect(pinned.locator('.story-overview')).toContainText(fixture.outline.summary);
        const filesA = await server.worker.next();
        expect((await server.worker.complete(filesA.taskId ?? 0, JSON.stringify(fixture.body))).stdout).not.toContain('rejected');
        await expect(pinned.locator('.story-preparation--ready')).toBeVisible();

        await publishB(page, server);
        await page.getByRole('button', { name: 'Открыть новый разбор', exact: true }).click();
        await expect(page.locator('.story-overview')).toContainText(summaryB);
        await expect(pinned.locator('.story-overview')).toContainText(fixture.outline.summary);
        await expect(pinned.locator('.story-overview')).not.toContainText(summaryB);
        await openBlocks(pinned);
        await expect(pinned.locator(`[data-reading-file="${fixture.first.fileId}"] .story-file-description`)).toContainText(fixture.body.stops[0]?.files[0]?.explanation ?? 'missing');
    } finally { await clean.close(); }
});

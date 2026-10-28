import { fixtureIteration, MEDIUM_DIFF_ID_V2 } from '@sherpa/fixtures';
import type { Page } from '@playwright/test';

import { test, expect, advanceIteration, sherpaAuth } from './sherpa-fixture.js';
import type { SherpaServerHandle } from './sherpa-fixture.js';
import { body, outline, evidence, evidenceSource } from './story-support.js';

test.setTimeout(45_000);

const longBody = { ...body, stops: body.stops.map((stop) => {
    const paragraph = [stop.paragraph,
        'Запрос проходит через обработчик и проверку состояния. Связь между этими частями видна в вызовах. '.repeat(3),
        'Отдельный абзац сохраняет своё место после перехода. Для дополнительных деталей доступен явный вопрос в чате. '.repeat(3),
    ].join('\n\n');
    return { ...stop, paragraph, evidence: evidence(stop.paragraph) };
}) };
async function startStory(page: Page, server: SherpaServerHandle, content = longBody) {
    await page.goto(server.url);
    await server.worker.register('codex', 'ru');
    const task = await server.worker.next();
    expect((await server.worker.complete(task.taskId ?? 0, JSON.stringify(outline))).stdout).not.toContain('rejected');
    const section = await server.worker.next();
    expect((await server.worker.complete(section.taskId ?? 0, JSON.stringify(content))).stdout).not.toContain('rejected');
    await expect(page.locator('.story-document section')).toHaveCount(3);
}
const storyTab = (page: Page) => page.locator('.story-topbar nav button').first();
const diffTab = (page: Page) => page.getByRole('button', { name: 'Дифф', exact: true });
async function visibleLine(page: Page) {
    return page.locator('.story-main').evaluate((root) => {
        const top = (document.querySelector('.story-preparation')?.getBoundingClientRect().bottom ?? 54) + 12;
        const line = [...root.querySelectorAll<HTMLElement>('.diff-row[data-key]')].find((row) => row.getBoundingClientRect().bottom > top);
        return { key: line?.dataset.key ?? '', y: line?.getBoundingClientRect().top ?? -1 };
    });
}

test('возврат хранит абзац, раскрытия и фокус; вкладки хранят файл, поиск, строки и раскрытый контекст', async ({ page, launchSherpa }) => {
    const server = await launchSherpa('fixture-medium');
    await startStory(page, server);
    const first = page.locator('.story-document section').nth(1);
    const second = page.locator('.story-document section').nth(2);
    await first.getByRole('button', { name: 'Показать изменение', exact: true }).click();
    await second.getByRole('button', { name: 'Показать изменение', exact: true }).click();
    const open = second.getByRole('button', { name: 'Открыть в диффе ↗', exact: true });
    await open.focus();
    await open.scrollIntoViewIfNeeded();
    const paragraph = second.locator('[data-reading]').nth(2);
    const before = (await paragraph.boundingBox())?.y ?? 0;
    await page.keyboard.press('Enter');
    await expect(page.locator('.story-main .diff-row.is-selected')).not.toHaveCount(0);
    await expect(page.locator('.story-return')).toContainText('Проверка ошибок');
    const target = page.locator(`.story-main .diff-row[data-key="a${String(evidenceSource.start)}"]`);
    await expect(target).toBeInViewport();
    const otherPath = 'services/orders/src/domain/policies/edit-policy.ts';
    await page.locator('.story-nav').getByRole('button', { name: otherPath, exact: true }).click();
    await storyTab(page).click();
    await expect(second.getByRole('button', { name: 'Скрыть изменение', exact: true })).toBeVisible();
    await expect(first.getByRole('button', { name: 'Скрыть изменение', exact: true })).toHaveCount(1);
    await expect(open).toBeFocused();
    await expect(async () => { expect(Math.abs(((await paragraph.boundingBox())?.y ?? 99999) - before)).toBeLessThan(3); }).toPass({ timeout: 5_000 });
    await page.screenshot({ path: test.info().outputPath('return-to-section.png'), fullPage: false });
    await page.setViewportSize({ width: 900, height: 900 });
    await expect(paragraph).toBeInViewport();
    await page.setViewportSize({ width: 1440, height: 900 });
    await expect(paragraph).toBeInViewport();

    await diffTab(page).click();
    await expect(page.locator('.story-code header code')).toHaveText(otherPath);
    await page.getByRole('textbox', { name: 'Найти файл' }).fill('edit-policy');
    await page.getByRole('button', { name: 'Раскрыть контекст файла', exact: true }).click();
    await expect(page.locator('.story-main .diff-row')).not.toHaveCount(0);
    await page.locator('.story-main .diff-row').nth(20).focus();
    await page.evaluate(() => { window.scrollBy(0, 250); });
    const selected = await page.locator('.story-main .diff-row.is-selected').first().getAttribute('data-key');
    const position = await visibleLine(page);
    const rows = await page.locator('.story-main .diff-row').count();
    await storyTab(page).click();
    await diffTab(page).click();
    await expect(page.locator('.story-code header code')).toHaveText(otherPath);
    await expect(page.getByRole('textbox', { name: 'Найти файл' })).toHaveValue('edit-policy');
    await expect(page.locator('.story-main .diff-row')).toHaveCount(rows);
    await expect(page.locator(`.story-main .diff-row[data-key="${selected ?? ''}"]`)).toHaveClass(/is-selected/);
    await expect(async () => { expect(Math.abs(((await page.locator(`.story-main .diff-row[data-key="${position.key}"]`).boundingBox())?.y ?? 99999) - position.y)).toBeLessThan(3); }).toPass({ timeout: 5_000 });
    await advanceIteration(page, server);
    await expect(page.getByRole('button', { name: 'Открыть новый дифф', exact: true })).toBeVisible();
    await storyTab(page).click(); await diffTab(page).click();
    await expect(page.locator('.story-main .diff-row')).toHaveCount(rows);
    await expect(page.locator('.story-code header code')).toHaveText(otherPath);
});

test('новый push и поздняя загрузка не подменяют выбранную версию; новый разбор открывается явно', async ({ page, launchSherpa }) => {
    const server = await launchSherpa('fixture-medium');
    await startStory(page, server);
    await page.locator('.story-document section').nth(1).getByRole('button', { name: 'Показать изменение', exact: true }).click();
    await page.locator('.story-document section').nth(1).getByRole('button', { name: 'Открыть в диффе ↗', exact: true }).click();
    const oldPath = await page.locator('.story-code header code').innerText();
    const oldCommit = await page.locator('.story-provenance').innerText();
    await advanceIteration(page, server);
    await expect(page.getByRole('button', { name: 'Открыть новый дифф', exact: true })).toBeVisible();
    await expect(page.locator('.story-provenance')).toHaveText(oldCommit);
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let started = (): void => undefined;
    const requested = new Promise<void>((resolve) => { started = resolve; });
    await page.route('**/api/ui/review/diff?*', async (route) => {
        if (new URL(route.request().url()).searchParams.get('diffId') === MEDIUM_DIFF_ID_V2) { started(); await gate; }
        await route.continue();
    });
    await page.getByRole('button', { name: 'Открыть новый дифф', exact: true }).click();
    await requested;
    await storyTab(page).click();
    release();
    await expect(page.locator('.story-document')).toBeVisible();
    await expect(page.locator('.story-code.file-card')).toHaveCount(0);
    await diffTab(page).click();
    await expect(page.locator('.story-code header code')).toHaveText(oldPath);
    await expect(page.locator('.story-provenance')).toHaveText(oldCommit);
    const oldPosition = await visibleLine(page);
    await page.getByRole('button', { name: 'Обновить рассказ', exact: true }).click();
    const plan = await server.worker.next();
    expect((await server.worker.complete(plan.taskId ?? 0, JSON.stringify(outline))).stdout).not.toContain('rejected');
    await expect(page.locator('.story-main--diff')).toBeVisible();
    await expect(page.locator('.story-provenance')).toHaveText(oldCommit);
    expect((await visibleLine(page)).key).toBe(oldPosition.key);
    await expect(page.locator('.story-return')).toHaveText('К рассказу · Введение');
    await storyTab(page).click();
    await expect(page.locator('[data-reading="intro:0"]')).toBeInViewport();
    await expect(page.getByRole('button', { name: 'Скрыть изменение', exact: true })).toHaveCount(1);
    await expect(page.locator('.story-provenance')).toHaveText(oldCommit);
    await page.getByRole('button', { name: 'Открыть новый разбор', exact: true }).click();
    await expect(page.locator('[data-reading="intro:0"]')).toBeInViewport();
    await expect(page.getByRole('button', { name: 'Скрыть изменение', exact: true })).toHaveCount(0);
    const section = await server.worker.next();
    await server.worker.complete(section.taskId ?? 0, JSON.stringify(body));
    await diffTab(page).click();
    await expect(page.locator('.story-provenance')).not.toHaveText(oldCommit);
    await expect(page.getByRole('button', { name: 'Открыть новый дифф', exact: true })).toHaveCount(0);
});

test('ошибка источника повторяется локально без новой задачи; legacy остаётся свёрнутым и честно подписан', async ({ page, launchSherpa }) => {
    const server = await launchSherpa('fixture-medium');
    let fail = true;
    await page.route('**/api/ui/review/diff**', async (route) => { if (fail) await route.abort(); else await route.continue(); });
    await startStory(page, server, body);
    const intro = page.locator('[data-story-section="intro"]');
    await intro.getByRole('button', { name: 'Показать изменение', exact: true }).click();
    await expect(intro.locator('.story-source [role="alert"]')).toBeVisible();
    const writes: string[] = [];
    page.on('request', (request) => { if (request.method() === 'POST') writes.push(request.url()); });
    fail = false;
    await intro.getByRole('button', { name: 'Повторить загрузку', exact: true }).click();
    await expect(intro.locator('.story-source-line')).not.toHaveCount(0);
    expect(writes).toEqual([]);
    await page.route('**/api/ui/review/route', async (route) => {
        const response = await route.fetch();
        const result = await response.json() as { route: { snapshot: Record<string, unknown> | null } };
        if (result.route.snapshot !== null) {
            delete result.route.snapshot.storyContractVersion; delete result.route.snapshot.summaryEvidence;
            const stops = result.route.snapshot.stops as { storyEvidence?: unknown; anchors: unknown[] }[];
            for (const stop of stops) { delete stop.storyEvidence; stop.anchors = [{ ...evidenceSource, collapsed: false, fileId: fixtureIteration('medium').diff.files.find((file) => file.path === evidenceSource.path)?.fileId }]; }
        }
        await route.fulfill({ response, json: result });
    });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.getByText(/Этот рассказ создан без связей/)).toHaveCount(1);
    await expect(page.locator('.story-source-line')).toHaveCount(0);
    await page.getByRole('button', { name: 'Фрагменты кода', exact: true }).first().click();
    await expect(page.locator('.story-source-line')).not.toHaveCount(0);
    const stateResponse = await page.request.get(new URL('/api/ui/state', server.url).href, { headers: sherpaAuth(server) });
    const state = await stateResponse.json() as Record<string, unknown>;
    // Закрываем живой SSE до установки его подмены: смена перехватчика при открытом
    // потоке может заблокировать следующую навигацию Chromium.
    await page.goto('about:blank');
    await page.route('**/api/ui/events?*', (route) => route.fulfill({ contentType: 'text/event-stream', body: `event: state\ndata: ${JSON.stringify({ ...state, worker: { kind: 'never' } })}\n\n` }));
    await page.goto(server.url, { waitUntil: 'domcontentloaded' });
    await expect(page.getByText('Агент не подключён. Сохранённый рассказ и дифф доступны для чтения.')).toBeVisible();
    await page.getByRole('button', { name: 'Фрагменты кода', exact: true }).first().click();
    await expect(page.locator('.story-source-line')).not.toHaveCount(0);
});

test('источники показывают точные стороны, отдельный файл и картинку; раскрытие не меняет вопрос', async ({ page, launchSherpa }) => {
    const server = await launchSherpa('fixture-medium');
    const changed = fixtureIteration('medium').diff.files.find((file) => file.path === '.github/CODEOWNERS');
    const picture = fixtureIteration('medium').diff.files.find((file) => file.image !== null && file.changeType === 'modify');
    if (changed === undefined || picture === undefined) throw new Error('Missing evidence fixture');
    const sources = [
        { kind: 'lines', path: changed.path, side: 'old', start: 9, end: 9 },
        { kind: 'lines', path: changed.path, side: 'new', start: 12, end: 12 },
        { kind: 'file', path: picture.path },
    ];
    await page.goto(server.url);
    await server.worker.register('codex', 'ru');
    const task = await server.worker.next();
    await server.worker.complete(task.taskId ?? 0, JSON.stringify({ ...outline, evidence: { claims: [{ quote: outline.summary, sources, limitation: null }] } }));
    const intro = page.locator('[data-story-section="intro"]');
    await page.getByRole('button', { name: 'Спросить в чате', exact: true }).click();
    await page.getByRole('textbox', { name: 'Вопрос агенту' }).fill('Мой черновик');
    const context = await page.locator('textarea').inputValue();
    await page.getByRole('button', { name: 'Закрыть чат', exact: true }).click();
    const button = intro.locator('.story-evidence-toggle');
    await button.focus(); await page.keyboard.press('Enter');
    await expect(button).toHaveAttribute('aria-expanded', 'true');
    const old = intro.locator('[data-source-side="old"]');
    const fresh = intro.locator('[data-source-side="new"]');
    await expect(old.locator('.story-source-line')).toHaveCount(1);
    await expect(fresh.locator('.story-source-line')).toHaveCount(1);
    await expect(old.locator('header')).toContainText('До · 9–9');
    await expect(fresh.locator('header')).toContainText('После · 12–12');
    await expect(old.locator('.story-source-line--add')).toHaveCount(0);
    await expect(fresh.locator('.story-source-line--del')).toHaveCount(0);
    await expect(old.locator('.story-source-line code')).toHaveText('/services/orders/src/payments/     @quillmart/payments');
    await expect(fresh.locator('.story-source-line code')).toHaveText('/services/orders/src/payments/     @quillmart/payments-platform @quillmart/security');
    const image = intro.locator('[data-source-side="file"]');
    await expect(image).toContainText(picture.path);
    await expect(image.locator('img')).not.toHaveCount(0);
    await page.getByRole('button', { name: 'Спросить в чате', exact: true }).click();
    await expect(page.getByRole('textbox', { name: 'Вопрос агенту' })).toHaveValue('Мой черновик');
    await expect(page.locator('textarea')).toHaveValue(context);
    await page.getByRole('button', { name: 'Закрыть чат', exact: true }).click();
    await page.screenshot({ path: test.info().outputPath('sources-dark.png'), fullPage: true });
    await intro.getByRole('button', { name: 'Скрыть изменение', exact: true }).focus();
    await page.keyboard.press('Enter');
    await expect(button).toBeFocused();
    await expect(intro.locator('.story-source')).toHaveCount(0);
});

test('поздний разбор первого файла не переключает выбранный позже файл', async ({ page, launchSherpa }) => {
    const server = await launchSherpa('fixture-medium');
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    await page.route('**/assets/worker-*.js', async (route) => { await gate; await route.continue(); });
    await page.goto(server.url);
    await diffTab(page).click();
    const path = 'services/orders/src/infra/clock.ts';
    await page.locator('.story-nav').getByRole('button', { name: path, exact: true }).click();
    await expect(page.locator('.story-code header code')).toHaveText(path);
    release();
    await expect(page.locator('.story-main .diff-row')).not.toHaveCount(0);
    await expect(page.locator('.story-code header code')).toHaveText(path);
    await expect(page.locator('.story-main [data-reading-wait]')).toHaveCount(0);
});

test('позднее изображение над текстом не сдвигает читаемый абзац', async ({ page, launchSherpa }) => {
    const server = await launchSherpa('fixture-medium');
    const picture = fixtureIteration('medium').diff.files.find((file) => file.image !== null && file.changeType === 'modify');
    if (picture === undefined) throw new Error('Missing image');
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    await page.route('**/api/ui/review/blob?*', async (route) => { await gate; await route.continue(); });
    await page.setViewportSize({ width: 1440, height: 700 });
    await page.goto(server.url);
    await server.worker.register('codex', 'ru');
    const plan = await server.worker.next();
    const result = { ...outline, evidence: { claims: [{ quote: outline.summary, sources: [{ kind: 'file', path: picture.path }], limitation: null }] } };
    expect((await server.worker.complete(plan.taskId ?? 0, JSON.stringify(result))).code).toBe(0);
    const bodyTask = await server.worker.next();
    expect((await server.worker.complete(bodyTask.taskId ?? 0, JSON.stringify(longBody))).code).toBe(0);
    await page.locator('[data-story-section="intro"]').getByRole('button', { name: 'Показать изменение', exact: true }).click();
    await expect(page.locator('.image-card')).toBeVisible();
    const paragraph = page.locator('.story-document section').nth(1).locator('[data-reading]').nth(1);
    await paragraph.evaluate((element) => { window.scrollBy(0, element.getBoundingClientRect().top - 120); });
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => { requestAnimationFrame(() => { resolve(); }); })));
    const before = (await paragraph.boundingBox())?.y ?? 0;
    release();
    await expect(page.locator('.image-card img')).toHaveCount(2);
    await expect(async () => { expect(Math.abs(((await paragraph.boundingBox())?.y ?? 99999) - before)).toBeLessThan(3); }).toPass({ timeout: 5_000 });
});

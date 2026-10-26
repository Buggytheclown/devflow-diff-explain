import fs from 'node:fs/promises';

import { outline, body, codeReference } from './story-support.js';
import { test, expect, advanceIteration, sherpaAuth } from './sherpa-fixture.js';

test('рассказ → явный вопрос → ответ; старое ревью скрыто, новый пуш не меняет контекст вопроса', async ({ page, launchSherpa }) => {
    const server = await launchSherpa('fixture-medium');
    const writes: string[] = [];
    page.on('request', (request) => {
        if (request.method() === 'POST' && /publish|draft|resolved|feedback/.test(request.url())) writes.push(request.url());
    });
    await page.goto(server.url);
    expect((await server.worker.register('codex', 'ru')).code).toBe(0);
    const plan = await server.worker.next();
    expect(plan.type).toBe('route.skeleton');
    const submitted = await server.worker.complete(plan.taskId ?? 0, JSON.stringify(outline));
    expect(submitted.stdout).not.toContain('rejected');
    await expect(page.locator('.story-document')).toContainText(outline.summary);
    await expect(page.getByText('Дописываю рассказ. Введение уже можно читать.')).toBeVisible();
    await page.getByRole('button', { name: 'Показать изменение', exact: true }).click();
    await expect(page.locator('.story-source-line')).not.toHaveCount(0);
    const compose = await server.worker.next();
    expect(compose.type).toBe('route.section');
    expect((await server.worker.complete(compose.taskId ?? 0, JSON.stringify(body))).stdout).not.toContain('rejected');
    await expect(page.getByRole('heading', { name: 'Запись до уведомления' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Проверка ошибок' })).toBeVisible();
    await expect(page.locator('.story-document')).not.toContainText('в других остановках');
    await expect(page.locator('[data-story-section="intro"] [aria-expanded="true"]')).toHaveCount(1);
    await expect(page.locator('.review-action-bar, .route-toolbar, .thread-list')).toHaveCount(0);

    await page.getByRole('button', { name: 'Вопрос об этом', exact: true }).nth(1).click();
    await page.getByRole('textbox', { name: 'Вопрос агенту' }).fill('Почему уведомление идёт после записи?');
    await page.getByRole('button', { name: 'Закрыть чат', exact: true }).click();
    await page.getByRole('button', { name: 'Спросить в чате', exact: true }).click();
    await expect(page.getByRole('textbox', { name: 'Вопрос агенту' })).toHaveValue('Почему уведомление идёт после записи?');
    await expect(page.locator('.story-chat-context')).toContainText('Запись до уведомления');
    await page.getByRole('textbox', { name: 'Вопрос агенту' }).press('Enter');
    await expect(page.locator('.chat-message--you')).toContainText('Почему уведомление');
    const question = await server.worker.next();
    expect(question.type).toBe('chat');
    const contextLine = question.stdout.split('\n').find((line) => line.endsWith('route-context.md'));
    expect(contextLine).toBeDefined();
    const context = await fs.readFile(contextLine?.trim() ?? '', 'utf8');
    expect(context).toContain(outline.summary);
    expect(context).toContain(body.stops[0]?.paragraph);
    const jumpStart = Math.max(codeReference.start, codeReference.end - 2);
    const address = `#code?path=${encodeURIComponent(codeReference.path)}&side=${codeReference.side}&start=${String(jumpStart)}&end=${String(codeReference.end)}`;
    const invalid = await server.worker.complete(question.taskId ?? 0, 'См. [источник](#code?path=missing.ts&side=new&start=1&end=1).');
    expect(invalid.stdout).toContain('rejected');
    const completed = await server.worker.complete(question.taskId ?? 0, `Так уведомление не отправится при откате записи. См. [нужные строки](${address}).`);
    expect(completed.stdout).not.toContain('rejected');
    await expect(page.locator('.chat-message--agent')).toContainText('не отправится');

    await page.getByRole('link', { name: 'нужные строки' }).click();
    await expect(page.locator('.story-code header code')).toHaveText(codeReference.path);
    const target = page.locator(`.diff-row[data-key="${codeReference.side === 'new' ? 'a' : 'd'}${String(jumpStart)}"]`);
    await expect(target).toHaveClass(/is-selected/);
    await expect(async () => {
        const box = await target.boundingBox();
        expect(box?.y).toBeGreaterThan(54);
        expect(box?.y).toBeLessThan(900);
    }).toPass();
    const toolbar = page.getByRole('toolbar', { name: 'Выбраны строки' });
    const toolbarBox = await toolbar.boundingBox();
    expect(toolbarBox?.y).toBeGreaterThanOrEqual(50);
    expect(toolbarBox?.y).toBeLessThan(900);
    const topbarBox = await page.locator('.story-topbar').boundingBox();
    expect(topbarBox?.y).toBe(0);
    await expect(page.getByRole('textbox', { name: 'Вопрос агенту' })).toBeInViewport();
    await page.screenshot({ path: '/private/tmp/sherpa-fixes-code-jump.png' });
    await toolbar.getByRole('button', { name: 'Спросить об этих строках', exact: true }).click();
    await expect(page.locator('.chat-panel__composer')).toContainText(`${String(jumpStart)}–${String(codeReference.end)}`);

    await page.getByRole('button', { name: 'Дифф', exact: true }).click();
    await expect(page.locator('.story-code')).toBeVisible();
    const columns = await page.locator('.diff-row').first().evaluate((element) => getComputedStyle(element).gridTemplateColumns.split(' '));
    expect(columns).toHaveLength(4);
    expect(Number.parseFloat(columns[0] ?? '')).toBeLessThan(100);
    await expect(page.locator('.diff-row__comment, .thread-marker, .comment-composer')).toHaveCount(0);
    await page.keyboard.press('c');
    await page.keyboard.press('r');
    await page.keyboard.press('ControlOrMeta+Shift+Enter');
    await expect(page.locator('.comment-composer, .review-action-bar')).toHaveCount(0);
    expect(writes).toEqual([]);

    await advanceIteration(page, server);
    await expect(page.getByText(/В ПР появились новые изменения/)).toBeVisible();
    const response = await page.request.get(new URL('/api/ui/review/chat', server.url).href, { headers: sherpaAuth(server) });
    const stored = await response.json() as { exchanges: { explanation: { text: string; commit: string } }[] };
    expect(stored.exchanges[0]?.explanation.text).toContain(body.stops[0]?.paragraph);
    await page.getByRole('link', { name: 'нужные строки' }).click();
    await expect(page.locator('.story-provenance')).toContainText(stored.exchanges[0]?.explanation.commit.slice(0, 12) ?? 'missing');
    await expect(target).toHaveClass(/is-selected/);
    await expect(async () => {
        const box = await target.boundingBox();
        expect(box?.y).toBeGreaterThan(54);
        expect(box?.y).toBeLessThan(900);
    }).toPass();
    await page.locator('.story-topbar').getByRole('button', { name: 'К рассказу', exact: true }).click();
    await page.screenshot({ path: '/private/tmp/sherpa-story-ui.png', fullPage: true });
});

test('дифф доступен без агента, история комментариев не загружается', async ({ page, launchSherpa }) => {
    const server = await launchSherpa('fixture-medium');
    const requests: string[] = [];
    page.on('request', (request) => { requests.push(request.url()); });
    await page.goto(server.url);
    await page.getByRole('button', { name: 'Дифф', exact: true }).click();
    await expect(page.locator('.story-code')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Построить рассказ' })).toHaveCount(0);
    expect(requests.some((url) => /\/threads|\/snapshots|draft-buffer/.test(url))).toBe(false);
});

test('в узком окне доступен поиск и выбор другого файла без горизонтальной прокрутки', async ({ page, launchSherpa }) => {
    const server = await launchSherpa('fixture-medium');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(server.url);
    await page.getByRole('button', { name: 'Дифф', exact: true }).click();
    await page.getByRole('button', { name: 'Файлы', exact: true }).click();
    const menu = page.locator('.story-nav');
    const last = menu.getByRole('button').last();
    const path = await last.innerText();
    await page.getByRole('textbox', { name: 'Найти файл' }).fill(path);
    await page.screenshot({ path: '/private/tmp/sherpa-fixes-files-menu.png' });
    await menu.getByRole('button', { name: path, exact: true }).click();
    await expect(menu).toBeHidden();
    await expect(page.locator('.story-code header code')).toHaveText(path);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: '/private/tmp/sherpa-fixes-narrow.png', fullPage: false });
});

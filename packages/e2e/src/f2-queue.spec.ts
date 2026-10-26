import type { Locator, Page } from '@playwright/test';

import {
    answerChat,
    buildRoute,
    fillSections,
    mediumRawResults,
    sectionFor,
    submit,
    takeTask,
} from './route-worker.js';
import { expect, test } from './sherpa-fixture.js';

/**
 * Очередь честна не на словах. Вопрос, заданный во время генерации маршрута, стоит
 * в очереди ровно один шаг — воркер видит его после сдачи текущей секции, — и UI это показывает
 * баннером в панели и длиной очереди в индикаторе (docs/protocol.md §5,
 * docs/design/README.md «Agent queue is honest»).
 *
 * Второй тест — отмена в полёте: обмен гаснет, но UI честно говорит, что воркер ещё держит
 * отменённую задачу, пока не отзовётся; поздний `complete` обмен не оживает, а «Повторить»
 * ставит новую задачу.
 */

const QUEUE_QUESTION = 'Что в этом PR ломается, если откатить миграцию?';
const QUEUE_ANSWER = [
    'Откат миграции снимает колонку с границами окна, а код читает её без проверки на null.',
    'Первый же запрос после отката упадёт на разборе строки, а не на самой миграции.',
    '',
    'Порядок безопасного отката такой:',
    '',
    '- сначала выключить окно редактирования флагом;',
    '- потом снять колонку.',
].join('\n');
const CANCEL_QUESTION = 'Что тут может сломаться при повторной отправке?';
const LATE_ANSWER = 'Поздний ответ на отменённый вопрос: его никто уже не ждёт.';
const RETRY_ANSWER = 'Повторная отправка защищена ключом идемпотентности, второй записи не появится.';

test('F2 очередь: вопрос во время генерации ждёт один шаг, UI честно показывает очередь', async ({
    page,
    launchSherpa,
}) => {
    const server = await launchSherpa('fixture-medium');
    const worker = server.worker;

    const section = await test.step('план сдан, воркер держит первую секцию', async () => {
        await page.goto(server.url);
        await page.getByRole('tab', { name: 'Маршрут', exact: true }).click();
        expect((await worker.register('claude-code')).code).toBe(0);

        const skeleton = await takeTask(worker, 'route.skeleton');
        await submit(worker, skeleton.taskId, mediumRawResults().skeleton);
        await expect(page.locator('.route-skeleton-card')).toHaveCount(6);

        // Аренда не сдаётся до конца шага: ровно та ситуация, в которой ревьюер задаёт вопрос.
        const held = await takeTask(worker, 'route.section');
        // Шесть секций поставлены разом: одна в аренде, пять ждут.
        await expect(pillLabel(page)).toHaveText('Агент работает · 6 в очереди');
        return held;
    });

    await test.step('вопрос встаёт в очередь: баннер маршрута и +1 к индикатору', async () => {
        await page.locator('.agent-pill').click();
        await expect(page.locator('.chat-panel')).toBeVisible();

        const question = page.getByRole('textbox', { name: 'Вопрос агенту' });
        await question.click();
        await question.pressSequentially(QUEUE_QUESTION);
        await question.press('Enter');

        await expect(page.locator('.chat-message--you .chat-message__body')).toHaveText(QUEUE_QUESTION);
        await expect(page.locator('.chat-panel__queue')).toHaveText('Генерирую маршрут · ваш вопрос следующий');
        // Пять невзятых секций + аренда воркера + сам вопрос.
        await expect(pillLabel(page)).toHaveText('Агент работает · 7 в очереди');
        // Пока обмен queued, ответной реплики в ленте нет вовсе.
        await expect(page.locator('.chat-message--agent')).toHaveCount(0);
    });

    await test.step('сдана секция — следующая задача воркера именно чат, а не остаток маршрута', async () => {
        await submit(worker, section.taskId, sectionFor(section.planIndexes));

        // Центральная проверка очереди: пять route.section ещё в очереди, но interactive идёт первым.
        const chat = await takeTask(worker, 'chat');
        await expect(page.locator('.chat-panel__queue')).toHaveCount(0);
        await expect(page.locator('.chat-message--agent .chat-message__activity')).toContainText('Отвечаю');

        await answerChat(worker, chat.taskId, QUEUE_ANSWER);
    });

    await test.step('ответ в панели, заметки нет — якоря у вопроса не было', async () => {
        const answer = page.locator('.chat-message--agent .chat-message__body');
        await expect(answer.locator('li')).toHaveText([
            'сначала выключить окно редактирования флагом;',
            'потом снять колонку.',
        ]);
        await expect(page.locator('.chat-message__note')).toHaveCount(0);
        await expect(page.locator('.chat-panel__notes')).toHaveCount(0);
        await expect(page.locator('.agent-note--collapsed')).toHaveCount(0);
    });

    await test.step('маршрут дособирается остатком секций', async () => {
        await fillSections(worker, 5);

        await expect(page.locator('.coverage__legend-text')).toHaveText(
            '866 изменённых строк · 95% объяснено · 38 строк не объяснено',
        );
        await expect(page.locator('.route-skeleton-card')).toHaveCount(0);
    });
});

test('F2 очередь: отмена в полёте гасит обмен, поздний ответ — no-op, Повторить доводит до ответа', async ({
    page,
    launchSherpa,
}) => {
    const server = await launchSherpa('fixture-medium');
    const worker = server.worker;

    await test.step('маршрут готов, вопрос взят воркером в работу', async () => {
        await page.goto(server.url);
        await page.getByRole('tab', { name: 'Маршрут', exact: true }).click();
        expect((await worker.register('claude-code')).code).toBe(0);
        await buildRoute(worker);
        await expect(page.locator('.route-skeleton-card')).toHaveCount(0);

        await page.locator('.agent-pill').click();
        const question = page.getByRole('textbox', { name: 'Вопрос агенту' });
        await question.click();
        await question.pressSequentially(CANCEL_QUESTION);
        await question.press('Enter');
    });

    const cancelled = await test.step('«Остановить» переводит обмен в отменённый', async () => {
        const chat = await takeTask(worker, 'chat');
        await page.getByRole('button', { name: 'Остановить', exact: true }).click();

        await expect(page.locator('.chat-message--failed .chat-message__body')).toHaveText('Вопрос отменён.');
        await expect(page.getByRole('button', { name: 'Повторить', exact: true })).toBeVisible();

        // Задача отменена, но воркер об этом ещё не знает — держание живо (docs/protocol.md §5).
        await expect(page.locator('.chat-panel__cancelled-lease')).toHaveText(
            'Агент ещё занят отменённой задачей — узнает об отмене при следующем обращении',
        );
        await expect(pillLabel(page)).toHaveText('Агент работает · 1 в очереди');
        return chat;
    });

    await test.step('поздний complete отменённой задачи — no-op и для сервера, и для ленты', async () => {
        const late = await worker.complete(cancelled.taskId, LATE_ANSWER);
        expect(late.code, late.stderr).toBe(0);
        expect(late.stdout).toContain('has been cancelled');

        // Воркер отозвался — держание снято, агент снова свободен.
        await expect(page.locator('.chat-panel__cancelled-lease')).toHaveCount(0);
        await expect(pillLabel(page)).not.toHaveText(/Агент работает/);
        await expect(page.locator('.chat-message--failed .chat-message__body')).toHaveText('Вопрос отменён.');
        await expect(page.getByText(LATE_ANSWER, { exact: true })).toHaveCount(0);
    });

    await test.step('«Повторить» ставит новую задачу чата, ответ доезжает', async () => {
        await page.getByRole('button', { name: 'Повторить', exact: true }).click();

        const retried = await takeTask(worker, 'chat');
        expect(retried.taskId).not.toBe(cancelled.taskId);
        await answerChat(worker, retried.taskId, RETRY_ANSWER);

        // Обмен один — «Повторить» переоткрывает его, а не заводит второй вопрос.
        await expect(page.locator('.chat-message--you .chat-message__body')).toHaveText(CANCEL_QUESTION);
        await expect(page.locator('.chat-message--agent .chat-message__body')).toHaveText(RETRY_ANSWER);
        await expect(page.getByText(LATE_ANSWER, { exact: true })).toHaveCount(0);
    });
});

function pillLabel(page: Page): Locator {
    return page.locator('.agent-pill__label');
}

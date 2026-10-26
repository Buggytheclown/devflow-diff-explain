import type { Locator, Page } from '@playwright/test';
import type { FixtureIterationView } from '@sherpa/fixtures';
import { fixtureIteration } from '@sherpa/fixtures';

import { answerChat, buildRoute, takeTask } from './route-worker.js';
import type { SherpaServerHandle } from './sherpa-fixture.js';
import { expect, test } from './sherpa-fixture.js';

/**
 * F2 (docs/product.md §7): по готовому маршруту ревьюер выделяет строки, спрашивает о них агента, получает
 * ответ в панели и заметку у тех же строк, превращает заметку в блокирующий черновик и возвращает
 * PR на доработку.
 *
 * Агент — тот же бандл CLI, что и в F1; ответ чата он сдаёт markdown-текстом, а не JSON маршрута.
 */

/** Первая остановка полного тура с кодом: единственный файл, строки 1–14 добавлены целиком. */
const STOP = 's01';
const FILE = 'edit-window.ts';
const ANCHOR = `${FILE}:3–5`;
const QUESTION = 'Почему окно редактирования считается именно здесь?';
const PROGRESS = 'Читаю edit-window.ts и соседние вызовы';
const ANSWER = [
    'Окно редактирования собирается из настроек заказа и текущего времени. Источник времени класс',
    'получает через конструктор, поэтому в тестах его подменяют, а в проде приходит системный.',
    '',
    'В этом диапазоне стоит проверить три вещи:',
    '',
    '- границы считаются в UTC, а показываются в часовом поясе пользователя;',
    '- нулевая длительность запрещена проверкой выше по стеку;',
    '- нижняя граница сравнивается включительно.',
    '',
    'Теста на переход через полночь в PR нет — его имеет смысл попросить у автора.',
].join('\n');
/** Список ответа: по нему видно, что в панели именно отрендеренный markdown, а не сырой текст. */
const ANSWER_ITEMS = [
    'границы считаются в UTC, а показываются в часовом поясе пользователя;',
    'нулевая длительность запрещена проверкой выше по стеку;',
    'нижняя граница сравнивается включительно.',
];
const DRAFT_TAIL = 'E2E F2: без теста на переход через полночь это не мержится.';
/** «Я» фикстуры: автор черновиков, которые ревьюер сохраняет и публикует. */
const ME = fixtureIteration('medium').currentUser.login;

test('F2: выделение → вопрос агенту → ответ и заметка → черновик → request changes', async ({
    page,
    launchSherpa,
}) => {
    const server = await launchSherpa('fixture-medium');
    const worker = server.worker;

    await test.step('маршрут собран, ревьюер идёт полным туром', async () => {
        await page.goto(server.url);
        await page.getByRole('tab', { name: 'Маршрут', exact: true }).click();
        expect((await worker.register('claude-code')).code).toBe(0);
        await buildRoute(worker);

        await expect(page.locator('.route-skeleton-card')).toHaveCount(0);
        await page.keyboard.press('t');
        await expect(page.getByRole('button', { name: 'Полный тур', exact: true })).toHaveAttribute(
            'aria-pressed',
            'true',
        );
        await expect(card(page).locator('.file-card__name')).toHaveText(FILE);
    });

    await test.step('протяжка по гаттеру выделяет три строки, поповер зовёт агента', async () => {
        await dragSelectLines(page, 'a3', 'a5');

        await expect(page.locator('.selection-popover__count')).toHaveText('3 строки выделены');
        await page.getByRole('button', { name: 'Спросить агента', exact: true }).click();

        await expect(page.locator('.chat-panel')).toBeVisible();
        // Диапазон переехал в композер чипом: basename на экране, полный путь — в title.
        await expect(page.locator('.chat-panel__context--anchor')).toHaveAttribute('title', new RegExp(`/${ANCHOR}$`));
        await expect(page.locator('.chat-panel__context-label')).toHaveText(ANCHOR);
    });

    await test.step('вопрос уходит по ⏎: реплика с якорем, поповер и индикатор показывают полёт', async () => {
        const question = page.getByRole('textbox', { name: 'Вопрос агенту' });
        await expect(question).toBeFocused();
        await question.pressSequentially(QUESTION);
        await question.press('Enter');

        await expect(page.locator('.chat-message--you .chat-message__body')).toHaveText(QUESTION);
        await expect(page.locator('.chat-message__anchor')).toHaveText(`↳ ${ANCHOR}`);
        await expect(page.locator('.selection-popover--chip')).toHaveText('спрошено · ответ появится здесь');
        await expect(page.locator('.agent-pill__label')).toHaveText('Агент работает · 1 в очереди');
    });

    await test.step('агент берёт задачу чата, строка прогресса видна в панели', async () => {
        const chat = await takeTask(worker, 'chat');
        expect((await worker.progress(chat.taskId, PROGRESS)).code).toBe(0);
        await expect(page.locator('.chat-message__progress')).toHaveText(PROGRESS);

        await answerChat(worker, chat.taskId, ANSWER);
    });

    await test.step('ответ отрендерен markdown-ом, закреплён заметкой у тех же строк', async () => {
        const answer = page.locator('.chat-message--agent .chat-message__body');
        await expect(answer.locator('li')).toHaveText(ANSWER_ITEMS);
        await expect(answer.locator('p')).toHaveCount(3);
        await expect(page.locator('.chat-message__note')).toHaveText(`◆ Закреплено заметкой у ${ANCHOR}`);
        await expect(page.locator('.chat-panel__notes')).toHaveText('Заметки 1');

        await expectNoteAtLines(page);
    });

    await test.step('заметка и история переживают перезагрузку, панель открывается индикатором', async () => {
        await page.reload();

        await expectNoteAtLines(page);
        await expect(page.locator('.chat-panel')).toHaveCount(0);
        await page.locator('.agent-pill').click();
        await expect(page.locator('.chat-message--you .chat-message__body')).toHaveText(QUESTION);
        // Ответ поднимается из обмена, а не из заметки: у заметки своя копия текста.
        await expect(page.locator('.chat-message--agent .chat-message__body li')).toHaveText(ANSWER_ITEMS);
        await expect(page.locator('.chat-panel__notes')).toHaveText('Заметки 1');
    });

    await test.step('«В черновик комментария»: композер у тех же строк с цитатой и issue', async () => {
        // Панель агента сузила колонку и пересобрала раскладку: к остановке снова подъезжаем.
        await stop(page).scrollIntoViewIfNeeded();
        await card(page).getByRole('button', { name: 'В черновик комментария', exact: true }).click();

        const composer = card(page).locator('.thread-composer');
        await expect(composer.locator('.thread-composer__context')).toHaveCount(0);

        await expect(composer).toContainText('Процитировано из ответа агента:');
        await expect(composer).toContainText('Окно редактирования собирается из настроек заказа');

        // Markdown-раскладка того же композера: дописать своё под цитату, не разбирая её вручную.
        await composer.getByRole('button', { name: 'Markdown', exact: true }).click();
        const input = composer.getByRole('textbox', { name: 'Новый комментарий' });
        const quoted = await input.inputValue();
        expect(quoted.startsWith('Процитировано из ответа агента:')).toBe(true);
        expect(quoted).toContain('> Окно редактирования собирается из настроек заказа');
        await input.fill(`${quoted}\n\n${DRAFT_TAIL}`);

        // Хост фикстуры умеет issue, и новый комментарий открывается блокирующим по умолчанию.
        await expect(composer.getByRole('switch', { name: 'Открыть issue, включено' })).toHaveAttribute(
            'aria-checked',
            'true',
        );
        await composer.getByRole('button', { name: 'Сохранить черновик', exact: true }).click();
        await expect(input).toHaveCount(0);
    });

    await test.step('черновик сохранён блокирующим, заметка на месте', async () => {
        await expect(card(page).getByText(DRAFT_TAIL, { exact: true })).toBeVisible();
        await expect(card(page).locator('.thread__chip--draft')).toHaveText('draft');
        await expect(page.locator('.review-action-bar')).toContainText('1 черновик уйдёт при публикации');
        await expect(card(page).locator('.agent-note--expanded')).toHaveCount(1);
        await expect(page.locator('.chat-panel__notes')).toHaveText('Заметки 1');

        // Блокирующий характер комментария в UI ничем не показан — читаем его из контракта.
        const saved = await myComments(page, server);
        expect(saved.map((comment) => ({ draft: comment.draft, issue: comment.issue }))).toEqual([
            { draft: true, issue: true },
        ]);
        expect(saved[0]?.body).toContain(DRAFT_TAIL);
    });

    await test.step('request changes публикует один блокирующий комментарий, заметка в хост не уходит', async () => {
        await page.getByRole('button', { name: /^Request changes/ }).click();

        await expect(page.getByRole('heading', { name: 'Запрошены изменения · PR 4821', exact: true })).toBeVisible();
        // Опубликован ровно один комментарий — заметка агента живёт только в Шерпе (docs/design/SPEC-elements.md §2.16).
        await expect(counter(page, 'Комментариев опубликовано')).toHaveText('1 (из них 0 ответов)');

        // Тот же комментарий у хоста: черновиком быть перестал, issue публикацию пережил.
        const published = await myComments(page, server);
        expect(published.map((comment) => ({ draft: comment.draft, issue: comment.issue }))).toEqual([
            { draft: false, issue: true },
        ]);
    });
});

/**
 * Протяжка мышью по гаттеру строки: тот же путь событий, что у ревьюера — mousedown по номеру
 * строки, mousemove с зажатой кнопкой до конечной строки, mouseup. По коду мышь оставлена
 * нативному выделению текста, поэтому тянуть надо именно за гаттер (`file-card.tsx`).
 */
async function dragSelectLines(page: Page, fromKey: string, toKey: string): Promise<void> {
    const gutter = (key: string): Locator =>
        card(page).locator(`.diff-row[data-key="${key}"] .diff-row__gutter`).first();
    await gutter(fromKey).scrollIntoViewIfNeeded();
    const from = await gutter(fromKey).boundingBox();
    const to = await gutter(toKey).boundingBox();
    if (from === null || to === null) {
        throw new Error(`строки ${fromKey}–${toKey} не отрисованы`);
    }

    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 6 });
    await page.mouse.up();
}

/** Заметка у своего диапазона: свёрнутая строка раскрывается кликом и называет те же строки. */
async function expectNoteAtLines(page: Page): Promise<void> {
    // Колонка диффа далёкой остановки снята с DOM: подъезжаем к секции, как ревьюер.
    await stop(page).scrollIntoViewIfNeeded();
    const collapsed = card(page).locator('.agent-note--collapsed');
    await expect(collapsed).toContainText('Заметка агента');
    await collapsed.click();
    await expect(card(page).locator('.agent-note--expanded .agent-note__header')).toContainText(
        'Заметка агента · спрошено у строк 3–5',
    );
}

type HostThread = FixtureIterationView['threads'][number];
type HostComment = HostThread['root'];

/**
 * Комментарии ревьюера прямо из ревью-контракта (`GET review/threads`): issue-флаг и
 * «черновик/опубликован» в UI не показаны, а хост их хранит. Токен сервера лежит во фрагменте
 * ссылки, которую печатает `devflow-diff-explain up`, — тем же токеном ходит и UI.
 */
async function myComments(page: Page, server: SherpaServerHandle): Promise<readonly HostComment[]> {
    const url = new URL(server.url);
    const token = new URLSearchParams(url.hash.slice(1)).get('t') ?? '';
    const response = await page.request.get(new URL('/api/ui/review/threads', url.origin).href, {
        headers: { Authorization: `Bearer ${token}` },
    });
    expect(response.status(), await response.text()).toBe(200);
    const body = (await response.json()) as { readonly threads: readonly HostThread[] };
    return body.threads
        .flatMap((thread) => flattenComments(thread.root))
        .filter((comment) => comment.author.login === ME);
}

function flattenComments(comment: HostComment): HostComment[] {
    return [comment, ...comment.replies.flatMap((reply) => flattenComments(reply))];
}

function stop(page: Page): Locator {
    return page.locator(`[data-stop="${STOP}"]`);
}

/** Карточка целевого файла: в остановке их несколько, и `data-key` строк в них повторяются. */
function card(page: Page): Locator {
    return stop(page)
        .locator('.file-card')
        .filter({ has: page.locator('.file-card__name', { hasText: FILE }) });
}

function counter(page: Page, label: string): Locator {
    return page.locator('.review-complete__counter').filter({ hasText: label }).locator('dd');
}

import type { ChatExchange } from '@sherpa/protocol';
import { describe, expect, it } from 'vitest';

import { CHAT_RECENT_LIMIT, searchChat } from './chat-search.js';

function exchange(id: number, question: string, answer: string | null, createdAt: string): ChatExchange {
    return {
        id,
        question,
        anchor: null,
        status: answer === null ? 'queued' : 'done',
        taskId: null,
        answer,
        progressText: null,
        error: null,
        locale: null,
        createdAt,
        updatedAt: createdAt,
    };
}

const HISTORY: readonly ChatExchange[] = Array.from({ length: 12 }, (_, index) =>
    exchange(
        index + 1,
        `Вопрос ${String(index + 1)}`,
        `Ответ ${String(index + 1)}`,
        `2026-08-20T09:${String(index + 10).padStart(2, '0')}:00.000Z`,
    ),
);

describe('searchChat', () => {
    it('пустой запрос отдаёт последние обмены, новые сверху', () => {
        const found = searchChat(HISTORY, '', 50);

        expect(found.exchanges).toHaveLength(CHAT_RECENT_LIMIT);
        expect(found.exchanges.map((item) => item.id)).toEqual([12, 11, 10, 9, 8, 7, 6, 5]);
        // Отсечка последних — не обрезка поиска: подпись о лимите здесь не при чём.
        expect(found.truncated).toBe(false);
    });

    it('одинаковое время разводит id, новые сверху', () => {
        const same = [
            exchange(1, 'Первый', null, '2026-08-20T09:00:00.000Z'),
            exchange(2, 'Второй', null, '2026-08-20T09:00:00.000Z'),
        ];

        expect(searchChat(same, '', 50).exchanges.map((item) => item.id)).toEqual([2, 1]);
    });

    it('ищет подстроку в вопросе и в ответе без учёта регистра', () => {
        const history = [
            exchange(1, 'Почему окно 30 минут?', 'Оно закрывается по дедлайну.', '2026-08-20T09:10:00.000Z'),
            exchange(2, 'Что с курьером?', 'Дедлайн проверяется до отправки.', '2026-08-20T09:11:00.000Z'),
            exchange(3, 'Есть ли риск утечки?', null, '2026-08-20T09:12:00.000Z'),
        ];

        expect(searchChat(history, 'ДЕДЛАЙН', 50).exchanges.map((item) => item.id)).toEqual([2, 1]);
        expect(searchChat(history, 'курьер', 50).exchanges.map((item) => item.id)).toEqual([2]);
        expect(searchChat(history, 'утечки', 50).exchanges.map((item) => item.id)).toEqual([3]);
        expect(searchChat(history, 'кэш', 50).exchanges).toEqual([]);
    });

    it('не нечёткий: подпоследовательность букв не считается совпадением', () => {
        const history = [exchange(1, 'Почему окно 30 минут?', 'Оно закрывается по дедлайну.', '2026-08-20T09:10:00.000Z')];

        expect(searchChat(history, 'пчм', 50).exchanges).toEqual([]);
    });

    it('обрезает выдачу поиска по лимиту и сообщает об этом', () => {
        const found = searchChat(HISTORY, 'вопрос', 3);

        expect(found.exchanges.map((item) => item.id)).toEqual([12, 11, 10]);
        expect(found.truncated).toBe(true);
        expect(searchChat(HISTORY, 'вопрос', 50).truncated).toBe(false);
    });
});

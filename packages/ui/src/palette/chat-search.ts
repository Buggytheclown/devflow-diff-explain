import type { ChatExchange } from '@sherpa/protocol';

/** Сколько последних обменов показывает пустой `@` (docs/design/SPEC-elements.md §2.18). */
export const CHAT_RECENT_LIMIT = 8;

export interface ChatSearchResult {
    readonly exchanges: readonly ChatExchange[];
    readonly truncated: boolean;
}

/**
 * История чата под запрос палитры. Поиск подстрочный, а не нечёткий: по длинным ответам
 * подпоследовательность матчит почти всё, и выдача перестаёт что-либо значить.
 */
export function searchChat(exchanges: readonly ChatExchange[], query: string, limit: number): ChatSearchResult {
    const needle = query.trim().toLowerCase();
    const sorted = [...exchanges].sort(
        (left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt) || right.id - left.id,
    );
    if (needle === '') {
        return { exchanges: sorted.slice(0, CHAT_RECENT_LIMIT), truncated: false };
    }
    const found = sorted.filter(
        (exchange) =>
            exchange.question.toLowerCase().includes(needle) ||
            exchange.answer?.toLowerCase().includes(needle) === true,
    );
    return { exchanges: found.slice(0, limit), truncated: found.length > limit };
}

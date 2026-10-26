import type { PrMeta } from '@sherpa/protocol';

/** Сегмент брендкрамба топ-бара; `href: null` — обычный текст. */
export interface BreadcrumbSegment {
    readonly text: string;
    readonly href: string | null;
}

/**
 * Ключ PR — `<host>-<pr>` (см. `prKeySchema` протокола). Разобранный ключ — запасной брендкрамб:
 * им топ-бар живёт, пока мета PR не приехала в снапшоте.
 */
export function breadcrumbFromPrKey(prKey: string): readonly string[] {
    const separator = prKey.indexOf('-');
    if (separator <= 0 || separator === prKey.length - 1) {
        return [prKey];
    }
    return [prKey.slice(0, separator), `PR ${prKey.slice(separator + 1)}`];
}

/**
 * Заголовок вкладки браузера: `<заголовок PR> · Sherpa`, до прихода меты — номер из ключа PR.
 * Пустым не бывает: без ключа и меты остаётся одно имя продукта.
 */
export function documentTitleFor(prKey: string, pr: PrMeta | null): string {
    const title = pr?.title.trim() ?? '';
    const head = title === '' ? (breadcrumbFromPrKey(prKey).at(-1)?.trim() ?? '') : title;
    return head === '' ? 'Sherpa' : `${head} · Sherpa`;
}

/** Брендкрамб топ-бара: с приходом меты последний сегмент ведёт на PR у хоста. */
export function breadcrumbFor(prKey: string, pr: PrMeta | null): readonly BreadcrumbSegment[] {
    const fallback = breadcrumbFromPrKey(prKey).map((text) => ({ text, href: null }));
    if (pr === null) {
        return fallback;
    }
    // Номер из меты вытесняет номер из ключа; хост-сегмент остаётся как был.
    const head = fallback.length > 1 ? fallback.slice(0, -1) : fallback;
    return [...head, { text: `PR ${pr.id}`, href: pr.url }];
}

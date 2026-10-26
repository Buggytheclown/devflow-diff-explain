/**
 * Выбор цели для клавиш перемещения (docs/design/SPEC-elements.md §5: `j`/`k`, `n`/`p`). Обе вью считают цель
 * одинаково — по своему списку записей и своему признаку «просмотрено», — поэтому сам выбор
 * живёт здесь, отдельно от прокрутки и от React.
 */

/**
 * Сосед по списку без цикла: конец списка — `null`, и вью ничего не делает. Когда текущей
 * записи нет (ещё не было прокрутки, запись ушла под фильтр), целью становится первая.
 */
export function neighbourId<T>(
    items: readonly T[],
    currentId: string | null,
    direction: 1 | -1,
    idOf: (item: T) => string,
): string | null {
    if (items.length === 0) {
        return null;
    }
    const index = currentId === null ? -1 : items.findIndex((item) => idOf(item) === currentId);
    if (index < 0) {
        const first = items[0];
        return first === undefined ? null : idOf(first);
    }
    const next = items[index + direction];
    return next === undefined ? null : idOf(next);
}

/**
 * Ближайшая непросмотренная запись в заданную сторону, циклически: с конца списка поиск
 * продолжается с начала (docs/design/SPEC-elements.md §5, `n`/`p`). `null` — непросмотренных нет вовсе.
 */
export function unreadNeighbourId<T>(
    items: readonly T[],
    currentId: string | null,
    direction: 1 | -1,
    idOf: (item: T) => string,
    unread: (item: T) => boolean,
): string | null {
    const count = items.length;
    if (count === 0) {
        return null;
    }
    const found = currentId === null ? -1 : items.findIndex((item) => idOf(item) === currentId);
    // Текущей записи нет — ищем от края: вперёд с начала, назад с конца.
    const start = found < 0 ? (direction === 1 ? -1 : count) : found;
    for (let step = 1; step <= count; step += 1) {
        const index = (((start + direction * step) % count) + count) % count;
        const item = items[index];
        if (item !== undefined && unread(item)) {
            return idOf(item);
        }
    }
    return null;
}

/**
 * Подгонка контекстных файлов задачи под бюджет (docs/protocol.md §4): общая механика для payload
 * чата и маршрута. Правило одно на всех: «не больше N байт» считается по готовому файлу
 * целиком, а урезанный кусок честно помечен, чтобы модель не приняла обрубок за полный текст.
 */

/** Файл payload, ещё не собранный: рендер зовётся уже зная, сколько байт ему осталось. */
export interface PayloadFileSpec {
    readonly name: string;
    readonly order: number;
    /** Место, которое файл занимает в бюджете в самом худшем случае: честная пометка вместо текста. */
    readonly minimum: string;
    readonly render: (maxBytes: number) => string;
}

/**
 * Приоритет — порядок массива; `order` задаёт только порядок путей в задаче. На остаток всегда
 * резервируется честная пометка для ещё не собранных файлов.
 */
export function fitPayloadFiles(
    specs: readonly PayloadFileSpec[],
    budgetBytes: number,
): { name: string; content: string; order: number }[] {
    const budget = Math.max(0, budgetBytes);
    const files: { name: string; content: string; order: number }[] = [];
    let used = 0;

    for (let index = 0; index < specs.length; index += 1) {
        const spec = specs[index];
        if (spec === undefined) {
            continue;
        }
        const reserve = specs.slice(index + 1).reduce((total, next) => total + byteLength(next.minimum), 0);
        const maxBytes = Math.max(0, budget - used - reserve);
        const content = fitText(spec.render(maxBytes), maxBytes, spec.minimum);
        used += byteLength(content);
        files.push({ name: spec.name, content, order: spec.order });
    }

    return files;
}

/** Пометка вместо содержимого: файл в задаче остаётся, но врать полнотой не должен. */
export function unavailableBlock(heading: string, reason: string): string {
    return `# ${heading}\n\n[TRUNCATED: ${reason}]\n`;
}

/** Текст под потолок в байтах: хвост уходит, на его месте — пометка; не влезла и она — `fallback`. */
export function fitText(text: string, maxBytes: number, fallback: string): string {
    const max = Math.max(0, maxBytes);
    if (byteLength(text) <= max) {
        return text;
    }
    if (byteLength(fallback) >= max) {
        return truncateUtf8(fallback, max);
    }
    const marker = '\n\n[TRUNCATED: remaining content omitted by the payload budget.]\n';
    if (byteLength(marker) >= max) {
        return truncateUtf8(fallback, max);
    }
    const prefix = truncateUtf8(text, max - byteLength(marker)).trimEnd();
    return `${prefix}${marker}`;
}

/** Обрезка по байтам, не разрывающая суррогатную пару. */
export function truncateUtf8(text: string, maxBytes: number): string {
    if (maxBytes <= 0) {
        return '';
    }
    let low = 0;
    let high = text.length;
    while (low < high) {
        const middle = Math.ceil((low + high) / 2);
        if (byteLength(text.slice(0, middle)) <= maxBytes) {
            low = middle;
        } else {
            high = middle - 1;
        }
    }
    let end = low;
    if (end > 0 && /[\uD800-\uDBFF]/.test(text.charAt(end - 1))) {
        end -= 1;
    }
    return text.slice(0, end);
}

export function byteLength(text: string): number {
    return Buffer.byteLength(text, 'utf8');
}

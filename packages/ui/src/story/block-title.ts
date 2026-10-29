/** Номер задаёт порядок маршрута; сохранённый префикс модели не дублируем. */
export function numberedBlockTitle(title: string, index: number): string {
    const text = title.replace(/^(?:\s*\d+(?:\.\d+)*[.)](?!\d)\s*)+/u, '').trim();
    return `${String(index + 1)}. ${text}`;
}

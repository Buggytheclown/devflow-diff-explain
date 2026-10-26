/** Циклически двигает единый курсор по исполнимым строкам. */
export function movePaletteCursor(current: number, count: number, delta: -1 | 1): number {
    if (count <= 0) {
        return -1;
    }
    if (current < 0 || current >= count) {
        return delta === 1 ? 0 : count - 1;
    }
    return (current + delta + count) % count;
}

/** Доводит активную строку палитры внутри её прокручиваемого списка. */
export function scrollPaletteCursor(container: ParentNode | null, index: number): void {
    container
        ?.querySelector<HTMLElement>(`[data-index="${String(index)}"]`)
        ?.scrollIntoView({ block: 'nearest' });
}

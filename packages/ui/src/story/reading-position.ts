import type { CodeLocation } from '@sherpa/protocol';

import { lineKeyNumbers } from '../diff-view/selection.js';

export interface ReadingPosition { address: string; offset: number }

export function readingTop(): number {
    const bar = document.querySelector('.story-topbar')?.getBoundingClientRect().bottom ?? 0;
    const selection = document.querySelector('.story-main .story-selection')?.getBoundingClientRect();
    return Math.max(bar, selection !== undefined && selection.top <= bar + 1 ? selection.bottom : 0) + 12;
}

function addressed(root: HTMLElement): { element: HTMLElement; address: string }[] {
    return [...root.querySelectorAll<HTMLElement>('[data-reading], .diff-row[data-key]')].map((element) => ({
        element, address: element.dataset.reading ?? `line:${element.dataset.key ?? ''}`,
    }));
}

export function capturePosition(root: HTMLElement): ReadingPosition | null {
    const top = readingTop();
    const all = addressed(root);
    const entries = all.some((entry) => entry.address.startsWith('line:')) ? all.filter((entry) => entry.address !== 'file') : all;
    const target = entries.find(({ element }) => element.getBoundingClientRect().bottom > top) ?? entries.at(-1);
    return target === undefined ? null : { address: target.address, offset: target.element.getBoundingClientRect().top - top };
}

export function restorePosition(root: HTMLElement, position: ReadingPosition): boolean {
    const target = addressed(root).find((entry) => entry.address === position.address)?.element;
    if (target === undefined) return false;
    // Sticky-панель меняет границу чтения после первого скролла. Сходимся к ней,
    // иначе каждый возврат теряет высоту панели выделения.
    for (let i = 0; i < 3; i += 1) {
        const delta = target.getBoundingClientRect().top - readingTop() - position.offset;
        if (Math.abs(delta) <= 1) break;
        window.scrollBy({ top: delta, behavior: 'instant' });
    }
    return true;
}

export function revealCode(root: HTMLElement, location: CodeLocation): boolean {
    const row = [...root.querySelectorAll<HTMLElement>('.diff-row[data-key]')].find((element) =>
        lineKeyNumbers(element.dataset.key ?? '')?.[location.side] === location.start);
    if (row === undefined) return false;
    window.scrollBy({ top: row.getBoundingClientRect().top - readingTop(), behavior: 'instant' });
    return true;
}

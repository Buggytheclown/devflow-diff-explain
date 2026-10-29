import type { CodeLocation } from '@sherpa/protocol';

import { lineKeyNumbers } from '../diff-view/selection.js';

export interface ReadingPosition { address: string; offset: number }

export function readingTop(): number {
    const bar = Math.max(document.querySelector('.story-preparation')?.getBoundingClientRect().bottom ?? 0, document.querySelector('.story-topbar')?.getBoundingClientRect().bottom ?? 0);
    return bar + 12;
}

export function readingFocus(element: HTMLElement): string | undefined {
    if (element.dataset.readingFocus !== undefined) return element.dataset.readingFocus;
    if (!element.matches('.diff-row[data-key]')) return undefined;
    return qualified(element, `line:${element.dataset.key ?? ''}`);
}

function qualified(element: HTMLElement, address: string): string {
    const id = element.closest<HTMLElement>('[data-reading-file]')?.dataset.readingFile;
    return id === undefined ? address : `file:${id}/${address}`;
}

function addressed(root: HTMLElement): { element: HTMLElement; address: string }[] {
    return [...root.querySelectorAll<HTMLElement>('[data-reading], .diff-row[data-key]')].map((element) => ({
        element, address: qualified(element, element.dataset.reading ?? `line:${element.dataset.key ?? ''}`),
    }));
}

export function capturePosition(root: HTMLElement): ReadingPosition | null {
    const top = readingTop();
    const all = addressed(root);
    // Пока конкретный файл разбирается, его карточка остаётся якорем,
    // даже если строки других файлов уже появились выше или ниже.
    const entries = all.filter((entry) => entry.element.dataset.reading !== 'file' || entry.element.querySelector('.diff-row') === null);
    const target = entries.find(({ element }) => element.getBoundingClientRect().bottom > top) ?? entries.at(-1);
    return target === undefined ? null : { address: target.address, offset: target.element.getBoundingClientRect().top - top };
}

export function restorePosition(root: HTMLElement, position: ReadingPosition): boolean {
    const target = addressed(root).find((entry) => entry.address === position.address)?.element;
    if (target === undefined) return false;
    // После изменения раскладки сверяем положение по видимому тексту.
    for (let i = 0; i < 3; i += 1) {
        const delta = target.getBoundingClientRect().top - readingTop() - position.offset;
        if (Math.abs(delta) <= 1) break;
        window.scrollBy({ top: delta, behavior: 'instant' });
    }
    // Короткий ещё загружающийся холст может ограничить scrollY.
    // Не принимаем эту промежуточную позицию за восстановленную.
    return Math.abs(target.getBoundingClientRect().top - readingTop() - position.offset) <= 1 || root.querySelector('[data-reading-wait]') === null;
}

export function revealCode(root: HTMLElement, location: CodeLocation): boolean {
    const row = [...root.querySelectorAll<HTMLElement>('.diff-row[data-key]')].find((element) =>
        lineKeyNumbers(element.dataset.key ?? '')?.[location.side] === location.start && (() => {
            const file = element.closest<HTMLElement>('[data-reading-file]');
            return file === null || (location.side === 'old' ? file.dataset.fileOldPath : file.dataset.filePath) === location.path;
        })());
    if (row === undefined) return false;
    window.scrollBy({ top: row.getBoundingClientRect().top - readingTop(), behavior: 'instant' });
    return true;
}

/** Оглавление прокручивает ту же ленту; файл и строки не перемонтируются. */
export function revealGuidePage(root: HTMLElement, page: string): boolean {
    const target = [...root.querySelectorAll<HTMLElement>('[data-guide-page]')].find((element) => element.dataset.guidePage === page);
    if (target === undefined) return false;
    window.scrollBy({ top: target.getBoundingClientRect().top - readingTop(), behavior: 'instant' });
    return true;
}

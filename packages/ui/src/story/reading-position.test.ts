// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { capturePosition, readingFocus, restorePosition, revealCode } from './reading-position.js';

afterEach(() => { document.body.replaceChildren(); vi.restoreAllMocks(); });

it('одинаковые номера строк в разных файлах имеют разные адреса и ссылки', () => {
    const root = document.createElement('main'); document.body.append(root);
    root.innerHTML = '<div data-reading-file="one" data-file-path="one.ts" data-file-old-path="old-one.ts"><div class="diff-row" data-key="a1"></div></div><div data-reading-file="two" data-file-path="two.ts" data-file-old-path="old-two.ts"><div class="diff-row" data-key="a1"></div></div>';
    const first = root.querySelector<HTMLElement>('[data-reading-file="one"] .diff-row');
    const second = root.querySelector<HTMLElement>('[data-reading-file="two"] .diff-row');
    if (first === null || second === null) throw new Error('Missing rows');
    vi.spyOn(first, 'getBoundingClientRect').mockReturnValue({ top: -100, bottom: -80 } as DOMRect);
    vi.spyOn(second, 'getBoundingClientRect').mockReturnValue({ top: 80, bottom: 100 } as DOMRect);
    const scroll = vi.spyOn(window, 'scrollBy').mockImplementation(() => undefined);
    expect(readingFocus(first)).not.toBe(readingFocus(second));
    const position = capturePosition(root); expect(position?.address).toBe('file:two/line:a1');
    expect(revealCode(root, { path: 'two.ts', side: 'new', start: 1, end: 1 })).toBe(true);
    expect(scroll).toHaveBeenLastCalledWith({ top: 68, behavior: 'instant' });
    scroll.mockClear();
    expect(restorePosition(root, { address: 'file:two/line:a1', offset: 0 })).toBe(true);
    expect(scroll).toHaveBeenCalledWith({ top: 68, behavior: 'instant' });
    expect(revealCode(root, { path: 'missing.ts', side: 'new', start: 1, end: 1 })).toBe(false);
});

it('карточка ещё не разобранного файла остаётся якорем среди готовых диффов', () => {
    const root = document.createElement('main'); document.body.append(root);
    root.innerHTML = '<div data-reading="file" data-reading-file="one"><div class="diff-row" data-key="a1"></div></div><div data-reading="file" data-reading-file="two"></div><div data-reading="file" data-reading-file="three"><div class="diff-row" data-key="a1"></div></div>';
    const files = [...root.children] as HTMLElement[];
    const rows = [...root.querySelectorAll<HTMLElement>('.diff-row')];
    files.forEach((file, index) => vi.spyOn(file, 'getBoundingClientRect').mockReturnValue({ top: index * 300 - 290, bottom: index * 300 } as DOMRect));
    rows.forEach((row, index) => vi.spyOn(row, 'getBoundingClientRect').mockReturnValue({ top: index * 600 - 100, bottom: index * 600 - 80 } as DOMRect));
    expect(capturePosition(root)).toEqual({ address: 'file:two/file', offset: -2 });
});

it('не завершает восстановление на временно коротком холсте со скелетонами', () => {
    const root = document.createElement('main'); document.body.append(root);
    root.innerHTML = '<p data-reading="target"></p><p data-reading-wait></p>';
    const target = root.querySelector<HTMLElement>('[data-reading]');
    if (target === null) throw new Error('Missing target');
    vi.spyOn(target, 'getBoundingClientRect').mockReturnValue({ top: 600, bottom: 620 } as DOMRect);
    vi.spyOn(window, 'scrollBy').mockImplementation(() => undefined);
    expect(restorePosition(root, { address: 'target', offset: 0 })).toBe(false);
    root.querySelector('[data-reading-wait]')?.remove();
    expect(restorePosition(root, { address: 'target', offset: 0 })).toBe(true);
});

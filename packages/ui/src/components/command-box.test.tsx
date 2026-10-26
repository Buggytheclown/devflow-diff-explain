// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CommandBox } from './command-box.tsx';

/**
 * Отклик на копирование виден глазами, а не только скринридеру: успех меняет подпись кнопки
 * на пару секунд, а запасной путь без Clipboard API печатает строку под командой.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const COMMAND = '/sherpa arcanum-4821';

const mounted: (() => void)[] = [];

afterEach(() => {
    for (const unmount of mounted.splice(0)) {
        unmount();
    }
    vi.useRealTimers();
    setClipboard(undefined);
});

/** `undefined` — Clipboard API у браузера нет вовсе. */
function setClipboard(clipboard: { writeText: (text: string) => Promise<void> } | undefined): void {
    Object.defineProperty(navigator, 'clipboard', { value: clipboard, configurable: true });
}

function mount(): { readonly host: HTMLElement; readonly button: HTMLButtonElement } {
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);

    act(() => {
        root.render(<CommandBox command={COMMAND} hint="Запусти в любом харнесе." />);
    });
    mounted.push(() => {
        act(() => {
            root.unmount();
        });
        host.remove();
    });

    const button = host.querySelector<HTMLButtonElement>('.command-box__action');
    if (button === null) {
        throw new Error('в боксе команды нет кнопки копирования');
    }
    return { host, button };
}

/** Видимая подпись кнопки: вторая, невидимая, держит ширину и в счёт не идёт. */
function visibleLabel(button: HTMLButtonElement): string {
    return [...button.querySelectorAll('.command-box__action-label')]
        .filter((label) => !label.classList.contains('command-box__action-label--ghost'))
        .map((label) => label.textContent)
        .join('');
}

function liveRegion(host: HTMLElement): HTMLElement {
    const region = host.querySelector<HTMLElement>('[aria-live="polite"]');
    if (region === null) {
        throw new Error('в боксе команды нет области отклика');
    }
    return region;
}

describe('бокс команды', () => {
    it('после успешного копирования кнопка на время говорит «Скопировано»', async () => {
        vi.useFakeTimers();
        const written: string[] = [];
        setClipboard({
            writeText: (text: string) => {
                written.push(text);
                return Promise.resolve();
            },
        });
        const { host, button } = mount();

        expect(visibleLabel(button)).toBe('Скопировать');

        await act(async () => {
            button.click();
            await Promise.resolve();
        });

        expect(written).toEqual([COMMAND]);
        expect(visibleLabel(button)).toBe('Скопировано');
        expect(liveRegion(host).textContent).toBe('Команда скопирована');
        // Обе подписи в разметке всегда: невидимая держит ширину кнопки.
        expect(button.querySelectorAll('.command-box__action-label')).toHaveLength(2);
    });

    it('отклик сбрасывается по таймеру', async () => {
        vi.useFakeTimers();
        setClipboard({ writeText: () => Promise.resolve() });
        const { host, button } = mount();

        await act(async () => {
            button.click();
            await Promise.resolve();
        });
        act(() => {
            vi.advanceTimersByTime(2000);
        });

        expect(visibleLabel(button)).toBe('Скопировать');
        expect(liveRegion(host).textContent).toBe('');
    });

    it('без Clipboard API команда выделяется, а запасная строка видима', async () => {
        setClipboard(undefined);
        const { host, button } = mount();

        await act(async () => {
            button.click();
            await Promise.resolve();
        });

        const input = host.querySelector<HTMLInputElement>('.command-box__command');
        expect(input?.selectionEnd).toBe(COMMAND.length);

        const region = liveRegion(host);
        expect(region.textContent).toBe('Команда выделена — скопируй вручную');
        expect(region.className).toBe('command-box__fallback');
    });

    it('отказ Clipboard API уводит на тот же запасной путь', async () => {
        setClipboard({ writeText: () => Promise.reject(new Error('нет доступа')) });
        const { host, button } = mount();

        await act(async () => {
            button.click();
            await Promise.resolve();
        });

        expect(liveRegion(host).textContent).toBe('Команда выделена — скопируй вручную');
    });

    it('таймер снимается при размонтировании', async () => {
        vi.useFakeTimers();
        setClipboard({ writeText: () => Promise.resolve() });
        const { button } = mount();

        await act(async () => {
            button.click();
            await Promise.resolve();
        });

        const clear = vi.spyOn(window, 'clearTimeout');
        for (const unmount of mounted.splice(0)) {
            unmount();
        }

        expect(clear).toHaveBeenCalled();
        clear.mockRestore();
    });
});

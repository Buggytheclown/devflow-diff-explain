// @vitest-environment jsdom
import { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';

import { PrStateProvider } from '../pr-state/context.tsx';
import { createUiPrStateStore } from '../pr-state/pr-state-store.js';
import { ShortcutsProvider } from '../shortcuts/context.tsx';
import { createShortcutRegistry } from '../shortcuts/registry.js';
import { CommandPalette } from './command-palette.tsx';

/**
 * Команда, которая отвечает строкой в палитре: «Проверить обновления» просит палитру
 * остаться открытой (`keepOpen`) и кладёт свой ответ в область подсказки и live-регион.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// jsdom не умеет прокрутку, а палитра ведёт к курсору сам список.
HTMLElement.prototype.scrollIntoView = function noopScrollIntoView(): void {
    return undefined;
};

const STATUS = 'Доступна 0.5.0';

const mounted: (() => void)[] = [];

afterEach(() => {
    for (const unmount of mounted.splice(0)) {
        unmount();
    }
});

function Harness() {
    const [status, setStatus] = useState<string | null>(null);
    const [open, setOpen] = useState(true);
    const [registry] = useState(() => {
        const created = createShortcutRegistry();
        created.register({
            id: 'update.check',
            keys: [],
            group: 'palette.group.sherpa',
            label: 'shortcut.update.check',
            scope: 'global',
            section: 'navigation',
            keepOpen: true,
            action: () => {
                setStatus(STATUS);
            },
        });
        return created;
    });
    const [prState] = useState(() => createUiPrStateStore());

    return (
        <ShortcutsProvider registry={registry}>
            <PrStateProvider store={prState}>
                <CommandPalette
                    open={open}
                    source={null}
                    initialQuery="Проверить"
                    status={status}
                    onStatusHandled={() => {
                        setStatus(null);
                    }}
                    onOpen={() => {
                        setOpen(true);
                    }}
                    onClose={() => {
                        setOpen(false);
                    }}
                />
            </PrStateProvider>
        </ShortcutsProvider>
    );
}

function mount(): HTMLElement {
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    act(() => {
        root.render(<Harness />);
    });
    mounted.push(() => {
        act(() => {
            root.unmount();
        });
        host.remove();
    });
    return host;
}

function command(host: HTMLElement): HTMLButtonElement {
    const button = host.querySelector<HTMLButtonElement>('.command-palette__item');
    if (button === null) {
        throw new Error('в выдаче палитры нет команды');
    }
    return button;
}

describe('строка статуса команды в палитре', () => {
    it('команда с keepOpen не закрывает палитру и печатает свой ответ', () => {
        const host = mount();
        expect(command(host).textContent).toContain('Проверить обновления');

        act(() => {
            command(host).click();
        });

        expect(host.querySelector('.command-palette')).not.toBeNull();
        expect(host.querySelector('.command-palette__notice')?.textContent).toBe(STATUS);
        expect(host.querySelector('[aria-live="polite"]')?.textContent).toBe(STATUS);
    });

    it('смена запроса снимает ответ', () => {
        const host = mount();
        act(() => {
            command(host).click();
        });

        const input = host.querySelector<HTMLInputElement>('.command-palette__query');
        if (input === null) {
            throw new Error('в палитре нет поля запроса');
        }
        act(() => {
            // React отслеживает значение через собственный дескриптор — пишем мимо него,
            // иначе onChange считает, что ничего не изменилось.
            Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, 'Провер');
            input.dispatchEvent(new Event('input', { bubbles: true }));
        });

        expect(host.querySelector('.command-palette__notice')).toBeNull();
    });
});

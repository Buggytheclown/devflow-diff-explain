// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ReviewHostProvider } from '../app/review-host-context.tsx';
import type { FileMenuTarget } from './context-menu.tsx';
import { FileContextMenu, useContextMenu } from './context-menu.tsx';

/**
 * Контекстное меню файла (docs/design/SPEC-elements.md §2.11): открытие обоими способами, клавиатура по кругу,
 * выключенный пункт без действия и возврат фокуса. Буфер обмена подменяется — в jsdom его нет.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const FILE: FileMenuTarget = {
    path: 'services/orders/src/domain/order.ts',
    hostFileUrl: 'https://github.com/quillmart/quillmart/blob/9f3c1ab6d4e2705c8a1b3f9d6e4c2a08b7d5f316/services/orders/src/domain/order.ts',
    blameUrl: 'https://github.com/quillmart/quillmart/blame/9f3c1ab6d4e2705c8a1b3f9d6e4c2a08b7d5f316/services/orders/src/domain/order.ts',
};

const mounted: (() => void)[] = [];

afterEach(() => {
    for (const unmount of mounted.splice(0)) {
        unmount();
    }
    setClipboard(undefined);
});

/** `undefined` — Clipboard API у браузера нет вовсе. */
function setClipboard(clipboard: { writeText: (text: string) => Promise<void> } | undefined): void {
    Object.defineProperty(navigator, 'clipboard', { value: clipboard, configurable: true });
}

interface Mounted {
    readonly host: HTMLElement;
    readonly trigger: HTMLButtonElement;
    readonly onToggleViewed: ReturnType<typeof vi.fn>;
    /** Клавиши, дошедшие до обвязки: меню обязано гасить свои, кроме Esc. */
    readonly rowKeys: string[];
}

function mount(
    file: FileMenuTarget = FILE,
    viewed = false,
    onCommentFile?: () => void,
    reviewHost: string | null = 'arcanum',
): Mounted {
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    const onToggleViewed = vi.fn();
    const rowKeys: string[] = [];

    act(() => {
        root.render(
            <ReviewHostProvider value={reviewHost}>
                <Harness
                    file={file}
                    viewed={viewed}
                    onToggleViewed={onToggleViewed}
                    onRowKey={(key) => rowKeys.push(key)}
                    {...(onCommentFile === undefined ? {} : { onCommentFile })}
                />
            </ReviewHostProvider>,
        );
    });
    mounted.push(() => {
        act(() => {
            root.unmount();
        });
        host.remove();
    });

    const trigger = host.querySelector<HTMLButtonElement>('.harness-more');
    if (trigger === null) {
        throw new Error('в обвязке нет кнопки «⋯»');
    }
    return { host, trigger, onToggleViewed, rowKeys };
}

/**
 * Обвязка повторяет оба места вызова: кнопка «⋯» и правый клик по строке. Строка фокусируемая
 * и со своей клавиатурой — как шапка карточки и контейнер дерева.
 */
function Harness({
    file,
    viewed,
    onToggleViewed,
    onCommentFile,
    onRowKey,
}: {
    file: FileMenuTarget;
    viewed: boolean;
    onToggleViewed: () => void;
    onCommentFile?: (() => void) | undefined;
    onRowKey: (key: string) => void;
}) {
    const menu = useContextMenu();
    return (
        <div
            className="harness-row"
            tabIndex={-1}
            onContextMenu={menu.openAtPointer}
            onKeyDown={(event) => {
                onRowKey(event.key);
            }}
        >
            <button type="button" className="harness-more" onClick={menu.openAtButton}>
                ⋯
            </button>
            {menu.anchor === null ? null : (
                <FileContextMenu
                    file={file}
                    viewed={viewed}
                    onToggleViewed={onToggleViewed}
                    {...(onCommentFile === undefined ? {} : { onCommentFile })}
                    anchor={menu.anchor}
                    onClose={menu.close}
                    toggleRef={menu.toggleRef}
                />
            )}
        </div>
    );
}

function menuElement(): HTMLElement {
    const menu = document.body.querySelector<HTMLElement>('[role="menu"]');
    if (menu === null) {
        throw new Error('меню не открылось');
    }
    return menu;
}

function items(): HTMLButtonElement[] {
    return [...menuElement().querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
}

function press(key: string): void {
    act(() => {
        menuElement().dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
    });
}

/** Полная последовательность мыши: `click()` сам по себе mousedown не шлёт, а меню его слушает. */
function pressTrigger(trigger: HTMLButtonElement): void {
    act(() => {
        trigger.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
        trigger.click();
    });
}

describe('контекстное меню файла', () => {
    it('кнопка «⋯» открывает меню с фиксированным составом и фокусом на первом пункте', () => {
        const { trigger } = mount();

        act(() => {
            trigger.click();
        });

        expect(items().map((item) => item.textContent)).toEqual([
            'Скопировать путь',
            'Скопировать ссылку на файл',
            'Открыть в Аркануме',
            'Просмотрено',
        ]);
        expect(document.activeElement).toBe(items()[0]);
    });

    it('карточка-картинка добавляет «Комментарий к файлу» перед отметкой просмотра', () => {
        const onCommentFile = vi.fn();
        const { trigger } = mount(FILE, false, onCommentFile);

        act(() => {
            trigger.click();
        });
        expect(items().map((item) => item.textContent)).toEqual([
            'Скопировать путь',
            'Скопировать ссылку на файл',
            'Открыть в Аркануме',
            'Комментарий к файлу',
            'Просмотрено',
        ]);

        act(() => {
            items()[3]?.click();
        });
        expect(onCommentFile).toHaveBeenCalledTimes(1);
    });

    it('правый клик по строке открывает то же меню', () => {
        const { host } = mount();

        act(() => {
            host.querySelector('.harness-row')?.dispatchEvent(
                new MouseEvent('contextmenu', { bubbles: true, clientX: 40, clientY: 60 }),
            );
        });

        expect(items()).toHaveLength(4);
    });

    it('стрелки ходят по кругу, Home и End прыгают к краям', () => {
        const { trigger } = mount();
        act(() => {
            trigger.click();
        });

        press('ArrowUp');
        expect(document.activeElement).toBe(items()[3]);
        press('ArrowDown');
        expect(document.activeElement).toBe(items()[0]);
        press('End');
        expect(document.activeElement).toBe(items()[3]);
        press('Home');
        expect(document.activeElement).toBe(items()[0]);
    });

    it('«Просмотрено» вызывает действие и закрывает меню с возвратом фокуса', () => {
        const { trigger, onToggleViewed } = mount();
        act(() => {
            trigger.click();
        });

        act(() => {
            items()[3]?.click();
        });

        expect(onToggleViewed).toHaveBeenCalledTimes(1);
        expect(document.body.querySelector('[role="menu"]')).toBeNull();
        expect(document.activeElement).toBe(trigger);
    });

    it('копирование пути уходит в буфер и закрывает меню', async () => {
        const written: string[] = [];
        setClipboard({
            writeText: (text) => {
                written.push(text);
                return Promise.resolve();
            },
        });
        const { trigger } = mount();
        act(() => {
            trigger.click();
        });

        await act(async () => {
            items()[0]?.click();
            await Promise.resolve();
        });

        expect(written).toEqual([FILE.path]);
        expect(document.body.querySelector('[role="menu"]')).toBeNull();
    });

    it('без буфера обмена меню остаётся открытым и объясняет отказ', async () => {
        const { trigger } = mount();
        act(() => {
            trigger.click();
        });

        await act(async () => {
            items()[1]?.click();
            await Promise.resolve();
        });

        expect(menuElement().querySelector('.context-menu__error')?.textContent).toBe('Буфер обмена недоступен.');
    });

    it('файл без ссылки хоста: пункт выключен, кликом ничего не делает', async () => {
        const written: string[] = [];
        setClipboard({
            writeText: (text) => {
                written.push(text);
                return Promise.resolve();
            },
        });
        const { trigger } = mount({ ...FILE, hostFileUrl: null });
        act(() => {
            trigger.click();
        });

        const link = items()[1];
        expect(link?.getAttribute('aria-disabled')).toBe('true');
        expect(link?.title).toBe('у этого файла нет веб-ссылки');

        await act(async () => {
            link?.click();
            await Promise.resolve();
        });

        expect(written).toEqual([]);
        expect(document.body.querySelector('[role="menu"]')).not.toBeNull();
    });

    it('просмотренный файл предлагает снять отметку', () => {
        const { trigger } = mount(FILE, true);
        act(() => {
            trigger.click();
        });

        expect(items()[3]?.textContent).toBe('Снять отметку');
    });

    it('клик снаружи закрывает меню без возврата фокуса', () => {
        const { trigger } = mount();
        act(() => {
            trigger.click();
        });

        act(() => {
            window.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
        });

        expect(document.body.querySelector('[role="menu"]')).toBeNull();
        expect(document.activeElement).not.toBe(trigger);
    });

    it('повторный клик по «⋯» закрывает меню', () => {
        const { trigger } = mount();

        pressTrigger(trigger);
        expect(document.body.querySelector('[role="menu"]')).not.toBeNull();

        pressTrigger(trigger);
        expect(document.body.querySelector('[role="menu"]')).toBeNull();
        expect(document.activeElement).toBe(trigger);
    });

    it('клавиши меню не доходят до строки, Esc доходит', () => {
        const { trigger, rowKeys } = mount();
        act(() => {
            trigger.click();
        });

        press('ArrowDown');
        press('Home');
        press('Enter');
        expect(rowKeys).toEqual([]);

        press('Escape');
        expect(rowKeys).toEqual(['Escape']);
    });

    it('после правого клика закрытие возвращает фокус на строку', () => {
        const { host } = mount();
        const row = host.querySelector<HTMLElement>('.harness-row');

        act(() => {
            row?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 40, clientY: 60 }));
        });
        act(() => {
            items()[3]?.click();
        });

        expect(document.activeElement).toBe(row);
    });

    it('Tab закрывает меню, не возвращая фокус', () => {
        const { trigger } = mount();
        act(() => {
            trigger.click();
        });

        press('Tab');

        expect(document.body.querySelector('[role="menu"]')).toBeNull();
        expect(document.activeElement).not.toBe(trigger);
    });
});

describe('подпись пункта, открывающего файл в вебе', () => {
    it('на GitHub — «Открыть на GitHub»', () => {
        const { trigger } = mount(FILE, false, undefined, 'github');
        act(() => {
            trigger.click();
        });
        expect(items().map((item) => item.textContent)).toContain('Открыть на GitHub');
    });

    it('без хоста — общие слова', () => {
        const { trigger } = mount(FILE, false, undefined, null);
        act(() => {
            trigger.click();
        });
        expect(items().map((item) => item.textContent)).toContain('Открыть в вебе');
    });
});

import { describe, expect, it, vi } from 'vitest';

import type { Shortcut, ShortcutEvent } from './registry.js';
import { createShortcutRegistry } from './registry.js';

/**
 * Раскладки: команда ищется по набранному символу, а когда он не латинская буква или цифра —
 * ещё и по физической клавише. Базовое поведение — в `registry.test.ts`.
 */

function keydown(key: string, code: string, extra: Partial<ShortcutEvent> = {}): ShortcutEvent {
    return {
        key,
        code,
        ctrlKey: false,
        metaKey: false,
        shiftKey: false,
        altKey: false,
        target: { tagName: 'BODY' },
        preventDefault: vi.fn(),
        ...extra,
    };
}

function shortcut(overrides: Partial<Shortcut> & Pick<Shortcut, 'id' | 'keys' | 'action'>): Shortcut {
    // Подпись — ключ словаря; реестру важен только её тип.
    return { label: 'shortcut.palette.open', scope: 'global', section: 'navigation', ...overrides };
}

describe('русская раскладка', () => {
    it('кириллическая буква вызывает команду своей физической клавиши', () => {
        const registry = createShortcutRegistry();
        const action = vi.fn();
        registry.register(shortcut({ id: 'diff.markViewed', keys: ['v'], action }));

        const event = keydown('м', 'KeyV');
        expect(registry.handle(event)).toBe(true);
        expect(action).toHaveBeenCalledOnce();
        expect(event.preventDefault).toHaveBeenCalledOnce();
    });

    it('mod-сочетание работает по физической клавише', () => {
        const registry = createShortcutRegistry();
        const action = vi.fn();
        registry.register(shortcut({ id: 'palette.open', keys: ['mod+k'], action }));

        expect(registry.handle(keydown('л', 'KeyK', { metaKey: true }))).toBe(true);
        expect(action).toHaveBeenCalledOnce();
    });

    it('аккорд `g o` набирается кириллицей', () => {
        // Окно ожидания второй клавиши не истекает: тест добирает аккорд сам.
        const registry = createShortcutRegistry({ setTimer: () => 1, clearTimer: () => undefined });
        const action = vi.fn();
        registry.register(shortcut({ id: 'view.overview', keys: ['g o'], action }));

        expect(registry.handle(keydown('п', 'KeyG'))).toBe(true);
        expect(action).not.toHaveBeenCalled();

        expect(registry.handle(keydown('щ', 'KeyO'))).toBe(true);
        expect(action).toHaveBeenCalledOnce();
    });

    it('цифра остаётся цифрой', () => {
        const registry = createShortcutRegistry();
        const action = vi.fn();
        registry.register(shortcut({ id: 'view.route', keys: ['1'], action }));

        expect(registry.handle(keydown('1', 'Digit1'))).toBe(true);
        expect(action).toHaveBeenCalledOnce();
    });

    it('модификаторы остаются строгими: ctrl+кириллица не срабатывает как одиночная клавиша', () => {
        const registry = createShortcutRegistry();
        const action = vi.fn();
        registry.register(shortcut({ id: 'diff.markViewed', keys: ['v'], action }));

        const event = keydown('м', 'KeyV', { ctrlKey: true });
        expect(registry.handle(event)).toBe(false);
        expect(action).not.toHaveBeenCalled();
    });

    it('в поле ввода кириллица остаётся текстом, а mod-команда с worksInInputs срабатывает', () => {
        const registry = createShortcutRegistry();
        const viewed = vi.fn();
        const palette = vi.fn();
        registry.register(shortcut({ id: 'diff.markViewed', keys: ['v'], action: viewed }));
        registry.register(
            shortcut({ id: 'palette.open', keys: ['mod+k'], worksInInputs: true, action: palette }),
        );

        const typed = keydown('м', 'KeyV', { target: { tagName: 'TEXTAREA' } });
        expect(registry.handle(typed)).toBe(false);
        expect(viewed).not.toHaveBeenCalled();
        expect(typed.preventDefault).not.toHaveBeenCalled();

        const mod = keydown('л', 'KeyK', { metaKey: true, target: { tagName: 'TEXTAREA' } });
        expect(registry.handle(mod)).toBe(true);
        expect(palette).toHaveBeenCalledOnce();
    });
});

describe('клавиша `?` и `/` в разных раскладках', () => {
    it('`?` матчится и на US, и на русской физической клавише', () => {
        const registry = createShortcutRegistry();
        const action = vi.fn();
        registry.register(shortcut({ id: 'help.cheatsheet', keys: ['?'], action }));

        expect(registry.handle(keydown('?', 'Slash', { shiftKey: true }))).toBe(true);
        expect(registry.handle(keydown(',', 'Slash', { shiftKey: true }))).toBe(true);
        expect(action).toHaveBeenCalledTimes(2);
    });

    it('`/` в русской раскладке приходит точкой и всё равно матчится', () => {
        const registry = createShortcutRegistry();
        const action = vi.fn();
        registry.register(shortcut({ id: 'tree.filter', keys: ['/'], action }));

        expect(registry.handle(keydown('.', 'Slash'))).toBe(true);
        expect(action).toHaveBeenCalledOnce();
    });
});

describe('латинские раскладки', () => {
    it('на Dvorak срабатывает набранный символ, а не физическая клавиша', () => {
        const registry = createShortcutRegistry();
        const typed = vi.fn();
        const physical = vi.fn();
        // Команда физической клавиши зарегистрирована первой: `handle` останавливается на первом
        // совпадении, и лишний кандидат из `code` увёл бы нажатие в `j` — тест это поймает.
        registry.register(shortcut({ id: 'physical.j', keys: ['j'], action: physical }));
        registry.register(shortcut({ id: 'typed.c', keys: ['c'], action: typed }));

        expect(registry.handle(keydown('c', 'KeyJ'))).toBe(true);
        expect(typed).toHaveBeenCalledOnce();
        expect(physical).not.toHaveBeenCalled();
    });
});

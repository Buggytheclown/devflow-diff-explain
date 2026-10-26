import { describe, expect, it, vi } from 'vitest';

import type { Shortcut, ShortcutEvent } from './registry.js';
import { createShortcutRegistry } from './registry.js';

function keydown(key: string, extra: Partial<ShortcutEvent> = {}): ShortcutEvent {
    return {
        key,
        code: '',
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
    // Подпись — ключ словаря; реестру важен только её тип, содержание проверяет палитра.
    return { label: 'shortcut.palette.open', scope: 'global', section: 'navigation', ...overrides };
}

describe('реестр шорткатов', () => {
    it('вызывает команду и гасит событие', () => {
        const registry = createShortcutRegistry();
        const action = vi.fn();
        registry.register(shortcut({ id: 'view.route', keys: ['2'], action }));

        const event = keydown('2');
        expect(registry.handle(event)).toBe(true);
        expect(action).toHaveBeenCalledTimes(1);
        expect(event.preventDefault).toHaveBeenCalledTimes(1);
    });

    it('чужую клавишу не трогает', () => {
        const registry = createShortcutRegistry();
        const action = vi.fn();
        registry.register(shortcut({ id: 'view.route', keys: ['2'], action }));

        const event = keydown('9');
        expect(registry.handle(event)).toBe(false);
        expect(action).not.toHaveBeenCalled();
        expect(event.preventDefault).not.toHaveBeenCalled();
    });

    it('модификаторы сверяются строго в обе стороны', () => {
        const registry = createShortcutRegistry();
        const plain = vi.fn();
        const withMod = vi.fn();
        registry.register(shortcut({ id: 'plain', keys: ['k'], action: plain }));
        registry.register(shortcut({ id: 'palette', keys: ['mod+k'], action: withMod }));

        registry.handle(keydown('k', { metaKey: true }));
        expect(withMod).toHaveBeenCalledTimes(1);
        expect(plain).not.toHaveBeenCalled();

        registry.handle(keydown('k', { ctrlKey: true }));
        expect(withMod).toHaveBeenCalledTimes(2);

        registry.handle(keydown('k'));
        expect(plain).toHaveBeenCalledTimes(1);
        expect(withMod).toHaveBeenCalledTimes(2);
    });

    it('нажатия в полях ввода игнорируются', () => {
        const registry = createShortcutRegistry();
        const action = vi.fn();
        registry.register(shortcut({ id: 'view.route', keys: ['2'], action }));

        for (const target of [
            { tagName: 'INPUT' },
            { tagName: 'textarea' },
            { tagName: 'SELECT' },
            { tagName: 'DIV', isContentEditable: true },
        ]) {
            const event = keydown('2', { target });
            expect(registry.handle(event)).toBe(false);
            expect(event.preventDefault).not.toHaveBeenCalled();
        }

        expect(action).not.toHaveBeenCalled();
    });

    it('worksInInputs пропускает mod-команду из инпута, но не одиночную клавишу', () => {
        const registry = createShortcutRegistry();
        const palette = vi.fn();
        const plain = vi.fn();
        registry.register(
            shortcut({ id: 'palette.open', keys: ['mod+k'], worksInInputs: true, action: palette }),
        );
        registry.register(shortcut({ id: 'view.route', keys: ['1'], worksInInputs: true, action: plain }));

        const mod = keydown('k', { metaKey: true, target: { tagName: 'INPUT' } });
        expect(registry.handle(mod)).toBe(true);
        expect(palette).toHaveBeenCalledTimes(1);
        expect(mod.preventDefault).toHaveBeenCalledTimes(1);

        const single = keydown('1', { target: { tagName: 'INPUT' } });
        expect(registry.handle(single)).toBe(false);
        expect(plain).not.toHaveBeenCalled();
        expect(single.preventDefault).not.toHaveBeenCalled();
    });

    it('модальный слой выключает все глобальные команды', () => {
        const registry = createShortcutRegistry();
        const action = vi.fn();
        registry.register(shortcut({ id: 'view.route', keys: ['2'], action }));
        registry.setModalOpen(true);

        const event = keydown('2');
        expect(registry.handle(event)).toBe(false);
        expect(action).not.toHaveBeenCalled();
        expect(event.preventDefault).not.toHaveBeenCalled();

        registry.setModalOpen(false);
        expect(registry.handle(keydown('2'))).toBe(true);
        expect(action).toHaveBeenCalledOnce();
    });

    it('пустой keys оставляет команду в списке, но никогда не матчится', () => {
        const registry = createShortcutRegistry();
        const action = vi.fn();
        registry.register(shortcut({ id: 'palette.searchDiff', keys: [], action }));

        expect(registry.list()).toHaveLength(1);
        expect(registry.handle(keydown(''))).toBe(false);
        expect(action).not.toHaveBeenCalled();
    });

    it('when выключает команду, не снимая её с регистрации', () => {
        const registry = createShortcutRegistry();
        const action = vi.fn();
        let enabled = false;
        registry.register(shortcut({ id: 'view.route', keys: ['2'], when: () => enabled, action }));

        expect(registry.handle(keydown('2'))).toBe(false);

        enabled = true;
        expect(registry.handle(keydown('2'))).toBe(true);
        expect(registry.list()).toHaveLength(1);
    });

    it('list отдаёт команды в порядке регистрации — из него растут палитра и читшит', () => {
        const registry = createShortcutRegistry();
        registry.register(shortcut({ id: 'a', keys: ['1'], action: vi.fn() }));
        registry.register(shortcut({ id: 'b', keys: ['2'], action: vi.fn() }));

        expect(registry.list().map((item) => item.id)).toEqual(['a', 'b']);
    });

    it('снятие регистрации убирает команду', () => {
        const registry = createShortcutRegistry();
        const action = vi.fn();
        const unregister = registry.register(shortcut({ id: 'view.route', keys: ['2'], action }));

        unregister();

        expect(registry.handle(keydown('2'))).toBe(false);
        expect(registry.list()).toHaveLength(0);
    });

    it('дубль идентификатора — ошибка: команда обязана быть объявлена один раз', () => {
        const registry = createShortcutRegistry();
        registry.register(shortcut({ id: 'view.route', keys: ['2'], action: vi.fn() }));

        expect(() => registry.register(shortcut({ id: 'view.route', keys: ['3'], action: vi.fn() }))).toThrow(
            /already registered/,
        );
    });
});

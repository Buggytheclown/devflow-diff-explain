import { describe, expect, it, vi } from 'vitest';

import { createT } from '../i18n/index.js';
import type { Shortcut, ShortcutEvent, ShortcutRegistry } from './registry.js';
import { createShortcutRegistry, formatKeys } from './registry.js';

/**
 * Области действия, аккорды, `?` и лестница Esc. Базовое поведение — в `registry.test.ts`.
 */

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
    // Подпись — ключ словаря; реестру важен только её тип.
    return { label: 'shortcut.palette.open', scope: 'global', section: 'navigation', ...overrides };
}

/** Реестр с ручным таймером аккорда: тест не ждёт реальную секунду. */
function chordRegistry(): { readonly registry: ShortcutRegistry; readonly expire: () => void } {
    let fire: (() => void) | null = null;
    const registry = createShortcutRegistry({
        setTimer: (callback) => {
            fire = callback;
            return 1;
        },
        clearTimer: () => {
            fire = null;
        },
    });
    return {
        registry,
        expire: () => {
            fire?.();
        },
    };
}

describe('области действия', () => {
    it('команда активной области старше глобальной с той же клавишей', () => {
        const registry = createShortcutRegistry();
        const global = vi.fn();
        const route = vi.fn();
        registry.register(shortcut({ id: 'global.v', keys: ['v'], action: global }));
        registry.register(shortcut({ id: 'route.v', keys: ['v'], scope: 'route', action: route }));

        registry.setActiveScope('route');

        expect(registry.handle(keydown('v'))).toBe(true);
        expect(route).toHaveBeenCalledOnce();
        expect(global).not.toHaveBeenCalled();
    });

    it('команда чужой области не матчится и не видна в списке', () => {
        const registry = createShortcutRegistry();
        const action = vi.fn();
        registry.register(shortcut({ id: 'route.v', keys: ['v'], scope: 'route', action }));
        registry.setActiveScope('full-diff');

        expect(registry.handle(keydown('v'))).toBe(false);
        expect(action).not.toHaveBeenCalled();
        expect(registry.list()).toHaveLength(0);
        expect(registry.listAll()).toHaveLength(1);
    });

    it('внутри одной области порядок матча — порядок регистрации', () => {
        const registry = createShortcutRegistry();
        const first = vi.fn();
        const second = vi.fn();
        registry.register(shortcut({ id: 'first', keys: ['v'], scope: 'route', action: first }));
        registry.register(shortcut({ id: 'second', keys: ['v'], scope: 'route', action: second }));
        registry.setActiveScope('route');

        registry.handle(keydown('v'));

        expect(first).toHaveBeenCalledOnce();
        expect(second).not.toHaveBeenCalled();
    });

    it('смена области уведомляет подписчиков палитры, повтор той же — нет', () => {
        const registry = createShortcutRegistry();
        registry.register(shortcut({ id: 'route.v', keys: ['v'], scope: 'route', action: vi.fn() }));
        const listener = vi.fn();
        registry.subscribe(listener);

        registry.setActiveScope('route');
        expect(listener).toHaveBeenCalledOnce();
        expect(registry.list().map((item) => item.id)).toEqual(['route.v']);

        registry.setActiveScope('route');
        expect(listener).toHaveBeenCalledOnce();
        expect(registry.getActiveScope()).toBe('route');
    });
});

describe('аккорды', () => {
    it('`g` затем `o` вызывает команду аккорда', () => {
        const { registry } = chordRegistry();
        const action = vi.fn();
        registry.register(shortcut({ id: 'view.overview', keys: ['1', 'g o'], action }));

        const first = keydown('g');
        expect(registry.handle(first)).toBe(true);
        expect(first.preventDefault).toHaveBeenCalledOnce();
        expect(action).not.toHaveBeenCalled();

        expect(registry.handle(keydown('o'))).toBe(true);
        expect(action).toHaveBeenCalledOnce();
    });

    it('первое сочетание команды с аккордом работает само по себе', () => {
        const { registry } = chordRegistry();
        const action = vi.fn();
        registry.register(shortcut({ id: 'view.overview', keys: ['1', 'g o'], action }));

        expect(registry.handle(keydown('1'))).toBe(true);
        expect(action).toHaveBeenCalledOnce();
    });

    it('истёкшее окно ожидания отменяет аккорд', () => {
        const { registry, expire } = chordRegistry();
        const chord = vi.fn();
        registry.register(shortcut({ id: 'view.overview', keys: ['g o'], action: chord }));

        registry.handle(keydown('g'));
        expire();

        expect(registry.handle(keydown('o'))).toBe(false);
        expect(chord).not.toHaveBeenCalled();
    });

    it('чужая клавиша отменяет аккорд и обрабатывается сама', () => {
        const { registry } = chordRegistry();
        const chord = vi.fn();
        const viewed = vi.fn();
        registry.register(shortcut({ id: 'view.overview', keys: ['g o'], action: chord }));
        registry.register(shortcut({ id: 'diff.markViewed', keys: ['v'], action: viewed }));

        registry.handle(keydown('g'));
        expect(registry.handle(keydown('v'))).toBe(true);

        expect(viewed).toHaveBeenCalledOnce();
        expect(chord).not.toHaveBeenCalled();
    });

    it('Esc отменяет аккорд и дальше не идёт', () => {
        const { registry } = chordRegistry();
        const chord = vi.fn();
        const layer = vi.fn();
        registry.register(shortcut({ id: 'view.overview', keys: ['g o'], action: chord }));
        registry.registerEscapeLayer({ kind: 'popover', handler: layer });

        registry.handle(keydown('g'));
        const escape = keydown('Escape');
        expect(registry.handle(escape)).toBe(true);

        expect(layer).not.toHaveBeenCalled();
        expect(escape.preventDefault).toHaveBeenCalledOnce();
        // Аккорд снят: следующая `o` — просто клавиша.
        expect(registry.handle(keydown('o'))).toBe(false);
        expect(chord).not.toHaveBeenCalled();
    });

    it('в поле ввода аккорд не начинается', () => {
        const { registry } = chordRegistry();
        const chord = vi.fn();
        registry.register(shortcut({ id: 'view.overview', keys: ['g o'], action: chord }));

        const event = keydown('g', { target: { tagName: 'INPUT' } });

        expect(registry.handle(event)).toBe(false);
        expect(event.preventDefault).not.toHaveBeenCalled();
    });

    it('модалка, открытая посреди аккорда, глушит его вторую клавишу', () => {
        const { registry } = chordRegistry();
        const chord = vi.fn();
        registry.register(shortcut({ id: 'view.overview', keys: ['g o'], action: chord }));

        registry.handle(keydown('g'));
        // Модалку открыли мышью, пока окно ожидания не истекло.
        registry.setModalOpen(true);

        expect(registry.handle(keydown('o'))).toBe(false);
        expect(chord).not.toHaveBeenCalled();

        // Аккорд снят вместе с открытием модалки, а не отложен до её закрытия.
        registry.setModalOpen(false);
        expect(registry.handle(keydown('o'))).toBe(false);
        expect(chord).not.toHaveBeenCalled();
    });

    it('под модалкой аккорд не начинается', () => {
        const { registry } = chordRegistry();
        const chord = vi.fn();
        registry.register(shortcut({ id: 'view.overview', keys: ['g o'], action: chord }));
        registry.setModalOpen(true);

        const event = keydown('g');
        expect(registry.handle(event)).toBe(false);
        expect(event.preventDefault).not.toHaveBeenCalled();
    });

    it('аккорд чужой области не перехватывает первую клавишу', () => {
        const { registry } = chordRegistry();
        const chord = vi.fn();
        registry.register(shortcut({ id: 'route.chord', keys: ['g o'], scope: 'route', action: chord }));
        registry.setActiveScope('full-diff');

        expect(registry.handle(keydown('g'))).toBe(false);
    });
});

describe('клавиша `?`', () => {
    it('матчится по символу и не требует ручного shift', () => {
        const registry = createShortcutRegistry();
        const action = vi.fn();
        registry.register(shortcut({ id: 'help.cheatsheet', keys: ['?'], action }));

        expect(registry.handle(keydown('?', { shiftKey: true }))).toBe(true);
        expect(action).toHaveBeenCalledOnce();
    });

    it('в поле ввода остаётся символом', () => {
        const registry = createShortcutRegistry();
        const action = vi.fn();
        registry.register(shortcut({ id: 'help.cheatsheet', keys: ['?'], action }));

        expect(registry.handle(keydown('?', { shiftKey: true, target: { tagName: 'INPUT' } }))).toBe(false);
        expect(action).not.toHaveBeenCalled();
    });
});

describe('лестница Esc', () => {
    it('срабатывает один самый старший слой за нажатие', () => {
        const registry = createShortcutRegistry();
        const selection = vi.fn();
        const palette = vi.fn();
        registry.registerEscapeLayer({ kind: 'selection', handler: selection });
        const dropPalette = registry.registerEscapeLayer({ kind: 'palette', handler: palette });

        const first = keydown('Escape');
        expect(registry.handle(first)).toBe(true);
        expect(palette).toHaveBeenCalledOnce();
        expect(selection).not.toHaveBeenCalled();
        expect(first.preventDefault).toHaveBeenCalledOnce();

        dropPalette();
        expect(registry.handle(keydown('Escape'))).toBe(true);
        expect(selection).toHaveBeenCalledOnce();
    });

    it('среди равных по старшинству закрывается последний зарегистрированный', () => {
        const registry = createShortcutRegistry();
        const first = vi.fn();
        const second = vi.fn();
        registry.registerEscapeLayer({ kind: 'popover', handler: first });
        registry.registerEscapeLayer({ kind: 'popover', handler: second });

        registry.handle(keydown('Escape'));

        expect(second).toHaveBeenCalledOnce();
        expect(first).not.toHaveBeenCalled();
    });

    it('работает в полях ввода и под модальным слоем', () => {
        const registry = createShortcutRegistry();
        const handler = vi.fn();
        registry.registerEscapeLayer({ kind: 'palette', handler });
        registry.setModalOpen(true);

        expect(registry.handle(keydown('Escape', { target: { tagName: 'INPUT' } }))).toBe(true);
        expect(handler).toHaveBeenCalledOnce();
    });

    it('без слоёв Esc не гасится', () => {
        const registry = createShortcutRegistry();

        const event = keydown('Escape');
        expect(registry.handle(event)).toBe(false);
        expect(event.preventDefault).not.toHaveBeenCalled();
    });

    it('снятие слоя убирает его из лестницы', () => {
        const registry = createShortcutRegistry();
        const handler = vi.fn();
        const unregister = registry.registerEscapeLayer({ kind: 'modal', handler });

        unregister();

        expect(registry.handle(keydown('Escape'))).toBe(false);
        expect(handler).not.toHaveBeenCalled();
    });
});

describe('formatKeys', () => {
    const ru = createT('ru');
    const en = createT('en');

    it('рисует модификаторы символами, аккорд — связкой из словаря', () => {
        expect(formatKeys(['mod+k'], ru)).toBe('⌘K');
        expect(formatKeys(['mod+shift+enter'], ru)).toBe('⌘⇧ENTER');
        expect(formatKeys(['1', 'g o'], ru)).toBe('1 / G затем O');
        expect(formatKeys(['g o'], en)).toBe('G then O');
        expect(formatKeys([], ru)).toBeNull();
    });
});

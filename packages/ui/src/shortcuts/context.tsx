import type { ReactNode } from 'react';
import { createContext, useContext, useEffect, useRef, useSyncExternalStore } from 'react';

import type { PointerTarget } from './pointer-target.js';
import { FOCUS_ONLY_TARGET } from './pointer-target.js';
import type { EscapeLayerKind, Shortcut, ShortcutRegistry } from './registry.js';

/**
 * Доступ вью к единственному реестру команд (docs/architecture.md §7.3): реестр создаётся при старте страницы,
 * а объявляют команды те компоненты, которым есть что делать. Вне провайдера (галерея состояний)
 * регистрация — no-op: состояние обязано рисоваться без клавиатуры.
 */

const ShortcutsContext = createContext<ShortcutRegistry | null>(null);
const PointerTargetContext = createContext<PointerTarget>(FOCUS_ONLY_TARGET);

export function ShortcutsProvider({
    registry,
    pointer = FOCUS_ONLY_TARGET,
    children,
}: {
    registry: ShortcutRegistry;
    /** Трекер курсора страницы; без него цель команд считается только по фокусу. */
    pointer?: PointerTarget;
    children: ReactNode;
}) {
    return (
        <ShortcutsContext value={registry}>
            <PointerTargetContext value={pointer}>{children}</PointerTargetContext>
        </ShortcutsContext>
    );
}

export function useShortcutRegistry(): ShortcutRegistry | null {
    return useContext(ShortcutsContext);
}

/** Правило «под курсором или под фокусом» для команд вью (docs/design/SPEC-elements.md §5). */
export function usePointerTarget(): PointerTarget {
    return useContext(PointerTargetContext);
}

/**
 * Реактивный снимок реестра для палитры и читшита: команды активной области, затем глобальные.
 * Чужие области сюда не попадают — их клавиши всё равно не сработают.
 */
export function useShortcutList(): readonly Shortcut[] {
    const registry = useShortcutRegistry();
    const empty = useRef<readonly Shortcut[]>([]);
    return useSyncExternalStore(
        registry?.subscribe ?? NO_SUBSCRIBE,
        registry?.list ?? (() => empty.current),
        registry?.list ?? (() => empty.current),
    );
}

const NO_SUBSCRIBE = (): (() => void) => () => undefined;

/**
 * Команда живёт, пока смонтирован компонент. `action` и `when` читаются через ref, поэтому
 * свежие замыкания не требуют перерегистрации, а `id`/`keys`/`label` менять нельзя —
 * это описание команды, а не её состояние.
 */
export function useShortcut(shortcut: Shortcut): void {
    const registry = useContext(ShortcutsContext);
    const latest = useRef(shortcut);
    useEffect(() => {
        latest.current = shortcut;
    });

    const { id, label, labelArg, scope, section, worksInInputs, consequence, consequenceArg, group, keepOpen } =
        shortcut;
    const keys = shortcut.keys.join('\n');
    useEffect(() => {
        if (registry === null) {
            return;
        }
        return registry.register({
            id,
            keys: keys === '' ? [] : keys.split('\n'),
            label,
            ...(labelArg === undefined ? {} : { labelArg }),
            scope,
            section,
            ...(worksInInputs === undefined ? {} : { worksInInputs }),
            ...(consequence === undefined ? {} : { consequence }),
            ...(consequenceArg === undefined ? {} : { consequenceArg }),
            ...(group === undefined ? {} : { group }),
            ...(keepOpen === undefined ? {} : { keepOpen }),
            when: () => latest.current.when?.() ?? true,
            action: () => {
                latest.current.action();
            },
        });
    }, [
        registry,
        id,
        keys,
        label,
        labelArg,
        scope,
        section,
        worksInInputs,
        consequence,
        consequenceArg,
        group,
        keepOpen,
    ]);
}

/**
 * Слой лестницы Esc. Пока `active`, слой стоит в стеке реестра; на Esc
 * срабатывает один самый старший активный слой, и своего слушателя клавиатуры оверлею
 * заводить не нужно.
 */
export function useEscapeLayer(kind: EscapeLayerKind, handler: () => void, active = true): void {
    const registry = useContext(ShortcutsContext);
    const latest = useRef(handler);
    useEffect(() => {
        latest.current = handler;
    });

    useEffect(() => {
        if (registry === null || !active) {
            return;
        }
        return registry.registerEscapeLayer({
            kind,
            handler: () => {
                latest.current();
            },
        });
    }, [registry, kind, active]);
}

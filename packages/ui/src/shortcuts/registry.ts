import type { MessageKey } from '../i18n/ru.js';
import type { Translate } from '../i18n/translate.js';

/**
 * Единый реестр клавиатурных команд (docs/architecture.md §7.3). Правило: команда объявляется здесь один раз,
 * и из этого же объявления потом строятся командная палитра и читшит — второго
 * места, где живут сочетания клавиш, в UI быть не должно.
 *
 * Клавиша ищется по набранному символу, а когда он не латинская буква или цифра — ещё и по
 * физической клавише (`event.code`): в русской раскладке команды работают без переключения.
 *
 * Слушатель keydown в приложении тоже один: он и решает, чья это клавиша. Он же держит
 * лестницу Esc — слои оверлеев (палитра, модалка, поповер, тост, выделение) закрываются
 * строго по старшинству, по одному на нажатие.
 */

/** Сочетание: имя клавиши с необязательными префиксами `mod+` (⌘/Ctrl), `shift+`, `alt+`. */
export type ShortcutKeys = string;

/**
 * Где команда живёт. Одна и та же клавиша значит разное на разных вью (`v` на маршруте —
 * остановка, в полном диффе — файл), и разводит их область, а не порядок регистрации.
 */
export type ShortcutScope = 'global' | 'route' | 'full-diff' | 'overview';

/** Раздел читшита; порядок разделов — `SHORTCUT_SECTIONS`. */
export type ShortcutSection = 'navigation' | 'reading' | 'comments' | 'route' | 'agent' | 'ship';

/** Порядок и ключи подписей разделов читшита — один источник на реестр и на оверлей `?`. */
export const SHORTCUT_SECTIONS: readonly { readonly id: ShortcutSection; readonly label: MessageKey }[] = [
    { id: 'navigation', label: 'shortcut.section.navigation' },
    { id: 'reading', label: 'shortcut.section.reading' },
    { id: 'comments', label: 'shortcut.section.comments' },
    { id: 'route', label: 'shortcut.section.route' },
    { id: 'agent', label: 'shortcut.section.agent' },
    { id: 'ship', label: 'shortcut.section.ship' },
];

export interface Shortcut {
    readonly id: string;
    /**
     * Пустой массив — команда видна в палитре, но не участвует в keydown-матчинге.
     * Пробел внутри строки — аккорд: `'g o'` это «G, затем O».
     */
    readonly keys: readonly ShortcutKeys[];
    /** Ключ подписи в словаре: палитра и читшит переводят его на языке ревьюера. */
    readonly label: MessageKey;
    /** Динамическая часть подписи для параметризованного ключа — название остановки. */
    readonly labelArg?: string | number;
    readonly scope: ShortcutScope;
    readonly section: ShortcutSection;
    /** Команда с mod-сочетанием может сработать из поля ввода. */
    readonly worksInInputs?: boolean;
    /** Ключ видимого следствия команды до её запуска. */
    readonly consequence?: MessageKey;
    /** Динамическая часть следствия — число черновиков в подписи шипа. */
    readonly consequenceArg?: string | number;
    /** Группа палитры; без неё команда попадает в общие «Команды». */
    readonly group?: MessageKey;
    /** Палитра остаётся открытой после запуска: команда отвечает в неё же строкой статуса. */
    readonly keepOpen?: boolean;
    /** Команда активна только когда возвращает true; без неё — активна всегда. */
    readonly when?: () => boolean;
    readonly action: () => void;
}

/**
 * Событие клавиатуры в объёме, который нужен реестру. `KeyboardEvent` браузера этому
 * описанию удовлетворяет; тестам не нужен DOM.
 */
export interface ShortcutEvent {
    readonly key: string;
    /** Физическая клавиша (`KeyV`, `Digit1`, `Slash`): по ней команда находится в нелатинской раскладке. */
    readonly code: string;
    readonly ctrlKey: boolean;
    readonly metaKey: boolean;
    readonly shiftKey: boolean;
    readonly altKey: boolean;
    readonly target: unknown;
    readonly preventDefault: () => void;
}

/**
 * Слои, которые закрывает Esc, от старшего к младшему. Старшинство важнее порядка появления:
 * палитра поверх выделения закрывается первой, а выделение переживает её закрытие.
 */
export type EscapeLayerKind = 'palette' | 'modal' | 'popover' | 'toast' | 'selection';

const ESCAPE_ORDER: readonly EscapeLayerKind[] = ['palette', 'modal', 'popover', 'toast', 'selection'];

export interface EscapeLayer {
    readonly kind: EscapeLayerKind;
    readonly handler: () => void;
}

/** Окно ожидания второй клавиши аккорда. */
export const CHORD_TIMEOUT_MS = 1000;

export interface ShortcutRegistryOptions {
    readonly chordTimeoutMs?: number;
    /** Точка инжекции таймера: тест не должен ждать реальную секунду. */
    readonly setTimer?: (callback: () => void, ms: number) => unknown;
    readonly clearTimer?: (handle: unknown) => void;
}

export interface ShortcutRegistry {
    /** Возвращает функцию снятия регистрации. Дубль id — ошибка: команда обязана быть одна. */
    readonly register: (shortcut: Shortcut) => () => void;
    /** Все зарегистрированные команды в порядке регистрации — включая чужие области. */
    readonly listAll: () => readonly Shortcut[];
    /**
     * Команды, доступные прямо сейчас: сперва активной области, затем глобальные. Источник
     * для палитры и читшита — чужой области в них не место.
     */
    readonly list: () => readonly Shortcut[];
    /** Палитра следит за командами вью, которые монтируются и снимаются вместе с ними. */
    readonly subscribe: (listener: () => void) => () => void;
    /** Область активного вью; команды остальных областей не матчатся и не показываются. */
    readonly setActiveScope: (scope: ShortcutScope) => void;
    readonly getActiveScope: () => ShortcutScope;
    /** Модальный слой временно выключает команды фонового интерфейса. */
    readonly setModalOpen: (open: boolean) => void;
    /** Слой лестницы Esc; возвращает функцию снятия. */
    readonly registerEscapeLayer: (layer: EscapeLayer) => () => void;
    /** `true` — команда нашлась и выполнена (событие погашено). */
    readonly handle: (event: ShortcutEvent) => boolean;
}

interface Combination {
    readonly key: string;
    readonly mod: boolean;
    readonly shift: boolean;
    readonly alt: boolean;
}

export function createShortcutRegistry(options: ShortcutRegistryOptions = {}): ShortcutRegistry {
    const chordTimeoutMs = options.chordTimeoutMs ?? CHORD_TIMEOUT_MS;
    const setTimer = options.setTimer ?? ((callback, ms) => setTimeout(callback, ms));
    const clearTimer = options.clearTimer ?? ((handle: unknown) => {
        clearTimeout(handle as ReturnType<typeof setTimeout>);
    });

    const shortcuts = new Map<string, Shortcut>();
    const listeners = new Set<() => void>();
    const escapeLayers: { readonly order: number; readonly layer: EscapeLayer }[] = [];
    let escapeOrder = 0;
    let allSnapshot: readonly Shortcut[] = [];
    let scopedSnapshot: readonly Shortcut[] = [];
    let activeScope: ShortcutScope = 'global';
    let modalOpen = false;
    /** Первая клавиша аккорда нажата, ждём вторую. */
    let pendingChord: { readonly press: Press; readonly timer: unknown } | null = null;

    const scoped = (): readonly Shortcut[] => {
        const all = [...shortcuts.values()];
        const own = activeScope === 'global' ? [] : all.filter((item) => item.scope === activeScope);
        return [...own, ...all.filter((item) => item.scope === 'global')];
    };
    const notify = (): void => {
        allSnapshot = [...shortcuts.values()];
        scopedSnapshot = scoped();
        for (const listener of [...listeners]) {
            listener();
        }
    };
    const cancelChord = (): void => {
        if (pendingChord !== null) {
            clearTimer(pendingChord.timer);
            pendingChord = null;
        }
    };
    const runEscapeLayer = (): boolean => {
        let best: { readonly order: number; readonly layer: EscapeLayer } | null = null;
        for (const candidate of escapeLayers) {
            if (best === null || rank(candidate.layer.kind) < rank(best.layer.kind)) {
                best = candidate;
                continue;
            }
            // Среди равных по старшинству старше тот, кто зарегистрировался последним:
            // два поповера подряд закрываются в порядке открытия.
            if (rank(candidate.layer.kind) === rank(best.layer.kind) && candidate.order > best.order) {
                best = candidate;
            }
        }
        if (best === null) {
            return false;
        }
        best.layer.handler();
        return true;
    };

    return {
        register: (shortcut) => {
            if (shortcuts.has(shortcut.id)) {
                throw new Error(`Shortcut "${shortcut.id}" is already registered`);
            }
            shortcuts.set(shortcut.id, shortcut);
            notify();
            return () => {
                if (shortcuts.delete(shortcut.id)) {
                    notify();
                }
            };
        },
        listAll: () => allSnapshot,
        list: () => scopedSnapshot,
        subscribe: (listener) => {
            listeners.add(listener);
            return () => {
                listeners.delete(listener);
            };
        },
        setActiveScope: (scope) => {
            if (scope === activeScope) {
                return;
            }
            activeScope = scope;
            cancelChord();
            notify();
        },
        getActiveScope: () => activeScope,
        setModalOpen: (open) => {
            modalOpen = open;
            if (open) {
                // Модалка могла открыться мышью посреди аккорда — ждать его вторую клавишу больше некому.
                cancelChord();
            }
        },
        registerEscapeLayer: (layer) => {
            escapeOrder += 1;
            const entry = { order: escapeOrder, layer };
            escapeLayers.push(entry);
            return () => {
                const index = escapeLayers.indexOf(entry);
                if (index >= 0) {
                    escapeLayers.splice(index, 1);
                }
            };
        },
        handle: (event) => {
            // Esc обрабатывается и в полях ввода (поле палитры — инпут), и под модалкой:
            // лестница слоёв — единственный способ закрыть верхний оверлей.
            if (event.key === 'Escape') {
                if (pendingChord !== null) {
                    cancelChord();
                    event.preventDefault();
                    return true;
                }
                if (!runEscapeLayer()) {
                    return false;
                }
                event.preventDefault();
                return true;
            }

            // Модалка глушит всё, включая недобранный аккорд: под ней не должно сработать `g o`.
            if (modalOpen) {
                cancelChord();
                return false;
            }

            const editable = isEditable(event.target);
            const hasMod = event.metaKey || event.ctrlKey;
            const available = (): readonly Shortcut[] =>
                scopedSnapshot.filter((shortcut) => shortcut.when?.() !== false);

            if (pendingChord !== null) {
                const first = pendingChord.press;
                cancelChord();
                // Фокус успел уехать в поле ввода — вторая клавиша принадлежит тексту.
                for (const shortcut of editable ? [] : available()) {
                    const matched = shortcut.keys.some((keys) => {
                        const steps = parseSequence(keys);
                        return (
                            steps.length === 2 &&
                            matchesPress(steps[0], first) &&
                            matches(steps[1], event)
                        );
                    });
                    if (matched) {
                        event.preventDefault();
                        shortcut.action();
                        return true;
                    }
                }
                // Аккорд не сложился: клавиша обрабатывается как обычная (`g`, затем `v` — отметка).
            }

            // Первая клавиша аккорда старше одиночных команд: перехватываем её и ждём вторую.
            if (!editable && !hasMod && !event.altKey) {
                const starts = available().some((shortcut) =>
                    shortcut.keys.some((keys) => {
                        const steps = parseSequence(keys);
                        return steps.length === 2 && matches(steps[0], event);
                    }),
                );
                if (starts) {
                    pendingChord = {
                        press: pressOf(event),
                        timer: setTimer(() => {
                            pendingChord = null;
                        }, chordTimeoutMs),
                    };
                    event.preventDefault();
                    return true;
                }
            }

            for (const shortcut of available()) {
                if (editable && !(shortcut.worksInInputs === true && hasMod)) {
                    // Ввод текста старше обычных команд: «1» в поле поиска — это символ, а не таб.
                    continue;
                }
                const matched = shortcut.keys.some((keys) => {
                    const steps = parseSequence(keys);
                    return steps.length === 1 && matches(steps[0], event);
                });
                if (!matched) {
                    continue;
                }

                event.preventDefault();
                shortcut.action();
                return true;
            }
            return false;
        },
    };
}

/**
 * Вешает единственный слушатель keydown. Возвращает функцию снятия — в проде она не нужна
 * (слушатель живёт со страницей), но без неё реестр нельзя было бы завести в тесте.
 */
export function attachShortcuts(target: EventTarget, registry: ShortcutRegistry): () => void {
    const listener = (event: Event): void => {
        registry.handle(event as unknown as ShortcutEvent);
    };
    target.addEventListener('keydown', listener);
    return () => {
        target.removeEventListener('keydown', listener);
    };
}

function rank(kind: EscapeLayerKind): number {
    return ESCAPE_ORDER.indexOf(kind);
}

/** Шаги аккорда: `'g o'` → два сочетания, обычная команда — одно. */
export function parseSequence(keys: ShortcutKeys): readonly Combination[] {
    return keys
        .split(' ')
        .filter((step) => step !== '')
        .map(parseKeys);
}

export function parseKeys(keys: ShortcutKeys): Combination {
    const parts = keys.toLowerCase().split('+');
    const key = parts.at(-1) ?? '';
    const modifiers = parts.slice(0, -1);
    return {
        key,
        mod: modifiers.includes('mod'),
        shift: modifiers.includes('shift'),
        alt: modifiers.includes('alt'),
    };
}

/** Нажатие в объёме, нужном для сверки: клавиши-кандидаты и модификаторы. */
interface Press {
    readonly keys: readonly string[];
    readonly mod: boolean;
    readonly shift: boolean;
    readonly alt: boolean;
}

function pressOf(event: ShortcutEvent): Press {
    return {
        keys: keyCandidates(event),
        mod: event.metaKey || event.ctrlKey,
        shift: event.shiftKey,
        alt: event.altKey,
    };
}

/**
 * Клавиши, по которым ищется команда. Набранный символ — всегда; латиница физической клавиши
 * добавляется, только когда символ не латинская буква или цифра (кириллическая `м`, пунктуация `,`).
 * В Dvorak и AZERTY права именно раскладка, а не физическая клавиша, и лишний кандидат там
 * превратил бы одно нажатие в две разные команды.
 */
function keyCandidates(event: ShortcutEvent): readonly string[] {
    const typed = event.key.toLowerCase();
    if (typed.length === 1 && /[a-z0-9]/.test(typed)) {
        return [typed];
    }
    const physical = physicalKey(event);
    return physical === null || physical === typed ? [typed] : [typed, physical];
}

/** Латинское имя физической клавиши: `KeyX` → `x`, `Digit1` → `1`, `Slash` → `/` или `?` с shift. */
function physicalKey(event: ShortcutEvent): string | null {
    if (/^Key[A-Z]$/.test(event.code)) {
        return event.code.slice(3).toLowerCase();
    }
    if (/^Digit[0-9]$/.test(event.code)) {
        return event.code.slice(5);
    }
    if (event.code === 'Slash') {
        return event.shiftKey ? '?' : '/';
    }
    return null;
}

/**
 * Символьная клавиша приходит уже с учётом раскладки и shift: `?` это `shift+/`, но
 * `event.key` там `?`, и сверять модификатор бессмысленно — иначе `?` не сработает никогда.
 */
function symbolKey(key: string): boolean {
    return key.length === 1 && !/[a-z0-9]/.test(key);
}

/**
 * Сочетание сошлось, если его клавиша есть среди кандидатов нажатия. `mod` — ⌘ на маке
 * и Ctrl на остальных; модификаторы сверяются строго в обе стороны: Ctrl+1 не должен
 * срабатывать как «1».
 */
function matchesPress(combination: Combination | undefined, press: Press): boolean {
    if (combination === undefined) {
        return false;
    }
    return (
        press.keys.includes(combination.key) &&
        press.mod === combination.mod &&
        (symbolKey(combination.key) || press.shift === combination.shift) &&
        press.alt === combination.alt
    );
}

function matches(combination: Combination | undefined, event: ShortcutEvent): boolean {
    return matchesPress(combination, pressOf(event));
}

/** Поле ввода: там клавиши принадлежат тексту, а не командам. */
function isEditable(target: unknown): boolean {
    if (target === null || typeof target !== 'object') {
        return false;
    }

    const element = target as { tagName?: unknown; isContentEditable?: unknown };
    if (element.isContentEditable === true) {
        return true;
    }

    const tagName = typeof element.tagName === 'string' ? element.tagName.toUpperCase() : '';
    return tagName === 'INPUT' || tagName === 'TEXTAREA' || tagName === 'SELECT';
}

/**
 * Подпись сочетания для палитры и читшита: `mod+k` → `⌘K`, аккорд `g o` → `G затем O`.
 * Связка шагов аккорда — единственное словарное слово в подписи, поэтому сюда приходит `t`.
 */
export function formatKeys(keys: readonly ShortcutKeys[], t: Translate): string | null {
    if (keys.length === 0) {
        return null;
    }
    return keys.map((combination) => formatCombination(combination, t)).join(' / ');
}

/** Стрелки печатаются глифом: `ARROWRIGHT` в читшите читать невозможно. */
const KEY_GLYPHS: Readonly<Record<string, string>> = {
    arrowright: '→',
    arrowleft: '←',
    arrowup: '↑',
    arrowdown: '↓',
};

function formatCombination(keys: ShortcutKeys, t: Translate): string {
    return keys
        .split(' ')
        .filter((step) => step !== '')
        .map((step) => {
            const glyph = KEY_GLYPHS[step.toLowerCase()];
            return (
                glyph ??
                step
                    .replace('mod+', '⌘')
                    .replace('shift+', '⇧')
                    .replace('alt+', '⌥')
                    .toUpperCase()
            );
        })
        .join(` ${t('shortcut.chord.then')} `);
}

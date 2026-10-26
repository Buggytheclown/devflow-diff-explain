/**
 * Цель действия «под курсором» (docs/design/SPEC-elements.md §5): элемент под мышиным курсором, если последним
 * сигналом от пользователя было движение мыши, иначе — сфокусированный. Правило живёт здесь
 * одной функцией `target`, чтобы каждая команда не решала его заново.
 *
 * Запоминается позиция, а не элемент: между движением мыши и нажатием клавиши контент под
 * неподвижным курсором успевает уехать колесом, и сохранённый элемент указывал бы на строку,
 * которой там уже нет.
 */

/** Документ в объёме, который нужен трекеру: в jsdom нет `elementFromPoint`, и тест подставляет свой. */
export interface PointerDocument {
    readonly elementFromPoint: (x: number, y: number) => Element | null;
    readonly activeElement: Element | null;
    readonly addEventListener: ListenerBinding;
    readonly removeEventListener: ListenerBinding;
}

/** Окно в объёме трекера: из него нужен только уход фокуса со страницы. */
export interface PointerWindow {
    readonly addEventListener: ListenerBinding;
    readonly removeEventListener: ListenerBinding;
}

/** Подписка в объёме трекера: тот же вид, что у `EventTarget`, но без карты типов событий. */
type ListenerBinding = (type: string, listener: EventListener, options?: boolean | AddEventListenerOptions) => void;

export interface PointerTarget {
    /** Элемент под мышью; `null` — мышь не двигалась после смены фокуса или ушла из окна. */
    readonly hovered: () => Element | null;
    /** Цель по правилу: под мышью, иначе под фокусом. */
    readonly target: (selector: string) => Element | null;
    readonly dispose: () => void;
}

export function createPointerTarget(win: PointerWindow, doc: PointerDocument): PointerTarget {
    let position: { readonly x: number; readonly y: number } | null = null;
    // Хватает флага последнего сигнала: сравнивать время движения и время фокуса незачем.
    let lastSignal: 'pointer' | 'focus' = 'focus';

    const onPointerMove = (event: Event): void => {
        const { clientX, clientY } = event as PointerEvent;
        position = { x: clientX, y: clientY };
        lastSignal = 'pointer';
    };
    const onFocusIn = (): void => {
        lastSignal = 'focus';
    };
    const onLeave = (): void => {
        position = null;
    };

    doc.addEventListener('pointermove', onPointerMove, { capture: true, passive: true });
    doc.addEventListener('focusin', onFocusIn, { capture: true });
    // Уход курсора слушается без `capture`: эти события не всплывают, и в фазе перехвата документ
    // слышал бы уход мыши с любого вложенного узла — прокрутка колесом, переиспользование ряда
    // виртуализатором, снятый под курсором элемент. Позиция забывалась бы, хотя мышь на месте.
    doc.addEventListener('pointerleave', onLeave);
    doc.addEventListener('mouseleave', onLeave);
    win.addEventListener('blur', onLeave);

    const hovered = (): Element | null =>
        position === null || lastSignal !== 'pointer' ? null : doc.elementFromPoint(position.x, position.y);

    return {
        hovered,
        target: (selector) => hovered()?.closest(selector) ?? doc.activeElement?.closest(selector) ?? null,
        dispose: () => {
            doc.removeEventListener('pointermove', onPointerMove, { capture: true });
            doc.removeEventListener('focusin', onFocusIn, { capture: true });
            doc.removeEventListener('pointerleave', onLeave);
            doc.removeEventListener('mouseleave', onLeave);
            win.removeEventListener('blur', onLeave);
        },
    };
}

/**
 * Трекера нет (галерея, тесты компонентов): цель всегда по фокусу — ровно поведение до правила
 * «под курсором».
 */
export const FOCUS_ONLY_TARGET: PointerTarget = {
    hovered: () => null,
    target: (selector) =>
        typeof document === 'undefined' ? null : (document.activeElement?.closest(selector) ?? null),
    dispose: () => undefined,
};

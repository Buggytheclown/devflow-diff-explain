import { useCallback, useRef, useState } from 'react';

/**
 * Модалка «Комментарии к PR» открывается из двух мест — панели действий и карточки обсуждения
 * на Обзоре (docs/design/SPEC-additions-2026-08-26.md §1e п.5). Состояние живёт выше обоих, а возврат фокуса привязан
 * к тому, кто открыл: колбэк приходит вместе с открытием и зовётся при закрытии.
 */
export interface PrCommentsGate {
    readonly open: boolean;
    readonly openModal: (returnFocus?: () => void) => void;
    readonly close: () => void;
}

export function usePrCommentsGate(): PrCommentsGate {
    const [open, setOpen] = useState(false);
    const returnFocus = useRef<(() => void) | null>(null);
    const openModal = useCallback((focus?: () => void) => {
        returnFocus.current = focus ?? null;
        setOpen(true);
    }, []);
    const close = useCallback(() => {
        setOpen(false);
        const focus = returnFocus.current;
        returnFocus.current = null;
        // Фокус возвращается после снятия модалки с DOM, иначе его перехватит ловушка фокуса.
        queueMicrotask(() => {
            focus?.();
        });
    }, []);
    return { open, openModal, close };
}

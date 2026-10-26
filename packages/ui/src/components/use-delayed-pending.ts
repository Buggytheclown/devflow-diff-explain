import { useEffect, useState } from 'react';

/**
 * «Нет спиннера раньше 200 мс» (docs/design/SPEC-elements.md §3) одной утилитой: индикатор ожидания загорается, только
 * если ожидание пережило задержку, и гаснет сразу — быстрый ответ не мигает, а медленный не
 * заставляет гадать, жив ли экран.
 *
 * Отсчёт идёт от момента, когда флаг поднялся в этом компоненте. Ожиданию со своей точкой
 * отсчёта, переживающей перемонтирование (задача с `createdAt`), хук не подходит: он начал бы
 * отсчёт заново на каждом монтировании.
 */

/** Порог docs/design/SPEC-elements.md §3 по умолчанию. */
export const PENDING_DELAY_MS = 200;

export function useDelayedPending(pending: boolean, delayMs: number = PENDING_DELAY_MS): boolean {
    const [elapsed, setElapsed] = useState(pending && delayMs <= 0);
    const [tracked, setTracked] = useState(pending);

    // Смена флага правит состояние на рендере, а не эффектом: гашение индикатора не должно
    // стоить лишнего кадра, а новое ожидание обязано начать отсчёт с нуля.
    if (tracked !== pending) {
        setTracked(pending);
        setElapsed(pending && delayMs <= 0);
    }

    useEffect(() => {
        if (!pending || delayMs <= 0) {
            return;
        }
        const timer = setTimeout(() => {
            setElapsed(true);
        }, delayMs);
        return () => {
            clearTimeout(timer);
        };
    }, [delayMs, pending]);

    return pending && elapsed;
}

import type { Thread, ThreadPin } from '@sherpa/protocol';
import type { ReactNode } from 'react';
import { createContext, useContext } from 'react';

/**
 * Пин треда к коммиту, на котором он написан (docs/design/SPEC-elements.md §2.17 и §4.5): чип «закреплён за 9f3c1ab»
 * и переход «Показать на старом коммите». Признак разложен контекстом, а не пропсом: чип
 * рисует лист (`ThreadBlock`) в трёх вью и в группе «вне диффа», а знание об активной
 * итерации и переход живут в App.
 *
 * Вне провайдера (галерея, тесты компонентов) активная итерация неизвестна — ни чипа,
 * ни действия: пин без сравнения с активной итерацией ничего ревьюеру не говорит.
 */

export interface ThreadPinContextValue {
    /** Активная итерация PR; null — неизвестна. */
    readonly activeDiffId: string | null;
    /** Итерация нарисованного диффа; null — активная. */
    readonly viewingDiffId: string | null;
    /** Открыть тред на итерации его пина; null — переход недоступен (галерея, тесты). */
    readonly openAtPin: ((diffId: string, threadId: string) => void) | null;
}

const EMPTY: ThreadPinContextValue = { activeDiffId: null, viewingDiffId: null, openAtPin: null };

const ThreadPinContext = createContext<ThreadPinContextValue>(EMPTY);

export function ThreadPinProvider({ value, children }: { value: ThreadPinContextValue; children: ReactNode }) {
    return <ThreadPinContext value={value}>{children}</ThreadPinContext>;
}

export function useThreadPinContext(): ThreadPinContextValue {
    return useContext(ThreadPinContext);
}

export interface ThreadPinState {
    readonly pin: ThreadPin;
    /** Переход на итерацию пина; null — уже смотрим её или перехода нет. */
    readonly open: (() => void) | null;
}

/**
 * Пин, о котором стоит сказать ревьюеру: тред написан не на той итерации, что PR сейчас.
 * Совпал с активной — коммент стоит там же, где код, и говорить не о чем.
 */
export function useThreadPin(thread: Thread): ThreadPinState | null {
    const context = useThreadPinContext();
    const pin = thread.pinnedTo;
    if (pin === null || context.activeDiffId === null || pin.diffId === context.activeDiffId) {
        return null;
    }
    const openAtPin = context.openAtPin;
    if (openAtPin === null || pin.diffId === (context.viewingDiffId ?? context.activeDiffId)) {
        return { pin, open: null };
    }
    return {
        pin,
        open: () => {
            openAtPin(pin.diffId, thread.id);
        },
    };
}

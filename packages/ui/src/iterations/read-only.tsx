import type { ReactNode } from 'react';
import { createContext, useContext, useMemo } from 'react';

import type { MessageKey } from '../i18n/index.js';
import { useT } from '../i18n/index.js';

/**
 * Режим чтения прошлой итерации: комментировать, отмечать просмотренным
 * и шипать можно только в активной итерации. Признак разложен контекстом, а не пропсом:
 * его спрашивают листья всех трёх вью — композер, отметки, поповер выделения, панель шипа, —
 * и тянуть флаг через каждый слой рендера дороже, чем читать его на месте.
 *
 * Вне провайдера (галерея, тесты компонентов) режим выключен — состояния обязаны рисоваться
 * без App.
 */

/** Причина выключенного контрола: один текст на все места (`title` и подписи). */
export const READ_ONLY_REASON: MessageKey = 'iteration.readOnly.reason';

/** Срез между итерациями: чужое пространство `fileId`, писать в него нечего. */
export const SLICE_READ_ONLY_REASON: MessageKey = 'iteration.readOnly.sliceReason';

interface ReadOnlyIteration {
    readonly readOnly: boolean;
    readonly reason: MessageKey;
}

const ReadOnlyIterationContext = createContext<ReadOnlyIteration>({ readOnly: false, reason: READ_ONLY_REASON });

export function ReadOnlyIterationProvider({
    readOnly,
    reason = READ_ONLY_REASON,
    children,
}: {
    readOnly: boolean;
    /** Почему контролы выключены: у снапшота и у среза причины разные. */
    reason?: MessageKey;
    children: ReactNode;
}) {
    // Значение мемоизируется: провайдер стоит корнем App и рендерится на каждое его состояние,
    // а новый объект будил бы контекст в каждой строке диффа мимо их `memo`.
    const value = useMemo(() => ({ readOnly, reason }), [readOnly, reason]);
    return <ReadOnlyIterationContext value={value}>{children}</ReadOnlyIterationContext>;
}

export function useReadOnlyIteration(): boolean {
    return useContext(ReadOnlyIterationContext).readOnly;
}

/** Текст для `title` выключенного контрола: он зависит от того, чем именно смотрят. */
export function useReadOnlyReason(): string {
    return useT()(useContext(ReadOnlyIterationContext).reason);
}

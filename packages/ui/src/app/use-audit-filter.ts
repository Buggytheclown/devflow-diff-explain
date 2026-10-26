import { useCallback, useRef } from 'react';

import { ALL_FILTER_ID } from '../filters/lens-filters.js';
import type { SessionStore } from '../session/session-store.js';

export interface AuditFilterResult {
    /** Full diff отдаёт сюда свой обработчик смены фильтра, пока список файлов на экране. */
    readonly setDiffFilterHandler: (handler: ((id: string) => void) | null) => void;
    readonly showAllAuditFiles: () => void;
}

/** «Показать все файлы» из баннера аудита: фильтр снимает тот, кто рисует список. */
export function useAuditFilter(session: SessionStore): AuditFilterResult {
    const diffFilterHandler = useRef<((id: string) => void) | null>(null);
    const setDiffFilterHandler = useCallback((handler: ((id: string) => void) | null) => {
        diffFilterHandler.current = handler;
    }, []);
    const showAllAuditFiles = useCallback(() => {
        const handler = diffFilterHandler.current;
        if (handler === null) {
            // Пока Full diff ещё грузится, удерживать нечего: списка и верхней карточки на экране нет.
            session.setFilter(ALL_FILTER_ID);
            return;
        }
        handler(ALL_FILTER_ID);
    }, [session]);

    return { setDiffFilterHandler, showAllAuditFiles };
}

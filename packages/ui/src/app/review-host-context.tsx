import type { ReactNode } from 'react';
import { createContext, useContext } from 'react';

/**
 * Имя адаптера ревью (`uiState.reviewHost`) для компонентов, которым нужно назвать хост словами:
 * в приложении его ставит `App`, в галерее и тестах — кадр. `null` — хоста нет.
 */
const ReviewHostContext = createContext<string | null>(null);

export function ReviewHostProvider({ value, children }: { value: string | null; children: ReactNode }) {
    return <ReviewHostContext value={value}>{children}</ReviewHostContext>;
}

export function useReviewHost(): string | null {
    return useContext(ReviewHostContext);
}

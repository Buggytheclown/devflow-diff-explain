import type { ReactNode } from 'react';
import { createContext, useContext } from 'react';

/**
 * Транспорт байтов картинки: карточка не знает ни про токен, ни про `fetch`.
 * В приложении его ставит `App` поверх `fetchBlob`, в галерее и тестах — фикстура.
 *
 * `null` — блобов у хоста нет (`capabilities.blobs` выключена): карточка-картинка не рисуется,
 * бинарник остаётся обычным нотисом.
 */
export type BlobLoader = (blobId: string) => Promise<Blob | null>;

const BlobLoaderContext = createContext<BlobLoader | null>(null);

export function BlobLoaderProvider({ loadBlob, children }: { loadBlob: BlobLoader | null; children: ReactNode }) {
    return <BlobLoaderContext value={loadBlob}>{children}</BlobLoaderContext>;
}

export function useBlobLoader(): BlobLoader | null {
    return useContext(BlobLoaderContext);
}

import type { FileContent } from '@sherpa/protocol';

import type { Translate } from '../i18n/index.js';
import type { ExpandDirection, FileExpansion, GapKey } from './expand.js';
import type { DiffViewStore } from './store.js';

export type ContextExpandRequest =
    | {
          readonly kind: 'gap';
          readonly gapKey: GapKey;
          readonly direction: ExpandDirection;
          readonly amount?: number;
      }
    | { readonly kind: 'file'; readonly gapKeys?: readonly GapKey[] };

export interface ContextExpandResult {
    readonly feedback: string | null;
    readonly content: FileContent | null;
    readonly expansion: FileExpansion;
}

export interface GapExpandResult {
    readonly feedback: string | null;
    readonly loaded: number;
    readonly hidden: number;
    /** Остаток чужих изменённых строк за тем же ключом: раскрытие делит промежуток на куски. */
    readonly hiddenChanged: number;
}

interface ExpandContextOptions {
    readonly store: DiffViewStore;
    readonly fileId: string;
    readonly request: ContextExpandRequest;
    readonly contentAvailable: boolean;
    readonly loadContent: (fileId: string) => Promise<FileContent | null>;
    /** Жалоба на сорвавшуюся догрузку встаёт готовой строкой в карточку файла. */
    readonly t: Translate;
}

/** Единый lazy-fetch содержимого и применение действия для Полного диффа и Маршрута. */
export async function expandContext(options: ExpandContextOptions): Promise<ContextExpandResult> {
    const { store, fileId, request, contentAvailable, loadContent, t } = options;
    const result = (feedback: string | null): ContextExpandResult => {
        const snapshot = store.getSnapshot();
        return {
            feedback,
            content: snapshot.content.get(fileId) ?? null,
            expansion: snapshot.expansion.get(fileId) ?? new Map(),
        };
    };
    if (!contentAvailable) {
        return result(null);
    }

    if (!store.getSnapshot().content.has(fileId)) {
        let content: FileContent | null;
        try {
            content = await loadContent(fileId);
        } catch (error: unknown) {
            const reason = (error instanceof Error ? error.message : String(error)).replace(/\s*\.\s*$/, '');
            return result(t('diff.contextFailed', reason));
        }
        store.setContent(fileId, content);
        if (content === null) {
            return result(null);
        }
    }

    if (request.kind === 'file') {
        store.expandFile(fileId, request.gapKeys);
    } else {
        store.expandGap(fileId, request.gapKey, request.direction, request.amount);
    }
    return result(null);
}

import type { AgentNote } from '@sherpa/protocol';
import { useCallback, useEffect, useRef } from 'react';

import { findComposer, focusComposerInput, revealWhenReady } from '../diff-view/line-target.js';
import { useT } from '../i18n/index.js';
import type { ThreadStore } from '../threads/store.js';
import { openNewComposer } from '../threads/thread-list.tsx';
import { noteComposerAnchor, noteComposerKey, noteDraftText } from './note-draft.js';

/**
 * Действие заметки «В черновик комментария» (docs/design/SPEC-elements.md §2.16): у якоря заметки открывается обычный
 * композер нового комментария с цитатой ответа агента. Черновик — ревьюера и живёт по общим
 * правилам: автосохранения нет, в хост он уходит только по явному
 * сохранению. Хук общий для полного диффа и маршрута — обе вью ведут себя одинаково.
 */

/** Цель ждём ограниченно: композер может так и не попасть в DOM (виртуализация, свёрнутая карточка). */
const COMPOSER_SEARCH_MS = 3000;

export interface TurnNoteIntoDraftOptions {
    readonly threadStore: ThreadStore;
    /** Диапазон переехал в композер: поповер выделения поверх него больше не нужен. */
    readonly clearSelection: () => void;
    readonly commentIssues: boolean;
}

/**
 * Открывает композер у якоря заметки, скроллит его в вьюпорт и ставит фокус в поле. Узел
 * композера появляется не в этом кадре (React перерисует карточку после обновления стора),
 * поэтому цель ждём тем же способом, что и заметку при переходе из чата.
 */
export function useTurnNoteIntoDraft({
    threadStore,
    clearSelection,
    commentIssues,
}: TurnNoteIntoDraftOptions): (note: AgentNote) => void {
    const t = useT();
    const stopReveal = useRef<(() => void) | null>(null);
    useEffect(
        () => () => {
            stopReveal.current?.();
            stopReveal.current = null;
        },
        [],
    );

    return useCallback(
        (note: AgentNote) => {
            const key = noteComposerKey(note.anchor);
            openNewComposer(threadStore, key, noteComposerAnchor(note.anchor), commentIssues, noteDraftText(note, t));
            clearSelection();
            stopReveal.current?.();
            stopReveal.current = revealWhenReady(() => {
                const composer = findComposer(document, key);
                if (composer === null) {
                    return false;
                }
                composer.scrollIntoView({ block: 'center' });
                focusComposerInput(composer);
                return true;
            }, COMPOSER_SEARCH_MS);
        },
        [clearSelection, commentIssues, t, threadStore],
    );
}

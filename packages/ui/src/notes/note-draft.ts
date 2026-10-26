import type { AgentNote, AnchorPosition, ChatAnchor, FileAnchor } from '@sherpa/protocol';

import type { Translate } from '../i18n/index.js';

/**
 * Черновик комментария из заметки агента (docs/design/SPEC-elements.md §2.16): текст цитаты и адрес композера.
 * Модуль чистый — им пользуются обе вью и модель маршрута.
 */

/** Текст черновика: атрибуция, пустая строка и весь текст заметки markdown-цитатой. */
export function noteDraftText(note: AgentNote, t: Translate): string {
    const lines = note.text.split(/\r?\n/u);
    while (lines.at(-1)?.trim() === '') {
        lines.pop();
    }
    return [t('note.attribution'), '', ...lines.map((line) => (line.trim() === '' ? '>' : `> ${line}`))].join('\n');
}

/**
 * Позиция комментария у диапазона заметки. `line` — первая строка диапазона, `size` — сколько
 * строк он занимает: ровно то, что даёт `commentPosition` для выделения тех же строк, поэтому
 * черновик от заметки неотличим от черновика, поставленного карандашом от выделения.
 */
export function noteCommentPosition(anchor: ChatAnchor): AnchorPosition {
    return { side: anchor.side, line: anchor.start, size: anchor.end - anchor.start + 1 };
}

/** Ключ композера — как у карандаша строки: файл, сторона и первая строка диапазона. */
export function noteComposerKey(anchor: ChatAnchor): string {
    return `new:${anchor.fileId}:${anchor.side}:${String(anchor.start)}`;
}

export function noteComposerAnchor(anchor: ChatAnchor): FileAnchor {
    return { fileId: anchor.fileId, path: anchor.path, position: noteCommentPosition(anchor) };
}

import type { UiChatAskAnchor } from '@sherpa/protocol';

import { readFragmentParam, updateFragment } from './fragment.js';

export interface SelectionLinkTarget {
    readonly fileId: string;
    readonly side: 'old' | 'new';
    readonly start: number;
    readonly end: number;
}

/** `null` — фрагмент не содержит полного валидного якоря диапазона. */
export function readSelectionLink(hash: string): SelectionLinkTarget | null {
    const fileId = readFragmentParam(hash, 'file');
    const side = readFragmentParam(hash, 'side');
    const start = positiveInteger(readFragmentParam(hash, 'line'));
    const end = positiveInteger(readFragmentParam(hash, 'end'));
    if (fileId === null || (side !== 'old' && side !== 'new') || start === null || end === null || end < start) {
        return null;
    }
    return { fileId, side, start, end };
}

/** Добавляет диапазон, сохраняет выбранную вью и удаляет конфликтующие цели перехода. */
export function selectionLinkHash(hash: string, anchor: UiChatAskAnchor): string {
    return updateFragment(hash, {
        file: anchor.fileId,
        side: anchor.side,
        line: String(anchor.start),
        end: String(anchor.end),
        thread: null,
        stop: null,
    });
}

function positiveInteger(value: string | null): number | null {
    if (value === null || !/^\d+$/.test(value)) {
        return null;
    }
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

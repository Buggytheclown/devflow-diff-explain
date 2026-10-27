import type { ChatAnchor, PrDiff } from '@sherpa/protocol';
import { parseCodeLink } from '@sherpa/protocol';
import { parseBlocks } from '@sherpa/protocol/markdown';

import { savedPatchIndex } from './saved-patch.js';

/** Ссылки отвечают только за доступные строки сохранённой версии вопроса. */
export function chatCodeLinkErrors(text: string, diff: PrDiff | null, anchor: ChatAnchor | null): string[] {
    const index = savedPatchIndex(diff);
    const hrefs: string[] = [];
    const visit = (value: unknown): void => {
        if (Array.isArray(value)) { for (const child of value) visit(child); return; }
        if (value === null || typeof value !== 'object') return;
        const node = value as Record<string, unknown>;
        if (node.kind === 'link' && typeof node.href === 'string' && node.href.startsWith('#code?')) hrefs.push(node.href);
        for (const child of Object.values(node)) visit(child);
    };
    visit(parseBlocks(text));
    return hrefs.flatMap((href) => {
        const location = parseCodeLink(href);
        if (location === null) return [`Invalid code link: ${href}. Use #code?path=ENCODED_PATH&side=new&start=N&end=N.`];
        // Старые ссылки чата могли использовать новый канонический путь и для old-стороны.
        const file = index.file(location.path, location.side, true);
        const selected = diff !== null && anchor?.diffId === diff.diffId && file?.fileId === anchor.fileId &&
            anchor.side === location.side && location.start >= anchor.start && location.end <= anchor.end;
        const present = index.range(file, location) !== null;
        return file !== null && (selected || present) ? [] : [
            `Code link ${location.path}:${String(location.start)}-${String(location.end)} is not available in this question's saved patch/selection. Correct the coordinates or give a plain path and explain the evidence limit.`,
        ];
    });
}

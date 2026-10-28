import type { CodeLocation, UiChatAskAnchor } from '@sherpa/protocol';
import type { DiffFileModel } from '../diff/model.js';

/** Полные строки выбранной стороны; скрытые пропуски не выдаём за непрерывный текст. */
export function selectedCode(model: DiffFileModel, range: CodeLocation): string | null {
    if (model.content.kind !== 'text') return null;
    const lines = model.content.blocks.flatMap((block) => block.kind === 'hunk' ? block.lines : [])
        .filter((line) => { const n = range.side === 'old' ? line.oldLine : line.newLine; return n !== null && n >= range.start && n <= range.end; });
    if (lines.length !== range.end - range.start + 1 || lines.some((line, index) => (range.side === 'old' ? line.oldLine : line.newLine) !== range.start + index)) return null;
    return lines.map((line) => line.text).join('\n');
}

/** Длинный код остаётся в превью; агент получает полный диапазон через сохранённый патч. */
export function withCodeQuote(anchor: UiChatAskAnchor, text: string | null): UiChatAskAnchor {
    return text !== null && text.length > 0 && text.length <= 4000 ? { ...anchor, selectedText: text } : anchor;
}

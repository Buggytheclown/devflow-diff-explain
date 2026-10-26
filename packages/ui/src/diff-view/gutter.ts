import type { DiffFileModel } from '../diff/model.js';

/**
 * Разрядность самого длинного номера строки среди показанных строк модели — по ней карточка
 * задаёт ширину колонок номеров (`--gutter-digits`, `diff-view.css`). Считаются обе стороны:
 * в split ширина общая для половин. Строк нет — один разряд.
 */
export function gutterDigits(model: DiffFileModel | null): number {
    let max = 0;
    if (model?.content.kind === 'text') {
        for (const block of model.content.blocks) {
            if (block.kind !== 'hunk') {
                continue;
            }
            for (const line of block.lines) {
                max = Math.max(max, line.oldLine ?? 0, line.newLine ?? 0);
            }
        }
    }
    return String(max).length;
}

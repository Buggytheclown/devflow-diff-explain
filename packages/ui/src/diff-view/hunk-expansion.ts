import type { DiffFileModel, DiffGap, DiffHunk } from '../diff/model.js';
import type { ExpandDirection, GapKey } from './expand.js';
import { gapKeyOf } from './expand.js';

/**
 * Клавиша `e` (docs/design/SPEC-elements.md §5): раскрыть контекст ханка под фокусом — на шаг вверх и на шаг вниз.
 * Перемычки вокруг ханка адресуются теми же ключами и направлениями, что и мишени в разметке
 * (`expandFileContext`): у внутренней перемычки «вниз» растит ханк под ней, «вверх» — над ней.
 */
export interface HunkExpandRequest {
    readonly gapKey: GapKey;
    readonly direction: ExpandDirection;
}

/**
 * Что раскрыть, чтобы у ханка под фокусом стало на шаг больше контекста сверху и снизу.
 * Пустой список — раскрывать нечего: ханка нет, перемычек вокруг него нет или они пусты.
 */
export function hunkContextRequests(
    model: DiffFileModel,
    side: 'old' | 'new',
    line: number,
): readonly HunkExpandRequest[] {
    if (model.content.kind !== 'text') {
        return [];
    }
    const blocks = model.content.blocks;
    const position = blocks.findIndex((block) => block.kind === 'hunk' && hunkHasLine(block, side, line));
    if (position < 0) {
        return [];
    }

    const requests: HunkExpandRequest[] = [];
    const above = blocks[position - 1];
    if (above?.kind === 'gap' && hasHidden(above)) {
        // Перемычка над ханком: «вниз» у внутренней и «вверх» у ведущей растят как раз его верх.
        requests.push({ gapKey: gapKeyOf(above), direction: above.edge === 'leading' ? 'up' : 'down' });
    }
    const below = blocks[position + 1];
    if (below?.kind === 'gap' && hasHidden(below)) {
        requests.push({ gapKey: gapKeyOf(below), direction: below.edge === 'trailing' ? 'down' : 'up' });
    }
    return requests;
}

function hasHidden(gap: DiffGap): boolean {
    // `null` — хвостовая перемычка неизвестной длины: раскрывать там точно есть что.
    return gap.hiddenLines === null || gap.hiddenLines > 0;
}

function hunkHasLine(hunk: DiffHunk, side: 'old' | 'new', line: number): boolean {
    return hunk.lines.some((value) => (side === 'old' ? value.oldLine : value.newLine) === line);
}

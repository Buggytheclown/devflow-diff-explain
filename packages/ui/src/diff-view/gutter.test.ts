import type { FileContent } from '@sherpa/protocol';
import { describe, expect, it } from 'vitest';

import type { DiffFileModel, DiffGap } from '../diff/model.js';
import { parseFileDiff } from '../diff/parse.js';
import { clipModelToAnchors } from '../route/anchor-clip.js';
import { expandFileContext, expandGap, gapKeyOf } from './expand.js';
import { shownFileModel } from './file-card.tsx';
import { gutterDigits } from './gutter.js';

/** Файл из 1100 строк: `line-1` … `line-1100`. */
const LINES = Array.from({ length: 1100 }, (_, index) => `line-${String(index + 1)}`);
const CONTENT: FileContent = { oldText: LINES.join('\n'), newText: LINES.join('\n') };

/** Правки в строках 5 и 995; хвост файла за ними скрыт. */
function model(): DiffFileModel {
    return parseFileDiff({
        fileId: 'f1',
        path: 'app.ts',
        oldPath: null,
        changeType: 'modify',
        binary: false,
        patch: ['@@ -5,1 +5,1 @@', '-line-5', '+line-5 changed', '@@ -995,1 +995,1 @@', '-line-995', '+line-995 changed', ''].join(
            '\n',
        ),
    });
}

function trailingGap(source: DiffFileModel): DiffGap {
    const gap =
        source.content.kind === 'text'
            ? source.content.blocks.find((block): block is DiffGap => block.kind === 'gap' && block.edge === 'trailing')
            : undefined;
    if (gap === undefined) {
        throw new Error('в модели нет хвостового пропуска');
    }
    return gap;
}

describe('gutterDigits', () => {
    it('без строк — один разряд', () => {
        expect(gutterDigits(null)).toBe(1);
    });

    it('берёт максимальный номер среди показанных строк обеих сторон', () => {
        expect(gutterDigits(model())).toBe(3);
    });

    it('раскрытый контекст с номерами длиннее расширяет колонку', () => {
        const source = model();
        const expansion = expandGap(new Map(), gapKeyOf(trailingGap(source)), 'down', 10);

        expect(gutterDigits(expandFileContext(source, CONTENT, expansion))).toBe(4);
    });

    it('срез маршрута считает только оставшиеся строки', () => {
        const clip = (expanded: DiffFileModel): DiffFileModel =>
            clipModelToAnchors(expanded, [{ side: 'new', start: 5, end: 5 }]).model;

        expect(gutterDigits(shownFileModel(model(), CONTENT, new Map(), clip))).toBe(1);
    });

    it('раскрытый в срезе контекст срез не прячет — его номера тоже в счёт', () => {
        const source = model();
        const expansion = expandGap(new Map(), gapKeyOf(trailingGap(source)), 'down', 10);
        const clip = (expanded: DiffFileModel): DiffFileModel =>
            clipModelToAnchors(expanded, [{ side: 'new', start: 5, end: 5 }]).model;

        expect(gutterDigits(shownFileModel(source, CONTENT, expansion, clip))).toBe(4);
    });
});

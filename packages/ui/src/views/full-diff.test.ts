import type { FileContent } from '@sherpa/protocol';
import { describe, expect, it } from 'vitest';

import { parseFileDiff } from '../diff/parse.js';
import { expandFileContext, expandGap, gapKeyOf } from '../diff-view/expand.js';
import { commentPosition, nextFileToAdvance } from './full-diff.tsx';

const MODEL = parseFileDiff({
    fileId: 'f1',
    path: 'app.ts',
    oldPath: null,
    changeType: 'modify',
    binary: false,
    patch: [
        '@@ -100,4 +120,5 @@',
        ' context-before',
        '-old-101',
        '-old-102',
        '+new-121',
        '+new-122',
        '+new-123',
        ' context-after',
    ].join('\n'),
});

describe('якорь комментария со строки', () => {
    const selection = { fileId: 'f1', anchor: 'a121', focus: 'a123' };

    it('сохраняет выделенный диапазон при клике внутри него', () => {
        expect(commentPosition(selection, MODEL, 'f1', 'new', 122)).toEqual({ side: 'new', line: 121, size: 3 });
    });

    it('обратное выделение привязывает комментарий к первой строке диапазона', () => {
        expect(commentPosition({ ...selection, anchor: 'a123', focus: 'a121' }, MODEL, 'f1', 'new', 121)).toEqual({
            side: 'new',
            line: 121,
            size: 3,
        });
    });

    it.each([
        ['удаление → добавление', 'd101', 'a123'],
        ['добавление → удаление', 'a123', 'd101'],
    ] as const)('%s проецирует replacement-диапазон на старую сторону', (_label, anchor, focus) => {
        expect(commentPosition({ fileId: 'f1', anchor, focus }, MODEL, 'f1', 'old', 101)).toEqual({
            side: 'old',
            line: 101,
            size: 2,
        });
    });

    it.each([
        ['удаление → добавление', 'd101', 'a123'],
        ['добавление → удаление', 'a123', 'd101'],
    ] as const)('%s проецирует replacement-диапазон на новую сторону', (_label, anchor, focus) => {
        expect(commentPosition({ fileId: 'f1', anchor, focus }, MODEL, 'f1', 'new', 123)).toEqual({
            side: 'new',
            line: 121,
            size: 3,
        });
    });

    it('использует раскрытый контекст, а не сырую модель файла', () => {
        if (MODEL.content.kind !== 'text') {
            throw new Error('тесту нужна текстовая модель');
        }
        const gap = MODEL.content.blocks.find((block) => block.kind === 'gap' && block.edge === 'leading');
        if (gap?.kind !== 'gap') {
            throw new Error('тесту нужен ведущий пропуск');
        }
        const lines = Array.from({ length: 140 }, (_, index) => `line-${String(index + 1)}`);
        const content: FileContent = { oldText: lines.join('\n'), newText: lines.join('\n') };
        const expanded = expandFileContext(MODEL, content, expandGap(new Map(), gapKeyOf(gap), 'up', 2));
        const expandedSelection = { fileId: 'f1', anchor: 'c98:98', focus: 'c99:99' };

        expect(commentPosition(expandedSelection, MODEL, 'f1', 'new', 98)).toEqual({
            side: 'new',
            line: 98,
            size: 1,
        });
        expect(commentPosition(expandedSelection, expanded, 'f1', 'new', 98)).toEqual({
            side: 'new',
            line: 98,
            size: 2,
        });
    });

    it('не переносит старое выделение на кнопку другой строки', () => {
        expect(commentPosition(selection, MODEL, 'f1', 'new', 50)).toEqual({ side: 'new', line: 50, size: 1 });
    });
});

describe('следующий файл после отметки просмотренным', () => {
    const FILES = [{ fileId: 'a' }, { fileId: 'b' }, { fileId: 'c' }, { fileId: 'd' }];
    const none = (): boolean => false;

    it('берёт соседний файл, когда ниже ничего не свёрнуто', () => {
        expect(nextFileToAdvance(FILES, 'a', none)).toBe('b');
    });

    it('пропускает свёрнутые и ведёт к первому развёрнутому ниже', () => {
        const collapsed = new Set(['b', 'c']);
        expect(nextFileToAdvance(FILES, 'a', (file) => collapsed.has(file.fileId))).toBe('d');
    });

    it('свёрнуто всё ниже — идёт просто к следующему', () => {
        expect(nextFileToAdvance(FILES, 'b', () => true)).toBe('c');
    });

    it('последний файл прокрутки не заказывает', () => {
        expect(nextFileToAdvance(FILES, 'd', none)).toBeNull();
    });

    it('файла нет в текущем списке — перехода нет', () => {
        expect(nextFileToAdvance(FILES, 'z', none)).toBeNull();
    });
});

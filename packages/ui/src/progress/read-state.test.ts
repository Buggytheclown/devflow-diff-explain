import type { UiFileProgress, UiSeenRange } from '@sherpa/protocol';
import { describe, expect, it } from 'vitest';

import { parseFileDiff } from '../diff/parse.js';
import { createT } from '../i18n/index.js';
import type { ReadStateFile } from './read-state.js';
import { changedLinesOf, changeSeenRanges, readStateOf, readStateTooltip } from './read-state.js';

const ru = createT('ru');
const en = createT('en');
const tooltip = (state: ReturnType<typeof readStateOf>): string => readStateTooltip(ru, state);

/** Три состояния прогресса чтения (docs/design/SPEC-elements.md §2.12) и числа тултипа. */

const PLAIN: ReadStateFile = { generated: false, viewed: null, additions: 40, deletions: 20 };

function record(viewed: boolean | null, seenRanges: UiSeenRange[] = []): UiFileProgress {
    return { fileId: 'f', viewed, seenRanges };
}

describe('read-state файла', () => {
    it('без записи и без покрытия — unread с нулём в тултипе', () => {
        const state = readStateOf({ file: PLAIN, record: null });
        expect(state).toMatchObject({ state: 'unread', seen: 0, total: 60, pinned: false, generatedDefault: false });
        expect(tooltip(state)).toBe('0 из 60 изменённых строк просмотрено');
        // Текст собирается на месте показа, поэтому смена языка не требует пересчёта модели.
        expect(readStateTooltip(en, state)).toBe('0 of 60 changed lines seen');
    });

    it('ручная отметка пинит read целиком: число тултипа сходится с залитой коробкой', () => {
        const state = readStateOf({ file: PLAIN, record: record(true) });
        expect(state).toMatchObject({ state: 'read', seen: 60, pinned: true });
        expect(tooltip(state)).toBe('60 из 60 изменённых строк просмотрено');
    });

    it('отметка хоста без своей записи тоже даёт read', () => {
        expect(readStateOf({ file: { ...PLAIN, viewed: true }, record: null }).state).toBe('read');
        expect(readStateOf({ file: { ...PLAIN, viewed: false }, record: null }).state).toBe('unread');
    });

    it('машинный файл прочитан по умолчанию и говорит об этом тултипом', () => {
        const state = readStateOf({ file: { ...PLAIN, generated: true }, record: null });

        expect(state).toMatchObject({ state: 'read', pinned: true, generatedDefault: true });
        expect(tooltip(state)).toBe('сгенерированный файл — по умолчанию прочитан · 60 из 60 изменённых строк просмотрено');
    });

    it('seen-only запись не снимает generated-дефолт', () => {
        const state = readStateOf({
            file: { ...PLAIN, generated: true },
            record: record(null, [{ side: 'new', start: 1, end: 3 }]),
        });

        expect(state).toMatchObject({
            state: 'read',
            seen: 60,
            pinned: true,
            generatedDefault: true,
        });
    });

    it('запись старше умолчаний: снятая отметка машинного файла и отметки хоста', () => {
        expect(readStateOf({ file: { ...PLAIN, generated: true }, record: record(false) })).toMatchObject({
            state: 'unread',
            generatedDefault: false,
        });
        expect(readStateOf({ file: { ...PLAIN, viewed: true }, record: record(false) }).state).toBe('unread');
    });

    it('seen-only запись обычного файла считает состояние от диапазонов', () => {
        const state = readStateOf({
            file: { generated: false, viewed: null, additions: 3, deletions: 2 },
            record: record(null, [{ side: 'new', start: 20, end: 21 }]),
            changed: { old: new Set([10, 11]), new: new Set([20, 21, 22]) },
        });

        expect(state).toMatchObject({ state: 'partial', seen: 2, total: 5, pinned: false });
    });

    it('покрытие диапазонами: часть — partial, всё — read', () => {
        const changed = { old: new Set([10, 11]), new: new Set([20, 21, 22]) };
        const file: ReadStateFile = { generated: false, viewed: null, additions: 3, deletions: 2 };

        const partial = readStateOf({
            file,
            record: record(false, [{ side: 'new', start: 20, end: 21 }]),
            changed,
        });
        expect(partial).toMatchObject({ state: 'partial', seen: 2, total: 5 });
        expect(tooltip(partial)).toBe('2 из 5 изменённых строк просмотрено');

        const full = readStateOf({
            file,
            record: record(false, [
                { side: 'new', start: 18, end: 30 },
                { side: 'old', start: 1, end: 12 },
            ]),
            changed,
        });
        expect(full).toMatchObject({ state: 'read', seen: 5, pinned: false });
    });

    it('диапазон мимо изменённых строк ничего не покрывает', () => {
        const state = readStateOf({
            file: { generated: false, viewed: null, additions: 3, deletions: 0 },
            record: record(false, [{ side: 'new', start: 100, end: 200 }]),
            changed: { old: new Set(), new: new Set([1, 2, 3]) },
        });

        expect(state).toMatchObject({ state: 'unread', seen: 0 });
    });

    it('без строк модели покрытие считается длиной диапазонов и не превышает изменённых строк', () => {
        const file: ReadStateFile = { generated: false, viewed: null, additions: 6, deletions: 0 };

        expect(
            readStateOf({ file, record: record(false, [{ side: 'new', start: 1, end: 3 }]) }),
        ).toMatchObject({ state: 'partial', seen: 3, total: 6 });
        // Пересекающиеся диапазоны склеиваются: строка, посчитанная дважды, соврала бы числом.
        expect(
            readStateOf({
                file,
                record: record(false, [
                    { side: 'new', start: 1, end: 4 },
                    { side: 'new', start: 3, end: 5 },
                ]),
            }),
        ).toMatchObject({ state: 'partial', seen: 5 });
        expect(
            readStateOf({ file, record: record(false, [{ side: 'new', start: 1, end: 99 }]) }),
        ).toMatchObject({ state: 'read', seen: 6 });
    });

    it('файл без изменённых строк не врёт числами', () => {
        const binary: ReadStateFile = { generated: false, viewed: null, additions: 0, deletions: 0 };

        const unread = readStateOf({ file: binary, record: null });
        expect(unread.state).toBe('unread');
        expect(tooltip(unread)).toBe('изменённых строк в файле нет');
        const read = readStateOf({ file: binary, record: record(true) });
        expect(read.state).toBe('read');
        expect(tooltip(read)).toBe('изменённых строк в файле нет');
    });

    it('изменённые строки берутся из модели по сторонам', () => {
        const model = parseFileDiff({
            fileId: 'f',
            path: 'src/a.ts',
            oldPath: null,
            changeType: 'modify',
            binary: false,
            patch: ['@@ -10,3 +10,3 @@', ' one', '-two', '+two!', ' three'].join('\n'),
        });

        expect(changedLinesOf(model)).toEqual({ old: new Set([11]), new: new Set([11]) });
        expect(changedLinesOf(null)).toBeUndefined();
    });
});

describe('правка seen-диапазонов', () => {
    const base: UiSeenRange[] = [
        { side: 'new', start: 1, end: 10 },
        { side: 'old', start: 5, end: 6 },
    ];

    it('добавление склеивает пересекающиеся и соседние диапазоны своей стороны', () => {
        expect(
            changeSeenRanges(base, 'add', [
                { side: 'new', start: 11, end: 15 },
                { side: 'old', start: 20, end: 21 },
            ]),
        ).toEqual([
            { side: 'old', start: 5, end: 6 },
            { side: 'old', start: 20, end: 21 },
            { side: 'new', start: 1, end: 15 },
        ]);
    });

    it('вычитание разрезает пересекающиеся диапазоны и не трогает другую сторону', () => {
        expect(changeSeenRanges(base, 'remove', [{ side: 'new', start: 4, end: 6 }])).toEqual([
            { side: 'old', start: 5, end: 6 },
            { side: 'new', start: 1, end: 3 },
            { side: 'new', start: 7, end: 10 },
        ]);
        expect(changeSeenRanges(base, 'remove', [{ side: 'old', start: 1, end: 9 }])).toEqual([
            { side: 'new', start: 1, end: 10 },
        ]);
    });
});

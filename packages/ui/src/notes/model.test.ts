import type { AgentNote, ChatAnchor, FileDiff } from '@sherpa/protocol';
import { describe, expect, it } from 'vitest';

import { parseFileDiff } from '../diff/parse.js';
import {
    groupOverlappingNotes,
    noteAnchorForIteration,
    notesForIteration,
    noteStackNeedsSummary,
    noteVisibleInIteration,
    placeNotesOnVisibleLines,
} from './model.js';

const FILE: FileDiff = {
    fileId: 'file-1',
    path: 'src/cache.ts',
    oldPath: null,
    changeType: 'modify',
    binary: false,
    additions: 3,
    deletions: 1,
    generated: false,
    viewed: false,
    blameUrl: null,
    hostFileUrl: null,
    image: null,
    patch: [
        '@@ -40,3 +40,5 @@',
        ' const cached = readCache(key);',
        '-return cached;',
        '+if (cached !== null) {',
        '+    return cached;',
        '+}',
        ' return load(key);',
        '',
    ].join('\n'),
};
const MODEL = parseFileDiff(FILE);

function note(
    id: number,
    start: number,
    end: number,
    createdAt: string,
    overrides: Partial<AgentNote> = {},
): AgentNote {
    const anchor: ChatAnchor = { diffId: 'iter-1', fileId: FILE.fileId, path: FILE.path, side: 'new', start, end };
    return {
        id,
        exchangeId: id,
        anchor,
        text: `Заметка ${String(id)}`,
        lostAnchor: false,
        origin: { commit: 'abcdef1', anchor },
        createdAt,
        ...overrides,
    };
}

describe('стопки заметок', () => {
    it('объединяет транзитивные пересечения и сортирует новые заметки сверху', () => {
        const groups = groupOverlappingNotes([
            note(1, 10, 12, '2026-09-01T10:00:00.000Z'),
            note(2, 12, 14, '2026-09-01T10:02:00.000Z'),
            note(3, 14, 16, '2026-09-01T10:01:00.000Z'),
            note(4, 30, 31, '2026-09-01T10:03:00.000Z'),
        ]);

        expect(groups).toHaveLength(2);
        expect(groups[0]).toMatchObject({ start: 10, end: 16 });
        expect(groups[0]?.notes.map((item) => item.id)).toEqual([2, 3, 1]);
        expect(groups[1]?.notes.map((item) => item.id)).toEqual([4]);
    });

    it('сводит стопку только когда заметок больше трёх', () => {
        const three = groupOverlappingNotes([
            note(1, 41, 43, '2026-09-01T10:00:00.000Z'),
            note(2, 42, 43, '2026-09-01T10:01:00.000Z'),
            note(3, 43, 43, '2026-09-01T10:02:00.000Z'),
        ])[0];
        const four = groupOverlappingNotes([
            note(1, 41, 43, '2026-09-01T10:00:00.000Z'),
            note(2, 42, 43, '2026-09-01T10:01:00.000Z'),
            note(3, 43, 43, '2026-09-01T10:02:00.000Z'),
            note(4, 43, 44, '2026-09-01T10:03:00.000Z'),
        ])[0];

        expect(three === undefined ? null : noteStackNeedsSummary(three)).toBe(false);
        expect(four === undefined ? null : noteStackNeedsSummary(four)).toBe(true);
    });
});

describe('раскладка заметок по строкам карточки', () => {
    it('exact оставляет обрезанный конец диапазона под шапкой и скрывает чужой диапазон', () => {
        const visible = note(1, 41, 42, '2026-09-01T10:00:00.000Z');
        const clipped = note(2, 43, 47, '2026-09-01T10:01:00.000Z');
        const outside = note(3, 90, 99, '2026-09-01T10:02:00.000Z');
        const placement = placeNotesOnVisibleLines(MODEL, true, [outside, clipped, visible], 'exact');

        expect(placement.byLine.get('new:42')?.flatMap((group) => group.notes.map((item) => item.id))).toEqual([1]);
        expect(placement.underHeader.flatMap((group) => group.notes.map((item) => item.id))).toEqual([2]);
        expect(placement.hidden.flatMap((group) => group.notes.map((item) => item.id))).toEqual([3]);
    });

    it('nearest притягивает заметку полного диффа к ближайшей видимой строке', () => {
        const outside = note(2, 90, 99, '2026-09-01T10:01:00.000Z');
        const placement = placeNotesOnVisibleLines(MODEL, true, [outside], 'nearest');

        expect(placement.byLine.get('new:44')?.[0]?.notes.map((item) => item.id)).toEqual([2]);
        expect(placement.hidden).toEqual([]);
    });

    it('карточка без строк показывает принадлежащие ей заметки под шапкой в обоих режимах', () => {
        const anchored = note(1, 41, 43, '2026-09-01T10:00:00.000Z');
        const nearest = placeNotesOnVisibleLines(MODEL, false, [anchored], 'nearest');
        const exact = placeNotesOnVisibleLines(MODEL, false, [anchored], 'exact');

        expect(nearest.underHeader[0]?.notes.map((item) => item.id)).toEqual([1]);
        expect(exact.underHeader[0]?.notes.map((item) => item.id)).toEqual([1]);
        expect(exact.hidden).toEqual([]);
    });
});

describe('заметки глазами итерации', () => {
    /** Заметка, переехавшая с `iter-1` на `iter-2` со сдвигом; `lost` — якорь перенести не удалось. */
    function migrated(id: number, lost = false): AgentNote {
        const source = note(id, 10, 12, '2026-09-01T10:00:00.000Z');
        return lost
            ? { ...source, lostAnchor: true }
            : {
                  ...source,
                  anchor: { ...source.anchor, diffId: 'iter-2', fileId: 'file-2', start: 16, end: 18 },
              };
    }

    it('в своей исходной итерации заметка стоит у исходных строк', () => {
        expect(noteAnchorForIteration(migrated(1), 'iter-1')).toMatchObject({
            diffId: 'iter-1',
            fileId: 'file-1',
            start: 10,
        });
    });

    it('в любой другой итерации — у перенесённых', () => {
        expect(noteAnchorForIteration(migrated(1), 'iter-2')).toMatchObject({ diffId: 'iter-2', start: 16 });
        expect(noteAnchorForIteration(migrated(1), null)).toMatchObject({ diffId: 'iter-2', start: 16 });
    });

    it('потерявшая якорь уходит из кода везде, кроме своей исходной итерации', () => {
        const lost = migrated(1, true);

        expect(noteVisibleInIteration(lost, 'iter-2')).toBe(false);
        expect(noteVisibleInIteration(lost, null)).toBe(false);
        expect(noteVisibleInIteration(lost, 'iter-1')).toBe(true);
    });

    it('раскладка активной итерации берёт переехавшие якоря и отбрасывает потерянные', () => {
        const laid = notesForIteration([migrated(1), migrated(2, true)], 'iter-2');

        expect(laid.map((item) => item.id)).toEqual([1]);
        expect(laid[0]?.anchor).toMatchObject({ fileId: 'file-2', start: 16, end: 18 });
    });

    it('в прошлой итерации у кода стоят обе — и потерявшая якорь тоже', () => {
        const laid = notesForIteration([migrated(1), migrated(2, true)], 'iter-1');

        expect(laid.map((item) => item.id)).toEqual([1, 2]);
        expect(laid.every((item) => item.anchor.diffId === 'iter-1')).toBe(true);
    });
});

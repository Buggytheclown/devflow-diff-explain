import type { FileDiff, RouteStop, UiFileProgress, UiSeenRange } from '@sherpa/protocol';
import { describe, expect, it } from 'vitest';

import type { DiffFileModel } from '../diff/model.js';
import type { FileReadState } from '../progress/read-state.js';
import type { AnchorSpan } from './anchor-clip.js';
import type { RouteEntry, RouteFileGroup } from './route-model.js';
import { cardViewedMark, groupReadState, stopCoveredByProgress } from './stop-coverage.js';

function file(fileId: string): FileDiff {
    return {
        fileId,
        path: `${fileId}.ts`,
        oldPath: null,
        changeType: 'modify',
        binary: false,
        generated: false,
        additions: 20,
        deletions: 20,
        patch: null,
        viewed: null,
        blameUrl: null,
        hostFileUrl: null,
        image: null,
    };
}

function group(fileId: string, seenRanges: readonly AnchorSpan[]): RouteFileGroup {
    return {
        file: file(fileId),
        fileId,
        path: `${fileId}.ts`,
        name: `${fileId}.ts`,
        dir: '',
        anchors: [],
        collapsedAnchors: [],
        contextLines: { old: new Set(), new: new Set() },
        hunks: seenRanges.length,
        additions: 0,
        deletions: 0,
        collapsedLines: 0,
        seenRanges,
        whole: false,
    };
}

function entry(stopId: string, groups: readonly RouteFileGroup[]): RouteEntry {
    const stop: RouteStop = {
        id: stopId,
        planIndex: 1,
        tier: 'high',
        title: stopId,
        status: 'ready',
        paragraph: 'готово',
        bridge: null,
        anchors: [],
        tests: [],
        droppedClaims: 0,
        validationNotes: [],
        provenance: null,
        change: null,
    };
    return {
        kind: 'stop',
        view: {
            stop,
            planLabel: '01',
            files: groups,
            changedLines: 0,
            unresolvedPaths: [],
            conflictPaths: [],
            drift: false,
            empty: false,
            pending: false,
            parseFailed: false,
        },
    };
}

function snapshot(
    records: readonly UiFileProgress[],
    readStates: readonly (readonly [string, FileReadState])[] = [],
) {
    return {
        progress: new Map(records.map((record) => [record.fileId, record])),
        readState: new Map(readStates),
    };
}

function progress(fileId: string, seenRanges: readonly UiSeenRange[]): UiFileProgress {
    return { fileId, viewed: false, seenRanges: [...seenRanges] };
}

describe('покрытие остановки прогрессом файлов', () => {
    it('требует полного вхождения диапазона в объединение просмотренного', () => {
        const target = entry('s01', [group('a', [{ side: 'new', start: 10, end: 20 }])]);

        expect(stopCoveredByProgress(target, snapshot([progress('a', [{ side: 'new', start: 10, end: 19 }])]))).toBe(false);
        expect(
            stopCoveredByProgress(
                target,
                snapshot([
                    progress('a', [
                        { side: 'new', start: 15, end: 20 },
                        { side: 'new', start: 10, end: 14 },
                    ]),
                ]),
            ),
        ).toBe(true);
    });

    it('пин целого файла покрывает его часть остановки без диапазонов', () => {
        const target = entry('s01', [group('a', [{ side: 'new', start: 10, end: 20 }])]);
        const pinned: FileReadState = {
            state: 'read',
            seen: 40,
            total: 40,
            pinned: true,
            generatedDefault: false,
        };

        expect(stopCoveredByProgress(target, snapshot([], [['a', pinned]]))).toBe(true);
    });

    it('generated-дефолт без записи прогресса не считается просмотром', () => {
        const target = entry('s01', [group('generated', [{ side: 'new', start: 1, end: 20 }])]);
        const generatedDefault: FileReadState = {
            state: 'read',
            seen: 40,
            total: 40,
            pinned: true,
            generatedDefault: true,
        };

        expect(stopCoveredByProgress(target, snapshot([], [['generated', generatedDefault]]))).toBe(false);
    });

    it('файл, разделённый между остановками, закрывает только покрытый диапазон', () => {
        const first = entry('s01', [group('shared', [{ side: 'new', start: 1, end: 5 }])]);
        const second = entry('s02', [group('shared', [{ side: 'new', start: 6, end: 10 }])]);
        const current = snapshot([progress('shared', [{ side: 'new', start: 1, end: 5 }])]);

        expect(stopCoveredByProgress(first, current)).toBe(true);
        expect(stopCoveredByProgress(second, current)).toBe(false);
    });

    it('не смешивает old и new стороны', () => {
        const target = entry('s01', [
            group('a', [
                { side: 'old', start: 2, end: 4 },
                { side: 'new', start: 8, end: 10 },
            ]),
        ]);

        expect(
            stopCoveredByProgress(
                target,
                snapshot([
                    progress('a', [
                        { side: 'new', start: 2, end: 4 },
                        { side: 'new', start: 8, end: 10 },
                    ]),
                ]),
            ),
        ).toBe(false);
        expect(
            stopCoveredByProgress(
                target,
                snapshot([
                    progress('a', [
                        { side: 'old', start: 2, end: 4 },
                        { side: 'new', start: 8, end: 10 },
                    ]),
                ]),
            ),
        ).toBe(true);
    });

    it('запись, которую держат одни конфликты, гардрейл не требует читать (docs/design/SPEC-elements.md §4.1)', () => {
        const base = entry('s01', []);
        if (base.kind !== 'stop') {
            throw new Error('нужна остановка');
        }
        const conflictStop: RouteEntry = {
            kind: 'stop',
            view: { ...base.view, conflictPaths: ['market/order.ts'] },
        };
        const other: RouteEntry = {
            kind: 'other',
            view: { stop: base.view.stop, planLabel: '07', files: [], lines: 0, conflictFiles: 2 },
        };

        expect(stopCoveredByProgress(conflictStop, snapshot([]))).toBe(true);
        expect(stopCoveredByProgress(other, snapshot([]))).toBe(true);
        // Пустая запись без конфликтов по-прежнему сама себя не закрывает.
        expect(stopCoveredByProgress(base, snapshot([]))).toBe(false);
    });

    it('общая сиротская пробельная строка не закрывает чужой якорный диапазон', () => {
        const orphan = { side: 'new' as const, start: 20, end: 20 };
        const first = entry('s01', [group('shared', [{ side: 'new', start: 1, end: 3 }, orphan])]);
        const second = entry('s02', [group('shared', [{ side: 'new', start: 10, end: 12 }, orphan])]);
        const afterFirst = snapshot([
            progress('shared', [
                { side: 'new', start: 1, end: 3 },
                orphan,
            ]),
        ]);

        expect(stopCoveredByProgress(first, afterFirst)).toBe(true);
        expect(stopCoveredByProgress(second, afterFirst)).toBe(false);
    });
});

describe('read-state карточки файла в остановке', () => {
    const unread: FileReadState = { state: 'unread', seen: 0, total: 40, pinned: false, generatedDefault: false };
    const card = group('shared', [
        { side: 'new', start: 1, end: 5 },
        { side: 'old', start: 3, end: 7 },
    ]);

    it('пин файла держит read в любой карточке', () => {
        const pinned: FileReadState = { state: 'read', seen: 40, total: 40, pinned: true, generatedDefault: false };
        const generated: FileReadState = { ...pinned, generatedDefault: true };

        expect(groupReadState(card, pinned, null)).toBe(pinned);
        expect(groupReadState(card, generated, null)).toBe(generated);
    });

    it('без пина считает покрытие строк самой карточки', () => {
        expect(groupReadState(card, unread, null)).toEqual({ ...unread, total: 10 });
        expect(groupReadState(card, unread, progress('shared', [{ side: 'new', start: 1, end: 5 }]))).toMatchObject({
            state: 'partial',
            seen: 5,
            total: 10,
            pinned: false,
        });
        expect(
            groupReadState(
                card,
                unread,
                progress('shared', [
                    { side: 'new', start: 1, end: 5 },
                    { side: 'old', start: 3, end: 7 },
                    // Строки чужой карточки того же файла её числа не двигают.
                    { side: 'new', start: 30, end: 39 },
                ]),
            ),
        ).toMatchObject({ state: 'read', seen: 10, total: 10 });
    });

    it('засчитывает диапазоны другой остановки, пересекающиеся с карточкой', () => {
        const other = progress('shared', [
            { side: 'new', start: 1, end: 2 },
            { side: 'new', start: 3, end: 20 },
            { side: 'old', start: 1, end: 7 },
        ]);

        expect(groupReadState(card, unread, other)).toMatchObject({ state: 'read', seen: 10, total: 10 });
    });

    it('частичное прочтение файла глобально не делает карточку прочитанной', () => {
        const partial: FileReadState = { state: 'partial', seen: 10, total: 40, pinned: false, generatedDefault: false };

        expect(groupReadState(card, partial, progress('shared', [{ side: 'new', start: 30, end: 39 }]))).toMatchObject({
            state: 'unread',
            seen: 0,
        });
    });
});

describe('чем отмечается карточка файла в остановке', () => {
    // Правилу важно только, есть ли модель: её содержимое оно не читает.
    const model = {} as DiffFileModel;

    it('строками карточки, когда они есть', () => {
        expect(cardViewedMark(group('a', [{ side: 'new', start: 1, end: 3 }]), model, false)).toBe('ranges');
    });

    it('пином файла, когда у разобранного файла строк нет — он нетекстовый и показан целиком', () => {
        expect(cardViewedMark(group('a', []), model, false)).toBe('pin');
    });

    it('никак, пока модели нет: разбор идёт или сорвался', () => {
        expect(cardViewedMark(group('a', []), null, false)).toBe('pending');
        expect(cardViewedMark(group('a', []), null, true)).toBe('parseFailed');
    });
});

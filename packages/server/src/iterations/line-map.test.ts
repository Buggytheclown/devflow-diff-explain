import type { FileDiff, PrDiff, RouteAnchor } from '@sherpa/protocol';
import { describe, expect, it } from 'vitest';

import { walkPatch } from '../route/diff-index.js';
import { mediumReadySnapshot } from '../route/fixture-support.js';
import type { LineRange } from '../route/ranges.js';
import type { IterationMap, MappedRange } from './line-map.js';
import { affectedStops, buildIterationMap, classifyStop, identityMap } from './line-map.js';

/**
 * Отображение строк A→B по интердиффу. Каждое правило — отдельным патчем: ошибка на строку
 * превращает перенесённый прогресс в чужой, а корректный стоп — в ложный `new`.
 */

const PATH = 'services/orders/src/infra/clock.ts';
const OTHER = 'services/orders/src/api/handlers.ts';
const BASE = 'base-a1b2c3';
const HEADERS = ['--- a/x.ts', '+++ b/x.ts'];

/** Одна удалённая строка вместо двух добавленных: дельта +1. */
const PLUS_ONE = [
    ...HEADERS,
    '@@ -10,6 +10,7 @@',
    ' ctx10',
    ' ctx11',
    '-del12',
    '+add12',
    '+add13',
    ' ctx13',
    ' ctx14',
    ' ctx15',
];

/** Две удалённые строки вместо одной добавленной: дельта −1. */
const MINUS_ONE = [
    ...HEADERS,
    '@@ -10,7 +10,6 @@',
    ' ctx10',
    ' ctx11',
    '-del12',
    '-del13',
    '+add12',
    ' ctx14',
    ' ctx15',
    ' ctx16',
];

/** Два изменения в одном ханке с контекстом между ними. */
const TWO_CHANGES = [
    ...HEADERS,
    '@@ -10,5 +10,5 @@',
    ' ctx10',
    '-del11',
    '+add11',
    ' ctx12',
    '-del13',
    '+add13',
    ' ctx14',
];

/** Вставка двух строк между 11 и 12 без единого удаления. */
const INSERT = [...HEADERS, '@@ -10,3 +10,5 @@', ' ctx10', ' ctx11', '+ins12', '+ins13', ' ctx12'];

/** Удаление двух строк без единого добавления. */
const DELETE_ONLY = [...HEADERS, '@@ -10,4 +10,2 @@', ' ctx10', '-del11', '-del12', ' ctx13'];

/** Две вставки в одном ханке с контекстом между ними: ни одного удаления. */
const TWO_INSERTS = [...HEADERS, '@@ -9,4 +9,6 @@', ' ctx9', ' ctx10', '+ins11', ' ctx11', '+ins13', ' ctx12'];

/** Вставка в начале области и замена в её конце: у вставки сосед снаружи есть, у замены нет. */
const INSERT_THEN_REPLACE = [
    ...HEADERS,
    '@@ -10,4 +10,5 @@',
    ' ctx10',
    '+ins11',
    ' ctx11',
    '-del12',
    '+add12',
    ' ctx13',
];

function fileDiff(overrides: Partial<FileDiff> & Pick<FileDiff, 'path'>): FileDiff {
    return {
        fileId: `file:${overrides.path}`,
        oldPath: null,
        changeType: 'modify',
        binary: false,
        generated: false,
        additions: 0,
        deletions: 0,
        patch: null,
        viewed: null,
        blameUrl: null,
        hostFileUrl: null,
        image: null,
        ...overrides,
    };
}

function interdiffOf(files: readonly FileDiff[]): PrDiff {
    return { diffId: 'iteration-b', baseCommit: BASE, headCommit: 'head-b', files: [...files] };
}

/** Карта по одному изменённому файлу `PATH`; базы по умолчанию совпадают. */
function mapWith(patch: readonly string[] | null, bases: { from?: string; to?: string } = {}): IterationMap {
    return buildIterationMap({
        interdiff: interdiffOf([fileDiff({ path: PATH, patch: patch === null ? null : patch.join('\n') })]),
        fromBaseCommit: bases.from ?? BASE,
        toBaseCommit: bases.to ?? BASE,
    });
}

function range(start: number, end: number): LineRange {
    return { start, end };
}

function mapNew(map: IterationMap, start: number, end: number): MappedRange {
    return map.mapRange(PATH, 'new', range(start, end));
}

function anchor(overrides: Partial<RouteAnchor> & Pick<RouteAnchor, 'start' | 'end'>): RouteAnchor {
    return { fileId: `file:${PATH}`, path: PATH, side: 'new', collapsed: false, ...overrides };
}

function totalLength(ranges: readonly LineRange[]): number {
    return ranges.reduce((sum, item) => sum + (item.end - item.start + 1), 0);
}

describe('перенос диапазонов стороны new', () => {
    it('диапазон целиком до ханка переносится без сдвига', () => {
        expect(mapNew(mapWith(PLUS_ONE), 1, 5)).toEqual({ carried: [range(1, 5)], touched: [] });
    });

    it('диапазон целиком после ханка уезжает на положительную дельту', () => {
        expect(mapNew(mapWith(PLUS_ONE), 20, 25)).toEqual({ carried: [range(21, 26)], touched: [] });
    });

    it('диапазон целиком после ханка уезжает на отрицательную дельту', () => {
        expect(mapNew(mapWith(MINUS_ONE), 20, 25)).toEqual({ carried: [range(19, 24)], touched: [] });
    });

    it('диапазон, задевший область ханка слева, режется на затронутое и перенесённое', () => {
        expect(mapNew(mapWith(PLUS_ONE), 11, 12)).toEqual({ carried: [range(11, 11)], touched: [range(12, 12)] });
    });

    it('диапазон, задевший область ханка справа, переносит хвост со сдвигом', () => {
        expect(mapNew(mapWith(PLUS_ONE), 12, 13)).toEqual({ carried: [range(14, 14)], touched: [range(12, 12)] });
    });

    it('диапазон вокруг ханка разрезан надвое: у кусков разные сдвиги', () => {
        expect(mapNew(mapWith(PLUS_ONE), 11, 14)).toEqual({
            carried: [range(11, 11), range(14, 15)],
            touched: [range(12, 12)],
        });
    });

    it('диапазон внутри области ханка не переносится вовсе', () => {
        expect(mapNew(mapWith(TWO_CHANGES), 11, 13)).toEqual({ carried: [], touched: [range(11, 13)] });
    });

    it('контекст в начале и в конце ханка не затронут', () => {
        expect(mapNew(mapWith(PLUS_ONE), 10, 11)).toEqual({ carried: [range(10, 11)], touched: [] });
        expect(mapNew(mapWith(PLUS_ONE), 13, 15)).toEqual({ carried: [range(14, 16)], touched: [] });
    });

    it('контекст между двумя изменениями одного ханка затронут', () => {
        expect(mapWith(TWO_CHANGES).touchedInA(PATH, 'new', range(12, 12))).toEqual([range(12, 12)]);
        expect(mapWith(TWO_CHANGES).touchedInB(PATH, 'new', range(12, 12))).toEqual([range(12, 12)]);
    });
});

describe('вставка без удалений', () => {
    it('в A затронуты соседние строки вставки', () => {
        expect(mapWith(INSERT).touchedInA(PATH, 'new', range(1, 30))).toEqual([range(11, 12)]);
    });

    it('в B затронуты сами вставленные строки', () => {
        expect(mapWith(INSERT).touchedInB(PATH, 'new', range(1, 30))).toEqual([range(12, 13)]);
    });

    it('строки после вставки переносятся со сдвигом', () => {
        expect(mapNew(mapWith(INSERT), 13, 14)).toEqual({ carried: [range(15, 16)], touched: [] });
    });

    it('вставка в начало файла трогает в A только строку после неё', () => {
        const patch = [...HEADERS, '@@ -1,2 +1,4 @@', '+ins1', '+ins2', ' ctx1', ' ctx2'];
        const map = mapWith(patch);
        expect(map.touchedInA(PATH, 'new', range(1, 10))).toEqual([range(1, 1)]);
        expect(mapNew(map, 2, 2)).toEqual({ carried: [range(4, 4)], touched: [] });
    });

    it('удаление без добавлений трогает в B соседей исчезнувших строк', () => {
        const map = mapWith(DELETE_ONLY);
        expect(map.touchedInA(PATH, 'new', range(1, 30))).toEqual([range(11, 12)]);
        expect(map.touchedInB(PATH, 'new', range(1, 30))).toEqual([range(10, 11)]);
    });

    it('вставка метит соседей и когда git склеил её с другой правкой в один ханк', () => {
        const map = mapWith(TWO_INSERTS);
        expect(map.touchedInA(PATH, 'new', range(1, 30))).toEqual([range(10, 12)]);
        expect(map.touchedInB(PATH, 'new', range(1, 30))).toEqual([range(11, 13)]);
    });

    it('вставка в начале области берёт соседа снаружи, замена в конце — нет', () => {
        const map = mapWith(INSERT_THEN_REPLACE);
        expect(map.touchedInA(PATH, 'new', range(1, 30))).toEqual([range(10, 12)]);
        expect(map.touchedInB(PATH, 'new', range(1, 30))).toEqual([range(11, 13)]);
        expect(mapNew(map, 13, 13)).toEqual({ carried: [range(14, 14)], touched: [] });
    });

    it('замена строки не выходит за свои строки: соседний контекст переносится', () => {
        expect(mapWith(PLUS_ONE).touchedInA(PATH, 'new', range(1, 30))).toEqual([range(12, 12)]);
    });
});

describe('статусы файлов', () => {
    it('путь, которого в интердиффе нет, не менялся и переносится тождественно', () => {
        const map = mapWith(PLUS_ONE);
        expect(map.fileStatus(OTHER)).toBe('unchanged');
        expect(map.mapRange(OTHER, 'new', range(5, 9))).toEqual({ carried: [range(5, 9)], touched: [] });
        expect(map.touchedInB(OTHER, 'new', range(5, 9))).toEqual([]);
    });

    it('удалённый файл: переносить нечего, всё затронуто', () => {
        const map = buildIterationMap({
            interdiff: interdiffOf([fileDiff({ path: PATH, changeType: 'delete' })]),
            fromBaseCommit: BASE,
            toBaseCommit: BASE,
        });
        expect(map.fileStatus(PATH)).toBe('removed');
        expect(mapNew(map, 3, 7)).toEqual({ carried: [], touched: [range(3, 7)] });
        expect(map.touchedInB(PATH, 'new', range(3, 7))).toEqual([range(3, 7)]);
    });

    it('добавленный файл: в A его не было, весь диапазон затронут', () => {
        const map = buildIterationMap({
            interdiff: interdiffOf([fileDiff({ path: PATH, changeType: 'add' })]),
            fromBaseCommit: BASE,
            toBaseCommit: BASE,
        });
        expect(map.fileStatus(PATH)).toBe('added');
        expect(mapNew(map, 1, 4)).toEqual({ carried: [], touched: [range(1, 4)] });
    });

    it('переименование — «ушёл и появился»: старый путь removed, новый added', () => {
        const map = buildIterationMap({
            interdiff: interdiffOf([fileDiff({ path: PATH, oldPath: OTHER, changeType: 'move' })]),
            fromBaseCommit: BASE,
            toBaseCommit: BASE,
        });
        expect(map.fileStatus(OTHER)).toBe('removed');
        expect(map.fileStatus(PATH)).toBe('added');
        expect(map.mapRange(OTHER, 'new', range(1, 3))).toEqual({ carried: [], touched: [range(1, 3)] });
        expect(mapNew(map, 1, 3)).toEqual({ carried: [], touched: [range(1, 3)] });
    });

    it('копирование: новый путь added, исходный не тронут', () => {
        const map = buildIterationMap({
            interdiff: interdiffOf([fileDiff({ path: PATH, oldPath: OTHER, changeType: 'copy' })]),
            fromBaseCommit: BASE,
            toBaseCommit: BASE,
        });
        expect(map.fileStatus(PATH)).toBe('added');
        expect(map.fileStatus(OTHER)).toBe('unchanged');
        expect(map.mapRange(OTHER, 'new', range(1, 3))).toEqual({ carried: [range(1, 3)], touched: [] });
    });

    it('conflict считается обычным изменением файла', () => {
        const map = buildIterationMap({
            interdiff: interdiffOf([
                fileDiff({ path: PATH, changeType: 'conflict', patch: PLUS_ONE.join('\n') }),
            ]),
            fromBaseCommit: BASE,
            toBaseCommit: BASE,
        });
        expect(map.fileStatus(PATH)).toBe('modified');
        expect(mapNew(map, 20, 20)).toEqual({ carried: [range(21, 21)], touched: [] });
    });

    it('файл без текстового диффа затронут целиком с обеих сторон', () => {
        const map = mapWith(null);
        expect(mapNew(map, 4, 8)).toEqual({ carried: [], touched: [range(4, 8)] });
        expect(map.touchedInB(PATH, 'new', range(4, 8))).toEqual([range(4, 8)]);
        // Сторона old не спасается неизменной базой: переносить всё равно не по чему.
        expect(map.mapRange(PATH, 'old', range(4, 8))).toEqual({ carried: [], touched: [range(4, 8)] });
        expect(map.touchedInB(PATH, 'old', range(4, 8))).toEqual([range(4, 8)]);
    });
});

describe('тождественные отображения', () => {
    it('интердифф null — перегенерация на той же итерации, всё переносится как есть', () => {
        const map = buildIterationMap({ interdiff: null, fromBaseCommit: BASE, toBaseCommit: BASE });
        expect(map.fileStatus(PATH)).toBe('unchanged');
        expect(mapNew(map, 7, 12)).toEqual({ carried: [range(7, 12)], touched: [] });
        expect(map.touchedInA(PATH, 'new', range(7, 12))).toEqual([]);
    });

    it('интердифф без файлов — тождество', () => {
        const map = buildIterationMap({ interdiff: interdiffOf([]), fromBaseCommit: BASE, toBaseCommit: BASE });
        expect(mapNew(map, 7, 12)).toEqual({ carried: [range(7, 12)], touched: [] });
    });

    it('identityMap не трогает ничего', () => {
        const map = identityMap();
        expect(map.fileStatus(PATH)).toBe('unchanged');
        expect(map.mapRange(PATH, 'old', range(1, 3))).toEqual({ carried: [range(1, 3)], touched: [] });
        expect(map.touchedInB(PATH, 'new', range(1, 3))).toEqual([]);
    });

    it('вырожденный диапазон не переносит ничего — одинаково у обеих карт', () => {
        expect(mapWith(PLUS_ONE).mapRange(PATH, 'new', range(5, 3))).toEqual({ carried: [], touched: [] });
        expect(identityMap().mapRange(PATH, 'new', range(5, 3))).toEqual({ carried: [], touched: [] });
    });
});

describe('сторона old и смена базы', () => {
    it('база не менялась — сторона old переносится тождественно', () => {
        expect(mapWith(PLUS_ONE).mapRange(PATH, 'old', range(10, 14))).toEqual({
            carried: [range(10, 14)],
            touched: [],
        });
    });

    it('база сменилась — вся сторона old затронута, а сторона new переносится как обычно', () => {
        const map = mapWith(PLUS_ONE, { to: 'base-d4e5f6' });
        expect(map.mapRange(PATH, 'old', range(10, 14))).toEqual({ carried: [], touched: [range(10, 14)] });
        expect(map.touchedInB(PATH, 'old', range(10, 14))).toEqual([range(10, 14)]);
        expect(mapNew(map, 20, 21)).toEqual({ carried: [range(21, 22)], touched: [] });
    });

    it('база сменилась при пустом интердиффе — сторона old всё равно затронута', () => {
        const map = buildIterationMap({ interdiff: null, fromBaseCommit: BASE, toBaseCommit: 'base-d4e5f6' });
        expect(map.mapRange(PATH, 'old', range(1, 5))).toEqual({ carried: [], touched: [range(1, 5)] });
        expect(map.touchedInB(PATH, 'old', range(1, 5))).toEqual([range(1, 5)]);
        expect(mapNew(map, 1, 5)).toEqual({ carried: [range(1, 5)], touched: [] });
    });

    it('база сменилась — сторона old затронута и у файлов вне интердиффа', () => {
        const map = mapWith(PLUS_ONE, { to: 'base-d4e5f6' });
        expect(map.mapRange(OTHER, 'old', range(1, 2))).toEqual({ carried: [], touched: [range(1, 2)] });
    });

    it('база неизвестна — сторона old затронута, сторона new переносится как обычно', () => {
        // Итерация записана сервером 0.3.x: ни строки в `iterations`, ни снапшота с базой.
        const map = buildIterationMap({
            interdiff: interdiffOf([fileDiff({ path: PATH, patch: PLUS_ONE.join('\n') })]),
            fromBaseCommit: null,
            toBaseCommit: BASE,
        });

        expect(map.mapRange(PATH, 'old', range(10, 14))).toEqual({ carried: [], touched: [range(10, 14)] });
        expect(map.touchedInB(PATH, 'old', range(10, 14))).toEqual([range(10, 14)]);
        expect(mapNew(map, 20, 21)).toEqual({ carried: [range(21, 22)], touched: [] });
    });
});

describe('инварианты отображения', () => {
    const patches = [PLUS_ONE, MINUS_ONE, TWO_CHANGES, INSERT, DELETE_ONLY, TWO_INSERTS, INSERT_THEN_REPLACE];

    it('куски не пересекаются, отсортированы, а длины сходятся с длиной входа', () => {
        for (const patch of patches) {
            const map = mapWith(patch);
            for (let start = 1; start <= 20; start += 1) {
                for (let end = start; end <= 20; end += 1) {
                    const result = map.mapRange(PATH, 'new', range(start, end));
                    const length = end - start + 1;
                    expect(totalLength(result.carried) + totalLength(result.touched)).toBe(length);
                    for (const pieces of [result.carried, result.touched]) {
                        let previous = 0;
                        for (const piece of pieces) {
                            expect(piece.start).toBeGreaterThan(previous);
                            expect(piece.end).toBeGreaterThanOrEqual(piece.start);
                            previous = piece.end;
                        }
                    }
                }
            }
        }
    });
});

describe('согласованность с walkPatch', () => {
    /**
     * Эталон правила 1 прямо из разметки: изменённые строки ханка плюс контекст между ними.
     * Годится для патчей без чистых вставок — у тех область растёт ещё и на соседей (правило 2).
     */
    function expectedTouchedOld(patch: readonly string[]): number[] {
        const touched: number[] = [];
        for (const hunk of hunksOf(patch)) {
            const first = hunk.findIndex((line) => line.changed);
            const last = hunk.findLastIndex((line) => line.changed);
            if (first < 0) {
                continue;
            }
            for (const line of hunk.slice(first, last + 1)) {
                if (line.old !== null) {
                    touched.push(line.old);
                }
            }
        }
        return touched;
    }

    function hunksOf(patch: readonly string[]): { old: number | null; new: number | null; changed: boolean }[][] {
        const hunks: { old: number | null; new: number | null; changed: boolean }[][] = [];
        for (const line of walkPatch(patch.join('\n'))) {
            if (line.old === null && line.new === null) {
                if (line.raw.startsWith('@@')) {
                    hunks.push([]);
                }
                continue;
            }
            hunks.at(-1)?.push({ old: line.old, new: line.new, changed: line.changed });
        }
        return hunks;
    }

    const patches = [PLUS_ONE, MINUS_ONE, TWO_CHANGES];

    it('множество затронутых строк A совпадает с посчитанным по walkPatch', () => {
        for (const patch of patches) {
            const touched = mapWith(patch).touchedInA(PATH, 'new', range(1, 100));
            const lines = touched.flatMap((piece) => {
                const numbers: number[] = [];
                for (let line = piece.start; line <= piece.end; line += 1) {
                    numbers.push(line);
                }
                return numbers;
            });
            expect(lines).toEqual(expectedTouchedOld(patch));
        }
    });

    it('сдвиг каждой непотревоженной контекстной строки равен new − old из walkPatch', () => {
        for (const patch of patches) {
            const map = mapWith(patch);
            const touched = new Set(expectedTouchedOld(patch));
            for (const hunk of hunksOf(patch)) {
                for (const line of hunk) {
                    if (line.changed || line.old === null || line.new === null || touched.has(line.old)) {
                        continue;
                    }
                    expect(map.mapRange(PATH, 'new', range(line.old, line.old)).carried).toEqual([
                        range(line.new, line.new),
                    ]);
                }
            }
        }
    });
});

describe('классификация стопа нового снапшота', () => {
    it('все строки якорей затронуты — стоп new', () => {
        const map = mapWith(TWO_CHANGES);
        expect(classifyStop({ anchors: [anchor({ start: 11, end: 13 })] }, map)).toBe('new');
    });

    it('файл появился между итерациями — стоп new', () => {
        const map = buildIterationMap({
            interdiff: interdiffOf([fileDiff({ path: PATH, changeType: 'add' })]),
            fromBaseCommit: BASE,
            toBaseCommit: BASE,
        });
        expect(classifyStop({ anchors: [anchor({ start: 1, end: 40 })] }, map)).toBe('new');
    });

    it('затронута часть строк — стоп changed', () => {
        const map = mapWith(TWO_CHANGES);
        expect(classifyStop({ anchors: [anchor({ start: 10, end: 14 })] }, map)).toBe('changed');
    });

    it('часть якорей затронута, часть нет — стоп changed', () => {
        const map = mapWith(TWO_CHANGES);
        const stop = { anchors: [anchor({ start: 11, end: 13 }), anchor({ path: OTHER, start: 1, end: 5 })] };
        expect(classifyStop(stop, map)).toBe('changed');
    });

    it('ни одна строка не затронута — без классификации', () => {
        const map = mapWith(TWO_CHANGES);
        expect(classifyStop({ anchors: [anchor({ start: 20, end: 25 })] }, map)).toBeNull();
    });

    it('стоп без якорей — без классификации', () => {
        expect(classifyStop({ anchors: [] }, mapWith(TWO_CHANGES))).toBeNull();
    });

    it('якорь на стороне old при смене базы — стоп new', () => {
        const map = mapWith(TWO_CHANGES, { to: 'base-d4e5f6' });
        expect(classifyStop({ anchors: [anchor({ side: 'old', start: 40, end: 44 })] }, map)).toBe('new');
    });
});

describe('затронутые стопы старого снапшота', () => {
    it('возвращает id стопов с затронутыми якорями в порядке снапшота', () => {
        const snapshot = mediumReadySnapshot();
        const map = mapWith(PLUS_ONE);
        expect(affectedStops(snapshot, map)).toEqual(['s01']);
    });

    it('нетронутый интердиффом снапшот не даёт ни одного стопа', () => {
        expect(affectedStops(mediumReadySnapshot(), identityMap())).toEqual([]);
    });

    it('смена базы задевает стопы с якорями на стороне old', () => {
        const snapshot = mediumReadySnapshot();
        const map = mapWith(PLUS_ONE, { to: 'base-d4e5f6' });
        expect(affectedStops(snapshot, map)).toContain('s02');
    });
});

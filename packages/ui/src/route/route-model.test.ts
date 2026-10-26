import { fixtureIteration, routeFixtures } from '@sherpa/fixtures';
import type { AgentNote, ChatAnchor, FileDiff, RouteSnapshot, RouteStop, UiStopSeenRange } from '@sherpa/protocol';
import { describe, expect, it } from 'vitest';

import type { DiffFileModel } from '../diff/model.js';
import { toParseRequest } from '../diff/model.js';
import { parseFileDiff } from '../diff/parse.js';
import type { FileReadState } from '../progress/read-state.js';
import { changedLinesOf, readStateOf } from '../progress/read-state.js';
import type { RouteFileGroup, RouteModel, RouteTotals, StopDiffMountState } from './route-model.js';
import {
    buildRouteModel,
    canUnmountStopDiff,
    changeFilterAvailable,
    composersForGroup,
    countStopComments,
    entryMatchesChangeFilter,
    entryParseFailed,
    filterOtherView,
    lazyCards,
    LAZY_HUNK_THRESHOLD,
    notesForGroup,
    PROMOTE_THRESHOLD,
    stopMatchesFilter,
    stopSeenRanges,
    threadsForGroup,
} from './route-model.js';

/**
 * Числа маршрута считаются от якорей и моделей диффа, а не берутся из снапшота. Эталон —
 * фикстура `medium`, у которой покрытие сведено с полосой дизайна (866 / 828 / 38, тиры
 * 196 / 327 / 305): если счёт разъедется, это увидит ровно этот тест. Изменённых строк в
 * патчах 868; две пустые строки psp-schema.ts вне якорей в статистику покрытия не входят.
 */

const DATA = fixtureIteration('medium');
const READY = routeFixtures('medium')?.states.ready ?? null;
if (READY?.snapshot == null) {
    throw new Error('фикстуре medium нужен готовый снапшот маршрута');
}
const SNAPSHOT: RouteSnapshot = READY.snapshot;

const MODELS = new Map<string, DiffFileModel>(
    DATA.diff.files.map((file) => [file.fileId, parseFileDiff(toParseRequest(file))]),
);

const EMPTY_TOTALS: RouteTotals = {
    changed: 0,
    covered: 0,
    uncovered: 0,
    byTier: { high: 0, medium: 0, low: 0, other: 0 },
    pendingFiles: 0,
    failedFiles: 0,
    conflictFiles: 0,
};

function build(snapshot: RouteSnapshot = SNAPSHOT, files: readonly FileDiff[] = DATA.diff.files) {
    return buildRouteModel({ snapshot, files, models: MODELS });
}

function stopFiles(id: string): readonly RouteFileGroup[] {
    return build().entries.flatMap((entry) =>
        entry.kind === 'stop' && entry.view.stop.id === id ? entry.view.files : [],
    );
}

/** Порядок и номера записей модели — то, что видит ревьюер в колонке остановок. */
function ids(model: ReturnType<typeof build>): string[] {
    return model.entries.map((entry) => entry.view.stop.id);
}

function numbers(model: ReturnType<typeof build>): string[] {
    return model.entries.map((entry) => entry.view.planLabel);
}

/** Якоря low-стопов и сборного 03 срезаны: непокрытого больше порога подъёма (docs/design/SPEC-elements.md §4.3). */
function strippedAnchors(): RouteSnapshot {
    return {
        ...SNAPSHOT,
        stops: SNAPSHOT.stops.map((stop) =>
            stop.tier === 'low' || stop.id === 's03' ? { ...stop, anchors: [] } : stop,
        ),
    };
}

function stopOf(id: string): RouteStop {
    const stop = SNAPSHOT.stops.find((candidate) => candidate.id === id);
    if (stop === undefined) {
        throw new Error(`в фикстурном снапшоте нет стопа ${id}`);
    }
    return stop;
}

describe('модель маршрута', () => {
    it('покрытие сходится с полосой покрытия в дизайн-хендоффе: 866 изменённых, 828 объяснено, 38 нет', () => {
        const { totals } = build();

        expect(totals.changed).toBe(866);
        expect(totals.covered).toBe(828);
        expect(totals.uncovered).toBe(38);
        expect(totals.pendingFiles).toBe(0);
        expect(totals.covered + totals.uncovered).toBe(totals.changed);
    });

    it('строки по тирам сходятся с фикстурой', () => {
        const { totals } = build();

        expect(totals.byTier).toEqual({ high: 196, medium: 327, low: 305, other: 38 });
        expect(totals.byTier.high + totals.byTier.medium + totals.byTier.low).toBe(totals.covered);
    });

    it('непокрытое лежит ровно в четырёх файлах фикстуры', () => {
        const model = build();
        const other = model.entries.find((entry) => entry.kind === 'other');

        expect(other?.kind).toBe('other');
        if (other?.kind !== 'other') {
            return;
        }
        // Порядок — порядок файлов диффа, а не якорей: «Прочее» идёт по документу.
        expect(other.view.files.map((file) => [file.name, file.lines])).toEqual([
            // 15, а не 17: две пустые строки хвоста psp-schema.ts «Прочее» не забирает.
            ['psp-schema.ts', 15],
            ['CODEOWNERS', 5],
            ['ci.yml', 12],
            // Картинки маршрут не видит: строки добавленной svg честно уходят в «Прочее».
            ['countdown-icon.svg', 6],
        ]);
        expect(other.view.lines).toBe(38);
    });

    it('порядок рендера — триаж снапшота, «Прочее» последним, номера план-фиксированные', () => {
        const model = build();

        expect(model.promoted).toBe(false);
        expect(model.stopCount).toBe(7);
        expect(
            model.entries.map((entry) => (entry.kind === 'stop' ? entry.view.stop.id : 'other')),
        ).toEqual(['s01', 's02', 's03', 's04', 's05', 's06', 'other']);
        expect(model.entries.map((entry) => entry.view.planLabel)).toEqual([
            '01',
            '02',
            '03',
            '04',
            '05',
            '06',
            '07',
        ]);
    });

    it('полный тур идёт по tourOrder снапшота, номера остаются план-фиксированными', () => {
        const tour = buildRouteModel({ snapshot: SNAPSHOT, files: DATA.diff.files, models: MODELS, preset: 'tour' });

        expect(ids(tour)).toEqual([...SNAPSHOT.tourOrder]);
        // Номера едут за своими остановками: у первой карточки тура номер 03, а не 01.
        expect(numbers(tour)).toEqual(['03', '01', '02', '05', '06', '04', '07']);
        // Набор тот же, что в триаже, — меняется только порядок карточек.
        expect([...ids(tour)].sort()).toEqual([...ids(build())].sort());
        expect([...numbers(tour)].sort()).toEqual([...numbers(build())].sort());
        expect(tour.stopCount).toBe(7);
    });

    it('в туре порядок строго по tourOrder: подъём «Прочего» — приём триажа, а не тура', () => {
        const stripped = strippedAnchors();
        const triage = build(stripped);
        const tour = buildRouteModel({ snapshot: stripped, files: DATA.diff.files, models: MODELS, preset: 'tour' });

        expect(triage.promoted).toBe(true);
        // Флаг общий — по нему поднимается баннер «стоит перегенерировать», — а порядок нет.
        expect(tour.promoted).toBe(true);
        expect(ids(tour)).toEqual([...SNAPSHOT.tourOrder]);
    });

    it('кривой tourOrder не роняет вью: чужие id пропущены, забытые стопы уходят в хвост', () => {
        const broken: RouteSnapshot = { ...SNAPSHOT, tourOrder: ['s03', 'выдуманный-стоп', 's03', 's01', 'other'] };
        const tour = buildRouteModel({ snapshot: broken, files: DATA.diff.files, models: MODELS, preset: 'tour' });

        expect(ids(tour)).toEqual(['s03', 's01', 'other', 's02', 's04', 's05', 's06']);
        expect(tour.stopCount).toBe(7);
    });

    it('при непокрытом выше порога «Прочее» встаёт перед первым low-стопом, номера не двигаются', () => {
        // Урезаем якоря low-стопов: непокрытого становится больше порога, план не меняется.
        const stripped: RouteSnapshot = {
            ...SNAPSHOT,
            stops: SNAPSHOT.stops.map((stop) =>
                stop.tier === 'low' || stop.id === 's03' ? { ...stop, anchors: [] } : stop,
            ),
        };
        const model = build(stripped);

        expect(model.totals.uncovered / model.totals.changed).toBeGreaterThan(PROMOTE_THRESHOLD);
        expect(model.promoted).toBe(true);
        expect(
            model.entries.map((entry) => (entry.kind === 'stop' ? entry.view.stop.id : 'other')),
        ).toEqual(['s01', 's02', 's03', 's04', 'other', 's05', 's06']);
        const other = model.entries.find((entry) => entry.kind === 'other');
        expect(other?.view.planLabel).toBe('07');
    });

    it('нулю непокрытых строк соответствует отсутствие «Прочего» (docs/design/SPEC-elements.md §4.3)', () => {
        // Один синтетический стоп на весь дифф: непокрытого не остаётся.
        const everything: RouteSnapshot = {
            ...SNAPSHOT,
            stops: [
                {
                    ...stopOf('s01'),
                    anchors: DATA.diff.files.flatMap((file) => [
                        { fileId: file.fileId, path: file.path, side: 'old' as const, start: 1, end: 100_000, collapsed: false },
                        { fileId: file.fileId, path: file.path, side: 'new' as const, start: 1, end: 100_000, collapsed: false },
                    ]),
                },
                stopOf('other'),
            ],
        };
        const model = build(everything);

        expect(model.totals.uncovered).toBe(0);
        expect(model.entries.every((entry) => entry.kind === 'stop')).toBe(true);
        // Знаменатель «01 / N», счётчик тулбара и гардрейл считают один набор слотов.
        expect(model.stopCount).toBe(model.entries.length);
        expect(model.stopCount).toBe(everything.stops.length - 1);
    });

    it('конфликтный файл вне математики покрытия и назван строкой «Прочего» (docs/design/SPEC-elements.md §4.1)', () => {
        const first = DATA.diff.files[0];
        if (first === undefined) {
            throw new Error('фикстуре нужен хотя бы один файл');
        }
        const base = build();
        // Тот же дифф, но первый файл пришёл конфликтным: его строк не должно остаться нигде.
        const withConflict = DATA.diff.files.map((file) =>
            file.fileId === first.fileId ? { ...file, changeType: 'conflict' as const } : file,
        );
        const model = buildRouteModel({ snapshot: SNAPSHOT, files: withConflict, models: MODELS });
        // Эталон — тот же дифф вовсе без этого файла: конфликт обязан считаться так же.
        const without = buildRouteModel({
            snapshot: SNAPSHOT,
            files: DATA.diff.files.filter((file) => file.fileId !== first.fileId),
            models: MODELS,
        });

        expect(model.totals.conflictFiles).toBe(1);
        expect(model.totals.changed).toBe(without.totals.changed);
        expect(model.totals.changed).toBeLessThan(base.totals.changed);
        expect(model.totals.uncovered).toBe(without.totals.uncovered);
        expect(
            model.entries.some(
                (entry) => entry.kind === 'stop' && entry.view.files.some((group) => group.fileId === first.fileId),
            ),
        ).toBe(false);
    });

    it('якоря на конфликтном файле — не дрейф: путь уходит в conflictPaths', () => {
        const first = SNAPSHOT.stops[0];
        if (first === undefined) {
            throw new Error('фикстуре нужен хотя бы один стоп');
        }
        // Все файлы первого стопа пришли конфликтными: строки на месте, но файл вне покрытия.
        const stopFiles = new Set(first.anchors.map((anchor) => anchor.fileId));
        const withConflict = DATA.diff.files.map((file) =>
            stopFiles.has(file.fileId) ? { ...file, changeType: 'conflict' as const } : file,
        );
        const entry = buildRouteModel({ snapshot: SNAPSHOT, files: withConflict, models: MODELS }).entries.find(
            (item) => item.kind === 'stop' && item.view.stop.id === first.id,
        );
        if (entry?.kind !== 'stop') {
            throw new Error('стоп пропал из маршрута');
        }

        expect(entry.view.drift).toBe(false);
        expect(entry.view.unresolvedPaths).toEqual([]);
        expect(entry.view.conflictPaths.length).toBeGreaterThan(0);
        expect(entry.view.files).toEqual([]);
        expect(entry.view.changedLines).toBe(0);
    });

    it('«Прочее» держится ради конфликтов, даже когда непокрытых строк нет', () => {
        const conflictsOnly = DATA.diff.files.map((file) => ({ ...file, changeType: 'conflict' as const }));
        const model = buildRouteModel({ snapshot: SNAPSHOT, files: conflictsOnly, models: MODELS });
        const other = model.entries.find((entry) => entry.kind === 'other');

        expect(model.totals.changed).toBe(0);
        expect(model.totals.uncovered).toBe(0);
        expect(other?.kind === 'other' ? other.view.conflictFiles : 0).toBe(conflictsOnly.length);
    });

    it('пока дифф разбирается, «Прочего» нет: непокрытое ещё не посчитано', () => {
        const model = buildRouteModel({ snapshot: SNAPSHOT, files: DATA.diff.files, models: new Map() });

        expect(model.totals.pendingFiles).toBe(DATA.diff.files.length);
        expect(model.entries.some((entry) => entry.kind === 'other')).toBe(false);
        expect(model.stopCount).toBe(6);
    });

    it('пока маршрут строится, «Прочего» нет, хотя незанятые слоты дают непокрытое', () => {
        const filling: RouteSnapshot = {
            ...SNAPSHOT,
            stops: SNAPSHOT.stops.map((stop) =>
                stop.id === 's02' ? { ...stop, status: 'filling' as const, anchors: [] } : stop,
            ),
        };
        const model = build(filling);

        expect(model.totals.uncovered).toBeGreaterThan(0);
        expect(model.entries.some((entry) => entry.kind === 'other')).toBe(false);
        expect(model.promoted).toBe(false);
    });

    it('строки провалившейся секции уходят в «Прочее»: маршрут с провалом достроен', () => {
        const failed: RouteSnapshot = {
            ...SNAPSHOT,
            stops: SNAPSHOT.stops.map((stop) =>
                stop.id === 's02' ? { ...stop, status: 'failed' as const, anchors: [] } : stop,
            ),
        };
        const model = build(failed);

        expect(model.totals.uncovered).toBeGreaterThan(build().totals.uncovered);
        expect(model.entries.some((entry) => entry.kind === 'other')).toBe(true);
    });

    it('файл с сорвавшимся разбором не держит остановку в «ещё считается»', () => {
        const first = DATA.diff.files[0];
        if (first === undefined) {
            throw new Error('фикстуре нужен хотя бы один файл');
        }
        const withoutFirst = new Map(MODELS);
        withoutFirst.delete(first.fileId);
        const stopsOf = (failed: ReadonlySet<string>) =>
            buildRouteModel({
                snapshot: SNAPSHOT,
                files: DATA.diff.files,
                models: withoutFirst,
                failed,
            }).entries.flatMap((entry) =>
                entry.kind === 'stop' && entry.view.files.some((group) => group.fileId === first.fileId)
                    ? [entry.view]
                    : [],
            );

        expect(stopsOf(new Set()).some((view) => view.pending)).toBe(true);
        expect(stopsOf(new Set()).every((view) => !view.parseFailed)).toBe(true);
        // Разбор сорвался: сам собой файл не досчитается, и ждать больше нечего — но и отметить
        // остановку нельзя, диапазонов по этому файлу не будет до повтора разбора.
        expect(stopsOf(new Set([first.fileId])).every((view) => !view.pending)).toBe(true);
        expect(stopsOf(new Set([first.fileId])).every((view) => view.parseFailed)).toBe(true);
    });

    it('seen-диапазоны остановки не досчитывают файл с сорвавшимся разбором', () => {
        const first = DATA.diff.files[0];
        if (first === undefined) {
            throw new Error('фикстуре нужен хотя бы один файл');
        }
        const withoutFirst = new Map(MODELS);
        withoutFirst.delete(first.fileId);
        const entry = buildRouteModel({
            snapshot: SNAPSHOT,
            files: DATA.diff.files,
            models: withoutFirst,
            failed: new Set([first.fileId]),
        }).entries.find(
            (candidate) =>
                candidate.kind === 'stop' && candidate.view.files.some((group) => group.fileId === first.fileId),
        );
        if (entry === undefined) {
            throw new Error('файл первым делом должен попасть в какую-то остановку');
        }

        // Ровно та дыра, ради которой заведён флаг: набор молча приехал бы без этого файла.
        expect(stopSeenRanges(entry).some((range) => range.fileId === first.fileId)).toBe(false);
        expect(entryParseFailed(entry, { ...EMPTY_TOTALS, failedFiles: 1 })).toBe(true);
    });

    it('якоря, не резолвящиеся в дифф, дают дрейф, а стоп без якорей — пустой слот', () => {
        const drifted: RouteSnapshot = {
            ...SNAPSHOT,
            stops: SNAPSHOT.stops.map((stop) => {
                if (stop.id === 's01') {
                    return {
                        ...stop,
                        anchors: stop.anchors.map((anchor) => ({ ...anchor, fileId: 'ушедший-файл' })),
                    };
                }
                return stop.id === 's02' ? { ...stop, anchors: [] } : stop;
            }),
        };
        const model = build(drifted);
        const stops = model.entries.flatMap((entry) => (entry.kind === 'stop' ? [entry.view] : []));

        expect(stops[0]?.drift).toBe(true);
        expect(stops[0]?.unresolvedPaths.length).toBeGreaterThan(0);
        expect(stops[0]?.empty).toBe(false);
        expect(stops[1]?.drift).toBe(false);
        expect(stops[1]?.empty).toBe(true);
    });

    it('файлы стопа несут свои счётчики и директиву свёртки', () => {
        const model = build();
        const lock = model.entries.flatMap((entry) =>
            entry.kind === 'stop' && entry.view.stop.id === 's06' ? entry.view.files : [],
        );

        expect(lock).toHaveLength(1);
        expect(lock[0]?.name).toBe('pnpm-lock.yaml');
        expect(lock[0]?.anchors).toHaveLength(0);
        expect(lock[0]?.collapsedAnchors).toHaveLength(2);
        expect(lock[0]?.collapsedLines).toBe((lock[0]?.additions ?? 0) + (lock[0]?.deletions ?? 0));
        expect(lock[0]?.whole).toBe(true);
    });

    it('без разобранных моделей числа честно помечены незаконченными', () => {
        const model = buildRouteModel({ snapshot: SNAPSHOT, files: DATA.diff.files, models: new Map() });

        expect(model.totals.pendingFiles).toBe(DATA.diff.files.length);
        // Счётчики патча: пробельные строки видны только по разобранной модели, поэтому здесь
        // ещё 868 — с ними. Пока `pendingFiles` больше нуля, числа и помечены незаконченными.
        expect(model.totals.changed).toBe(868);
        expect(model.totals.covered).toBe(0);
        expect(model.totals.uncovered).toBe(0);
    });

    it('фильтр файлов прячет стопы, в которых не осталось ни одного файла', () => {
        const model = build();
        const stops = model.entries.flatMap((entry) => (entry.kind === 'stop' ? [entry.view] : []));
        const first = stops[0];
        if (first === undefined) {
            throw new Error('в модели должен быть хотя бы один стоп');
        }
        const onlyFirst = new Set(first.files.map((file) => file.fileId));

        expect(stopMatchesFilter(first, onlyFirst)).toBe(true);
        expect(stopMatchesFilter(first, null)).toBe(true);
        expect(stops.filter((stop) => stopMatchesFilter(stop, onlyFirst))).toEqual([first]);
    });

    it('фильтр «что нового» оставляет только классифицированные стопы и прячет «Прочее»', () => {
        const snapshot: RouteSnapshot = {
            ...SNAPSHOT,
            stops: SNAPSHOT.stops.map((stop) =>
                stop.id === 's02'
                    ? { ...stop, change: { kind: 'changed', reason: null, threadIds: [] } }
                    : stop.id === 's06'
                      ? { ...stop, change: { kind: 'new', reason: null, threadIds: [] } }
                      : stop,
            ),
        };
        const model = buildRouteModel({ snapshot, files: DATA.diff.files, models: new Map() });
        const shown = model.entries.filter((entry) => entryMatchesChangeFilter(entry, true));

        expect(changeFilterAvailable(model.entries)).toBe(true);
        expect(shown.map((entry) => entry.view.stop.id)).toEqual(['s02', 's06']);
        // Номера план-фиксированные: знаменатель считается по полному набору записей.
        expect(model.stopCount).toBe(model.entries.length);
        expect(shown.map((entry) => entry.view.planLabel)).toEqual(['02', '06']);
    });

    it('классифицированных стопов нет — фильтр «что нового» недействителен', () => {
        const model = build();

        expect(changeFilterAvailable(model.entries)).toBe(false);
        expect(model.entries.filter((entry) => entryMatchesChangeFilter(entry, false))).toEqual(model.entries);
    });

    it('часть якорей уехала — остановка остаётся с уцелевшими файлами и нотисом', () => {
        const target = stopFiles('s03')[0];
        if (target === undefined) {
            throw new Error('у стопа s03 должны быть файлы');
        }
        const partial: RouteSnapshot = {
            ...SNAPSHOT,
            stops: SNAPSHOT.stops.map((stop) =>
                stop.id === 's03'
                    ? {
                          ...stop,
                          anchors: stop.anchors.map((anchor) =>
                              anchor.fileId === target.fileId ? { ...anchor, fileId: 'ушедший-файл' } : anchor,
                          ),
                      }
                    : stop,
            ),
        };
        const view = build(partial).entries.flatMap((entry) =>
            entry.kind === 'stop' && entry.view.stop.id === 's03' ? [entry.view] : [],
        )[0];

        expect(view?.drift).toBe(false);
        expect(view?.unresolvedPaths).toEqual([target.path]);
        expect(view?.files.map((file) => file.fileId)).not.toContain(target.fileId);
    });

    it('якорь указывает в существующий файл, но мимо изменённых строк — тоже дрейф', () => {
        const target = stopFiles('s03')[0];
        if (target === undefined) {
            throw new Error('у стопа s03 должны быть файлы');
        }
        const moved: RouteSnapshot = {
            ...SNAPSHOT,
            stops: SNAPSHOT.stops.map((stop) =>
                stop.id === 's03'
                    ? {
                          ...stop,
                          anchors: stop.anchors.map((anchor) =>
                              anchor.fileId === target.fileId
                                  ? { ...anchor, start: 900_000, end: 900_010 }
                                  : anchor,
                          ),
                      }
                    : stop,
            ),
        };
        const view = build(moved).entries.flatMap((entry) =>
            entry.kind === 'stop' && entry.view.stop.id === 's03' ? [entry.view] : [],
        )[0];

        expect(view?.unresolvedPaths).toEqual([target.path]);
        expect(view?.files.map((file) => file.fileId)).not.toContain(target.fileId);
    });

    it('комментарий на строке контекста достаётся остановке, которая её рисует', () => {
        const group = stopFiles('s01')[0];
        const anchor = group?.anchors[0];
        if (group === undefined || anchor === undefined) {
            throw new Error('у стопа s01 должен быть якорь');
        }
        const at = (line: number) => ({
            ...DATA.threads[0],
            id: `thread-${String(line)}`,
            outdated: false,
            anchor: {
                fileId: group.fileId,
                path: group.path,
                position: { side: anchor.side, line, size: 1 },
            },
        }) as (typeof DATA.threads)[number];
        // Строка сразу под диапазоном: карточка её рисует контекстом, значит и комментарий её.
        const context = at(anchor.end + 1);
        const far = at(anchor.end + 100);

        expect(threadsForGroup(group, new Map([[group.fileId, [context, far]]]))).toEqual([context]);
    });

    it('заметка на маршруте подчиняется тому же владению диапазоном, что тред', () => {
        const group = stopFiles('s01')[0];
        const anchor = group?.anchors[0];
        if (group === undefined || anchor === undefined) {
            throw new Error('у стопа s01 должен быть якорь');
        }
        const at = (id: number, line: number): AgentNote => {
            const noteAnchor: ChatAnchor = {
                diffId: DATA.diff.diffId,
                fileId: group.fileId,
                path: group.path,
                side: anchor.side,
                start: line,
                end: line,
            };
            return {
                id,
                exchangeId: id,
                anchor: noteAnchor,
                text: 'Ответ агента',
                lostAnchor: false,
                origin: { commit: 'abcdef1', anchor: noteAnchor },
                createdAt: '2026-09-01T10:00:00.000Z',
            };
        };
        const context = at(1, anchor.end + 1);
        const far = at(2, anchor.end + 100);

        expect(notesForGroup(group, new Map([[group.fileId, [context, far]]]))).toEqual([context]);
    });

    it('контекст между двумя остановками достаётся одной — комментарий не двоится', () => {
        const file = DATA.diff.files[0];
        if (file === undefined) {
            throw new Error('в фикстуре должен быть хотя бы один файл');
        }
        const spans = [
            { start: 10, end: 12 },
            { start: 16, end: 18 },
        ];
        const twins: RouteSnapshot = {
            ...SNAPSHOT,
            stops: SNAPSHOT.stops.slice(0, 2).map((stop, index) => ({
                ...stop,
                anchors: [
                    {
                        fileId: file.fileId,
                        path: file.path,
                        side: 'new' as const,
                        start: spans[index]?.start ?? 0,
                        end: spans[index]?.end ?? 0,
                        collapsed: false,
                    },
                ],
            })),
        };
        const groups = build(twins).entries.flatMap((entry) =>
            entry.kind === 'stop' ? entry.view.files : [],
        );
        // Строки 13–15 — контекст обеих остановок; забирает их первая по плану.
        const owners = [13, 14, 15].map(
            (line) => groups.filter((group) => group.contextLines.new.has(line)).length,
        );

        expect(owners).toEqual([1, 1, 1]);
    });

    it('черновик комментария достаётся тем же остановкам, что и тред', () => {
        const group = stopFiles('s01')[0];
        const anchor = group?.anchors[0];
        if (group === undefined || anchor === undefined) {
            throw new Error('у стопа s01 должен быть якорь');
        }
        const composer = (line: number) => ({
            key: `new:${group.fileId}:${anchor.side}:${String(line)}`,
            threadId: null,
            parentId: null,
            anchor: {
                fileId: group.fileId,
                path: group.path,
                position: { side: anchor.side, line, size: 1 },
            },
            text: '',
            commentId: null,
            status: 'idle' as const,
            slow: false,
            confirmDiscard: false,
            resolvedAtOpen: false,
        });
        const inside = composer(anchor.start);
        const outside = composer(100_000);

        expect(composersForGroup(group, new Map([[group.fileId, [inside, outside]]]))).toEqual([inside]);
    });

    it('сорвавшийся разбор не держит счётчики незаконченными вечно', () => {
        const broken = DATA.diff.files[0];
        if (broken === undefined) {
            throw new Error('в фикстуре должен быть хотя бы один файл');
        }
        const models = new Map(MODELS);
        models.delete(broken.fileId);
        const model = buildRouteModel({
            snapshot: SNAPSHOT,
            files: DATA.diff.files,
            models,
            failed: new Set([broken.fileId]),
        });

        expect(model.totals.pendingFiles).toBe(0);
        expect(model.totals.failedFiles).toBe(1);
    });

    it('«Прочее» под фильтром считает ровно то, что раскроется', () => {
        const other = build().entries.find((entry) => entry.kind === 'other');
        if (other?.kind !== 'other') {
            throw new Error('в модели должно быть «Прочее»');
        }
        const first = other.view.files[0];
        if (first === undefined) {
            throw new Error('в «Прочем» должны быть файлы');
        }
        const filtered = filterOtherView(other.view, new Set([first.fileId]));

        expect(filtered.files).toEqual([first]);
        expect(filtered.lines).toBe(first.lines);
        expect(filterOtherView(other.view, null)).toBe(other.view);
    });

    it('ленивый рендер режет остановку по ханкам, а не по файлам', () => {
        const group = (hunks: number, fileId: string): RouteFileGroup =>
            ({ fileId, hunks }) as unknown as RouteFileGroup;
        const small = [group(3, 'a'), group(3, 'b'), group(3, 'c')];
        const big = [group(3, 'a'), group(3, 'b'), group(LAZY_HUNK_THRESHOLD, 'c')];

        // Ханков меньше порога — рисуется всё, дробить нечего.
        expect(lazyCards(small)).toEqual(small);
        // Порог пройден: первые карточки набирают пять ханков, остальное ждёт прокрутки.
        expect(lazyCards(big).map((file) => file.fileId)).toEqual(['a', 'b']);
        expect(lazyCards([group(40, 'one'), group(1, 'two')]).map((file) => file.fileId)).toEqual(['one']);
    });

    it('колонка диффа снимается с DOM только у далёкой измеренной остановки', () => {
        const far: StopDiffMountState = {
            nearViewport: false,
            measuredHeight: 640,
            first: false,
            rendersCards: true,
            jumping: false,
            busy: false,
        };
        expect(canUnmountStopDiff(far)).toBe(true);

        // Каждое исключение по отдельности оставляет колонку на месте.
        expect(canUnmountStopDiff({ ...far, nearViewport: true })).toBe(false);
        // Высоты не мерили — плейсхолдеру нечем держать место, документ бы съёжился.
        expect(canUnmountStopDiff({ ...far, measuredHeight: null })).toBe(false);
        expect(canUnmountStopDiff({ ...far, first: true })).toBe(false);
        expect(canUnmountStopDiff({ ...far, rendersCards: false })).toBe(false);
        expect(canUnmountStopDiff({ ...far, jumping: true })).toBe(false);
        expect(canUnmountStopDiff({ ...far, busy: true })).toBe(false);
        // Нулевая высота — это тоже замер: пустая остановка снимается наравне с прочими.
        expect(canUnmountStopDiff({ ...far, measuredHeight: 0 })).toBe(true);
    });

    it('счётчик комментариев берёт треды по позиции внутри якорей стопа', () => {
        const model = build();
        const stop = model.entries.flatMap((entry) =>
            entry.kind === 'stop' && entry.view.stop.id === 's03' ? [entry.view] : [],
        )[0];
        if (stop === undefined) {
            throw new Error('в модели должен быть стоп s03');
        }
        const group = stop.files[0];
        if (group === undefined) {
            throw new Error('у стопа s03 должны быть файлы');
        }
        const anchor = group.anchors[0];
        if (anchor === undefined) {
            throw new Error('у файла стопа должен быть якорь');
        }
        const inside = {
            ...DATA.threads[0],
            id: 'thread-inside',
            anchor: {
                fileId: group.fileId,
                path: group.path,
                position: { side: anchor.side, line: anchor.start, size: 1 },
            },
        } as (typeof DATA.threads)[number];
        const outside = {
            ...inside,
            id: 'thread-outside',
            anchor: {
                fileId: group.fileId,
                path: group.path,
                position: { side: anchor.side, line: 100_000, size: 1 },
            },
        };

        const byFile = new Map([[group.fileId, [inside, outside]]]);

        expect(countStopComments(stop, byFile)).toBe(1);
    });
});

/**
 * Правило пробельных строк на синтетическом диффе: пустые и
 * пробельные изменённые строки вне якорей выпадают из статистики покрытия целиком, покрытые
 * якорем — считаются как раньше.
 *
 * Дифф `WHITESPACE_PATCH`: под якорями старая 2 и новые 2–3 (одна из них пустая), вне якорей —
 * новая 6 (`delta`), пустая новая 5 и удаление одних пробелов на старой 5.
 */
const WHITESPACE_PATCH = [
    '@@ -1,6 +1,8 @@',
    ' alpha',
    '-old-one',
    '+new-one',
    '+',
    ' beta',
    '+  ',
    '+delta',
    ' gamma',
    '-\t',
    ' omega',
    '',
].join('\n');

const WHITESPACE_FILE: FileDiff = {
    fileId: 'ws',
    path: 'src/ws.ts',
    oldPath: null,
    changeType: 'modify',
    binary: false,
    generated: false,
    additions: 4,
    deletions: 2,
    patch: WHITESPACE_PATCH,
    viewed: null,
    blameUrl: null,
    hostFileUrl: null,
    image: null,
};

/** Снапшот из одного стопа с заданными якорями плюс «Прочее». */
function whitespaceSnapshot(anchors: readonly { side: 'old' | 'new'; start: number; end: number }[]): RouteSnapshot {
    return {
        ...SNAPSHOT,
        stops: [
            {
                ...stopOf('s01'),
                anchors: anchors.map((span) => ({
                    fileId: WHITESPACE_FILE.fileId,
                    path: WHITESPACE_FILE.path,
                    ...span,
                    collapsed: false,
                })),
            },
            stopOf('other'),
        ],
    };
}

function whitespaceModel(anchors: readonly { side: 'old' | 'new'; start: number; end: number }[]) {
    return buildRouteModel({
        snapshot: whitespaceSnapshot(anchors),
        files: [WHITESPACE_FILE],
        models: new Map([[WHITESPACE_FILE.fileId, parseFileDiff(toParseRequest(WHITESPACE_FILE))]]),
    });
}

describe('пробельные строки вне якорей', () => {
    it('не попадают в «Прочее», а знаменатель сходится: покрытое плюс непокрытое равно изменённому', () => {
        const model = whitespaceModel([
            { side: 'old', start: 2, end: 2 },
            { side: 'new', start: 2, end: 3 },
        ]);
        const other = model.entries.find((entry) => entry.kind === 'other');

        // Изменённых строк в патче 6; две пробельные вне якорей в счёт не идут.
        expect(model.totals.changed).toBe(4);
        // Пустая новая 3 под якорем считается наравне с текстовой: правило только вне якорей.
        expect(model.totals.covered).toBe(3);
        expect(model.totals.uncovered).toBe(1);
        expect(model.totals.covered + model.totals.uncovered).toBe(model.totals.changed);
        if (other?.kind !== 'other') {
            throw new Error('в модели должно быть «Прочее»');
        }
        // В «Прочем» только `delta`: ни пустой новой 5, ни удаления пробелов на старой 5.
        expect(other.view.files[0]?.anchors).toEqual([{ side: 'new', start: 6, end: 6 }]);
        expect(other.view.lines).toBe(1);
    });

    it('отметка «просмотрено» всё равно накрывает их: прогресс чтения считает строки патча', () => {
        const model = whitespaceModel([
            { side: 'old', start: 2, end: 2 },
            { side: 'new', start: 2, end: 3 },
        ]);
        const seen = model.entries.reduce(
            (total, entry) =>
                total + stopSeenRanges(entry).reduce((sum, range) => sum + (range.end - range.start + 1), 0),
            0,
        );

        expect(seen).toBe(WHITESPACE_FILE.additions + WHITESPACE_FILE.deletions);
    });

    it('когда непокрытыми остались только они, «Прочее» не показывается вовсе', () => {
        const model = whitespaceModel(FULLY_COVERED);

        expect(model.totals.uncovered).toBe(0);
        expect(model.totals.changed).toBe(4);
        expect(model.totals.covered).toBe(4);
        expect(model.entries.every((entry) => entry.kind === 'stop')).toBe(true);
        expect(model.stopCount).toBe(1);
    });

    it('без «Прочего» их дочитывает остановка файла: маршрут закрывает прогресс до конца', () => {
        // «Прочего» в маршруте нет, а прогресс чтения считает все 6 изменённых строк патча:
        // без пробельных диапазонов в seen файл навсегда остался бы `partial`.
        const model = whitespaceModel(FULLY_COVERED);
        const state = whitespaceReadState(model);

        expect(model.entries.every((entry) => entry.kind === 'stop')).toBe(true);
        expect(state.seen).toBe(WHITESPACE_FILE.additions + WHITESPACE_FILE.deletions);
        expect(state.state).toBe('read');
    });

    it('пока часть файла не покрыта, отметка одной остановки оставляет его частично прочитанным', () => {
        const model = whitespaceModel([
            { side: 'old', start: 2, end: 2 },
            { side: 'new', start: 2, end: 3 },
        ]);
        const stop = model.entries.find((entry) => entry.kind === 'stop');
        if (stop === undefined) {
            throw new Error('в модели должна быть остановка');
        }

        // Пробельные строки забирает «Прочее»: остановка отвечает только за свои три.
        expect(readStateOfWhitespace(stopSeenRanges(stop))).toMatchObject({ state: 'partial', seen: 3 });
    });
});

/** Якоря, покрывающие все текстовые изменённые строки файла: непокрытым остаётся только пробельное. */
const FULLY_COVERED = [
    { side: 'old', start: 2, end: 2 },
    { side: 'new', start: 2, end: 3 },
    { side: 'new', start: 6, end: 6 },
] as const;

/** Прогресс файла, когда отмечены все записи маршрута: их seen-диапазоны — весь вход read-state. */
function whitespaceReadState(model: RouteModel): FileReadState {
    return readStateOfWhitespace(model.entries.flatMap((entry) => stopSeenRanges(entry)));
}

function readStateOfWhitespace(ranges: readonly UiStopSeenRange[]): FileReadState {
    const changed = changedLinesOf(parseFileDiff(toParseRequest(WHITESPACE_FILE)));
    if (changed === undefined) {
        throw new Error('синтетический патч обязан разбираться в текст');
    }
    return readStateOf({
        file: WHITESPACE_FILE,
        record: {
            fileId: WHITESPACE_FILE.fileId,
            viewed: false,
            seenRanges: ranges.map(({ side, start, end }) => ({ side, start, end })),
        },
        changed,
    });
}

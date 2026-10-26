import type { Iteration, RouteSnapshot, UiRouteStale, UiRouteState, UiSnapshotSummary } from '@sherpa/protocol';
import { describe, expect, it } from 'vitest';

import {
    fallbackSnapshots,
    parseViewing,
    pickerRows,
    resolveViewing,
    rowAction,
    sliceBetween,
    sliceMarks,
    VIEWING_CURRENT,
    viewingFragmentPatch,
} from './viewing.js';
import type { ViewingInput } from './viewing.js';

/**
 * Разрешение выбора итерации: что уезжает в параметры ручек, где режим чтения,
 * и как выбор деградирует, когда сервер ручку снапшотов ещё не умеет.
 */

const OLD_COMMIT = '9f3c1ab6d4e2705c8a1b3f9d6e4c2a08b7d5f316';
const NEW_COMMIT = 'a71d4e2c9b8f5301d6e4a2c7b09f8e3d5a4c6b21';

function summary(patch: Partial<UiSnapshotSummary> = {}): UiSnapshotSummary {
    return {
        snapshotId: 'route-old',
        diffId: '182800',
        commit: OLD_COMMIT,
        baseCommit: 'base',
        createdAt: '2026-08-31T06:00:00.000Z',
        provenance: { harness: 'claude-code', model: 'sonnet-5', locale: null },
        previousSnapshotId: null,
        status: 'stale',
        ...patch,
    };
}

const CURRENT = summary({ snapshotId: 'route-new', diffId: '182801', commit: NEW_COMMIT, status: 'current' });

function iteration(patch: Partial<Iteration> = {}): Iteration {
    return {
        diffId: '182801',
        baseCommit: 'base',
        headCommit: NEW_COMMIT,
        createdAt: '2026-08-31T09:00:00.000Z',
        status: 'active',
        ...patch,
    };
}

function routeSnapshot(patch: Partial<RouteSnapshot> = {}): RouteSnapshot {
    return {
        snapshotId: 'route-new',
        commit: NEW_COMMIT,
        baseCommit: 'base',
        diffId: '182801',
        createdAt: '2026-08-31T09:30:00.000Z',
        provenance: { harness: 'claude-code', model: 'sonnet-5', locale: null },
        previousSnapshotId: null,
        carried: null,
        summary: 'сводка',
        stops: [],
        tourOrder: [],
        contentHash: 'hash',
        ...patch,
    };
}

const STALE: UiRouteStale = {
    routeCommit: OLD_COMMIT,
    prCommit: NEW_COMMIT,
    prDiffId: '182801',
    newIterations: 1,
    affectedStopIds: [],
};

function route(patch: Partial<UiRouteState> = {}): UiRouteState {
    return { phase: 'ready', smallPr: false, snapshot: routeSnapshot(), failure: null, stale: null, ...patch };
}

function input(patch: Partial<ViewingInput> = {}): ViewingInput {
    return {
        viewing: VIEWING_CURRENT,
        snapshots: [summary(), CURRENT],
        iterations: [],
        route: route(),
        activeDiffId: '182801',
        activeCommit: NEW_COMMIT,
        snapshotsLoaded: true,
        activeLoaded: true,
        ...patch,
    };
}

describe('разрешение выбора итерации', () => {
    it('текущее состояние — ручки без параметров и запись разрешена', () => {
        const resolved = resolveViewing(input());

        expect(resolved).toMatchObject({ diffId: null, snapshotId: null, readOnly: false, gone: false });
        expect(resolved.label).toEqual({ kind: 'snapshot', commit: NEW_COMMIT, status: 'current' });
    });

    it('устаревший маршрут виден в подписи индикатора', () => {
        const resolved = resolveViewing(input({ route: route({ stale: STALE }) }));

        expect(resolved.label?.status).toBe('stale');
    });

    it('выбран текущий снапшот — то же, что текущее, но выбор остаётся', () => {
        const resolved = resolveViewing(input({ viewing: { kind: 'snapshot', snapshotId: 'route-new' } }));

        expect(resolved).toMatchObject({ diffId: null, snapshotId: null, readOnly: false, unknown: false });
        expect(resolved.viewing).toEqual({ kind: 'snapshot', snapshotId: 'route-new' });
    });

    it('прошлый снапшот уезжает в параметры и включает режим чтения', () => {
        const resolved = resolveViewing(input({ viewing: { kind: 'snapshot', snapshotId: 'route-old' } }));

        expect(resolved).toMatchObject({
            diffId: '182800',
            snapshotId: 'route-old',
            readOnly: true,
            gone: false,
            createdAt: '2026-08-31T06:00:00.000Z',
        });
        expect(resolved.label).toEqual({ kind: 'snapshot', commit: OLD_COMMIT, status: 'stale' });
    });

    it('снапшот на активной итерации, но не текущий, режимом чтения не становится', () => {
        const regenerated = summary({ snapshotId: 'route-regen', diffId: '182801', commit: NEW_COMMIT });
        const resolved = resolveViewing(
            input({ snapshots: [regenerated, CURRENT], viewing: { kind: 'snapshot', snapshotId: 'route-regen' } }),
        );

        expect(resolved).toMatchObject({ diffId: '182801', snapshotId: 'route-regen', readOnly: false });
    });

    it('снапшот ушедшей итерации помечен `gone` и читается', () => {
        const gone = summary({ status: 'gone' });
        const resolved = resolveViewing(
            input({ snapshots: [gone, CURRENT], viewing: { kind: 'snapshot', snapshotId: 'route-old' } }),
        );

        expect(resolved).toMatchObject({ readOnly: true, gone: true });
        expect(resolved.label?.status).toBe('gone');
    });

    it('прошлая итерация без маршрута: свой дифф, чтение и вкладка маршрута без маршрута', () => {
        const resolved = resolveViewing(
            input({
                iterations: [iteration({ diffId: '182800', headCommit: OLD_COMMIT, status: 'previous' }), iteration()],
                snapshots: [CURRENT],
                viewing: { kind: 'diff', diffId: '182800' },
            }),
        );

        expect(resolved).toMatchObject({ diffId: '182800', snapshotId: null, readOnly: true, routeless: true });
        expect(resolved.label).toEqual({ kind: 'diff', commit: OLD_COMMIT, status: 'noRoute' });
    });

    it('активная итерация без маршрута читается и пишется теми же ручками без параметров', () => {
        const resolved = resolveViewing(
            input({
                iterations: [iteration()],
                snapshots: [summary()],
                route: route({ snapshot: routeSnapshot({ diffId: '182800', commit: OLD_COMMIT }), stale: STALE }),
                viewing: { kind: 'diff', diffId: '182801' },
            }),
        );

        expect(resolved).toMatchObject({ diffId: null, snapshotId: null, readOnly: false, routeless: true });
        expect(resolved.label).toEqual({ kind: 'diff', commit: NEW_COMMIT, status: 'noRoute' });
    });

    // Сервер может прислать `iterations: []`, и активную итерацию знает только маршрут
    // без параметров: его ответ живёт отдельно от данных вкладки и переживает смену выбора.
    it('активная итерация узнаётся из фактов даже без списка итераций и маршрута вкладки', () => {
        const resolved = resolveViewing(
            input({
                iterations: [],
                snapshots: [CURRENT],
                route: null,
                viewing: { kind: 'diff', diffId: '182801' },
            }),
        );

        expect(resolved).toMatchObject({ diffId: null, readOnly: false, unknown: false, routeless: true });
        expect(resolved.label).toEqual({ kind: 'diff', commit: NEW_COMMIT, status: 'noRoute' });
    });

    it('пока факты об активной итерации не приехали, выбор держится и данные не грузятся', () => {
        const resolved = resolveViewing(
            input({ activeLoaded: false, viewing: { kind: 'snapshot', snapshotId: 'route-old' } }),
        );

        expect(resolved).toMatchObject({ pending: true, unknown: false, diffId: null, snapshotId: null });
        expect(resolved.viewing).toEqual({ kind: 'snapshot', snapshotId: 'route-old' });
    });

    it('снапшот на активной итерации не читается только потому, что маршрут вкладки чужой', () => {
        const regenerated = summary({ snapshotId: 'route-regen', diffId: '182801', commit: NEW_COMMIT });
        const resolved = resolveViewing(
            input({
                iterations: [],
                snapshots: [regenerated, CURRENT],
                route: null,
                viewing: { kind: 'snapshot', snapshotId: 'route-regen' },
            }),
        );

        expect(resolved).toMatchObject({ diffId: '182801', snapshotId: 'route-regen', readOnly: false });
    });

    it('неизвестный снапшот возвращает к текущему и просит почистить адрес', () => {
        const resolved = resolveViewing(input({ viewing: { kind: 'snapshot', snapshotId: 'нет-такого' } }));

        expect(resolved).toMatchObject({ unknown: true, diffId: null, snapshotId: null, readOnly: false });
        expect(resolved.viewing).toEqual(VIEWING_CURRENT);
    });

    it('неизвестная итерация возвращает к текущему', () => {
        const resolved = resolveViewing(input({ viewing: { kind: 'diff', diffId: '999' } }));

        expect(resolved).toMatchObject({ unknown: true, viewing: VIEWING_CURRENT });
    });

    it('пока список снапшотов не приехал, выбор держится и данные не грузятся', () => {
        const resolved = resolveViewing(
            input({ snapshotsLoaded: false, viewing: { kind: 'snapshot', snapshotId: 'route-old' } }),
        );

        expect(resolved).toMatchObject({ pending: true, unknown: false, diffId: null, snapshotId: null });
    });

    it('без известной активной итерации прошлый снапшот всё равно только читается', () => {
        const resolved = resolveViewing(
            input({ activeDiffId: null, viewing: { kind: 'snapshot', snapshotId: 'route-old' } }),
        );

        expect(resolved.readOnly).toBe(true);
    });
});

describe('фрагмент выбора', () => {
    it('snapshot главнее среза, срез главнее diff, пустые значения не считаются', () => {
        expect(parseViewing('s1', 'd1')).toEqual({ kind: 'snapshot', snapshotId: 's1' });
        expect(parseViewing(null, 'd1')).toEqual({ kind: 'diff', diffId: 'd1' });
        expect(parseViewing(null, 'd1', 'b1', 'h1')).toEqual({ kind: 'slice', base: 'b1', head: 'h1' });
        expect(parseViewing('s1', null, 'b1', 'h1')).toEqual({ kind: 'snapshot', snapshotId: 's1' });
        expect(parseViewing(null, null)).toEqual(VIEWING_CURRENT);
    });

    it('срез без одной половины игнорируется целиком', () => {
        expect(parseViewing(null, null, 'b1', null)).toEqual(VIEWING_CURRENT);
        expect(parseViewing(null, null, null, 'h1')).toEqual(VIEWING_CURRENT);
        expect(parseViewing(null, 'd1', 'b1', '')).toEqual({ kind: 'diff', diffId: 'd1' });
    });

    it('текущее в адрес не пишется, а смена выбора снимает якоря другого диффа', () => {
        expect(viewingFragmentPatch(VIEWING_CURRENT, VIEWING_CURRENT)).toEqual({
            snapshot: null,
            diff: null,
            base: null,
            head: null,
        });
        expect(viewingFragmentPatch({ kind: 'snapshot', snapshotId: 's1' }, VIEWING_CURRENT)).toEqual({
            snapshot: 's1',
            diff: null,
            base: null,
            head: null,
            file: null,
            side: null,
            line: null,
            end: null,
            thread: null,
            stop: null,
        });
        expect(viewingFragmentPatch({ kind: 'diff', diffId: 'd1' }, { kind: 'diff', diffId: 'd1' })).toEqual({
            snapshot: null,
            diff: 'd1',
            base: null,
            head: null,
        });
    });

    it('срез уезжает в адрес обеими сторонами и снимает якоря прошлого выбора', () => {
        expect(viewingFragmentPatch({ kind: 'slice', base: 'b1', head: 'h1' }, VIEWING_CURRENT)).toEqual({
            snapshot: null,
            diff: null,
            base: 'b1',
            head: 'h1',
            file: null,
            side: null,
            line: null,
            end: null,
            thread: null,
            stop: null,
        });
        // Тот же срез — якоря на месте: вкладка никуда не переезжала.
        expect(
            viewingFragmentPatch({ kind: 'slice', base: 'b1', head: 'h1' }, { kind: 'slice', base: 'b1', head: 'h1' }),
        ).toEqual({ snapshot: null, diff: null, base: 'b1', head: 'h1' });
    });
});

describe('разрешение среза между итерациями', () => {
    const OLD = iteration({ diffId: '182800', headCommit: OLD_COMMIT, status: 'previous' });
    const ACTIVE = iteration();

    function sliceInput(patch: Partial<ViewingInput> = {}): ViewingInput {
        return input({
            iterations: [OLD, ACTIVE],
            snapshots: [CURRENT],
            viewing: { kind: 'slice', base: '182800', head: '182801' },
            ...patch,
        });
    }

    it('срез читается ручкой base/head: только чтение, без маршрута и без снапшота', () => {
        const resolved = resolveViewing(sliceInput());

        expect(resolved).toMatchObject({
            diffId: '182801',
            snapshotId: null,
            readOnly: true,
            routeless: true,
            unknown: false,
            createdAt: OLD.createdAt,
        });
        expect(resolved.slice).toEqual({ base: '182800', head: '182801' });
        expect(resolved.label).toEqual({
            kind: 'slice',
            commit: NEW_COMMIT,
            baseCommit: OLD_COMMIT,
            status: 'slice',
        });
    });

    it('срез между двумя прошлыми итерациями: голова не обязана быть активной', () => {
        const older = iteration({ diffId: '182799', headCommit: 'c0ffee1', status: 'previous' });
        const resolved = resolveViewing(
            sliceInput({
                iterations: [older, OLD, ACTIVE],
                viewing: { kind: 'slice', base: '182799', head: '182800' },
            }),
        );

        expect(resolved).toMatchObject({ diffId: '182800', readOnly: true, routeless: true, unknown: false });
        expect(resolved.slice).toEqual({ base: '182799', head: '182800' });
        expect(resolved.label).toEqual({ kind: 'slice', commit: OLD_COMMIT, baseCommit: 'c0ffee1', status: 'slice' });
    });

    it('активная итерация вне списка годится в голову: её коммит известен из фактов', () => {
        const resolved = resolveViewing(sliceInput({ iterations: [OLD] }));

        expect(resolved.slice).toEqual({ base: '182800', head: '182801' });
        expect(resolved.label).toMatchObject({ commit: NEW_COMMIT, baseCommit: OLD_COMMIT });
    });

    it('ушедшая итерация краем среза не бывает — ни базой, ни головой', () => {
        const gone = iteration({ diffId: '182799', headCommit: 'c0ffee1', status: 'gone' });
        const asBase = resolveViewing(
            sliceInput({ iterations: [gone, OLD, ACTIVE], viewing: { kind: 'slice', base: '182799', head: '182801' } }),
        );
        const asHead = resolveViewing(
            sliceInput({ iterations: [OLD, gone, ACTIVE], viewing: { kind: 'slice', base: '182800', head: '182799' } }),
        );

        expect(asBase).toMatchObject({ unknown: true, viewing: VIEWING_CURRENT, slice: null, readOnly: false });
        expect(asHead).toMatchObject({ unknown: true, viewing: VIEWING_CURRENT, slice: null, readOnly: false });
    });

    it('база новее головы — выбор невалиден: такой адрес UI не строит, дифф вышел бы обращённым', () => {
        const older = iteration({ diffId: '182799', headCommit: 'c0ffee1', status: 'previous' });
        const fromActive = resolveViewing(
            sliceInput({ iterations: [older, OLD, ACTIVE], viewing: { kind: 'slice', base: '182801', head: '182799' } }),
        );
        const betweenPrevious = resolveViewing(
            sliceInput({ iterations: [older, OLD, ACTIVE], viewing: { kind: 'slice', base: '182800', head: '182799' } }),
        );

        expect(fromActive).toMatchObject({ unknown: true, viewing: VIEWING_CURRENT, slice: null });
        expect(betweenPrevious).toMatchObject({ unknown: true, viewing: VIEWING_CURRENT, slice: null });
    });

    it('голова не из списка и не активная — выбор невалиден', () => {
        const resolved = resolveViewing(sliceInput({ viewing: { kind: 'slice', base: '182800', head: '999' } }));

        expect(resolved).toMatchObject({ unknown: true, slice: null });
    });

    it('база не из списка итераций — выбор невалиден', () => {
        const resolved = resolveViewing(sliceInput({ viewing: { kind: 'slice', base: '999', head: '182801' } }));

        expect(resolved).toMatchObject({ unknown: true, slice: null });
    });

    it('срез итерации с самой собой не строится', () => {
        const resolved = resolveViewing(sliceInput({ viewing: { kind: 'slice', base: '182801', head: '182801' } }));

        expect(resolved).toMatchObject({ unknown: true, slice: null });
    });

    it('пока факты об активной итерации не приехали, срез держится и данные не грузятся', () => {
        const resolved = resolveViewing(sliceInput({ activeLoaded: false }));

        expect(resolved).toMatchObject({ pending: true, unknown: false, diffId: null, slice: null });
        expect(resolved.viewing).toEqual({ kind: 'slice', base: '182800', head: '182801' });
    });
});

describe('строки пикера', () => {
    it('снапшоты идут новыми сверху с провенансом и статусом', () => {
        const rows = pickerRows({ snapshots: [summary(), CURRENT], iterations: [], activeIteration: null });

        expect(rows.iterations.map((row) => row.id)).toEqual(['route-new', 'route-old']);
        expect(rows.iterations[0]).toMatchObject({ status: 'current', model: 'sonnet-5', harness: 'claude-code' });
        expect(rows.iterations[1]?.status).toBe('stale');
    });

    it('текущий снапшот прошлой итерации в меню устарел, как и в индикаторе', () => {
        const current = summary({ status: 'current' });
        const onPrevious = pickerRows({
            snapshots: [current],
            iterations: [],
            activeIteration: { diffId: '182801', commit: NEW_COMMIT },
        });
        const onActive = pickerRows({
            snapshots: [current],
            iterations: [],
            activeIteration: { diffId: current.diffId, commit: current.commit },
        });
        const unknownActive = pickerRows({ snapshots: [current], iterations: [], activeIteration: null });

        // Подпись меняется, а выбор без параметров по-прежнему отмечает эту строку.
        expect(onPrevious.iterations.find((row) => row.kind === 'snapshot')).toMatchObject({
            status: 'stale',
            latest: true,
        });
        expect(onActive.iterations[0]?.status).toBe('current');
        expect(unknownActive.iterations[0]?.status).toBe('current');
    });

    it('активная итерация без маршрута стоит первой строкой, над снапшотами прошлых', () => {
        const rows = pickerRows({
            snapshots: [summary()],
            iterations: [
                iteration({ diffId: '182799', headCommit: 'c0ffee1', status: 'gone', createdAt: '2026-08-31T03:00:00.000Z' }),
                iteration({ diffId: '182800', headCommit: OLD_COMMIT, status: 'previous', createdAt: '2026-08-31T05:00:00.000Z' }),
                iteration(),
            ],
            activeIteration: null,
        });

        // Активная 182801 маршрута не имеет, но ищут её первой; 182800 показан своим снапшотом.
        expect(rows.iterations.map((row) => row.id)).toEqual(['182801', 'route-old', '182799']);
        expect(rows.iterations[0]?.status).toBe('activeIteration');
        expect(rows.iterations[1]?.kind).toBe('snapshot');
        expect(rows.iterations[2]?.status).toBe('gone');
    });

    it('снапшот стоит рядом со своей итерацией, а не отдельным разделом сверху', () => {
        const older = summary({ snapshotId: 'route-older', diffId: '182799', createdAt: '2026-08-31T04:00:00.000Z' });
        const rows = pickerRows({
            snapshots: [older, summary()],
            iterations: [
                iteration({ diffId: '182799', headCommit: 'c0ffee1', status: 'previous', createdAt: '2026-08-31T03:00:00.000Z' }),
                iteration({ diffId: '182800', headCommit: OLD_COMMIT, status: 'previous', createdAt: '2026-08-31T05:00:00.000Z' }),
                iteration({ createdAt: '2026-08-31T09:00:00.000Z' }),
            ],
            activeIteration: null,
        });

        expect(rows.iterations.map((row) => row.id)).toEqual(['182801', 'route-old', 'route-older']);
    });

    it('одинаковые семь символов коммита удлиняются до различимых', () => {
        const head = '6630996aa1b2c3d4e5f60718293a4b5c6d7e8f90';
        const rows = pickerRows({
            snapshots: [],
            iterations: [
                iteration({ diffId: '1', headCommit: `${head}+11111111`, status: 'previous', createdAt: '2026-08-31T03:00:00.000Z' }),
                iteration({ diffId: '2', headCommit: `${head}+22222222`, status: 'previous', createdAt: '2026-08-31T05:00:00.000Z' }),
                iteration({ diffId: '3', headCommit: head, createdAt: '2026-08-31T09:00:00.000Z' }),
            ],
            activeIteration: null,
        });

        expect(rows.iterations.map((row) => row.short)).toEqual(['6630996…8f90', '6630996…2222', '6630996…1111']);
    });

    it('коммит у двух итераций один — строки помечены на точное время', () => {
        const rows = pickerRows({
            snapshots: [],
            iterations: [
                iteration({ diffId: '1', status: 'previous', createdAt: '2026-08-31T03:00:00.000Z' }),
                iteration({ diffId: '2', status: 'previous', createdAt: '2026-08-31T05:00:00.000Z' }),
                iteration({ diffId: '3', headCommit: OLD_COMMIT, createdAt: '2026-08-31T09:00:00.000Z' }),
            ],
            activeIteration: null,
        });

        // Коммит и короткий id у первых двух совпадают целиком: различает их только время.
        expect(rows.iterations.map((row) => [row.id, row.ambiguous])).toEqual([
            ['3', false],
            ['2', true],
            ['1', true],
        ]);
    });

    it('пустой список итераций даёт строку активной из фактов App', () => {
        const rows = pickerRows({
            snapshots: [summary()],
            iterations: [],
            activeIteration: { diffId: STALE.prDiffId, commit: STALE.prCommit },
        });

        expect(rows.iterations.map((row) => row.id)).toEqual(['182801', 'route-old']);
        expect(rows.iterations[0]).toMatchObject({ id: '182801', commit: NEW_COMMIT, status: 'activeIteration' });
    });

    it('в меню одна хронология, края среза — итерации без ушедшей, от старых к новым', () => {
        const rows = pickerRows({
            snapshots: [CURRENT],
            iterations: [
                iteration({ diffId: '182799', headCommit: 'c0ffee1', status: 'gone' }),
                iteration({ diffId: '182800', headCommit: OLD_COMMIT, status: 'previous' }),
                iteration(),
            ],
            activeIteration: { diffId: '182801', commit: NEW_COMMIT },
            interdiff: true,
        });

        expect(rows.iterations.map((row) => `${row.kind}:${row.id}`)).toEqual([
            'snapshot:route-new',
            'diff:182800',
            'diff:182799',
        ]);
        expect([...rows.sliceOrder]).toEqual([
            ['182800', 1],
            ['182801', 2],
        ]);
    });

    it('без срезов у хоста краёв среза нет', () => {
        const rows = pickerRows({
            snapshots: [CURRENT],
            iterations: [iteration({ diffId: '182800', headCommit: OLD_COMMIT, status: 'previous' }), iteration()],
            activeIteration: { diffId: '182801', commit: NEW_COMMIT },
        });

        expect(rows.sliceOrder.size).toBe(0);
    });

    it('активная итерация вне списка — самая новая', () => {
        const rows = pickerRows({
            snapshots: [CURRENT],
            iterations: [iteration({ diffId: '182800', headCommit: OLD_COMMIT, status: 'previous' })],
            activeIteration: { diffId: '182801', commit: NEW_COMMIT },
            interdiff: true,
        });

        expect([...rows.sliceOrder]).toEqual([
            ['182800', 0],
            ['182801', 1],
        ]);
    });

    it('без ручки снапшотов список считается из текущего снапшота маршрута', () => {
        const list = fallbackSnapshots(routeSnapshot());

        expect(list).toHaveLength(1);
        expect(list[0]).toMatchObject({ snapshotId: 'route-new', diffId: '182801', status: 'current' });
        expect(fallbackSnapshots(null)).toEqual([]);
    });
});

describe('срез в два шага по строкам пикера', () => {
    const OLDER = iteration({ diffId: '182799', headCommit: 'c0ffee1', status: 'previous' });
    const OLD = iteration({ diffId: '182800', headCommit: OLD_COMMIT, status: 'previous' });
    const ACTIVE = iteration();
    const ROWS = pickerRows({
        snapshots: [CURRENT],
        iterations: [OLDER, OLD, ACTIVE],
        activeIteration: { diffId: '182801', commit: NEW_COMMIT },
        interdiff: true,
    });

    function row(diffId: string, rows = ROWS) {
        const found = rows.iterations.find((candidate) => candidate.diffId === diffId);
        if (found === undefined) {
            throw new Error(`нет строки ${diffId}`);
        }
        return found;
    }

    it('обычный клик без первого края — выбор строки', () => {
        expect(rowAction(ROWS, null, row('182800'), false)).toEqual({
            kind: 'select',
            viewing: { kind: 'diff', diffId: '182800' },
        });
    });

    it('Shift+клик ставит первый край, ничего не выбирая — и по активной итерации тоже', () => {
        expect(rowAction(ROWS, null, row('182800'), true)).toEqual({ kind: 'edge', edge: '182800' });
        expect(rowAction(ROWS, null, row('182801'), true)).toEqual({ kind: 'edge', edge: '182801' });
    });

    it('второй клик — с Shift и без — строит срез: старшая итерация база, новее — голова', () => {
        const slice = { kind: 'select', viewing: { kind: 'slice', base: '182799', head: '182801' } };

        expect(rowAction(ROWS, '182799', row('182801'), false)).toEqual(slice);
        expect(rowAction(ROWS, '182799', row('182801'), true)).toEqual(slice);
        expect(rowAction(ROWS, '182801', row('182799'), false)).toEqual(slice);
    });

    it('клик по итерации первого края снимает его', () => {
        expect(rowAction(ROWS, '182801', row('182801'), false)).toEqual({ kind: 'edge', edge: null });
        expect(rowAction(ROWS, '182801', row('182801'), true)).toEqual({ kind: 'edge', edge: null });
    });

    it('снапшот итерации первого края — та же итерация: край снимается', () => {
        const rows = pickerRows({
            snapshots: [summary({ snapshotId: 'route-old-1' }), summary({ snapshotId: 'route-old-2', status: 'current' })],
            iterations: [OLDER, OLD, ACTIVE],
            activeIteration: { diffId: '182801', commit: NEW_COMMIT },
            interdiff: true,
        });
        const second = rows.iterations.find((candidate) => candidate.id === 'route-old-1');
        expect(second).toBeDefined();
        if (second !== undefined) {
            expect(rowAction(rows, '182800', second, false)).toEqual({ kind: 'edge', edge: null });
        }
    });

    it('ушедшая итерация и хост без срезов: Shift+клик — обычный выбор', () => {
        const withGone = pickerRows({
            snapshots: [],
            iterations: [{ ...OLDER, status: 'gone' }, OLD, ACTIVE],
            activeIteration: null,
            interdiff: true,
        });
        expect(rowAction(withGone, null, row('182799', withGone), true)).toEqual({
            kind: 'select',
            viewing: { kind: 'diff', diffId: '182799' },
        });

        const noInterdiff = pickerRows({ snapshots: [], iterations: [OLD, ACTIVE], activeIteration: null });
        expect(rowAction(noInterdiff, null, row('182800', noInterdiff), true)).toEqual({
            kind: 'select',
            viewing: { kind: 'diff', diffId: '182800' },
        });
    });

    it('сравнить не с чем — одна годная итерация: Shift+клик — обычный выбор', () => {
        const alone = pickerRows({
            snapshots: [],
            iterations: [{ ...OLDER, status: 'gone' }, ACTIVE],
            activeIteration: null,
            interdiff: true,
        });
        expect(rowAction(alone, null, row('182801', alone), true)).toEqual({
            kind: 'select',
            viewing: { kind: 'diff', diffId: '182801' },
        });
    });

    it('с первым краем клик по строке, которая краем быть не может, — обычный выбор', () => {
        const withGone = pickerRows({
            snapshots: [],
            iterations: [{ ...OLDER, status: 'gone' }, OLD, ACTIVE],
            activeIteration: null,
            interdiff: true,
        });
        expect(rowAction(withGone, '182800', row('182799', withGone), false)).toEqual({
            kind: 'select',
            viewing: { kind: 'diff', diffId: '182799' },
        });
    });

    it('первый край, которого больше нет среди годных, не действует', () => {
        expect(rowAction(ROWS, 'нет-такой', row('182800'), false)).toEqual({
            kind: 'select',
            viewing: { kind: 'diff', diffId: '182800' },
        });
    });

    it('активная итерация вне списка без своей строки годится в голову среза', () => {
        const rows = pickerRows({
            snapshots: [],
            iterations: [OLDER, OLD],
            activeIteration: { diffId: '182801', commit: NEW_COMMIT },
            interdiff: true,
        });

        expect(sliceBetween(rows, '182801', '182800')).toEqual({ kind: 'slice', base: '182800', head: '182801' });
        expect(sliceBetween(rows, '182800', '182800')).toBeNull();
        expect(sliceBetween(rows, '182800', 'нет-такой')).toBeNull();
    });

    function marked(marks: ReturnType<typeof sliceMarks>) {
        return [...marks].map(([markedRow, mark]) => [markedRow.id, mark.part, mark.role]);
    }

    it('первый край без курсора на другой итерации — отмечен только он', () => {
        expect(marked(sliceMarks(ROWS, VIEWING_CURRENT, '182799', null))).toEqual([['182799', 'edge', null]]);
        expect(marked(sliceMarks(ROWS, VIEWING_CURRENT, '182799', row('182799')))).toEqual([['182799', 'edge', null]]);
    });

    it('курсор на другой годной итерации — превью диапазона, край без подписей', () => {
        expect(marked(sliceMarks(ROWS, VIEWING_CURRENT, '182799', row('182801')))).toEqual([
            ['route-new', 'edge', null],
            ['182800', 'inside', null],
            ['182799', 'edge', null],
        ]);
    });

    it('курсор на строке, которая краем быть не может, — превью нет', () => {
        const withGone = pickerRows({
            snapshots: [],
            iterations: [OLDER, { ...OLD, status: 'gone' }, ACTIVE],
            activeIteration: null,
            interdiff: true,
        });
        expect(marked(sliceMarks(withGone, VIEWING_CURRENT, '182801', row('182800', withGone)))).toEqual([
            ['182801', 'edge', null],
        ]);
    });

    it('в срезе отмечены края с подписями базы и головы и снапшоты итераций внутри', () => {
        const rows = pickerRows({
            snapshots: [summary({ snapshotId: 'route-old-1' }), summary({ snapshotId: 'route-old-2' }), CURRENT],
            iterations: [OLDER, OLD, ACTIVE],
            activeIteration: { diffId: '182801', commit: NEW_COMMIT },
            interdiff: true,
        });
        const slice = { kind: 'slice', base: '182799', head: '182801' } as const;

        expect(marked(sliceMarks(rows, slice, null, null))).toEqual([
            ['route-new', 'edge', 'head'],
            ['route-old-2', 'inside', null],
            ['route-old-1', 'inside', null],
            ['182799', 'edge', 'base'],
        ]);
    });

    it('подпись края — только на первой строке группы итерации', () => {
        const rows = pickerRows({
            snapshots: [summary({ snapshotId: 'route-old-1' }), summary({ snapshotId: 'route-old-2' })],
            iterations: [OLD, ACTIVE],
            activeIteration: { diffId: '182801', commit: NEW_COMMIT },
            interdiff: true,
        });

        expect(marked(sliceMarks(rows, { kind: 'slice', base: '182800', head: '182801' }, null, null))).toEqual([
            ['182801', 'edge', 'head'],
            ['route-old-2', 'edge', 'base'],
            ['route-old-1', 'edge', null],
        ]);
    });

    it('превью заменяет отметку активного среза', () => {
        const slice = { kind: 'slice', base: '182800', head: '182801' } as const;

        expect(marked(sliceMarks(ROWS, slice, '182799', row('182800')))).toEqual([
            ['182800', 'edge', null],
            ['182799', 'edge', null],
        ]);
    });

    it('вне среза и без первого края отметок нет', () => {
        expect(sliceMarks(ROWS, { kind: 'diff', diffId: '182800' }, null, row('182799')).size).toBe(0);
    });
});

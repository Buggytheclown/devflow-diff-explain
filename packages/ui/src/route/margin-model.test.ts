import { fixtureIteration, routeFixtures } from '@sherpa/fixtures';
import type { FileDiff, RouteSnapshot } from '@sherpa/protocol';
import { describe, expect, it } from 'vitest';

import type { DiffFileModel } from '../diff/model.js';
import { toParseRequest } from '../diff/model.js';
import { parseFileDiff } from '../diff/parse.js';
import type { RouteMarginFile } from './margin-model.js';
import {
    buildRouteMargin,
    marginBadgeLabel,
    marginBadgeShown,
    marginBadgeTitle,
    marginFooterNote,
    marginStripSummary,
    marginStripText,
    marginTargetStopId,
    treeBadgeLabel,
} from './margin-model.js';
import { createT } from '../i18n/index.js';

const t = createT('ru');

/**
 * Маршрут на полях считает те же числа, что и вью маршрута: 38 непокрытых строк в четырёх файлах
 * фикстуры `medium` (CODEOWNERS 5, ci.yml 12, countdown-icon.svg 6, хвост psp-schema.ts 15 — две пустые строки хвоста
 * правило пробельных выводит из счёта). Разъедется счёт — увидит
 * этот тест, а не глаз на скриншоте.
 */

const DATA = fixtureIteration('medium');
const SNAPSHOT: RouteSnapshot = (() => {
    const snapshot = routeFixtures('medium')?.states.ready?.snapshot ?? null;
    if (snapshot === null) {
        throw new Error('фикстуре medium нужен готовый снапшот маршрута');
    }
    return snapshot;
})();

const MODELS = new Map<string, DiffFileModel>(
    DATA.diff.files.map((file) => [file.fileId, parseFileDiff(toParseRequest(file))]),
);

function build(snapshot: RouteSnapshot = SNAPSHOT, models = MODELS) {
    return buildRouteMargin({ snapshot, files: DATA.diff.files, models });
}

function fileOf(path: string): RouteMarginFile {
    const file = DATA.diff.files.find((candidate) => candidate.path === path);
    if (file === undefined) {
        throw new Error(`в фикстуре нет файла ${path}`);
    }
    const margin = build().files.get(file.fileId);
    if (margin === undefined) {
        throw new Error(`в модели полей нет файла ${path}`);
    }
    return margin;
}

describe('маршрут на полях полного диффа', () => {
    it('непокрытое сходится с маршрутом: 38 строк в четырёх файлах', () => {
        const model = build();

        expect(model.uncoveredLines).toBe(38);
        expect(model.uncoveredFiles).toBe(4);
        expect(model.pendingFiles).toBe(0);
        expect(model.failedFiles).toBe(0);

        const uncovered = DATA.diff.files
            .map((file) => ({ name: file.path, lines: model.files.get(file.fileId)?.uncoveredLines ?? 0 }))
            .filter((entry) => entry.lines > 0)
            .map((entry) => [entry.name.slice(entry.name.lastIndexOf('/') + 1), entry.lines]);

        expect(uncovered).toEqual([
            ['psp-schema.ts', 15],
            ['CODEOWNERS', 5],
            ['ci.yml', 12],
            ['countdown-icon.svg', 6],
        ]);
    });

    it('карта файл→остановки строится по якорям и держит план-порядок', () => {
        const model = build();
        const placed = [...model.files.values()].filter((file) => file.stops.length > 0);

        expect(placed.length).toBeGreaterThan(0);
        for (const file of placed) {
            const numbers = file.stops.map((stop) => stop.planLabel);
            expect(numbers).toEqual([...numbers].sort((left, right) => left.localeCompare(right)));
            // Один и тот же стоп не удваивается, сколько бы якорей он ни поставил на файл.
            expect(new Set(numbers).size).toBe(numbers.length);
        }
    });

    it('«Прочее» в карту не входит: его строки и есть «не размещено»', () => {
        const model = build();
        const other = SNAPSHOT.stops.find((stop) => stop.tier === 'other');

        expect(other?.id).toBe(model.otherStopId);
        expect(model.otherStopId).not.toBeNull();
        for (const file of model.files.values()) {
            expect(file.stops.some((stop) => stop.stopId === model.otherStopId)).toBe(false);
        }
    });

    it('файл без якорей объяснён «Прочим», а бейдж ведёт туда же', () => {
        const model = build();
        const yaml = fileOf('.github/CODEOWNERS');

        expect(yaml.stops).toEqual([]);
        expect(yaml.changed).toBe(true);
        expect(marginBadgeShown(yaml)).toBe(true);
        // Метка «не размещён» текста не несёт: за неё в дереве говорят штриховка и тултип.
        expect(treeBadgeLabel(yaml)).toBe('');
        expect(marginBadgeLabel(yaml, t)).toBe('без остановки маршрута');
        expect(marginTargetStopId(yaml, model.otherStopId)).toBe(model.otherStopId);
        expect(marginBadgeTitle(yaml, true, t)).toBe('Без остановки маршрута — перейти к «Прочему»');
    });

    it('частично покрытый файл несёт бейдж своей остановки и непокрытые диапазоны', () => {
        const schema = fileOf('services/orders/src/payments/generated/psp-schema.ts');

        expect(schema.stops.length).toBeGreaterThan(0);
        expect(schema.uncoveredLines).toBe(15);
        expect(marginBadgeLabel(schema, t)).toContain(`объяснено в ${schema.stops[0]?.planLabel ?? ''} · `);
    });

    it('файл в нескольких остановках: метка дерева и бейдж карточки, в тултипе все номера', () => {
        const many: RouteMarginFile = {
            fileId: 'f1',
            stops: [
                { stopId: 's02', planLabel: '02', title: 'кэш сбрасывается после записи' },
                { stopId: 's05', planLabel: '05', title: 'логи' },
            ],
            uncovered: [],
            uncoveredLines: 0,
            parsed: true,
            changed: true,
        };

        // В метку 17×13 помещается один номер — «+1» остаётся бейджу карточки и тултипу.
        expect(treeBadgeLabel(many)).toBe('02');
        expect(marginBadgeLabel(many, t)).toBe('объяснено в 02 +1 · кэш сбрасывается после записи');
        expect(marginBadgeTitle(many, true, t)).toBe(
            'Объяснено в остановках 02, 05 · кэш сбрасывается после записи — перейти',
        );
        expect(marginTargetStopId(many, 'other')).toBe('s02');
    });

    it('бэктики заголовка в бейдж и тултип не уезжают: это строки, а не markdown', () => {
        const backticked: RouteMarginFile = {
            fileId: 'f3',
            stops: [{ stopId: 's02', planLabel: '02', title: 'политика решает по `EditWindow`' }],
            uncovered: [],
            uncoveredLines: 0,
            parsed: true,
            changed: true,
        };

        expect(marginBadgeLabel(backticked, t)).toBe('объяснено в 02 · политика решает по EditWindow');
        expect(marginBadgeTitle(backticked, false, t)).toBe('Объяснено в остановке 02 · политика решает по EditWindow');
    });

    it('файл без изменённых строк бейджа не получает', () => {
        const empty: RouteMarginFile = {
            fileId: 'f2',
            stops: [],
            uncovered: [],
            uncoveredLines: 0,
            parsed: true,
            changed: false,
        };

        expect(marginBadgeShown(empty)).toBe(false);
    });

    it('футер-нота считает строки и файлы, а до разбора честно говорит «считаю»', () => {
        expect(marginFooterNote(build(), t)).toBe(
            'Штриховка — у диапазона нет остановки маршрута. 38 строк в 4 файлах.',
        );

        const pending = build(SNAPSHOT, new Map());
        expect(pending.pendingFiles).toBe(DATA.diff.files.length);
        expect(marginFooterNote(pending, t)).toBe('Штриховка — у диапазона нет остановки маршрута. Считаю строки…');
    });

    it('нота молчит при нуле непокрытых и говорит о неразобранных файлах', () => {
        const covered = buildRouteMargin({ snapshot: SNAPSHOT, files: [], models: new Map() });
        expect(marginFooterNote(covered, t)).toBeNull();

        const failedId = DATA.diff.files[0]?.fileId ?? '';
        const failed = buildRouteMargin({
            snapshot: SNAPSHOT,
            files: DATA.diff.files,
            models: MODELS,
            failed: new Set([failedId]),
        });
        expect(failed.failedFiles).toBe(0);

        const unparsed = new Map(MODELS);
        unparsed.delete(failedId);
        const broken = buildRouteMargin({
            snapshot: SNAPSHOT,
            files: DATA.diff.files,
            models: unparsed,
            failed: new Set([failedId]),
        });
        expect(broken.pendingFiles).toBe(0);
        expect(broken.failedFiles).toBe(1);
        expect(marginFooterNote(broken, t)).toContain('1 файл не разобрался — его строки в счёт не вошли.');
    });

    it('подписи штриховки различают стороны и одиночную строку', () => {
        expect(marginStripText({ side: 'new', start: 18, end: 26 }, t)).toBe('строки 18–26 без остановки маршрута');
        expect(marginStripText({ side: 'new', start: 18, end: 18 }, t)).toBe('строка 18 без остановки маршрута');
        expect(marginStripText({ side: 'old', start: 4, end: 9 }, t)).toBe(
            'удалённые строки 4–9 без остановки маршрута',
        );
        // Номер строки печатается как в гаттере: без разрядных разделителей.
        expect(marginStripText({ side: 'new', start: 1234, end: 1240 }, t)).toBe(
            'строки 1234–1240 без остановки маршрута',
        );
        expect(
            marginStripSummary([
                { side: 'new', start: 18, end: 26 },
                { side: 'old', start: 4, end: 4 },
            ], t),
        ).toBe('10 строк без остановки маршрута');
    });

    it('штриховка не встаёт на пустые и пробельные строки вне остановок', () => {
        // Тот же синтетический дифф, что в `route-model.test`: под якорями старая 2 и новые 2–3,
        // вне якорей — `delta` на новой 6, пустая новая 5 и удаление пробелов на старой 5.
        const file: FileDiff = {
            fileId: 'ws',
            path: 'src/ws.ts',
            oldPath: null,
            changeType: 'modify',
            binary: false,
            generated: false,
            additions: 4,
            deletions: 2,
            patch: ['@@ -1,6 +1,8 @@', ' alpha', '-old-one', '+new-one', '+', ' beta', '+  ', '+delta', ' gamma', '-\t', ' omega', ''].join('\n'),
            viewed: null,
            blameUrl: null,
            hostFileUrl: null,
            image: null,
        };
        const first = SNAPSHOT.stops.find((stop) => stop.id === 's01');
        if (first === undefined) {
            throw new Error('в фикстурном снапшоте нет стопа s01');
        }
        const snapshot: RouteSnapshot = {
            ...SNAPSHOT,
            stops: [
                {
                    ...first,
                    anchors: [
                        { fileId: file.fileId, path: file.path, side: 'old', start: 2, end: 2, collapsed: false },
                        { fileId: file.fileId, path: file.path, side: 'new', start: 2, end: 3, collapsed: false },
                    ],
                },
            ],
        };
        const margin = buildRouteMargin({
            snapshot,
            files: [file],
            models: new Map([[file.fileId, parseFileDiff(toParseRequest(file))]]),
        });

        expect(margin.files.get(file.fileId)?.uncovered).toEqual([{ side: 'new', start: 6, end: 6 }]);
        expect(margin.uncoveredLines).toBe(1);
        expect(marginFooterNote(margin, t)).toBe('Штриховка — у диапазона нет остановки маршрута. 1 строка в 1 файле.');
    });

    it('файл из одних пробельных изменений бейджа «вне маршрута» не получает', () => {
        // Пустая добавленная строка и удаление одних пробелов: размещать в маршруте нечего,
        // а штрихованный бейдж повёл бы в «Прочее», где такого файла нет.
        const file: FileDiff = {
            fileId: 'blank',
            path: 'src/blank.ts',
            oldPath: null,
            changeType: 'modify',
            binary: false,
            generated: false,
            additions: 1,
            deletions: 1,
            patch: ['@@ -1,3 +1,3 @@', ' alpha', '+', '-\t', ' omega', ''].join('\n'),
            viewed: null,
            blameUrl: null,
            hostFileUrl: null,
            image: null,
        };
        const margin = buildRouteMargin({
            snapshot: { ...SNAPSHOT, stops: SNAPSHOT.stops.filter((stop) => stop.tier === 'other') },
            files: [file],
            models: new Map([[file.fileId, parseFileDiff(toParseRequest(file))]]),
        });
        const view = margin.files.get(file.fileId);
        if (view === undefined) {
            throw new Error('в модели полей нет синтетического файла');
        }

        expect(view.uncoveredLines).toBe(0);
        expect(view.changed).toBe(false);
        expect(marginBadgeShown(view)).toBe(false);
        expect(margin.uncoveredFiles).toBe(0);
        expect(marginFooterNote(margin, t)).toBeNull();
    });
});

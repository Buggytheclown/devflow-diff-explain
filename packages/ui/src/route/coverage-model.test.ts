import { fixtureIteration, routeFixtures } from '@sherpa/fixtures';
import type { RouteSnapshot } from '@sherpa/protocol';
import { describe, expect, it } from 'vitest';

import type { DiffFileModel } from '../diff/model.js';
import { toParseRequest } from '../diff/model.js';
import { parseFileDiff } from '../diff/parse.js';
import type { ChangedLines } from '../progress/read-state.js';
import { changedLinesOf, readStateOf, readStateTooltip } from '../progress/read-state.js';
import { buildCoverageStrip } from './coverage-model.js';
import type { RouteEntry, RouteTotals } from './route-model.js';
import { buildRouteModel, stopSeenRanges } from './route-model.js';
import { createT } from '../i18n/index.js';

const t = createT('ru');

/**
 * Полоса покрытия и seen-диапазоны остановок (docs/design/SPEC-elements.md §2.4 и §2.10) на фикстуре `medium`:
 * 866 изменённых строк в статистике покрытия (в патчах 868: две пустые строки вне якорей
 * из счёта выпали), тиры 196 / 327 / 305, непокрыто 38
 * (шесть из них — добавленная svg картинки: маршрут картинок не видит).
 * Разъедется счёт — упадёт этот тест.
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

function model() {
    return buildRouteModel({ snapshot: SNAPSHOT, files: DATA.diff.files, models: MODELS });
}

function strip() {
    const built = model();
    return buildCoverageStrip({ totals: built.totals, entries: built.entries, t});
}

/** Итоги под руками: тесты про мин-ширину и нулевой тир не должны зависеть от фикстуры. */
function totals(patch: Partial<RouteTotals>): RouteTotals {
    return {
        changed: 100,
        covered: 100,
        uncovered: 0,
        byTier: { high: 100, medium: 0, low: 0, other: 0 },
        pendingFiles: 0,
        failedFiles: 0,
        conflictFiles: 0,
        ...patch,
    };
}

describe('модель полосы покрытия', () => {
    it('сегменты пропорциональны изменённым строкам фикстуры', () => {
        const built = strip();

        expect(built.changed).toBe(866);
        expect(built.uncovered).toBe(38);
        expect(built.explained).toBe(828);
        expect(built.segments.map((segment) => [segment.tier, segment.lines])).toEqual([
            ['high', 196],
            ['medium', 327],
            ['low', 305],
            ['other', 38],
        ]);
        // Доли считаются от изменённых строк, а не от суммы сегментов.
        expect(built.segments.map((segment) => segment.share)).toEqual([196 / 866, 327 / 866, 305 / 866, 38 / 866]);
    });

    it('тултип сегмента несёт диапазон план-номеров своих остановок', () => {
        const built = strip();

        expect(built.segments[0]?.title).toBe('high · остановки 01–02 · 196 строк');
        expect(built.segments[1]?.title).toBe('medium · остановки 03–04 · 327 строк');
        expect(built.segments[3]?.title).toBe('не объяснено · 38 строк');
    });

    it('клик ведёт к первой остановке тира, штриховка — к «Прочему»', () => {
        const built = strip();

        expect(built.segments[0]?.targetStopId).toBe('s01');
        expect(built.segments[0]?.stopIds).toEqual(['s01', 's02']);
        expect(built.segments[3]?.targetStopId).toBe('other');
        expect(built.otherStopId).toBe('other');
    });

    it('легенда вычислена, процент округлён вниз', () => {
        const built = strip();

        // 828 / 866 = 95.61…% — это «95%», а не «96%».
        expect(built.percent).toBe(95);
        expect(built.legend.changed).toBe('866 изменённых строк');
        expect(built.legend.explained).toBe('95% объяснено');
        expect(built.legend.unexplained).toBe('38 строк не объяснено');
    });

    it('процент округляется вниз и на границе', () => {
        const built = buildCoverageStrip({
            totals: totals({ changed: 1000, uncovered: 44, byTier: { high: 956, medium: 0, low: 0, other: 44 } }),
            entries: [], t,});

        // 95.6% — «95%», никогда не «96%» (docs/design/SPEC-elements.md §2.4).
        expect(built.percent).toBe(95);
    });

    it('100% объяснено: штриховки нет, третья клауза опущена', () => {
        const built = buildCoverageStrip({ totals: totals({}), entries: [], t});

        expect(built.segments.map((segment) => segment.tier)).toEqual(['high']);
        expect(built.percent).toBe(100);
        expect(built.legend.unexplained).toBeNull();
    });

    it('тир на ноль строк не рендерится вовсе', () => {
        const built = buildCoverageStrip({
            totals: totals({
                changed: 60,
                uncovered: 6,
                byTier: { high: 54, medium: 0, low: 0, other: 6 },
            }),
            entries: [], t,});

        expect(built.segments.map((segment) => segment.tier)).toEqual(['high', 'other']);
        // Шестистрочный кусок остаётся в полосе: его ширина упрётся в минимум, а не исчезнет.
        expect(built.segments[1]?.lines).toBe(6);
    });

    it('строки конфликтного файла в полосу не попадают (docs/design/SPEC-elements.md §4.1)', () => {
        const first = DATA.diff.files[0];
        if (first === undefined) {
            throw new Error('фикстуре нужен хотя бы один файл');
        }
        const withConflict = buildRouteModel({
            snapshot: SNAPSHOT,
            files: DATA.diff.files.map((file) =>
                file.fileId === first.fileId ? { ...file, changeType: 'conflict' as const } : file,
            ),
            models: MODELS,
        });
        const built = buildCoverageStrip({ totals: withConflict.totals, entries: withConflict.entries, t });

        expect(built.changed).toBe(withConflict.totals.changed);
        expect(built.changed).toBeLessThan(strip().changed);
        // Знаменатель и сумма сегментов сходятся: конфликт не остался ни в одном тире.
        expect(built.segments.reduce((total, segment) => total + segment.lines, 0)).toBe(built.changed);
    });
});

describe('seen-диапазоны остановки', () => {
    it('обычная остановка отдаёт покрытые изменённые строки своих файлов', () => {
        const stop = model().entries.find(
            (entry): entry is Extract<RouteEntry, { kind: 'stop' }> =>
                entry.kind === 'stop' && entry.view.stop.id === 's01',
        );
        if (stop === undefined) {
            throw new Error('в модели нет остановки s01');
        }
        const ranges = stopSeenRanges(stop);

        expect(ranges.length).toBeGreaterThan(0);
        expect(lines(ranges)).toBe(stop.view.changedLines);
        // Файлы диапазонов — ровно файлы остановки.
        expect(new Set(ranges.map((range) => range.fileId))).toEqual(
            new Set(stop.view.files.map((group) => group.fileId)),
        );
    });

    it('сумма диапазонов всех остановок и «Прочего» — все изменённые строки диффа', () => {
        const built = model();
        const total = built.entries.reduce((sum, entry) => sum + lines(stopSeenRanges(entry)), 0);

        expect(total).toBe(868);
    });

    it('«Прочее» отдаёт непокрытые диапазоны — те самые 40 строк в четырёх файлах', () => {
        const built = model();
        const other = built.entries.find((entry) => entry.kind === 'other');
        if (other === undefined) {
            throw new Error('в модели нет «Прочего»');
        }
        const ranges = stopSeenRanges(other);

        expect(lines(ranges)).toBe(40);
        expect(new Set(ranges.map((range) => range.fileId)).size).toBe(4);
    });
});

describe('read-state от отметки остановки', () => {
    it('файл, покрытый остановкой целиком, — read; частично — partial, и числа тултипа сходятся', () => {
        const built = model();
        const seen: string[] = [];

        for (const entry of built.entries) {
            if (entry.kind !== 'stop') {
                continue;
            }
            const ranges = stopSeenRanges(entry);
            for (const group of entry.view.files) {
                const state = readStateOf({
                    file: group.file,
                    record: {
                        fileId: group.fileId,
                        viewed: false,
                        seenRanges: ranges
                            .filter((range) => range.fileId === group.fileId)
                            .map(({ side, start, end }) => ({ side, start, end })),
                    },
                    changed: changedOf(group.fileId),
                });

                expect(state.state).toBe(group.whole ? 'read' : 'partial');
                // Тултип обязан нести ровно то число, которое залило коробку (docs/design/SPEC-elements.md §2.12).
                expect(state.seen).toBe(group.additions + group.deletions);
                expect(readStateTooltip(createT('ru'), state)).toBe(
                    `${String(state.seen)} из ${String(state.total)} изменённых строк просмотрено`,
                );
                seen.push(`${entry.view.stop.id}:${group.fileId}`);
            }
        }

        // Проверка не должна незаметно выродиться в пустой цикл.
        expect(seen.length).toBeGreaterThan(5);
    });

    it('снятие отметки остановки не отменяет generated-дефолт у файла с диапазонами «Прочего»', () => {
        const built = model();
        const other = built.entries.find((entry) => entry.kind === 'other');
        const partialGroup = built.entries
            .flatMap((entry) => (entry.kind === 'stop' ? entry.view.files : []))
            .find((group) => !group.whole && other !== undefined && stopSeenRanges(other).some((range) => range.fileId === group.fileId));
        if (other === undefined || partialGroup === undefined) {
            throw new Error('в фикстуре нет файла, поделённого между остановкой и «Прочим»');
        }

        // Остановка и «Прочее» были просмотрены. После снятия остановки остаются только диапазоны
        // «Прочего», а строки file_progress нет: сервер возвращает viewed: null.
        const rest = stopSeenRanges(other)
            .filter((range) => range.fileId === partialGroup.fileId)
            .map(({ side, start, end }) => ({ side, start, end }));
        const state = readStateOf({
            file: partialGroup.file,
            record: { fileId: partialGroup.fileId, viewed: null, seenRanges: rest },
            changed: changedOf(partialGroup.fileId),
        });

        expect(partialGroup.file.path).toBe('services/orders/src/payments/generated/psp-schema.ts');
        expect(rest.length).toBeGreaterThan(0);
        expect(state).toMatchObject({
            state: 'read',
            seen: partialGroup.file.additions + partialGroup.file.deletions,
            pinned: true,
            generatedDefault: true,
        });
        expect(readStateTooltip(createT('ru'), state)).toContain('сгенерированный файл — по умолчанию прочитан');
    });
});

/** Изменённые строки разобранной модели — вход read-state; в фикстуре они есть у всех файлов. */
function changedOf(fileId: string): ChangedLines {
    const changed = changedLinesOf(MODELS.get(fileId) ?? null);
    if (changed === undefined) {
        throw new Error(`у файла ${fileId} нет разобранной модели`);
    }
    return changed;
}

function lines(ranges: readonly { start: number; end: number }[]): number {
    return ranges.reduce((total, range) => total + (range.end - range.start + 1), 0);
}

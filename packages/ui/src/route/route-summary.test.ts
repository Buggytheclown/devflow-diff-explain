import { routeFixtures } from '@sherpa/fixtures';
import type { RouteSnapshot } from '@sherpa/protocol';
import { describe, expect, it } from 'vitest';

import { UNKNOWN_OTHER } from './other-stop.js';
import { routeFactsForSnapshot } from './route-summary.js';

const READY = routeFixtures('medium')?.states.ready?.snapshot ?? null;
if (READY === null) {
    throw new Error('фикстуре medium нужен готовый снапшот маршрута');
}
const SNAPSHOT: RouteSnapshot = READY;

describe('числа маршрута для панели действий', () => {
    it('использует точный отчёт только для того же снапшота', () => {
        const report = {
            snapshotId: SNAPSHOT.snapshotId,
            value: { stopIds: ['s01', 'other'], otherStopId: 'other', uncoveredLines: 32 },
        };

        expect(routeFactsForSnapshot(SNAPSHOT, report, UNKNOWN_OTHER)).toEqual(report.value);
    });

    it('без отчёта «Прочего» нет, пока непокрытое не посчитано или равно нулю', () => {
        for (const other of [UNKNOWN_OTHER, { uncovered: 0, conflictFiles: 0 }]) {
            const facts = routeFactsForSnapshot(SNAPSHOT, null, other);

            expect(facts.stopIds).toEqual(
                SNAPSHOT.stops.filter((stop) => stop.tier !== 'other').map((stop) => stop.id),
            );
            expect(facts.otherStopId).toBeNull();
        }
    });

    it('без отчёта непустое «Прочее» входит в набор остановок', () => {
        const facts = routeFactsForSnapshot(SNAPSHOT, null, { uncovered: 38, conflictFiles: 0 });

        expect(facts.stopIds).toEqual(SNAPSHOT.stops.map((stop) => stop.id));
        expect(facts.otherStopId).toBe('other');
    });

    it('конфликтные файлы держат «Прочее» и без отчёта: сказать о них больше негде', () => {
        const facts = routeFactsForSnapshot(SNAPSHOT, null, { uncovered: null, conflictFiles: 2 });

        expect(facts.stopIds).toContain('other');
        expect(facts.otherStopId).toBe('other');
    });

    it('при смене снапшота сразу отбрасывает прежние стопы и непокрытые строки', () => {
        const next: RouteSnapshot = {
            ...SNAPSHOT,
            snapshotId: 'new-snapshot',
            stops: SNAPSHOT.stops.filter((stop) => stop.id !== 's01'),
        };
        const oldReport = {
            snapshotId: SNAPSHOT.snapshotId,
            value: { stopIds: ['s01', 'other'], otherStopId: 'other', uncoveredLines: 32 },
        };

        const facts = routeFactsForSnapshot(next, oldReport, { uncovered: 0, conflictFiles: 0 });

        expect(facts.stopIds).not.toContain('s01');
        expect(facts.stopIds).not.toContain('other');
        expect(facts.otherStopId).toBeNull();
        expect(facts.uncoveredLines).toBeNull();
    });
});

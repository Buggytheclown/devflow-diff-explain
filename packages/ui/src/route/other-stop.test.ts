import { routeFixtures } from '@sherpa/fixtures';
import type { RouteSnapshot, RouteStopStatus } from '@sherpa/protocol';
import { describe, expect, it } from 'vitest';

import { otherStopVisible, snapshotFilling, UNKNOWN_OTHER, visibleStops } from './other-stop.js';

const READY = routeFixtures('medium')?.states.ready?.snapshot ?? null;
if (READY === null) {
    throw new Error('фикстуре medium нужен готовый снапшот маршрута');
}
const SNAPSHOT: RouteSnapshot = READY;

/** Готовый снапшот, у первой остановки которого другой статус. */
function withFirstStatus(status: RouteStopStatus): RouteSnapshot {
    return {
        ...SNAPSHOT,
        stops: SNAPSHOT.stops.map((stop, index) => (index === 0 ? { ...stop, status } : stop)),
    };
}

describe('видимость «Прочего»', () => {
    it('пока маршрут строится, «Прочего» нет, даже если непокрытое есть', () => {
        expect(snapshotFilling(withFirstStatus('filling'))).toBe(true);
        expect(otherStopVisible(withFirstStatus('filling'), { uncovered: 120, conflictFiles: 0 })).toBe(false);
        expect(otherStopVisible(withFirstStatus('queued'), { uncovered: 120, conflictFiles: 1 })).toBe(false);
    });

    it('на достроенном маршруте без непокрытых строк «Прочего» нет', () => {
        expect(otherStopVisible(SNAPSHOT, { uncovered: 0, conflictFiles: 0 })).toBe(false);
    });

    it('непокрытое ещё не посчитано — «Прочего» нет', () => {
        expect(otherStopVisible(SNAPSHOT, UNKNOWN_OTHER)).toBe(false);
    });

    it('на достроенном маршруте с непокрытыми строками «Прочее» видно', () => {
        expect(otherStopVisible(SNAPSHOT, { uncovered: 1, conflictFiles: 0 })).toBe(true);
    });

    it('провалившаяся секция считается достроенной: её строки честно уходят в «Прочее»', () => {
        const failed = withFirstStatus('failed');
        expect(snapshotFilling(failed)).toBe(false);
        expect(otherStopVisible(failed, { uncovered: 40, conflictFiles: 0 })).toBe(true);
    });

    it('конфликтные файлы держат «Прочее» и при нуле непокрытых', () => {
        expect(otherStopVisible(SNAPSHOT, { uncovered: 0, conflictFiles: 1 })).toBe(true);
    });

    it('скрытое «Прочее» выпадает из списка остановок, номера остальных не двигаются', () => {
        const hidden = visibleStops(SNAPSHOT, { uncovered: 0, conflictFiles: 0 });
        const shown = visibleStops(SNAPSHOT, { uncovered: 5, conflictFiles: 0 });

        expect(hidden.map((stop) => stop.tier)).not.toContain('other');
        expect(shown).toEqual(SNAPSHOT.stops);
        expect(hidden.map((stop) => stop.planIndex)).toEqual(shown.slice(0, -1).map((stop) => stop.planIndex));
        // «Прочее» — последний номер плана: без него дыр в нумерации нет.
        expect(shown.at(-1)?.tier).toBe('other');
        expect(shown.at(-1)?.planIndex).toBe(Math.max(...SNAPSHOT.stops.map((stop) => stop.planIndex)));
    });
});

import type { RouteRawResultsEn, RouteRawResults } from '@sherpa/fixtures';
import { fixtureData, fixtureIteration, routeFixtures } from '@sherpa/fixtures';
import type { PrDiff, RouteSnapshot, Thread } from '@sherpa/protocol';

/**
 * Доступ к маршрутным фикстурам для тестов сервера: `routeFixtures` отдаёт `null` там, где
 * маршрута нет, и каждому тесту незачем разбираться с этим самому.
 */

export function mediumDiff(): PrDiff {
    return fixtureIteration('medium').diff;
}

export function mediumRawResults(): RouteRawResults {
    const raw = routeFixtures('medium')?.rawResults;
    if (raw === null || raw === undefined) {
        throw new Error('у фикстуры medium нет сырых выводов модели');
    }
    return raw;
}

/** Английский набор выводов той же фикстуры. */
export function mediumRawResultsEn(): RouteRawResultsEn {
    const raw = routeFixtures('medium')?.rawResultsEn;
    if (raw === null || raw === undefined) {
        throw new Error('у фикстуры medium нет английских сырых выводов модели');
    }
    return raw;
}

/** Дифф второй итерации фикстуры: тот же PR после пуша. */
export function mediumDiffV2(): PrDiff {
    return fixtureIteration('medium', 1).diff;
}

/** Треды PR глазами второй итерации: якоря перепривязаны, у одного появился ответ автора. */
export function mediumThreadsV2(): Thread[] {
    return fixtureIteration('medium', 1).threads;
}

/** Срез первой итерации во вторую — объявлен фикстурой данными, а не вычислен. */
export function mediumInterdiffV1V2(): PrDiff {
    const data = fixtureData('medium');
    const from = data.iterations[0]?.iteration.diffId;
    const to = data.iterations[1]?.iteration.diffId;
    const slice = data.interdiffs.find((candidate) => candidate.base === from && candidate.head === to);
    if (slice === undefined) {
        throw new Error('у фикстуры medium нет среза первой итерации во вторую');
    }
    return slice.diff;
}

/** Сырые выводы модели второго захода: те же стопы плюс «почему изменилась остановка». */
export function mediumRawResultsV2(): RouteRawResults {
    const raw = routeFixtures('medium')?.rawResultsV2;
    if (raw === null || raw === undefined) {
        throw new Error('у фикстуры medium нет сырых выводов модели второго захода');
    }
    return raw;
}

export function mediumReadySnapshot(): RouteSnapshot {
    const snapshot = routeFixtures('medium')?.states.ready?.snapshot;
    if (snapshot === null || snapshot === undefined) {
        throw new Error('у фикстуры medium нет готового снапшота маршрута');
    }
    return snapshot;
}

/** Сырой текст результата: модель сдаёт файл, а не объект. */
export function asRawText(result: unknown): string {
    return JSON.stringify(result, null, 2);
}

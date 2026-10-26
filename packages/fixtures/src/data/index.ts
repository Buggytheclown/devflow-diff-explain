import type { PrDiff } from '@sherpa/protocol';
import {
    iterationSchema,
    lensSchema,
    prDiffSchema,
    prMetaSchema,
    reviewUserSchema,
    threadSchema,
} from '@sherpa/protocol';

import { makeEdgeFixture } from './edge.js';
import { makeEmptyFixture } from './empty.js';
import { makeHugeFixture } from './huge.js';
import { makeLargeFixture } from './large.js';
import { makeMediumFixture } from './medium.js';
import { makeSmallFixture } from './small.js';
import type {
    FixtureData,
    FixtureDataInput,
    FixtureInterdiff,
    FixtureIteration,
    FixtureIterationView,
} from './types.js';

export type {
    FixtureData,
    FixtureDataInput,
    FixtureInterdiff,
    FixtureIteration,
    FixtureIterationView,
} from './types.js';
export {
    MEDIUM_DIFF_ID,
    MEDIUM_DIFF_ID_V2,
    MEDIUM_DIFF_ID_V3,
    MEDIUM_HEAD_COMMIT,
    MEDIUM_HEAD_COMMIT_V2,
    MEDIUM_HEAD_COMMIT_V3,
    MEDIUM_TOTALS,
} from './medium.js';
export { LARGE_FILE_COUNT, LONG_LINE_FILE_PATH, LONG_LINE_MARKER } from './large.js';
export {
    HUGE_CHANGED_LINE_COUNT,
    HUGE_COLLAPSED_FILE_LINES,
    HUGE_COLLAPSED_FILE_PATH,
    HUGE_DIFF_ID,
    HUGE_FILE_COUNT,
    HUGE_PARSED_FILE_COUNT,
    HUGE_PARSED_LINE_COUNT,
} from './huge.js';
export { buildChatFixtures, chatFixtures } from './chat.js';
export type { ChatFixtures } from './chat.js';
export { buildRouteFixtures, routeFixtures } from './route.js';
export type { RouteBrokenResults, RouteFixtures, RouteRawResults, RouteRawResultsEn } from './route.js';

export type FixtureName = 'medium' | 'small' | 'large' | 'edge' | 'huge' | 'empty';

export const FIXTURE_NAMES: readonly FixtureName[] = ['medium', 'small', 'large', 'edge', 'huge', 'empty'];

const BUILDERS: Record<FixtureName, () => FixtureDataInput> = {
    medium: makeMediumFixture,
    small: makeSmallFixture,
    large: makeLargeFixture,
    edge: makeEdgeFixture,
    huge: makeHugeFixture,
    empty: makeEmptyFixture,
};

/** Схема итерации без статуса: статус — вычисляемое хостом поле, в данных его нет. */
const iterationMetaSchema = iterationSchema.omit({ status: true });

function validateIteration(iteration: FixtureIteration): FixtureIteration {
    return {
        iteration: iterationMetaSchema.parse(iteration.iteration),
        diff: prDiffSchema.parse(iteration.diff),
        threads: iteration.threads.map((thread) => threadSchema.parse(thread)),
        replaces: iteration.replaces,
    };
}

function validateInterdiff(interdiff: FixtureInterdiff): FixtureInterdiff {
    return {
        base: interdiff.base,
        head: interdiff.head,
        diff: prDiffSchema.parse(interdiff.diff),
    };
}

/**
 * Фикстура проходит через те же схемы, что и ответ настоящего хоста: ошибку в данных надо ловить
 * при сборке фикстуры, а не в тесте UI через три задачи. Срезы между итерациями — тоже `PrDiff`,
 * поэтому валидируются той же схемой.
 */
function validate(data: FixtureDataInput): FixtureData {
    if (data.iterations.length === 0) {
        throw new Error('фикстура без итераций: хосту нечего отдавать');
    }
    return {
        // «Я» фикстуры одно: смотрит PR тот же, кто пишет в нём черновики.
        pr: prMetaSchema.parse({ ...data.pr, viewer: data.currentUser }),
        iterations: data.iterations.map(validateIteration),
        interdiffs: data.interdiffs.map(validateInterdiff),
        ownership: data.ownership === null ? null : lensSchema.parse(data.ownership),
        extraLenses: data.extraLenses.map((lens) => lensSchema.parse(lens)),
        currentUser: reviewUserSchema.parse(data.currentUser),
        mutationEpoch: data.mutationEpoch,
    };
}

/** Собранные фикстуры неизменны, поэтому строятся один раз на процесс. */
const built = new Map<FixtureName, FixtureData>();

/**
 * Сборка фикстуры с нуля, мимо кэша. Нужна тесту детерминизма: детерминизм между процессами
 * (стабильные скриншоты галереи, e2e) держится на чистоте билдеров, а сравнение двух обращений
 * к кэшу это по построению не проверяет.
 */
export function buildFixture(name: FixtureName): FixtureData {
    return validate(BUILDERS[name]());
}

/**
 * Свежая копия данных фикстуры. Копия — потому что хост их мутирует в памяти, а следующий
 * хост с тем же именем обязан получить те же исходные данные байт-в-байт.
 */
export function fixtureData(name: FixtureName): FixtureData {
    let data = built.get(name);
    if (data === undefined) {
        data = buildFixture(name);
        built.set(name, data);
    }
    return structuredClone(data);
}

/**
 * Срез между двумя итерациями фикстуры (интердифф) — тот же `PrDiff`, что отдаёт хост на
 * `getDiff({base, head})`. Индексы — позиции итераций в списке фикстуры.
 */
export function fixtureInterdiff(name: FixtureName, baseIndex: number, headIndex: number): PrDiff {
    const data = fixtureData(name);
    const base = data.iterations[baseIndex];
    const head = data.iterations[headIndex];
    if (base === undefined || head === undefined) {
        throw new Error(`у фикстуры ${name} нет итераций №${String(baseIndex)} и №${String(headIndex)}`);
    }
    const found = data.interdiffs.find(
        (interdiff) => interdiff.base === base.iteration.diffId && interdiff.head === head.iteration.diffId,
    );
    if (found === undefined) {
        throw new Error(`у фикстуры ${name} нет среза ${base.iteration.diffId}→${head.iteration.diffId}`);
    }
    return found.diff;
}

/**
 * Фикстура на одной итерации плоско: PR, её дифф и треды рядом с линзами. Ею живут потребители,
 * которым итерации не нужны, — UI-тесты, галерея, e2e; по умолчанию это первая итерация,
 * то есть состояние PR до всякого пуша.
 */
export function fixtureIteration(name: FixtureName, index = 0): FixtureIterationView {
    const data = fixtureData(name);
    const iteration = data.iterations[index];
    if (iteration === undefined) {
        throw new Error(`у фикстуры ${name} нет итерации №${String(index)}`);
    }
    return {
        pr: data.pr,
        iteration: iteration.iteration,
        diff: iteration.diff,
        threads: iteration.threads,
        ownership: data.ownership,
        extraLenses: data.extraLenses,
        currentUser: data.currentUser,
        mutationEpoch: data.mutationEpoch,
    };
}

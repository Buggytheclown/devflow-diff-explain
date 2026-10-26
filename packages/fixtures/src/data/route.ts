import type { RouteSectionResult, RouteSkeletonResult, UiRoutePhase, UiRouteState } from '@sherpa/protocol';
import { routeSectionResultSchema, routeSkeletonResultSchema, uiRouteStateSchema } from '@sherpa/protocol';

import type { FixtureName } from './index.js';
import {
    makeMediumBrokenResults,
    makeMediumSectionResults,
    makeMediumSkeletonResult,
    makeMediumRouteStates,
} from './route-medium.js';
import { makeMediumSectionResultsEn, makeMediumSkeletonResultEn } from './route-medium-en.js';
import { makeHugeRawResults } from './route-huge.js';
import {
    makeMediumBrokenResultsV2,
    makeMediumSecondPassState,
    makeMediumSectionResultsV2,
    makeMediumSkeletonResultV2,
} from './route-medium-v2.js';

/**
 * Маршрутные данные фикстур: состояния генерации для галереи и сырые выводы модели
 * для fake-воркера e2e и голден-корпуса валидатора.
 *
 * Раздаются по образцу `fixtureData`: валидация схемами протокола при сборке, кэш на процесс,
 * наружу — `structuredClone`-копия (потребитель их мутирует).
 */

/** Битые выводы: схемам протокола удовлетворяют, ломается семантика — материал негативных тестов. */
export interface RouteBrokenResults {
    /** Якорь в файл, которого нет в диффе. */
    sectionUnknownFile: RouteSectionResult;
    /** Диапазон за пределами изменённых строк файла. */
    sectionRangeOutsideChanges: RouteSectionResult;
    /** `tourOrder` — не перестановка плановых номеров: один стоп назван дважды, другой пропущен. */
    skeletonTourOrderNotPermutation: RouteSkeletonResult;
}

export interface RouteRawResults {
    skeleton: RouteSkeletonResult;
    /** По одной секции на каждый стоп плана модели, в план-порядке («Прочего» в плане нет). */
    sections: RouteSectionResult[];
    broken: RouteBrokenResults;
}

/**
 * Выводы модели на английском: те же якоря, другой язык. Битого набора здесь нет —
 * негативный корпус ломает семантику, а она от языка не зависит.
 */
export interface RouteRawResultsEn {
    skeleton: RouteSkeletonResult;
    /** Часть плана, а не весь: голден на en проверяет язык текстов, а не покрытие диффа. */
    sections: RouteSectionResult[];
}

export interface RouteFixtures {
    /** Состояние на фазу; ключ совпадает с `phase` значения. */
    states: Partial<Record<UiRoutePhase, UiRouteState>>;
    /** null — у фикстуры нет заготовленных выводов модели (галерее они не нужны). */
    rawResults: RouteRawResults | null;
    /** Выводы модели для второй итерации: те же стопы плюс «why this stop changed». */
    rawResultsV2: RouteRawResults | null;
    /** Английский набор выводов; null — у фикстуры его нет. */
    rawResultsEn: RouteRawResultsEn | null;
    /** Готовый маршрут второго захода (`docs/design/README.md §9`); null — второй итерации у фикстуры нет. */
    secondPass: UiRouteState | null;
}

/**
 * Провал валидации у `edge`: якоря уехали вместе с переименованием файла — состояние
 * Generation failed (`docs/design/README.md §12`) на реальном сдвиге якорей, а не на выдуманной ошибке.
 */
function edgeFailedState(): UiRouteState {
    return {
        phase: 'failed',
        smallPr: false,
        snapshot: null,
        stale: null,
        failure: {
            message:
                'Генерация остановлена на валидации: стоп 02 ссылается на services/orders/src/infra/clock.ts, которого нет в этой итерации — файл переименован в infra/time/clock.ts.',
            rawOutput: `{
  "stops": [
    {
      "planIndex": 2,
      "paragraph": "Часы переехали в отдельный пакет времени, источник времени инжектируется…",
      "anchors": [
        { "path": "services/orders/src/infra/clock.ts", "side": "new", "start": 1, "end": 24 },
        { "path": "services/orders/src/infra/time/index.ts", "side": "new", "start": 1, "end": 3 }
      ]
    }
  ]
}`,
        },
    };
}

const BUILDERS: Partial<Record<FixtureName, () => RouteFixtures>> = {
    medium: () => ({
        states: makeMediumRouteStates(),
        rawResults: {
            skeleton: makeMediumSkeletonResult(),
            sections: makeMediumSectionResults(),
            broken: makeMediumBrokenResults(),
        },
        rawResultsV2: {
            skeleton: makeMediumSkeletonResultV2(),
            sections: makeMediumSectionResultsV2(),
            broken: makeMediumBrokenResultsV2(),
        },
        rawResultsEn: {
            skeleton: makeMediumSkeletonResultEn(),
            sections: makeMediumSectionResultsEn(),
        },
        secondPass: makeMediumSecondPassState(),
    }),
    // PR ниже порога маршрута: генерация не ставится вовсе.
    small: () => ({
        states: { none: { phase: 'none', smallPr: true, snapshot: null, failure: null, stale: null } },
        rawResults: null,
        rawResultsV2: null,
        rawResultsEn: null,
        secondPass: null,
    }),
    edge: () => ({
        states: { failed: edgeFailedState() },
        rawResults: null,
        rawResultsV2: null,
        rawResultsEn: null,
        secondPass: null,
    }),
    // Маршрута нет: `large` живёт в UI-тестах виртуализации, генерацию на нём никто не запускал.
    large: () => ({
        states: { none: { phase: 'none', smallPr: false, snapshot: null, failure: null, stale: null } },
        rawResults: null,
        rawResultsV2: null,
        rawResultsEn: null,
        secondPass: null,
    }),
    // Перф-фикстура: готовых состояний нет, маршрут на 25 стопов e2e строит через fake-воркер.
    huge: () => ({
        states: { none: { phase: 'none', smallPr: false, snapshot: null, failure: null, stale: null } },
        rawResults: makeHugeRawResults(),
        rawResultsV2: null,
        rawResultsEn: null,
        secondPass: null,
    }),
};

/**
 * Те же схемы, что и на входе UI: ошибку в маршрутных данных надо ловить при сборке фикстуры,
 * а не в галерее через три задачи. Битые выводы через схемы не гоняются — они битые нарочно.
 */
function validate(fixtures: RouteFixtures): RouteFixtures {
    const states: Partial<Record<UiRoutePhase, UiRouteState>> = {};
    for (const [phase, state] of Object.entries(fixtures.states) as [UiRoutePhase, UiRouteState][]) {
        const parsed = uiRouteStateSchema.parse(state);
        if (parsed.phase !== phase) {
            throw new Error(`состояние маршрута лежит под ключом ${phase}, а несёт фазу ${parsed.phase}`);
        }
        states[phase] = parsed;
    }

    return {
        states,
        rawResults: validateRaw(fixtures.rawResults),
        rawResultsV2: validateRaw(fixtures.rawResultsV2),
        rawResultsEn: validateRawEn(fixtures.rawResultsEn),
        secondPass: fixtures.secondPass === null ? null : uiRouteStateSchema.parse(fixtures.secondPass),
    };
}

function validateRawEn(raw: RouteRawResultsEn | null): RouteRawResultsEn | null {
    return raw === null
        ? null
        : {
              skeleton: routeSkeletonResultSchema.parse(raw.skeleton),
              sections: raw.sections.map((section) => routeSectionResultSchema.parse(section)),
          };
}

/** Битые выводы через `parse` не гоняются — они битые нарочно. */
function validateRaw(raw: RouteRawResults | null): RouteRawResults | null {
    return raw === null
        ? null
        : {
              skeleton: routeSkeletonResultSchema.parse(raw.skeleton),
              sections: raw.sections.map((section) => routeSectionResultSchema.parse(section)),
              broken: raw.broken,
          };
}

const built = new Map<FixtureName, RouteFixtures | null>();

/** Сборка с нуля, мимо кэша: тест детерминизма сравнивает именно две сборки. */
export function buildRouteFixtures(name: FixtureName): RouteFixtures | null {
    const builder = BUILDERS[name];
    return builder === undefined ? null : validate(builder());
}

/** Свежая копия маршрутных данных; null — у фикстуры их нет. */
export function routeFixtures(name: FixtureName): RouteFixtures | null {
    let fixtures = built.get(name);
    if (fixtures === undefined) {
        fixtures = buildRouteFixtures(name);
        built.set(name, fixtures);
    }
    return fixtures === null ? null : structuredClone(fixtures);
}

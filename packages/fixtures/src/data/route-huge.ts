import type { RouteSectionResult, RouteSkeletonResult, RouteTier } from '@sherpa/protocol';

import { HUGE_COLLAPSED_FILE_PATH, hugeFiles } from './huge.js';
import type { RouteBrokenResults, RouteRawResults } from './route.js';

/**
 * Маршрут перф-фикстуры `huge`: 25 стопов на 100 файлов. Нужен, чтобы померить вкладку
 * «Маршрут» на длинном списке остановок — содержательного разбора PR здесь нет,
 * тексты собираются по шаблону из состава стопа.
 *
 * Якоря строятся из тех же диапазонов, которыми сгенерированы ханки, поэтому лежат ровно
 * на изменённых строках. Машинные файлы в якоря не попадают — их строки остаются «Прочему».
 */

export const HUGE_STOP_COUNT = 25;
/** Файлов на стоп: 25 стопов ровно покрывают 100 файлов фикстуры. */
const FILES_PER_STOP = 4;

const SUBJECTS = [
    'адаптеры хранилища',
    'репозитории заказов',
    'мапперы DTO',
    'ручки платформы',
    'тесты модулей',
] as const;

const TIER_ORDER = ['high', 'medium', 'low'] as const;

/** Тир по позиции в плане: первые стопы — про ядро переезда, хвост — про машинный обвес. */
function tierAt(stopIndex: number): Exclude<RouteTier, 'other'> {
    if (stopIndex < 5) {
        return 'high';
    }
    return stopIndex < 15 ? 'medium' : 'low';
}

interface HugeStopSpec {
    planIndex: number;
    tier: Exclude<RouteTier, 'other'>;
    title: string;
    intent: string;
    paragraph: string;
    bridge: string | null;
    anchors: RouteSectionResult['stops'][number]['anchors'];
}

function modulesLabel(paths: readonly string[]): string {
    const modules = [...new Set(paths.map((path) => /\/(mod-\d+)\//.exec(path)?.[1] ?? path))];
    const first = modules[0] ?? 'mod-01';
    const last = modules.at(-1) ?? first;
    return first === last ? `Модуль ${first}` : `Модули ${first}–${last}`;
}

function stopSpecs(): HugeStopSpec[] {
    const files = hugeFiles();
    const specs: HugeStopSpec[] = [];

    for (let stopIndex = 0; stopIndex < HUGE_STOP_COUNT; stopIndex += 1) {
        const group = files
            .slice(stopIndex * FILES_PER_STOP, (stopIndex + 1) * FILES_PER_STOP)
            // Машинные файлы модель не разбирает: их строки остаются в «Прочем».
            .filter((entry) => !entry.file.generated);
        const subject = SUBJECTS[stopIndex % SUBJECTS.length] ?? SUBJECTS[0];
        const nextSubject = SUBJECTS[(stopIndex + 1) % SUBJECTS.length] ?? SUBJECTS[0];
        const label = modulesLabel(group.map((entry) => entry.file.path));

        specs.push({
            planIndex: stopIndex + 1,
            tier: tierAt(stopIndex),
            title: `${label}: ${subject}`,
            intent: `Что переехало в платформенный слой: ${subject}, ${String(group.length)} файлов.`,
            paragraph:
                `${label}: ${subject} вынесены в платформенный слой — интерфейс один на все модули, ` +
                `реализация осталась в модуле. Из этого следует, что вызывающий больше не выбирает ` +
                `реализацию по имени модуля, а получает её от платформы.`,
            bridge: stopIndex === HUGE_STOP_COUNT - 1 ? null : `Дальше — ${nextSubject}.`,
            anchors: group.flatMap((entry) =>
                entry.ranges.map((range) => ({
                    path: entry.file.path,
                    side: range.side,
                    start: range.start,
                    end: range.end,
                })),
            ),
        });
    }

    return specs;
}

const SUMMARY = [
    'PR вытаскивает платформенный слой из дерева модулей: адаптеры хранилища, репозитории, ' +
        'мапперы и ручки переезжают в `src/platform`, а модули оставляют у себя только реализацию.',
    'Правка механическая и однообразная: сто файлов, двадцать модулей, у каждого одна и та же ' +
        'пятёрка файлов. Машинные файлы генератора в маршрут не размечены — читать их построчно нечего.',
].join('\n\n');

function skeletonOf(specs: readonly HugeStopSpec[]): RouteSkeletonResult {
    return {
        summary: SUMMARY,
        stops: specs.map((spec) => ({ title: spec.title, tier: spec.tier, intent: spec.intent })),
        // Тур: тиры по важности, внутри тира — от хвоста к началу, чтобы порядок отличался от плана.
        tourOrder: TIER_ORDER.flatMap((tier) =>
            specs
                .filter((spec) => spec.tier === tier)
                .map((spec) => spec.planIndex)
                .reverse(),
        ),
    };
}

function sectionsOf(specs: readonly HugeStopSpec[]): RouteSectionResult[] {
    return specs.map((spec) => ({
        stops: [
            {
                planIndex: spec.planIndex,
                paragraph: spec.paragraph,
                ...(spec.bridge === null ? {} : { bridge: spec.bridge }),
                anchors: spec.anchors,
            },
        ],
    }));
}

/** Битые выводы для негативных тестов: схемам удовлетворяют, ломается семантика. */
function brokenOf(skeleton: RouteSkeletonResult): RouteBrokenResults {
    return {
        sectionUnknownFile: {
            stops: [
                {
                    planIndex: 1,
                    paragraph: 'Платформенный слой получил собственный реестр адаптеров.',
                    anchors: [
                        { path: 'services/orders/src/platform/mod-99/registry.ts', side: 'new', start: 1, end: 40 },
                    ],
                },
            ],
        },
        sectionRangeOutsideChanges: {
            stops: [
                {
                    planIndex: 2,
                    paragraph: 'Хвост нового сервиса описывает миграцию со старого адаптера.',
                    // В файле 2412 добавленных строк, дальше них изменённых нет.
                    anchors: [{ path: HUGE_COLLAPSED_FILE_PATH, side: 'new', start: 3000, end: 3010 }],
                },
            ],
        },
        skeletonTourOrderNotPermutation: {
            ...skeleton,
            // Стоп 02 назван дважды, стоп 01 пропущен.
            tourOrder: Array.from({ length: HUGE_STOP_COUNT }, (_, index) => (index === 0 ? 2 : index + 1)),
        },
    };
}

/** Сырые выводы модели целиком; состав стопов считается один раз — генерация ста файлов недешёвая. */
export function makeHugeRawResults(): RouteRawResults {
    const specs = stopSpecs();
    const skeleton = skeletonOf(specs);
    return { skeleton, sections: sectionsOf(specs), broken: brokenOf(skeleton) };
}

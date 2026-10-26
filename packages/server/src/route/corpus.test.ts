import type { RouteAnchor, RouteStop } from '@sherpa/protocol';
import { describe, expect, it } from 'vitest';

import { asRawText, mediumDiff, mediumRawResults, mediumRawResultsEn } from './fixture-support.js';
import { validateSection } from './section.js';
import { validateSkeleton } from './skeleton.js';
import type { RouteValidation } from './types.js';

/**
 * Негативный корпус валидатора. Пополняется каждым инцидентом «модель вернула странное»:
 * новый кейс — одна запись в `CASES` с сырым текстом и ожидаемыми ошибками.
 *
 * Ошибки читает модель, поэтому проверяются дословно; исключение — тексты, которые принадлежат
 * zod или `JSON.parse` (их формулировки меняются с версией рантайма), для них заведён `patterns`.
 */

const WINDOW = 'services/orders/src/domain/edit-window.ts';
const CLOCK = 'services/orders/src/infra/clock.ts';
const README = 'services/orders/README.md';

function plan(): RouteStop[] {
    const skeleton = validateSkeleton(asRawText(mediumRawResults().skeleton));
    if (!skeleton.ok) {
        throw new Error(`скелет фикстуры не принят: ${skeleton.errors.join(' | ')}`);
    }
    return skeleton.value.stops;
}

/** Тот же план на английской генерации: номера те же, тексты другие. */
function planEn(): RouteStop[] {
    const skeleton = validateSkeleton(asRawText(mediumRawResultsEn().skeleton), 'en');
    if (!skeleton.ok) {
        throw new Error(`английский скелет фикстуры не принят: ${skeleton.errors.join(' | ')}`);
    }
    return skeleton.value.stops;
}

/** План, в котором стоп уже заполнен: материал для правил дедупликации. */
function planWith(planIndex: number, anchors: readonly Omit<RouteAnchor, 'fileId' | 'collapsed'>[]): RouteStop[] {
    const files = mediumDiff().files;
    return plan().map((stop) =>
        stop.planIndex === planIndex
            ? {
                  ...stop,
                  status: 'ready',
                  paragraph: 'Уже принятое заполнение.',
                  anchors: anchors.map((anchor) => ({
                      ...anchor,
                      fileId: files.find((file) => file.path === anchor.path)?.fileId ?? 'нет такого файла',
                      collapsed: false,
                  })),
              }
            : stop,
    );
}

function section(stops: unknown[]): string {
    return asRawText({ stops });
}

function anchoredStop(planIndex: number, anchors: unknown[], extra: Record<string, unknown> = {}): unknown {
    return { planIndex, paragraph: 'Что изменилось → какие следствия.', anchors, ...extra };
}

/** Одна запись корпуса: сырой текст и то, чем валидатор обязан ответить. */
interface Case {
    readonly name: string;
    readonly run: () => RouteValidation<unknown>;
    /** Дословные ошибки. */
    readonly errors?: readonly string[];
    /** Ошибки, текст которых принадлежит zod или `JSON.parse`: проверяются по форме. */
    readonly patterns?: readonly RegExp[];
}

const CASES: readonly Case[] = [
    {
        name: 'не JSON вовсе',
        run: () => validateSkeleton('маршрут готов, стопов семь'),
        patterns: [/^Result is not valid JSON: .+\. Return a single JSON object matching the skeleton schema/],
    },
    {
        name: 'оборванный JSON',
        run: () => validateSkeleton('{"summary": "PR вводит окно", "stops": ['),
        patterns: [/^Result is not valid JSON: /],
    },
    {
        name: 'скелет без стопов',
        run: () => validateSkeleton(asRawText({ summary: 'PR вводит окно', stops: [], tourOrder: [] })),
        patterns: [/^skeleton\.stops: /],
    },
    {
        name: 'скелет из 41 стопа',
        run: () =>
            validateSkeleton(
                asRawText({
                    summary: 'PR вводит окно',
                    stops: Array.from({ length: 41 }, (_unused, index) => ({
                        title: `Стоп ${String(index + 1)}`,
                        tier: 'low',
                        intent: 'Замысел стопа.',
                    })),
                    tourOrder: Array.from({ length: 41 }, (_unused, index) => index + 1),
                }),
            ),
        patterns: [/^skeleton\.stops: /],
    },
    {
        name: 'tourOrder — не перестановка плановых номеров',
        run: () => validateSkeleton(asRawText(mediumRawResults().broken.skeletonTourOrderNotPermutation)),
        errors: [
            'skeleton.tourOrder must list every plan number 1..6 exactly once (listed twice: 3; missing: 4). Reorder the numbers, do not add or drop stops.',
        ],
    },
    {
        name: 'секция: якорь в файл, которого нет в диффе',
        run: () =>
            validateSection(
                asRawText(mediumRawResults().broken.sectionUnknownFile),
                plan(),
                [3],
                mediumDiff(),
            ),
        errors: [
            'section.stops[0]: every anchor of stop 3 was dropped (anchor 1 ("services/orders/src/domain/order-state.ts" new 1-64): the file is not in this diff). Re-anchor the stop to lines this diff actually changes and call complete again.',
        ],
    },
    {
        name: 'секция: диапазон вне изменённых строк',
        run: () =>
            validateSection(
                asRawText(mediumRawResults().broken.sectionRangeOutsideChanges),
                plan(),
                [5],
                mediumDiff(),
            ),
        errors: [
            'section.stops[0]: every anchor of stop 5 was dropped (anchor 1 ("services/orders/README.md" new 400-420): it covers no line changed on the new side). Re-anchor the stop to lines this diff actually changes and call complete again.',
        ],
    },
    {
        name: 'секция: чужой плановый номер',
        run: () =>
            validateSection(
                section([anchoredStop(3, [{ path: WINDOW, side: 'new', start: 1, end: 94 }])]),
                plan(),
                [1],
                mediumDiff(),
            ),
        errors: [
            'section.stops[0].planIndex: stop 3 is not assigned to this task. Fill only these stops: 1.',
        ],
    },
    {
        name: 'секция: планового номера нет в плане',
        run: () =>
            validateSection(
                section([anchoredStop(99, [{ path: WINDOW, side: 'new', start: 1, end: 94 }])]),
                plan(),
                [1],
                mediumDiff(),
            ),
        errors: [
            'section.stops[0].planIndex: 99 is not a stop of the route plan (plan numbers are 1..6). Fill only the stops assigned to this task: 1.',
        ],
    },
    {
        name: 'секция: попытка заполнить синтетическое «Прочее»',
        run: () =>
            validateSection(
                section([anchoredStop(7, [{ path: WINDOW, side: 'new', start: 1, end: 94 }])]),
                plan(),
                [7],
                mediumDiff(),
            ),
        errors: [
            'section.stops[0].planIndex: 7 is not a stop of the route plan (plan numbers are 1..6). Fill only the stops assigned to this task: 7.',
        ],
    },
    {
        name: 'секция: end < start',
        run: () =>
            validateSection(
                section([anchoredStop(1, [{ path: WINDOW, side: 'new', start: 40, end: 12 }])]),
                plan(),
                [1],
                mediumDiff(),
            ),
        errors: [
            'section.stops[0].anchors[0]: stop 1 has end (12) before start (40). An anchor is an inclusive range, so end must be >= start.',
        ],
    },
    {
        // Путь в ошибке адресует JSON модели, а не наш порядок обработки: модель сдаёт стопы
        // в удобном ей порядке, а правит результат по этому пути (`docs/protocol.md §3`).
        name: 'секция: битый стоп не первым в выводе модели',
        run: () =>
            validateSection(
                section([
                    anchoredStop(3, [{ path: WINDOW, side: 'new', start: 80, end: 40 }]),
                    anchoredStop(1, [{ path: WINDOW, side: 'new', start: 1, end: 40 }]),
                ]),
                plan(),
                [1, 3],
                mediumDiff(),
            ),
        errors: [
            'section.stops[0].anchors[0]: stop 3 has end (40) before start (80). An anchor is an inclusive range, so end must be >= start.',
        ],
    },
    {
        name: 'секция: один стоп заполнен дважды',
        run: () =>
            validateSection(
                section([
                    anchoredStop(1, [{ path: WINDOW, side: 'new', start: 1, end: 40 }]),
                    anchoredStop(1, [{ path: WINDOW, side: 'new', start: 41, end: 94 }]),
                ]),
                plan(),
                [1],
                mediumDiff(),
            ),
        errors: ['section.stops[1].planIndex: stop 1 is filled twice in this result. Return one entry per stop.'],
    },
    {
        name: 'секция: якорь целиком съеден чужим стопом и других якорей нет',
        run: () =>
            validateSection(
                section([anchoredStop(2, [{ path: WINDOW, side: 'new', start: 10, end: 20 }])]),
                planWith(1, [{ path: WINDOW, side: 'new', start: 1, end: 94 }]),
                [2],
                mediumDiff(),
            ),
        errors: [
            'section.stops[0]: every anchor of stop 2 was dropped (anchor 1 ("services/orders/src/domain/edit-window.ts" new 10-20): the range is already explained by stop 01). Re-anchor the stop to lines this diff actually changes and call complete again.',
        ],
    },
    {
        // Спор между результатами решается в пользу занявшего первым (`docs/design/SPEC-elements.md
        // §4.3`: keeps the first), плановый номер претендента роли не играет — валидатор чужие
        // заполнения не правит. Порядок приёма секций, если он важен для качества маршрута,
        // обеспечивает оркестрация.
        name: 'секция: меньший плановый номер не отбирает диапазон у принятого стопа',
        run: () =>
            validateSection(
                section([anchoredStop(2, [{ path: WINDOW, side: 'new', start: 27, end: 56 }])]),
                planWith(5, [{ path: WINDOW, side: 'new', start: 1, end: 60 }]),
                [2],
                mediumDiff(),
            ),
        errors: [
            'section.stops[0]: every anchor of stop 2 was dropped (anchor 1 ("services/orders/src/domain/edit-window.ts" new 27-56): the range is already explained by stop 05). Re-anchor the stop to lines this diff actually changes and call complete again.',
        ],
    },
    {
        name: 'секция: пустой массив стопов',
        run: () => validateSection(section([]), plan(), [1], mediumDiff()),
        patterns: [/^section\.stops: /],
    },
    {
        name: 'скелет: фраза-заполнитель в summary',
        run: () =>
            validateSkeleton(
                asRawText({
                    ...mediumRawResults().skeleton,
                    summary: 'Важно отметить, что PR вводит окно редактирования.',
                }),
            ),
        errors: [
            'skeleton.summary: drop the filler phrase "важно отметить" and state the fact directly (see Voice in the methodology).',
        ],
    },
    {
        name: 'скелет: эмодзи в заголовке стопа',
        run: () => {
            const skeleton = mediumRawResults().skeleton;
            const stops = skeleton.stops.map((stop, index) =>
                index === 0 ? { ...stop, title: `${stop.title} 🚀` } : stop,
            );
            return validateSkeleton(asRawText({ ...skeleton, stops }));
        },
        errors: [
            'skeleton.stops[0].title: contains emoji — route texts are plain prose (see Voice in the methodology).',
        ],
    },
    {
        name: 'секция: фраза-заполнитель в абзаце',
        run: () =>
            validateSection(
                section([
                    anchoredStop(1, [{ path: WINDOW, side: 'new', start: 1, end: 40 }], {
                        paragraph: 'Стоит отметить, что обработчик переписан.',
                    }),
                ]),
                plan(),
                [1],
                mediumDiff(),
            ),
        errors: [
            'section.stops[0].paragraph: drop the filler phrase "стоит отметить" and state the fact directly (see Voice in the methodology).',
        ],
    },
    {
        name: 'секция: эмодзи в утверждении дайджеста',
        run: () =>
            validateSection(
                section([
                    anchoredStop(1, [{ path: WINDOW, side: 'new', start: 1, end: 40 }], {
                        tests: [{ kind: 'new', text: 'Отклоняет правку позже окна ✅', testPath: WINDOW, testLine: 12 }],
                    }),
                ]),
                plan(),
                [1],
                mediumDiff(),
            ),
        errors: [
            'section.stops[0].tests[0].text: contains emoji — route texts are plain prose (see Voice in the methodology).',
        ],
    },
    {
        name: 'секция: заголовок в описании остановки',
        run: () =>
            validateSection(
                section([
                    anchoredStop(1, [{ path: WINDOW, side: 'new', start: 1, end: 40 }], {
                        paragraph: '## Что изменилось\n\nОкно правки стало доменным понятием.',
                    }),
                ]),
                plan(),
                [1],
                mediumDiff(),
            ),
        errors: [
            'section.stops[0].paragraph: paragraph of stop 1 uses a heading; allowed: paragraphs, `- `/`* `/`1. ` lists up to 4 items, `code`, **bold**, [links](url).',
        ],
    },
    {
        // Потолок схемы выше бюджета не зря: бюджет ловит валидатор, и модель получает
        // не отказ zod, а текст с советом.
        name: 'секция: описание остановки длиннее бюджета',
        run: () =>
            validateSection(
                section([
                    anchoredStop(1, [{ path: WINDOW, side: 'new', start: 1, end: 40 }], {
                        paragraph: 'я'.repeat(900),
                    }),
                ]),
                plan(),
                [1],
                mediumDiff(),
            ),
        errors: [
            'section.stops[0].paragraph: paragraph of stop 1 is 900 chars, limit is 840. Cut it down, do not split it across stops.',
        ],
    },
    {
        // Причина изменения — такой же ревьюер-читаемый текст, как абзац: голос проверяется жёстко
        // ещё до классификации стопа, иначе отказ зависел бы от того, есть ли прошлый снапшот.
        name: 'секция: фраза-заполнитель в причине изменения',
        run: () =>
            validateSection(
                section([
                    anchoredStop(1, [{ path: WINDOW, side: 'new', start: 1, end: 40 }], {
                        changeReason: 'Как мы видим, автор переписал вычисление окна.',
                    }),
                ]),
                plan(),
                [1],
                mediumDiff(),
            ),
        errors: [
            'section.stops[0].changeReason: drop the filler phrase "как мы видим" and state the fact directly (see Voice in the methodology).',
        ],
    },
    {
        name: 'en: фраза-заполнитель в summary',
        run: () =>
            validateSkeleton(
                asRawText({
                    ...mediumRawResultsEn().skeleton,
                    summary: 'It should be noted that the pull request adds an edit window.',
                }),
                'en',
            ),
        errors: [
            'skeleton.summary: drop the filler phrase "it should be noted" and state the fact directly (see Voice in the methodology).',
        ],
    },
    {
        name: 'en: эмодзи в заголовке стопа',
        run: () => {
            const skeleton = mediumRawResultsEn().skeleton;
            const stops = skeleton.stops.map((stop, index) =>
                index === 0 ? { ...stop, title: `${stop.title} 🚀` } : stop,
            );
            return validateSkeleton(asRawText({ ...skeleton, stops }), 'en');
        },
        errors: [
            'skeleton.stops[0].title: contains emoji — route texts are plain prose (see Voice in the methodology).',
        ],
    },
    {
        name: 'en: фраза-заполнитель в абзаце',
        run: () =>
            validateSection(
                section([
                    anchoredStop(1, [{ path: WINDOW, side: 'new', start: 1, end: 40 }], {
                        paragraph: 'As we can see, the handler was rewritten.',
                    }),
                ]),
                planEn(),
                [1],
                mediumDiff(),
                { locale: 'en' },
            ),
        errors: [
            'section.stops[0].paragraph: drop the filler phrase "as we can see" and state the fact directly (see Voice in the methodology).',
        ],
    },
    {
        name: 'en: фраза-заполнитель в причине изменения',
        run: () =>
            validateSection(
                section([
                    anchoredStop(1, [{ path: WINDOW, side: 'new', start: 1, end: 40 }], {
                        paragraph: 'The handler was rewritten around the window.',
                        changeReason: 'Needless to say, the author rewrote the window computation.',
                    }),
                ]),
                planEn(),
                [1],
                mediumDiff(),
                { locale: 'en' },
            ),
        errors: [
            'section.stops[0].changeReason: drop the filler phrase "needless to say" and state the fact directly (see Voice in the methodology).',
        ],
    },
];

describe('валидатор маршрута: негативный корпус', () => {
    for (const testCase of CASES) {
        it(testCase.name, () => {
            const result = testCase.run();
            expect(result.ok).toBe(false);
            if (result.ok) {
                return;
            }
            if (testCase.errors !== undefined) {
                expect(result.errors).toEqual([...testCase.errors]);
            }
            if (testCase.patterns !== undefined) {
                expect(result.errors.length).toBe(testCase.patterns.length);
                testCase.patterns.forEach((pattern, index) => {
                    expect(result.errors[index]).toMatch(pattern);
                });
            }
        });
    }
});

describe('валидатор маршрута: мягкая деградация', () => {
    it('JSON в markdown-фенсе — валиден', () => {
        for (const opening of ['```json', '```']) {
            const fenced = [opening, asRawText(mediumRawResults().skeleton), '```'].join('\n');
            const result = validateSkeleton(fenced);

            expect(result.ok).toBe(true);
            if (result.ok) {
                expect(result.value.stops.length).toBe(7);
            }
        }
    });

    it('текст, похожий на фенс, но не фенс, остаётся невалидным JSON', () => {
        const result = validateSkeleton('``` вот маршрут ```');

        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.errors[0]).toMatch(/^Result is not valid JSON: /);
        }
    });

    it('лишние поля модель может слать: схема их срезает', () => {
        const raw = mediumRawResults().skeleton;
        const result = validateSkeleton(
            asRawText({
                ...raw,
                confidence: 0.9,
                stops: raw.stops.map((stop) => ({ ...stop, files: ['a.ts'] })),
            }),
        );

        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.value.stops[0]).not.toHaveProperty('files');
            expect(result.value.stops[0]?.title).toBe(raw.stops[0]?.title);
        }
    });

    it('якорь с контекстом сохраняется как есть и не клампится по изменённым строкам', () => {
        // В README на новой стороне менялись строки 25–27 и 43–52; 20–30 захватывает контекст.
        const result = validateSection(
            section([anchoredStop(5, [{ path: README, side: 'new', start: 20, end: 30 }])]),
            plan(),
            [5],
            mediumDiff(),
        );

        expect(result.ok).toBe(true);
        if (!result.ok) {
            return;
        }
        expect(result.value[0]?.anchors).toEqual([
            {
                fileId: mediumDiff().files.find((file) => file.path === README)?.fileId,
                path: README,
                side: 'new',
                start: 20,
                end: 30,
                collapsed: false,
            },
        ]);
        expect(result.value[0]?.validationNotes).toEqual([]);
    });

    it('пересечение с принятым стопом вычитается, якорь урезается, ревьюер получает пометку', () => {
        const result = validateSection(
            section([anchoredStop(2, [{ path: WINDOW, side: 'new', start: 40, end: 94 }])]),
            planWith(1, [{ path: WINDOW, side: 'new', start: 1, end: 50 }]),
            [2],
            mediumDiff(),
        );

        expect(result.ok).toBe(true);
        if (!result.ok) {
            return;
        }
        expect(result.value[0]?.anchors.map((anchor) => `${String(anchor.start)}-${String(anchor.end)}`)).toEqual([
            '51-94',
        ]);
        expect(result.value[0]?.validationNotes).toEqual([
            'Часть диапазона `services/orders/src/domain/edit-window.ts` 40–94 уже объяснена в стопе 01 — якорь урезан.',
        ]);
    });

    it('вычитание в середине диапазона расщепляет якорь надвое', () => {
        const result = validateSection(
            section([anchoredStop(2, [{ path: WINDOW, side: 'new', start: 1, end: 94 }])]),
            planWith(1, [{ path: WINDOW, side: 'new', start: 40, end: 50 }]),
            [2],
            mediumDiff(),
        );

        expect(result.ok).toBe(true);
        if (!result.ok) {
            return;
        }
        expect(result.value[0]?.anchors.map((anchor) => `${String(anchor.start)}-${String(anchor.end)}`)).toEqual([
            '1-39',
            '51-94',
        ]);
    });

    it('опустевший от дубля якорь дропается, живой сосед остаётся', () => {
        const result = validateSection(
            section([
                anchoredStop(2, [
                    { path: WINDOW, side: 'new', start: 10, end: 20 },
                    { path: CLOCK, side: 'new', start: 1, end: 33 },
                ]),
            ]),
            planWith(1, [{ path: WINDOW, side: 'new', start: 1, end: 94 }]),
            [2],
            mediumDiff(),
        );

        expect(result.ok).toBe(true);
        if (!result.ok) {
            return;
        }
        expect(result.value[0]?.anchors.map((anchor) => anchor.path)).toEqual([CLOCK]);
        expect(result.value[0]?.validationNotes).toEqual([
            'Диапазон `services/orders/src/domain/edit-window.ts` 10–20 уже объяснён в стопе 01.',
        ]);
    });

    it('утверждение дайджеста без якоря на тест отбрасывается со счётчиком', () => {
        const result = validateSection(
            section([
                anchoredStop(1, [{ path: WINDOW, side: 'new', start: 1, end: 94 }], {
                    tests: [
                        { kind: 'new', text: 'Окно закрывается через 30 минут.' },
                        { kind: 'changed', text: 'Закрытое окно отвечает 409.', testPath: WINDOW },
                    ],
                }),
            ]),
            plan(),
            [1],
            mediumDiff(),
        );

        expect(result.ok).toBe(true);
        if (!result.ok) {
            return;
        }
        expect(result.value[0]?.tests).toEqual([]);
        expect(result.value[0]?.droppedClaims).toBe(2);
        expect(result.value[0]?.validationNotes).toEqual(['Два утверждения отброшены: якорь на тест не указан.']);
    });

    it('утверждение дайджеста с якорем в файл вне диффа отбрасывается с названием файла', () => {
        const result = validateSection(
            section([
                anchoredStop(1, [{ path: WINDOW, side: 'new', start: 1, end: 94 }], {
                    tests: [
                        {
                            kind: 'new',
                            text: 'Окно закрывается через 30 минут.',
                            testPath: 'services/orders/src/domain/__tests__/factories.ts',
                            testLine: 12,
                        },
                    ],
                }),
            ]),
            plan(),
            [1],
            mediumDiff(),
        );

        expect(result.ok).toBe(true);
        if (!result.ok) {
            return;
        }
        expect(result.value[0]?.droppedClaims).toBe(1);
        expect(result.value[0]?.validationNotes).toEqual([
            'Одно утверждение отброшено: якорь вёл в `services/orders/src/domain/__tests__/factories.ts`, которого нет в этом диффе.',
        ]);
    });

    it('uncovered с путём вне диффа остаётся в дайджесте без якоря и ничего не дропает', () => {
        const result = validateSection(
            section([
                anchoredStop(1, [{ path: WINDOW, side: 'new', start: 1, end: 94 }], {
                    tests: [
                        {
                            kind: 'uncovered',
                            text: 'Маскирование PAN не покрыто.',
                            testPath: 'services/orders/src/payments/legacy.ts',
                            testLine: 4,
                        },
                    ],
                }),
            ]),
            plan(),
            [1],
            mediumDiff(),
        );

        expect(result.ok).toBe(true);
        if (!result.ok) {
            return;
        }
        expect(result.value[0]?.tests).toEqual([
            { kind: 'uncovered', text: 'Маскирование PAN не покрыто.', anchor: null },
        ]);
        expect(result.value[0]?.droppedClaims).toBe(0);
        expect(result.value[0]?.validationNotes).toEqual([]);
    });

    it('мёртвый якорь при живом соседе — пометка ревьюеру, а не отказ', () => {
        const result = validateSection(
            section([
                anchoredStop(1, [
                    { path: WINDOW, side: 'new', start: 1, end: 94 },
                    { path: 'services/orders/src/domain/order-state.ts', side: 'new', start: 1, end: 10 },
                ]),
            ]),
            plan(),
            [1],
            mediumDiff(),
        );

        expect(result.ok).toBe(true);
        if (!result.ok) {
            return;
        }
        expect(result.value[0]?.anchors.map((anchor) => anchor.path)).toEqual([WINDOW]);
        expect(result.value[0]?.validationNotes).toEqual([
            'Якорь на `services/orders/src/domain/order-state.ts` отброшен: файла нет в этом диффе.',
        ]);
    });

    it('якорь на строку за пустой строкой-контекстом живёт: нумерация та же, что в UI', () => {
        // Хосты режут хвостовой пробел, и строка контекста приезжает пустой. Считать её
        // «не строкой» нельзя: дальше по ханку номера разъедутся с тем, что видит модель.
        const patch = [
            '--- a/clock.ts',
            '+++ b/clock.ts',
            '@@ -1,3 +1,3 @@',
            ' const a = 1;',
            '',
            '-const b = 2;',
            '+const b = 3;',
        ].join('\n');
        const diff = mediumDiff();
        const patched = {
            ...diff,
            files: diff.files.map((file) => (file.path === CLOCK ? { ...file, patch } : file)),
        };

        const result = validateSection(
            section([anchoredStop(1, [{ path: CLOCK, side: 'new', start: 3, end: 3 }])]),
            plan(),
            [1],
            patched,
        );

        expect(result.ok).toBe(true);
        if (!result.ok) {
            return;
        }
        expect(result.value[0]?.anchors.map((anchor) => `${String(anchor.start)}-${String(anchor.end)}`)).toEqual([
            '3-3',
        ]);
        expect(result.value[0]?.validationNotes).toEqual([]);
    });

    it('повторная сдача той же секции не спорит сама с собой', () => {
        const first = mediumRawResults().sections[0];
        const filled = planWith(1, [
            { path: WINDOW, side: 'new', start: 1, end: 94 },
            { path: CLOCK, side: 'new', start: 1, end: 33 },
        ]);
        const result = validateSection(asRawText(first), filled, [1], mediumDiff());

        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.value[0]?.anchors.length).toBe(2);
            expect(result.value[0]?.validationNotes).toEqual([]);
        }
    });
});

/**
 * Стоп-лист принадлежит локали генерации: чужеязычная фраза нарушением не считается —
 * иначе цитата из обсуждения ловилась бы валидатором.
 */
describe('валидатор маршрута: стоп-лист голоса на чужом языке', () => {
    it('русская фраза-заполнитель в английском тексте проходит', () => {
        const result = validateSection(
            section([
                anchoredStop(1, [{ path: WINDOW, side: 'new', start: 1, end: 40 }], {
                    paragraph: 'The reviewer note said «важно отметить» and the handler was rewritten.',
                }),
            ]),
            planEn(),
            [1],
            mediumDiff(),
            { locale: 'en' },
        );

        expect(result.ok).toBe(true);
    });

    it('английская фраза-заполнитель в русском тексте проходит', () => {
        const result = validateSection(
            section([
                anchoredStop(1, [{ path: WINDOW, side: 'new', start: 1, end: 40 }], {
                    paragraph: 'Комментарий автора «it is worth noting» остался в коде без изменений.',
                }),
            ]),
            plan(),
            [1],
            mediumDiff(),
        );

        expect(result.ok).toBe(true);
    });
});

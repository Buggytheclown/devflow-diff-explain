import { routeFixtures } from '@sherpa/fixtures';
import type { RouteSectionResult, RouteStop } from '@sherpa/protocol';
import { describe, expect, it } from 'vitest';

import type { IterationMap } from '../iterations/index.js';
import { buildIterationMap, identityMap } from '../iterations/index.js';
import {
    asRawText,
    mediumDiff,
    mediumDiffV2,
    mediumInterdiffV1V2,
    mediumRawResults,
    mediumRawResultsEn,
    mediumRawResultsV2,
    mediumReadySnapshot,
    mediumThreadsV2,
} from './fixture-support.js';
import type { SectionContext } from './section.js';
import { validateSection } from './section.js';
import { otherStopTitle, validateSkeleton } from './skeleton.js';
import type { RouteStopFilling } from './types.js';
import { applyFilling } from './types.js';

/**
 * Сквозной голден: сырые выводы модели из фикстур → валидатор → стопы готового снапшота.
 * Фикстура и живой пайплайн обязаны сходиться дословно — иначе галерея, e2e и UI видят одни
 * данные, а сервер собирает другие.
 */

function planStops(): RouteStop[] {
    const skeleton = validateSkeleton(asRawText(mediumRawResults().skeleton));
    if (!skeleton.ok) {
        throw new Error(`скелет фикстуры не принят: ${skeleton.errors.join(' | ')}`);
    }
    return skeleton.value.stops;
}

/** Слияние заполнений в план — то, что делает `RouteStore`. */
function merge(stops: readonly RouteStop[], fillings: readonly RouteStopFilling[]): RouteStop[] {
    const byIndex = new Map(fillings.map((filling) => [filling.planIndex, filling]));
    return stops.map((stop) => {
        const filling = byIndex.get(stop.planIndex);
        return filling === undefined || stop.tier === 'other' ? stop : applyFilling(stop, filling);
    });
}

function fill(stops: RouteStop[], section: RouteSectionResult, allowed: readonly number[]): RouteStop[] {
    const result = validateSection(asRawText(section), stops, allowed, mediumDiff());
    if (!result.ok) {
        throw new Error(`секция не принята: ${result.errors.join(' | ')}`);
    }
    return merge(stops, result.value);
}

describe('валидатор маршрута: сквозной голден на фикстуре medium', () => {
    const raw = mediumRawResults();
    const snapshot = mediumReadySnapshot();

    it('скелет разворачивается в план снапшота: id, тиры, «Прочее», tour-порядок', () => {
        const skeleton = validateSkeleton(asRawText(raw.skeleton));
        expect(skeleton.ok).toBe(true);
        if (!skeleton.ok) {
            return;
        }

        expect(skeleton.value.summary).toBe(snapshot.summary);
        expect(skeleton.value.tourOrder).toEqual(snapshot.tourOrder);
        expect(skeleton.value.stops.map((stop) => stop.id)).toEqual(snapshot.stops.map((stop) => stop.id));
        expect(skeleton.value.stops.map((stop) => stop.tier)).toEqual(snapshot.stops.map((stop) => stop.tier));
        expect(skeleton.value.stops.map((stop) => stop.title)).toEqual(snapshot.stops.map((stop) => stop.title));
        expect(skeleton.value.stops.map((stop) => stop.status)).toEqual([
            'queued',
            'queued',
            'queued',
            'queued',
            'queued',
            'queued',
            // «Прочее» заполнять нечем — оно готово сразу.
            'ready',
        ]);

        // Замысел стопов в снапшот не едет: его потребит постановщик секций.
        expect([...skeleton.value.intents.keys()]).toEqual([1, 2, 3, 4, 5, 6]);
        expect(skeleton.value.intents.get(4)).toBe(raw.skeleton.stops[3]?.intent);
        for (const stop of skeleton.value.stops) {
            expect(stop).not.toHaveProperty('intent');
        }
    });

    it('шесть секций по очереди дают стопы фикстурного ready-снапшота дословно', () => {
        let stops = planStops();
        for (const section of raw.sections) {
            const planIndex = section.stops[0]?.planIndex ?? 0;
            stops = fill(stops, section, [planIndex]);
        }

        expect(stops).toEqual(snapshot.stops);
    });

    it('батч из всех шести секций сразу даёт тот же результат', () => {
        const batched: RouteSectionResult = { stops: raw.sections.flatMap((section) => section.stops) };
        const stops = fill(planStops(), batched, [1, 2, 3, 4, 5, 6]);

        expect(stops).toEqual(mediumReadySnapshot().stops);
    });

    it('дайджест стопа 04: 12 принятых утверждений, 2 отброшенных, пометка ревьюеру по-русски', () => {
        const section = raw.sections.find((candidate) => candidate.stops[0]?.planIndex === 4);
        const result = validateSection(asRawText(section), planStops(), [4], mediumDiff());
        expect(result.ok).toBe(true);
        if (!result.ok) {
            return;
        }

        const [filling] = result.value;
        expect(filling?.tests.length).toBe(12);
        expect(filling?.droppedClaims).toBe(2);
        expect(filling?.validationNotes).toEqual([
            'Два утверждения отброшены: якорь вёл в `services/orders/src/domain/__tests__/factories.ts`, которого нет в этом диффе.',
        ]);
        // `uncovered` без якоря на тест остаётся в дайджесте: инверсия «поведение без покрытия».
        expect(filling?.tests.filter((claim) => claim.anchor === null).map((claim) => claim.kind)).toEqual([
            'uncovered',
        ]);
    });

    it('якоря резолвятся в fileId активной итерации, директива свёртки доезжает', () => {
        const stops = planStops();
        const lock = raw.sections.find((candidate) => candidate.stops[0]?.planIndex === 6);
        const result = validateSection(asRawText(lock), stops, [6], mediumDiff());
        expect(result.ok).toBe(true);
        if (!result.ok) {
            return;
        }

        const anchors = result.value[0]?.anchors ?? [];
        const lockFile = mediumDiff().files.find((file) => file.path === 'pnpm-lock.yaml');
        expect(anchors.map((anchor) => anchor.fileId)).toEqual([lockFile?.fileId, lockFile?.fileId]);
        expect(anchors.map((anchor) => anchor.collapsed)).toEqual([true, true]);
    });
});

/**
 * Второй заход на той же фикстуре: план и секции v2 против среза v1→v2. Классификацию стопов
 * считает сервер по якорям, модель только объясняет — расхождение с фикстурой означало бы, что
 * бейдж в UI и данные снапшота разъехались.
 */
describe('валидатор маршрута: второй заход после пуша', () => {
    const knownThreadIds = new Set(mediumThreadsV2().map((thread) => thread.id));

    function mapV1V2(): IterationMap {
        return buildIterationMap({
            interdiff: mediumInterdiffV1V2(),
            fromBaseCommit: mediumDiff().baseCommit,
            toBaseCommit: mediumDiffV2().baseCommit,
        });
    }

    function planV2(): RouteStop[] {
        const skeleton = validateSkeleton(asRawText(mediumRawResultsV2().skeleton));
        if (!skeleton.ok) {
            throw new Error(`скелет второго захода не принят: ${skeleton.errors.join(' | ')}`);
        }
        return skeleton.value.stops;
    }

    function fillV2(
        stops: RouteStop[],
        section: RouteSectionResult,
        allowed: readonly number[],
        context: SectionContext,
    ): RouteStop[] {
        const result = validateSection(asRawText(section), stops, allowed, mediumDiffV2(), context);
        if (!result.ok) {
            throw new Error(`секция второго захода не принята: ${result.errors.join(' | ')}`);
        }
        return merge(stops, result.value);
    }

    function fillAll(context: SectionContext): RouteStop[] {
        let stops = planV2();
        for (const section of mediumRawResultsV2().sections) {
            const planIndex = section.stops[0]?.planIndex ?? 0;
            stops = fillV2(stops, section, [planIndex], context);
        }
        return stops;
    }

    it('классификация считается сервером и совпадает с фикстурой второго захода', () => {
        const stops = fillAll({ map: mapV1V2(), knownThreadIds });
        const expected = routeFixtures('medium')?.secondPass?.snapshot?.stops ?? [];

        expect(stops.map((stop) => [stop.id, stop.change?.kind ?? null])).toEqual(
            expected.map((stop) => [stop.id, stop.change?.kind ?? null]),
        );
        expect(stops.map((stop) => stop.change?.reason ?? null)).toEqual(
            expected.map((stop) => stop.change?.reason ?? null),
        );
        expect(stops.find((stop) => stop.id === 's03')?.change?.threadIds).toEqual(['4820242']);
        expect(stops.find((stop) => stop.id === 's01')?.change).toBeNull();
    });

    it('причина на нетронутом стопе отброшена с пометкой ревьюеру', () => {
        const section = withReason(sectionOfV2(1), 'Автор переписал этот стоп заново.');
        const [filling] = accept(section, [1], { map: mapV1V2(), knownThreadIds });

        expect(filling?.change).toBeNull();
        expect(filling?.validationNotes).toContain(
            'Причина изменения отброшена: остановка не менялась с прошлого захода.',
        );
    });

    it('ссылка на неизвестный тред вырезается из текста и не едет в threadIds', () => {
        const section = withReason(
            sectionOfV2(2),
            'Автор закрыл замечание линтера [thread:999], ветка `default` появилась.',
        );
        const [filling] = accept(section, [2], { map: mapV1V2(), knownThreadIds });

        expect(filling?.change?.kind).toBe('changed');
        expect(filling?.change?.reason).toBe('Автор закрыл замечание линтера, ветка `default` появилась.');
        expect(filling?.change?.threadIds).toEqual([]);
        expect(filling?.validationNotes).toContain('Ссылка на неизвестный тред 999 удалена.');
    });

    it('причина из одной битой ссылки схлопывается в null, а не в пустой блок', () => {
        const section = withReason(sectionOfV2(2), '[thread:999]');
        const [filling] = accept(section, [2], { map: mapV1V2(), knownThreadIds });

        expect(filling?.change).toEqual({ kind: 'changed', reason: null, threadIds: [] });
        expect(filling?.validationNotes).toContain('Ссылка на неизвестный тред 999 удалена.');
    });

    it('ссылки без причины остаются: они и сами ведут ревьюера в обсуждение', () => {
        const section = withThreadIds(withReason(sectionOfV2(3), null), ['4820242']);
        const [filling] = accept(section, [3], { map: mapV1V2(), knownThreadIds });

        expect(filling?.change).toEqual({ kind: 'changed', reason: null, threadIds: ['4820242'] });
    });

    it('известная ссылка в тексте причины доезжает до threadIds и вырезается из текста', () => {
        const section = withReason(sectionOfV2(3), 'Ответ автора объясняет правку [thread:4820242].');
        const [filling] = accept(section, [3], { map: mapV1V2(), knownThreadIds });

        expect(filling?.change?.threadIds).toEqual(['4820242']);
        // UI показывает треды рядом с причиной отдельным рядом — литерал токена в прозе не нужен.
        expect(filling?.change?.reason).toBe('Ответ автора объясняет правку.');
        expect(filling?.validationNotes).toEqual([]);
    });

    it('ответ без причины у классифицированного стопа принимается: причина не обязательна', () => {
        const section = withReason(sectionOfV2(6), null);
        const [filling] = accept(section, [6], { map: mapV1V2(), knownThreadIds });

        expect(filling?.change).toEqual({ kind: 'new', reason: null, threadIds: [] });
    });

    it('перегенерация на той же итерации: причины отброшены, классификации нет', () => {
        const stops = fillAll({ map: identityMap(), knownThreadIds });

        expect(stops.every((stop) => stop.change === null)).toBe(true);
        expect(stops.find((stop) => stop.id === 's02')?.validationNotes).toContain(
            'Причина изменения отброшена: остановка не менялась с прошлого захода.',
        );
    });

    it('без прошлого снапшота классификации нет и причины не читаются', () => {
        const stops = fillAll({ map: null, knownThreadIds: new Set() });

        expect(stops.every((stop) => stop.change === null)).toBe(true);
    });

    /** Секция второго захода по плановому номеру. */
    function sectionOfV2(planIndex: number): RouteSectionResult {
        const section = mediumRawResultsV2().sections.find(
            (candidate) => candidate.stops[0]?.planIndex === planIndex,
        );
        if (section === undefined) {
            throw new Error(`у фикстуры нет секции второго захода для стопа ${String(planIndex)}`);
        }
        return section;
    }

    /** Тот же результат с подменённой причиной; `null` — причины нет вовсе. */
    function withReason(section: RouteSectionResult, reason: string | null): RouteSectionResult {
        return {
            stops: section.stops.map((stop) => {
                const { changeReason: _dropped, changeThreadIds: _ids, ...rest } = stop;
                return reason === null ? rest : { ...rest, changeReason: reason };
            }),
        };
    }

    /** Тот же результат с явным списком тредов у каждого стопа. */
    function withThreadIds(section: RouteSectionResult, ids: readonly string[]): RouteSectionResult {
        return { stops: section.stops.map((stop) => ({ ...stop, changeThreadIds: [...ids] })) };
    }

    function accept(
        section: RouteSectionResult,
        allowed: readonly number[],
        context: SectionContext,
    ): RouteStopFilling[] {
        const result = validateSection(asRawText(section), planV2(), allowed, mediumDiffV2(), context);
        if (!result.ok) {
            throw new Error(`секция не принята: ${result.errors.join(' | ')}`);
        }
        return result.value;
    }
});

/**
 * Тот же пайплайн на английской генерации: язык меняет тексты модели и строки сервера,
 * но не якоря и не номера. Проверяется ровно это — иначе локаль тихо ломала бы валидатор.
 */
describe('валидатор маршрута: английская генерация', () => {
    const raw = mediumRawResultsEn();

    function planEn(): RouteStop[] {
        const skeleton = validateSkeleton(asRawText(raw.skeleton), 'en');
        if (!skeleton.ok) {
            throw new Error(`английский скелет не принят: ${skeleton.errors.join(' | ')}`);
        }
        return skeleton.value.stops;
    }

    it('синтетический стоп получает английский заголовок, план — те же номера', () => {
        const stops = planEn();
        expect(stops.map((stop) => stop.planIndex)).toEqual([1, 2, 3, 4, 5, 6, 7]);
        expect(stops.at(-1)?.id).toBe('other');
        expect(stops.at(-1)?.title).toBe('Other — lines the model did not place');
        expect(stops.at(-1)?.title).not.toBe(otherStopTitle('ru'));
    });

    it('секции принимаются с теми же якорями, что и русские', () => {
        let stops = planEn();
        for (const section of raw.sections) {
            const planIndex = section.stops[0]?.planIndex ?? 0;
            const result = validateSection(asRawText(section), stops, [planIndex], mediumDiff(), { locale: 'en' });
            expect(result.ok).toBe(true);
            if (!result.ok) {
                return;
            }
            stops = merge(stops, result.value);
        }

        const ruStops = mediumReadySnapshot().stops;
        for (const planIndex of [1, 2, 4]) {
            const actual = stops.find((stop) => stop.planIndex === planIndex);
            const expected = ruStops.find((stop) => stop.planIndex === planIndex);
            expect(actual?.anchors).toEqual(expected?.anchors);
        }
    });

    it('пометки валидатора о дайджесте — по-английски', () => {
        const section = raw.sections.find((candidate) => candidate.stops[0]?.planIndex === 4);
        const result = validateSection(asRawText(section), planEn(), [4], mediumDiff(), { locale: 'en' });
        expect(result.ok).toBe(true);
        if (!result.ok) {
            return;
        }

        const [filling] = result.value;
        expect(filling?.tests.length).toBe(12);
        expect(filling?.droppedClaims).toBe(2);
        expect(filling?.validationNotes).toEqual([
            '2 claims dropped: the anchor pointed at `services/orders/src/domain/__tests__/factories.ts`, which is not in this diff.',
        ]);
    });

    it('русская фраза-заполнитель в английском тексте ошибкой не считается', () => {
        const skeleton = validateSkeleton(
            asRawText({ ...raw.skeleton, summary: `Важно отметить. ${raw.skeleton.summary}` }),
            'en',
        );
        expect(skeleton.ok).toBe(true);
    });

    it('английская фраза-заполнитель и эмодзи отвергаются', () => {
        const filler = validateSkeleton(
            asRawText({ ...raw.skeleton, summary: 'It is worth noting that the window is 30 minutes.' }),
            'en',
        );
        expect(filler.ok).toBe(false);
        if (!filler.ok) {
            expect(filler.errors).toEqual([
                'skeleton.summary: drop the filler phrase "it is worth noting" and state the fact directly (see Voice in the methodology).',
            ]);
        }

        const stops = raw.skeleton.stops.map((stop, index) =>
            index === 0 ? { ...stop, title: `${stop.title} 🚀` } : stop,
        );
        const emoji = validateSkeleton(asRawText({ ...raw.skeleton, stops }), 'en');
        expect(emoji.ok).toBe(false);
    });
});

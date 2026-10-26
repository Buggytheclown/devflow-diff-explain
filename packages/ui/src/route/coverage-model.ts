import type { RouteTier } from '@sherpa/protocol';

import type { Translate } from '../i18n/index.js';
import type { RouteEntry, RouteTotals } from './route-model.js';

/**
 * Модель полосы покрытия (docs/design/SPEC-elements.md §2.4, docs/design/README.md §1): сегменты пропорциональны изменённым строкам,
 * легенда считается, а не хардкодится. Чистый модуль — на входе итоги маршрута и его остановки,
 * на выходе то, что рисует полоса; ни React, ни DOM.
 *
 * Числа обязаны сойтись с остальным вью: `RouteTotals` считаются от той же модели диффа, которой
 * живут чипы и «Прочее», поэтому второй арифметики здесь нет — только раскладка и тексты.
 */

/** Минимальная ширина сегмента: шестистрочный кусок обязан оставаться кликабельным (docs/design/SPEC-elements.md §2.4). */
export const MIN_SEGMENT_PX = 3;

/** Порядок сегментов слева направо: важное первым, штриховка последней. */
const TIER_ORDER: readonly RouteTier[] = ['high', 'medium', 'low', 'other'];

/** Имена тиров контракта одинаковы на обоих языках; у штриховки подпись своя, из словаря. */
const TIER_LABEL: Readonly<Record<Exclude<RouteTier, 'other'>, string>> = {
    high: 'high',
    medium: 'medium',
    low: 'low',
};

export interface CoverageSegment {
    readonly tier: RouteTier;
    readonly lines: number;
    /** Доля от изменённых строк: ширина сегмента задаётся ею, а не пикселями. */
    readonly share: number;
    /** Тултип `title`: тир, диапазон план-номеров его остановок и строки. */
    readonly title: string;
    /** Остановки тира: на наведение они получают акцентную линейку (двусторонняя связь). */
    readonly stopIds: readonly string[];
    /** Куда ведёт клик: первая остановка тира, у штриховки — «Прочее». */
    readonly targetStopId: string | null;
}

export interface CoverageLegend {
    readonly changed: string;
    readonly explained: string;
    /** `null` при 100% объяснено: третья клауза опускается, а не пишет «0 строк» (docs/design/SPEC-elements.md §2.4). */
    readonly unexplained: string | null;
}

export interface CoverageStripModel {
    readonly segments: readonly CoverageSegment[];
    readonly changed: number;
    readonly explained: number;
    /** Процент округляется вниз: 95.6% — это «95%», никогда не «96%». */
    readonly percent: number;
    readonly uncovered: number;
    readonly legend: CoverageLegend;
    /** Остановка «Прочее», если она в маршруте есть: цель ссылки легенды и штриховки. */
    readonly otherStopId: string | null;
}

export interface CoverageStripInput {
    readonly totals: RouteTotals;
    /** Записи маршрута в порядке рендера: из них берутся план-номера и цели прыжка. */
    readonly entries: readonly RouteEntry[];
    /** Легенда и тултипы — готовые строки: их читает `title`, куда ключ не отдать. */
    readonly t: Translate;
}

export function buildCoverageStrip({ totals, entries, t }: CoverageStripInput): CoverageStripModel {
    const changed = totals.changed;
    const uncovered = totals.uncovered;
    const explained = Math.max(changed - uncovered, 0);
    const percent = changed === 0 ? 100 : Math.floor((explained / changed) * 100);
    const otherStopId = entries.find((entry) => entry.kind === 'other')?.view.stop.id ?? null;

    const byTier = new Map<RouteTier, { ids: string[]; labels: string[] }>();
    for (const entry of entries) {
        const tier = entry.kind === 'other' ? 'other' : entry.view.stop.tier;
        const bucket = byTier.get(tier) ?? { ids: [], labels: [] };
        bucket.ids.push(entry.view.stop.id);
        bucket.labels.push(entry.view.planLabel);
        byTier.set(tier, bucket);
    }

    const segments: CoverageSegment[] = [];
    for (const tier of TIER_ORDER) {
        const lines = totals.byTier[tier];
        // Тир на ноль строк не рендерится вовсе — волосок вместо сегмента врал бы (docs/design/SPEC-elements.md §2.4).
        if (lines <= 0) {
            continue;
        }
        const bucket = byTier.get(tier) ?? { ids: [], labels: [] };
        segments.push({
            tier,
            lines,
            share: changed === 0 ? 0 : lines / changed,
            title: segmentTitle(t, tier, bucket.labels, lines),
            stopIds: bucket.ids,
            targetStopId: (tier === 'other' ? otherStopId : (bucket.ids[0] ?? null)) ?? null,
        });
    }

    return {
        segments,
        changed,
        explained,
        percent,
        uncovered,
        legend: {
            changed: t('coverage.legend.changed', changed),
            explained: t('coverage.legend.explained', percent),
            unexplained: uncovered === 0 ? null : t('coverage.legend.unexplained', uncovered),
        },
        otherStopId,
    };
}

/** «high · остановки 01–02 · 196 строк» — диапазон номеров вычисляется, а не задан руками. */
function segmentTitle(t: Translate, tier: RouteTier, labels: readonly string[], lines: number): string {
    const label = tier === 'other' ? t('coverage.tier.other') : TIER_LABEL[tier];
    if (tier === 'other' || labels.length === 0) {
        return t('coverage.segment.tier', label, lines);
    }
    const sorted = [...labels].sort((left, right) => left.localeCompare(right));
    const first = sorted[0] ?? '';
    const last = sorted.at(-1) ?? '';
    return first === last
        ? t('coverage.segment.stop', label, first, lines)
        : t('coverage.segment.stops', label, first, last, lines);
}

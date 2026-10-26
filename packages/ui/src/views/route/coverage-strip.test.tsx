import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { buildCoverageStrip } from '../../route/coverage-model.js';
import type { RouteTotals } from '../../route/route-model.js';
import { CoverageStrip } from './coverage-strip.tsx';
import { createT } from '../../i18n/index.js';

const t = createT('ru');

/** Полоса покрытия как её видит ревьюер: ширины, минимум 3px, легенда и состояние загрузки. */

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

function render(model: ReturnType<typeof buildCoverageStrip> | null, stops = { viewed: 0, total: 0 }): string {
    return renderToStaticMarkup(
        <CoverageStrip model={model} viewedStops={stops.viewed} totalStops={stops.total} />,
    );
}

describe('полоса покрытия', () => {
    it('ширина сегмента задана долей, а минимум — 3px', () => {
        const html = render(
            buildCoverageStrip({
                totals: totals({ changed: 200, uncovered: 6, byTier: { high: 194, medium: 0, low: 0, other: 6 } }),
                entries: [], t,}),
        );

        expect(html).toContain('flex-grow:0.97');
        expect(html).toContain('flex-grow:0.03');
        expect(count(html, 'min-width:3px')).toBe(2);
    });

    it('при 100% объяснено штриховки нет и третьей клаузы тоже', () => {
        const html = render(buildCoverageStrip({ totals: totals({}), entries: [], t}), { viewed: 3, total: 7 });

        expect(html).toContain('100% объяснено');
        expect(html).not.toContain('не объяснены');
        expect(html).not.toContain('coverage__segment--other');
        expect(html).toContain('просмотрено 3 из 7 остановок');
    });

    it('состояние загрузки: плоский трек, шиммер по готовым стопам и честная легенда', () => {
        const html = renderToStaticMarkup(
            <CoverageStrip model={null} loading={{ kind: 'plan', ready: 3, total: 7 }} viewedStops={0} totalStops={7} />,
        );

        expect(html).toContain('покрытие известно после плана');
        expect(html).toContain('coverage__shimmer');
        expect(html).toContain('coverage__rest');
        expect(html).not.toContain('coverage__segment');
    });

    it('плана ещё нет — знаменателя тоже: шиммер занимает весь трек', () => {
        const html = renderToStaticMarkup(
            <CoverageStrip model={null} loading={{ kind: 'plan', ready: 0, total: 0 }} />,
        );

        expect(html).toContain('coverage__shimmer');
        expect(html).not.toContain('coverage__rest');
        expect(html).not.toContain('просмотрено');
    });
});

function count(html: string, needle: string): number {
    return html.split(needle).length - 1;
}

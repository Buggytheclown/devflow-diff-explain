import type { RouteTier } from '@sherpa/protocol';

import type { MessageKey } from '../../i18n/index.js';
import { useT } from '../../i18n/index.js';
import type { CoverageStripModel } from '../../route/coverage-model.js';
import { MIN_SEGMENT_PX } from '../../route/coverage-model.js';

/**
 * Полоса покрытия (docs/design/SPEC-elements.md §2.4, docs/design/README.md §1, вторая строка тулбара маршрута): сегменты
 * пропорциональны изменённым строкам, легенда только вычисленная, а связь с остановками
 * двусторонняя — наведение подсвечивает их линейки, клик к ним прокручивает.
 *
 * Компонент ничего не считает: модель приезжает пропсом, поэтому та же полоса рисуется
 * в галерее состояний на фикстуре.
 */

export interface CoverageStripLoading {
    /**
     * Чего ждём: `plan` — маршрут генерится, `diff` — план готов, но дифф ещё разбирается
     * и покрытие не с чего считать. Разница видна только в тексте легенды.
     */
    readonly kind: 'plan' | 'diff';
    /** Готовой части: её размером идёт шиммер-сегмент (docs/design/SPEC-elements.md §2.4 loading). */
    readonly ready: number;
    readonly total: number;
}

const LOADING_TEXT: Readonly<Record<CoverageStripLoading['kind'], MessageKey>> = {
    plan: 'coverage.loading.plan',
    diff: 'coverage.loading.diff',
};

export interface CoverageStripProps {
    /** `null` — маршрут ещё генерится, полоса стоит в состоянии загрузки. */
    readonly model: CoverageStripModel | null;
    readonly loading?: CoverageStripLoading | null;
    readonly viewedStops?: number;
    readonly totalStops?: number;
    readonly onJump?: (stopId: string) => void;
    /** Наведение на сегмент: вью подсвечивает остановки этого тира. */
    readonly onHoverTier?: (tier: RouteTier | null) => void;
}

export function CoverageStrip({
    model,
    loading = null,
    viewedStops = 0,
    totalStops = 0,
    onJump,
    onHoverTier,
}: CoverageStripProps) {
    const t = useT();
    /*
     * Цель шага 04 тура стоит на счётчике просмотренных остановок — о нём и шаг.
     * Пока счётчика нет (плана ещё нет, знаменатель неизвестен), целью держится вся полоса:
     * шаг обязан быть на чём-то обведён и над каркасом тура.
     */
    const counterAnchored = totalStops > 0;
    const stripAnchor = counterAnchored ? {} : { 'data-tour': 'progress' };

    if (model === null) {
        // Знаменателя нет — плана ещё нет: делить полосу не на что, шиммер идёт во весь трек.
        const unknown = loading === null || loading.total === 0;
        const ready = unknown ? 0 : loading.ready / loading.total;
        return (
            <div className="coverage" {...stripAnchor}>
                <div className="coverage__track" aria-hidden="true">
                    {unknown || ready > 0 ? (
                        <span
                            className="coverage__shimmer"
                            style={{ flexGrow: unknown ? 1 : ready, flexBasis: 0 }}
                        />
                    ) : null}
                    {unknown ? null : (
                        <span
                            className="coverage__rest"
                            style={{ flexGrow: Math.max(1 - ready, 0.001), flexBasis: 0 }}
                        />
                    )}
                </div>
                <div className="coverage__legend">
                    <span className="coverage__legend-text">{t(LOADING_TEXT[loading?.kind ?? 'plan'])}</span>
                    <span className="coverage__spacer" />
                    <StopCounter viewed={viewedStops} total={totalStops} anchored={counterAnchored} />
                </div>
            </div>
        );
    }

    return (
        <div className="coverage" {...stripAnchor}>
            <div className="coverage__track" role="group" aria-label={t('coverage.aria')}>
                {model.segments.map((segment) => (
                    <button
                        key={segment.tier}
                        type="button"
                        className={`coverage__segment coverage__segment--${segment.tier}`}
                        style={{ flexGrow: segment.share, flexBasis: 0, minWidth: `${String(MIN_SEGMENT_PX)}px` }}
                        title={segment.title}
                        aria-label={segment.title}
                        disabled={segment.targetStopId === null}
                        onMouseEnter={() => {
                            onHoverTier?.(segment.tier);
                        }}
                        onMouseLeave={() => {
                            onHoverTier?.(null);
                        }}
                        onFocus={() => {
                            onHoverTier?.(segment.tier);
                        }}
                        onBlur={() => {
                            onHoverTier?.(null);
                        }}
                        onClick={() => {
                            if (segment.targetStopId !== null) {
                                onJump?.(segment.targetStopId);
                            }
                        }}
                    />
                ))}
            </div>
            <div className="coverage__legend">
                <span className="coverage__legend-text">
                    {model.legend.changed} · {model.legend.explained}
                    {model.legend.unexplained === null ? null : (
                        <>
                            {' · '}
                            <button
                                type="button"
                                className="ctl ctl--link-muted coverage__link"
                                disabled={model.otherStopId === null}
                                onClick={() => {
                                    if (model.otherStopId !== null) {
                                        onJump?.(model.otherStopId);
                                    }
                                }}
                            >
                                {model.legend.unexplained}
                            </button>
                        </>
                    )}
                </span>
                <span className="coverage__spacer" />
                <StopCounter viewed={viewedStops} total={totalStops} anchored={counterAnchored} />
            </div>
        </div>
    );
}

/** «просмотрено 3 из 7 остановок» — docs/design/README.md §1 «N / 7 stops viewed» в голосе остального UI. */
function StopCounter({ viewed, total, anchored }: { viewed: number; total: number; anchored: boolean }) {
    const t = useT();
    if (total === 0) {
        return null;
    }
    return (
        <span className="coverage__stops" {...(anchored ? { 'data-tour': 'progress' } : {})}>
            {t('coverage.stopsViewed', viewed, total)}
        </span>
    );
}

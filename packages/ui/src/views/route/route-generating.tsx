import type { UiRouteFailure } from '@sherpa/protocol';

import { useT } from '../../i18n/index.js';
import { CoverageStrip } from './coverage-strip.tsx';
import { RouteFailedCard } from './generation-card.tsx';
import { StopSkeleton } from './stop-card.tsx';
import './route.css';
import './generation.css';

/**
 * Вкладка «Маршрут» в фазах, где маршрута ещё (или уже) нет: скелет фазы чтения (docs/design/README.md §8),
 * красная карточка провала (docs/design/README.md §12) и объяснение малого PR (docs/design/SPEC-elements.md §4.1).
 *
 * Все три ничего не грузят — рисуются в галерее состояний как есть.
 */

/**
 * Фаза чтения: три безномерных плейсхолдера `— / ?`. Чисел нет намеренно — план ещё не готов,
 * и сколько будет остановок, неизвестно (docs/design/README.md §6, последнее предложение §8).
 */
export function RouteReadingView({ onOpenDiff }: { onOpenDiff: () => void }) {
    const t = useT();
    return (
        <main className="route route--skeleton" id="view-route">
            <div className="route-skeleton__bar">
                <CoverageStrip model={null} loading={{ kind: 'plan', ready: 0, total: 0 }} />
            </div>

            <div className="route__stops">
                {PLACEHOLDERS.map((key) => (
                    <section key={key} className="route-stop route-stop--unfilled" aria-hidden="true">
                        <div className="route-stop__side">
                            <div className="route-stop__head">
                                <span className="route-stop__rule" />
                                <span className="route-stop__number">— / ?</span>
                                <span className="route-stop__badge route-stop__badge--queued">{t('route.gen.plan.queued')}</span>
                            </div>
                            <div className="route-skeleton__title" />
                            <div className="route-skeleton__line" />
                            <div className="route-skeleton__line route-skeleton__line--short" />
                        </div>
                        <div className="route-stop__diff">
                            <StopSkeleton />
                        </div>
                    </section>
                ))}

                <p className="route-skeleton__note">
                    {t('route.gen.planning.note')}
                    <button type="button" className="ctl ctl--link route-skeleton__link" onClick={onOpenDiff}>
                        {t('route.readFullDiff')}
                    </button>
                </p>
            </div>
        </main>
    );
}

/** Вкладка «Маршрут» в фазе `failed`: красная карточка вместо остановок. */
export function RouteFailedView({
    failure,
    retrying = false,
    actionError = null,
    initialRawShown = false,
    onRetry,
    onOpenDiff,
}: {
    failure: UiRouteFailure;
    retrying?: boolean;
    actionError?: string | null;
    /** Сырой вывод раскрыт сразу — только для галереи состояний. */
    initialRawShown?: boolean;
    onRetry: () => void;
    onOpenDiff: () => void;
}) {
    return (
        <main className="route-empty" id="view-route">
            <div className="gen-failed-wrap">
                <RouteFailedCard
                    failure={failure}
                    retrying={retrying}
                    actionError={actionError}
                    initialRawShown={initialRawShown}
                    onRetry={onRetry}
                    onOpenDiff={onOpenDiff}
                />
            </div>
        </main>
    );
}

const PLACEHOLDERS = ['a', 'b', 'c'] as const;

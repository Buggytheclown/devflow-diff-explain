import type { RouteStop } from '@sherpa/protocol';
import { useMemo } from 'react';

import { createDiffViewStore } from '../diff-view/store.js';
import { buildFileFilters } from '../filters/lens-filters.js';
import { useT } from '../i18n/index.js';
import type { RouteStopView } from '../route/route-model.js';
import { CoverageStrip } from '../views/route/coverage-strip.tsx';
import { RouteToolbar } from '../views/route/route-toolbar.tsx';
import { CollapsedStop, StopCard, StopSkeleton } from '../views/route/stop-card.tsx';
import './tour.css';

/**
 * Каркас тура на вкладке «Маршрут», пока маршрута ещё нет:
 * тур стартует сразу при первом открытии UI, и недостающие цели шагов подставляет заглушка —
 * иначе первый заход проходил бы по пустому экрану.
 *
 * Каркас инертен по построению: он не попадает ни в `buildRouteModel`, ни в `entries`, у него
 * нет `data-stop`, его не видят `j/k/n/p` и палитра, а все обработчики — пустые. Клики он
 * гасит собой; `aria-hidden` не ставится — кольцо тура ссылается на заглушку `aria-describedby`.
 *
 * Исчезает, когда тур закончился или когда приехал настоящий маршрут.
 */
/** Слой каркаса: цель шага ищется сперва в нём — см. `anchorOf` в `tour-layer.tsx`. */
export const TOUR_SCAFFOLD_SELECTOR = '.tour-scaffold';

export function TourScaffold() {
    const t = useT();
    const store = useMemo(() => createDiffViewStore({ files: [], progress: [] }), []);
    const filters = useMemo(() => buildFileFilters({ files: [], ownership: null, extra: [], t }), [t]);
    const filter = filters[0];
    const view = useMemo<RouteStopView>(() => stubStopView(t('tour.stub.title'), t('tour.stub.body')), [t]);

    if (filter === undefined) {
        return null;
    }

    return (
        <div className="route tour-scaffold">
            <RouteToolbar
                store={store}
                preset="triage"
                onPreset={NOOP}
                presetDisabled
                filters={filters}
                filter={filter}
                onFilter={NOOP}
                strip={<CoverageStrip model={null} loading={{ kind: 'plan', ready: 0, total: 0 }} />}
            />

            <div className="route__stops">
                <StopCard
                    view={view}
                    tourAnchors
                    stopCount={1}
                    comments={0}
                    viewed={false}
                    onViewed={NOOP}
                    chips={null}
                    diff={<StopSkeleton />}
                />
                <CollapsedStop label={t('tour.stub.fold')} dataTour="fold-stub" onExpand={NOOP} />
            </div>
        </div>
    );
}

const NOOP = (): void => undefined;

/**
 * Плейсхолдерная остановка: `queued` — про неё честно нечего рассказать, кроме того, что
 * здесь встанет первая остановка маршрута. Ни якорей, ни файлов, ни чисел покрытия у неё нет.
 */
function stubStopView(title: string, paragraph: string): RouteStopView {
    const stop: RouteStop = {
        id: 'tour-stub',
        planIndex: 1,
        tier: 'medium',
        title,
        status: 'queued',
        paragraph,
        bridge: null,
        anchors: [],
        tests: [],
        droppedClaims: 0,
        validationNotes: [],
        provenance: null,
        change: null,
    };
    return {
        stop,
        planLabel: '01',
        files: [],
        changedLines: 0,
        unresolvedPaths: [],
        conflictPaths: [],
        drift: false,
        empty: true,
        pending: false,
        parseFailed: false,
    };
}

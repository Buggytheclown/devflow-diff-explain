import { TourLayer } from './tour-layer.tsx';
import type { TourRunOptions } from './tour-store.js';
import { useTourRun } from './tour-store.js';

/**
 * Хост тура: монтируется, пока тур идёт, и держит проход (на каком шаге стоим). Монтирование
 * и есть старт прохода — стартовый шаг читается из настроек в инициализаторе состояния.
 *
 * Отделён от `TourLayer` (кольцо, карточка, замер), чтобы слой оставался чистым от персиста
 * и рисовался в галерее состояний по пропсам.
 */
export interface TourHostProps extends TourRunOptions {
    /** См. `TourLayerProps.epoch`. */
    readonly epoch: string;
}

export function TourHost({ epoch, ...options }: TourHostProps) {
    const run = useTourRun(options);
    return (
        <TourLayer
            step={run.step}
            index={run.index}
            total={run.steps.length}
            epoch={epoch}
            onNext={run.next}
            onBack={run.back}
            onSkip={run.skip}
        />
    );
}

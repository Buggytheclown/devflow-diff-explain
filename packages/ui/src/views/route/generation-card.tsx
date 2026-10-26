import type { RouteSnapshot, UiRouteFailure, UiRouteState } from '@sherpa/protocol';
import { useState } from 'react';

import type { MessageKey } from '../../i18n/index.js';
import { useT } from '../../i18n/index.js';
import { Icon } from '../../icons/icon.tsx';
import { Markdown } from '../../markdown/markdown.tsx';
import type { GenerationSlot } from '../../route/generation.js';
import { generationCardKind, generationProgress } from '../../route/generation.js';
import type { OtherStopFacts } from '../../route/other-stop.js';
import { otherStopPending, UNKNOWN_OTHER } from '../../route/other-stop.js';
import './generation.css';

/**
 * Генеративные состояния маршрута в правом рельсе Overview (docs/design/README.md §6–7) и красная карточка
 * провала (docs/design/README.md §12, docs/design/SPEC-elements.md §2.21).
 *
 * Компоненты ничего не грузят: фаза, снапшот и флаги приезжают пропсами, поэтому те же карточки
 * рисуются в галерее состояний. Все числа — из `snapshot.stops[].status`.
 */

export interface GenerationCardProps {
    readonly route: UiRouteState;
    /**
     * Что известно о «Прочем» готового снапшота. Пока непокрытое не посчитано, «Прочего» нет
     * в плане, а число остановок не называется.
     */
    readonly other?: OtherStopFacts;
    /** Файлов в диффе — строка прогресса фазы A; `null`, пока дифф не приехал. */
    readonly diffFiles?: number | null;
    /** Генерация идёт дольше минуты: строка «всё ещё работаю» с отменой (docs/design/SPEC-elements.md §3). */
    readonly longRunning?: boolean;
    readonly cancelling?: boolean;
    readonly retrying?: boolean;
    /** Провал самой ручки (сеть, сервер) — отдельно от провала генерации. */
    readonly actionError?: string | null;
    readonly onOpenRoute: () => void;
    readonly onOpenDiff: () => void;
    readonly onRetry: () => void;
    readonly onCancel: () => void;
}

/**
 * План-лист карточки генерации: номер, заголовок и состояние каждой остановки. Один кусок
 * на обе фазы — заполнение и готовый маршрут показывают один и тот же список (docs/design/README.md §7).
 */
function GenerationPlan({ slots }: { slots: readonly GenerationSlot[] }) {
    const t = useT();
    return (
        <ul className="gen-plan">
            {slots.map((slot) => (
                <li key={slot.id} className={`gen-plan__item gen-plan__item--${slot.status}`}>
                    <span className="gen-plan__number">{slot.planLabel}</span>
                    <span className="gen-plan__title">
                        <Markdown text={slot.title} profile="route" />
                    </span>
                    <span className="gen-plan__state">
                        {slot.status === 'ready' ? <Icon name="check" size={13} /> : null}
                        {t(PLAN_STATE[slot.status])}
                    </span>
                </li>
            ))}
        </ul>
    );
}

/** `null` — в этой фазе карточке генерации нечего сказать (маршрут не запускали). */
export function GenerationCard({
    route,
    other = UNKNOWN_OTHER,
    diffFiles = null,
    longRunning = false,
    cancelling = false,
    retrying = false,
    actionError = null,
    onOpenRoute,
    onOpenDiff,
    onRetry,
    onCancel,
}: GenerationCardProps) {
    const t = useT();
    const kind = generationCardKind(route);
    if (kind === 'failed' && route.failure !== null) {
        return (
            <RouteFailedCard
                failure={route.failure}
                rebuilding={route.snapshot !== null}
                retrying={retrying}
                actionError={actionError}
                onRetry={onRetry}
                onOpenDiff={onOpenDiff}
                compact
            />
        );
    }

    const snapshot = route.snapshot;
    if (kind === 'ready' && snapshot !== null) {
        const { slots } = generationProgress(snapshot, other);
        return (
            <section className="gen-card" aria-label={t('route.gen.aria')}>
                <div className="gen-card__head">
                    <h2 className="gen-card__title">
                        {otherStopPending(snapshot, other)
                            ? t('route.gen.readyCounting')
                            : t('route.gen.ready', slots.length)}
                    </h2>
                </div>

                <GenerationPlan slots={slots} />

                <button type="button" className="ctl ctl--primary gen-card__cta" onClick={onOpenRoute}>
                    {t('route.gen.open')}
                </button>
            </section>
        );
    }

    if (kind === 'filling' && snapshot !== null) {
        const progress = generationProgress(snapshot);
        const rest = progress.total - progress.ready;
        return (
            <section className="gen-card" aria-label={t('route.gen.aria')}>
                <div className="gen-card__head">
                    <h2 className="gen-card__title">{t('route.gen.filling.title')}</h2>
                    <span className="gen-card__counter">
                        {t('route.gen.filling.counter', progress.ready, progress.total)}
                    </span>
                </div>

                <div className="gen-bar" aria-hidden="true">
                    {progress.slots.map((slot) => (
                        <span key={slot.id} className={`gen-bar__segment gen-bar__segment--${slot.status}`} />
                    ))}
                </div>

                <p className="gen-card__note">{t('route.gen.filling.note')}</p>

                <GenerationPlan slots={progress.slots} />

                {longRunning ? (
                    <StillWorking
                        counter={t('route.gen.counter', progress.ready, progress.total)}
                        cancelling={cancelling}
                        onCancel={onCancel}
                    />
                ) : null}

                <button type="button" className="ctl ctl--primary gen-card__cta" onClick={onOpenRoute}>
                    {t('route.gen.open')}
                </button>
                <p className="gen-card__hint">{t('route.gen.filling.hint', progress.ready, rest)}</p>
                {actionError === null ? null : (
                    <p className="gen-card__error" role="status">
                        {actionError}
                    </p>
                )}
            </section>
        );
    }

    if (kind !== 'reading') {
        return null;
    }

    return (
        <section className="gen-card" aria-label={t('route.gen.aria')}>
            <div className="gen-card__head">
                <span className="gen-card__spinner" aria-hidden="true" />
                <h2 className="gen-card__title">
                    {snapshot === null ? t('route.gen.reading.title') : t('route.gen.rebuild.title')}
                </h2>
                <span className="gen-card__counter">{t('route.gen.eta')}</span>
            </div>

            <ol className="gen-steps">
                <li className="gen-steps__item is-active">
                    {diffFiles === null ? t('route.gen.step.diff') : t('route.gen.step.diffFiles', diffFiles)}
                </li>
                <li className="gen-steps__item">{t('route.gen.step.plan')}</li>
                <li className="gen-steps__item">{t('route.gen.step.fill')}</li>
            </ol>

            <p className="gen-card__note">
                {snapshot === null ? t('route.gen.reading.note') : t('route.gen.rebuild.note')}
            </p>

            {longRunning ? <StillWorking counter={null} cancelling={cancelling} onCancel={onCancel} /> : null}

            <button type="button" className="ctl ctl--primary gen-card__cta" onClick={onOpenRoute}>
                {snapshot === null ? t('route.gen.open.skeleton') : t('route.gen.open.previous')}
            </button>
            <p className="gen-card__hint">
                {snapshot === null ? t('route.gen.reading.hint') : t('route.gen.rebuild.hint')}
            </p>
            {actionError === null ? null : (
                <p className="gen-card__error" role="status">
                    {actionError}
                </p>
            )}
        </section>
    );
}

/** Задача идёт дольше минуты (docs/design/SPEC-elements.md §3): честная строка и отмена. */
function StillWorking({
    counter,
    cancelling,
    onCancel,
}: {
    counter: string | null;
    cancelling: boolean;
    onCancel: () => void;
}) {
    const t = useT();
    return (
        <p className="gen-card__still" role="status">
            {t('route.gen.still')}
            {counter === null ? '' : ` · ${counter}`}
            <button type="button" className="ctl ctl--link gen-card__cancel" disabled={cancelling} onClick={onCancel}>
                {cancelling ? t('route.gen.cancelling') : t('route.gen.cancel')}
            </button>
        </p>
    );
}

export interface RouteFailedCardProps {
    readonly failure: UiRouteFailure;
    readonly rebuilding?: boolean;
    readonly retrying?: boolean;
    readonly actionError?: string | null;
    readonly onRetry: () => void;
    readonly onOpenDiff: () => void;
    /** Вариант для рельса Overview: без сырого вывода и футера — они живут на вкладке маршрута. */
    readonly compact?: boolean;
    /** Сырой вывод раскрыт с самого начала: детерминированный кадр галереи состояний. */
    readonly initialRawShown?: boolean;
}

/**
 * Generation failed (docs/design/README.md §12): причина одним предложением, повтор и сырой вывод модели.
 *
 * Подсказка дизайна «поправь якоря и перевалидируй без модели» не переносится: перевалидация
 * правленого вывода не реализована, а `rawOutput` — вывод скелета, якорей в нём нет по схеме.
 */
export function RouteFailedCard({
    failure,
    rebuilding = false,
    retrying = false,
    actionError = null,
    onRetry,
    onOpenDiff,
    compact = false,
    initialRawShown = false,
}: RouteFailedCardProps) {
    const t = useT();
    const [rawShown, setRawShown] = useState(initialRawShown);
    const raw = failure.rawOutput;

    return (
        <section
            className={`gen-failed${compact ? ' gen-failed--compact' : ''}`}
            role="region"
            aria-label={rebuilding ? t('route.failed.title.rebuild') : t('route.failed.title')}
        >
            <h2 className="gen-failed__title">
                {rebuilding ? t('route.failed.title.rebuild') : t('route.failed.title')}
            </h2>
            <p className="gen-failed__reason">{failure.message}</p>

            <div className="gen-failed__actions">
                <RetryButton retrying={retrying} onRetry={onRetry} />
                {compact || raw === null ? null : (
                    <button
                        type="button"
                        className="ctl ctl--ghost gen-failed__secondary"
                        aria-expanded={rawShown}
                        onClick={() => {
                            setRawShown(!rawShown);
                        }}
                    >
                        {rawShown ? t('route.failed.hideRaw') : t('route.failed.showRaw')}
                    </button>
                )}
            </div>

            {actionError === null ? null : (
                <p className="gen-failed__error" role="status">
                    {actionError}
                </p>
            )}

            {rawShown && raw !== null ? <pre className="gen-failed__raw">{raw}</pre> : null}

            {compact ? null : (
                <p className="gen-failed__footer">
                    {t('route.failed.footer')}
                    <button type="button" className="ctl ctl--link gen-failed__link" onClick={onOpenDiff}>
                        {t('route.readFullDiff')}
                    </button>
                </p>
            )}
        </section>
    );
}

/**
 * Баннер частично заполненного маршрута (docs/design/README.md §8). Condition-баннер: держится, пока
 * маршрут достраивается; числа — из статусов слотов снапшота.
 */
export function RouteFillingBanner({
    snapshot,
    onReadDiff,
}: {
    snapshot: RouteSnapshot;
    onReadDiff: () => void;
}) {
    const t = useT();
    const progress = generationProgress(snapshot);
    return (
        <div className="gen-filling" role="status">
            <span className="gen-filling__dot" aria-hidden="true" />
            <span className="gen-filling__text">{t('route.filling.banner', progress.ready, progress.total)}</span>
            <button type="button" className="ctl ctl--link gen-filling__link" onClick={onReadDiff}>
                {t('route.filling.readDiff')}
            </button>
        </div>
    );
}

/** Перестройка поверх готового маршрута: старый остаётся рабочим до принятого нового плана. */
export function RouteRegeneratingBanner({
    cancelling = false,
    onCancel,
}: {
    cancelling?: boolean;
    onCancel: () => void;
}) {
    const t = useT();
    return (
        <div className="gen-filling" role="status">
            <span className="gen-filling__dot" aria-hidden="true" />
            <span className="gen-filling__text">{t('route.regenerating.text')}</span>
            <button type="button" className="ctl ctl--link gen-filling__link" disabled={cancelling} onClick={onCancel}>
                {cancelling ? t('route.gen.cancelling') : t('route.gen.cancel')}
            </button>
        </div>
    );
}

/** Баннер провала генерации: верхняя ступень лестницы приоритетов слота (docs/design/SPEC-elements.md §2.21). */
export function GenerationFailedBanner({
    message,
    rebuilding = false,
    retrying = false,
    onRetry,
}: {
    message: string;
    rebuilding?: boolean;
    retrying?: boolean;
    onRetry: () => void;
}) {
    const t = useT();
    return (
        <div className="gen-banner" role="region" aria-label={t('route.failed.banner.aria')}>
            <span className="gen-banner__dot" aria-hidden="true" />
            <div className="gen-banner__body">
                <div className="gen-banner__title">
                    {rebuilding ? t('route.failed.banner.title.rebuild') : t('route.failed.banner.title')}
                </div>
                <div className="gen-banner__text">{message}</div>
            </div>
            <RetryButton retrying={retrying} onRetry={onRetry} />
        </div>
    );
}

/**
 * Ручка генерации не отработала: сеть, отсутствие хост-адаптера, порог малого PR.
 *
 * Обычно причина стоит рядом с кнопкой, которая её вызвала, — в красной карточке маршрута или
 * в карточке генерации Overview. Но «Построить маршрут» вызывается и из палитры, с любой вкладки
 * и в фазе, где ни той, ни другой карточки на экране нет; без слота такой запрос проваливался бы
 * молча.
 */
export function RouteActionErrorBanner({ message }: { message: string }) {
    const t = useT();
    return (
        <div className="gen-banner gen-banner--plain" role="status" aria-label={t('route.actionFailed.aria')}>
            <span className="gen-banner__dot" aria-hidden="true" />
            <div className="gen-banner__body">
                <div className="gen-banner__title">{t('route.actionFailed.title')}</div>
                <div className="gen-banner__text">{message}</div>
            </div>
        </div>
    );
}

/** Кнопка повтора в состоянии загрузки: глиф крутится на месте, ширина не прыгает (docs/design/SPEC-elements.md §1.1). */
function RetryButton({ retrying, onRetry }: { retrying: boolean; onRetry: () => void }) {
    const t = useT();
    return (
        <button type="button" className="ctl ctl--secondary gen-retry" disabled={retrying} onClick={onRetry}>
            <span className={`gen-retry__glyph${retrying ? ' is-spinning' : ''}`} aria-hidden="true" />
            {t('route.gen.retry')}
        </button>
    );
}

const PLAN_STATE: Readonly<Record<'queued' | 'filling' | 'ready' | 'failed', MessageKey>> = {
    ready: 'route.gen.plan.ready',
    filling: 'route.gen.plan.filling',
    queued: 'route.gen.plan.queued',
    failed: 'route.gen.plan.failed',
};

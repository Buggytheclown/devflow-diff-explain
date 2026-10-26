import type { HostId, RouteCarried, RouteSnapshot, RouteStop, UiRouteStale, UiRouteState } from '@sherpa/protocol';

import type { Translate } from '../../i18n/index.js';
import { relativeTime, shortCommit, useLocale, useT } from '../../i18n/index.js';
import { Icon } from '../../icons/icon.tsx';
import type { ViewingLabel } from '../../iterations/viewing.js';
import { planLabel } from '../../route/route-model.js';
import type { ViewId } from '../../session/views.js';
import './iteration-banners.css';

/**
 * Баннеры итераций (docs/design/README.md §9): «маршрут устарел» и «маршрут перестроен». Оба рисуются через
 * общий слот баннеров — собственное условие активности и приоритет держит реестр источников
 * в App, компоненты только показывают то, что им дали.
 *
 * Stale описывает условие и живёт, пока условие держится (docs/design/SPEC-elements.md §2.21), поэтому крестика у него
 * нет. Баннер второго захода описывает фильтр — его закрывают.
 */

/** «02, 03 и 07» — перечисление номеров остановок в тексте баннера. */
function enumerate(items: readonly string[], t: Translate): string {
    if (items.length <= 1) {
        return items.join('');
    }
    return t('iteration.stops.enumerate', items.slice(0, -1).join(', '), items[items.length - 1] ?? '');
}

/**
 * Устаревший маршрут — новость про весь PR, поэтому баннер виден на любой вкладке: «Перестроить
 * маршрут» запускается откуда угодно. Кроме фаз перестройки: там генерация уже идёт, кнопка
 * заблокирована гардом, а на вкладке маршрута место занимают баннеры перестройки и заполнения.
 */
export function staleBannerVisible(
    phase: UiRouteState['phase'] | null,
    stale: UiRouteStale | null,
    snapshot: RouteSnapshot | null,
    /** Вкладка смотрит прошлый снапшот или итерацию: stale — новость про текущий маршрут. */
    readingOld = false,
): boolean {
    return !readingOld && stale !== null && snapshot !== null && phase !== 'reading' && phase !== 'filling';
}

/**
 * Баннер второго захода виден на готовом снапшоте, у которого есть предыдущий, — пока его не
 * закрыли именно для этого снапшота. Устаревший маршрут его гасит: пока PR ушёл вперёд, новость
 * про перенесённый прогресс уже не главная. Только на вкладке маршрута: его действие — фильтр
 * маршрута, на других вкладках нажимать кнопку не на что.
 */
export function secondPassBannerVisible(
    view: ViewId,
    snapshot: RouteSnapshot | null,
    stale: UiRouteStale | null,
    dismissedSnapshotId: string | null,
    /** Вкладка смотрит прошлый снапшот или итерацию: второй заход — новость про текущий маршрут. */
    readingOld = false,
): boolean {
    return (
        !readingOld &&
        view === 'route' &&
        snapshot !== null &&
        snapshot.previousSnapshotId !== null &&
        stale === null &&
        dismissedSnapshotId !== snapshot.snapshotId
    );
}

/**
 * Ключ дизмисса баннера потерянных заметок: набор потерявших якорь. Новая потерянная заметка —
 * новая новость, и закрытый баннер возвращается; закрытие переживает исчезновение одной из них.
 */
export function notesLostKey(noteIds: readonly number[]): string {
    return [...noteIds].sort((left, right) => left - right).join(',');
}

/**
 * Заметки, потерявшие якорь, — новость про весь PR: баннер виден на любой вкладке, как stale.
 * В режиме чтения прошлой итерации его нет: там заметка по-прежнему стоит у своего кода.
 * В фазах перестройки маршрута тоже — место занято новостями крупнее.
 */
export function notesLostBannerVisible(
    phase: UiRouteState['phase'] | null,
    lostNoteIds: readonly number[],
    dismissedKey: string | null,
    /** Вкладка смотрит прошлый снапшот или итерацию. */
    readingOld = false,
): boolean {
    return (
        !readingOld &&
        lostNoteIds.length > 0 &&
        phase !== 'reading' &&
        phase !== 'filling' &&
        dismissedKey !== notesLostKey(lostNoteIds)
    );
}

export interface NotesLostBannerProps {
    readonly count: number;
    /** Открыть чат на первой потерявшей якорь заметке. */
    readonly onShow: () => void;
    readonly onDismiss: () => void;
}

/**
 * «2 заметки потеряли якорь после нового пуша · показать» (docs/design/SPEC-elements.md §2.16). Баннер-фильтр:
 * у него есть крестик — новость разовая, и ревьюер вправе её закрыть (docs/design/SPEC-elements.md §2.21).
 */
export function NotesLostBanner({ count, onShow, onDismiss }: NotesLostBannerProps) {
    const t = useT();
    return (
        <div className="iteration-banner" role="status" aria-label={t('iteration.notesLost.aria')}>
            <div className="iteration-banner__body">
                <div className="iteration-banner__line">{t('iteration.notesLost.text', count)}</div>
            </div>
            <button type="button" className="ctl ctl--attention iteration-banner__action" onClick={onShow}>
                {t('iteration.notesLost.show')}
            </button>
            <button
                type="button"
                className="ctl ctl--toolbar-icon iteration-banner__dismiss"
                aria-label={t('iteration.notesLost.dismiss')}
                onClick={onDismiss}
            >
                <Icon name="cross" size={14} />
            </button>
        </div>
    );
}

export interface RouteStaleBannerProps {
    readonly stale: UiRouteStale;
    /** Стопы текущего снапшота: из них берутся план-номера затронутых остановок. */
    readonly stops: readonly RouteStop[];
    /** Локальное ревью: PR здесь нет, вперёд ушло само рабочее дерево. */
    readonly localHost?: boolean;
    /** Та же перегенерация, что у остальных кнопок маршрута. */
    readonly onRegenerate: () => void;
    /** Переключение на активную итерацию без маршрута; без него кнопки нет. */
    readonly onOpenDiffWithoutRoute?: (diffId: HostId) => void;
}

export function RouteStaleBanner({
    stale,
    stops,
    localHost = false,
    onRegenerate,
    onOpenDiffWithoutRoute,
}: RouteStaleBannerProps) {
    const t = useT();
    const byId = new Map(stops.map((stop) => [stop.id, stop]));
    const affected = stale.affectedStopIds
        .map((stopId) => byId.get(stopId))
        .filter((stop) => stop !== undefined)
        .map((stop) => planLabel(stop.planIndex));
    const prCommit = shortCommit(stale.prCommit);

    return (
        <div className="iteration-banner" role="status" aria-label={t('iteration.stale.aria')}>
            <div className="iteration-banner__body">
                <div className="iteration-banner__line">
                    {t('iteration.stale.builtFor')}
                    <code className="iteration-banner__commit" title={stale.routeCommit}>
                        {shortCommit(stale.routeCommit)}
                    </code>
                    {t(localHost ? 'iteration.stale.treeAt' : 'iteration.stale.prAt')}
                    <code className="iteration-banner__commit" title={stale.prCommit}>
                        {prCommit}
                    </code>
                    {t('iteration.stale.newIterations', stale.newIterations)}
                    {affected.length === 0 ? '' : t('iteration.stale.affected', enumerate(affected, t))}
                </div>
            </div>
            <button type="button" className="ctl ctl--secondary iteration-banner__action" onClick={onRegenerate}>
                {t('iteration.stale.regenerate')}
            </button>
            {onOpenDiffWithoutRoute === undefined ? null : (
                <button
                    type="button"
                    className="ctl ctl--ghost ctl--topbar iteration-banner__secondary"
                    onClick={() => {
                        onOpenDiffWithoutRoute(stale.prDiffId);
                    }}
                >
                    {t('iteration.stale.openDiff', prCommit)}
                </button>
            )}
        </div>
    );
}

export interface ReadOnlyIterationBannerProps {
    readonly label: ViewingLabel;
    /** Момент снапшота; null — у итерации без маршрута его нет. */
    readonly createdAt: string | null;
    /** Момент отсчёта относительного времени; инжектируется ради детерминированной галереи. */
    readonly now: number;
    readonly gone: boolean;
    /** Локальное ревью: итерация исчезает не из PR, а из истории рабочего дерева. */
    readonly localHost?: boolean;
    readonly onCurrent: () => void;
}

/**
 * Режим чтения прошлой итерации: условие, а не новость, — крестика нет (docs/design/SPEC-elements.md §2.21).
 * Дата печатается тем же относительным временем, что и остальные моменты в UI.
 */
export function ReadOnlyIterationBanner({
    label,
    createdAt,
    now,
    gone,
    localHost = false,
    onCurrent,
}: ReadOnlyIterationBannerProps) {
    const t = useT();
    const locale = useLocale();
    if (label.kind === 'slice') {
        return (
            <div className="iteration-banner" role="status" aria-label={t('iteration.readOnly.aria')}>
                <div className="iteration-banner__body">
                    <div className="iteration-banner__line">
                        {t('iteration.slice.lead')}
                        <code className="iteration-banner__commit" title={label.baseCommit}>
                            {shortCommit(label.baseCommit)}
                        </code>{' '}
                        →{' '}
                        <code className="iteration-banner__commit" title={label.commit}>
                            {shortCommit(label.commit)}
                        </code>
                        {t('iteration.readOnly.tail')}
                    </div>
                </div>
                <button type="button" className="ctl ctl--attention iteration-banner__action" onClick={onCurrent}>
                    {t('iteration.toActive')}
                </button>
            </div>
        );
    }
    return (
        <div className="iteration-banner" role="status" aria-label={t('iteration.readOnly.aria')}>
            <div className="iteration-banner__body">
                <div className="iteration-banner__line">
                    {label.kind === 'snapshot' ? t('iteration.snapshot.lead') : t('iteration.previous.lead')}
                    <code className="iteration-banner__commit" title={label.commit}>
                        {shortCommit(label.commit)}
                    </code>
                    {/* Время — отдельным сегментом через «·»: форматтер отдаёт и «вчера», с предлогом не согласуется. */}
                    {createdAt === null ? '' : ` · ${relativeTime(createdAt, now, locale)}`}
                    {t('iteration.readOnly.tail')}
                    {gone ? t(localHost ? 'iteration.goneLocal.tail' : 'iteration.gone.tail') : ''}
                </div>
            </div>
            <button type="button" className="ctl ctl--attention iteration-banner__action" onClick={onCurrent}>
                {t('iteration.toCurrent')}
            </button>
        </div>
    );
}

/**
 * Предложение о переносе отметок просмотра. Числа `carried` — только про перенос: сколько
 * остановок из тех, куда перенос вообще возможен, остались просмотренными. Нулевой перенос
 * объясняется причиной с сервера; у старых снапшотов её нет — тогда говорим только число.
 */
function carriedNote(carried: RouteCarried, t: Translate): string {
    if (carried.kept > 0) {
        return t('iteration.secondPass.carried.kept', carried.kept, carried.total);
    }
    switch (carried.zeroReason) {
        case 'no_marks':
            return t('iteration.secondPass.carried.noMarks');
        case 'no_overlap':
            return t('iteration.secondPass.carried.noOverlap');
        case 'no_interdiff':
            return t('iteration.secondPass.carried.noInterdiff');
        case null:
            return t('iteration.secondPass.carried.none', carried.total);
    }
}

export interface RouteSecondPassBannerProps {
    readonly commit: string;
    /** Итог переноса отметок просмотра; null — переносить было не от чего, предложение опускается. */
    readonly carried: RouteCarried | null;
    /** Сколько остановок классифицированы как изменившиеся: без них фильтр включать не на что. */
    readonly changedStops: number;
    readonly onShowNew: () => void;
    readonly onDismiss: () => void;
}

export function RouteSecondPassBanner({
    commit,
    carried,
    changedStops,
    onShowNew,
    onDismiss,
}: RouteSecondPassBannerProps) {
    const t = useT();
    const hasChanges = changedStops > 0;
    return (
        <div className="iteration-banner" role="status" aria-label={t('iteration.secondPass.aria')}>
            <div className="iteration-banner__body">
                <div className="iteration-banner__line">
                    {t('iteration.secondPass.lead')}
                    <code className="iteration-banner__commit" title={commit}>
                        {shortCommit(commit)}
                    </code>
                    .
                </div>
                <div className="iteration-banner__note">
                    {carried === null ? '' : carriedNote(carried, t)}
                    {hasChanges
                        ? t('iteration.secondPass.changed', changedStops)
                        : t('iteration.secondPass.noChanges')}
                </div>
            </div>
            {hasChanges ? (
                <button type="button" className="ctl ctl--attention iteration-banner__action" onClick={onShowNew}>
                    {t('iteration.secondPass.showNew')}
                </button>
            ) : null}
            <button
                type="button"
                className="ctl ctl--toolbar-icon iteration-banner__dismiss"
                aria-label={t('iteration.secondPass.dismiss')}
                onClick={onDismiss}
            >
                <Icon name="cross" size={14} />
            </button>
        </div>
    );
}

import type { Locale, UiRouteState } from '@sherpa/protocol';

import { useLocale, useT } from '../i18n/index.js';
import { localeOnKey, snapshotLocale } from '../route/generation.js';
import './route-locale-banner.css';

/**
 * «Маршрут построен на английском — перестроить на русском?»
 *
 * Автоперестройки нет: маршрут стоит минуты работы агента, и менять его молча из-за переключателя
 * языка нельзя. Баннер низкого приоритета — новость фоновая, старый маршрут читается как есть.
 * «Оставить» живёт в памяти вкладки и привязано к id снапшота: новый маршрут на чужом языке
 * спросит заново.
 */

/**
 * Условие показа. Готовый или дозаполняемый снапшот, чей язык не совпадает с языком вкладки,
 * пока не идёт генерация и ревьюер не сказал «оставить» про этот же снапшот.
 *
 * На просмотре прошлой итерации плашки нет: «Перестроить» — глобальная ручка, она строит маршрут
 * текущей итерации, а не того снапшота, про язык которого спрашивает плашка.
 */
export function routeLocaleBannerVisible({
    route,
    uiLocale,
    generating,
    keptSnapshotId,
    readOnly,
}: {
    readonly route: UiRouteState | null;
    readonly uiLocale: Locale;
    readonly generating: boolean;
    /** Снапшот, про который уже нажали «Оставить»; null — не нажимали. */
    readonly keptSnapshotId: string | null;
    /** Вкладка смотрит прошлую итерацию. */
    readonly readOnly: boolean;
}): boolean {
    const snapshot = route?.snapshot ?? null;
    if (snapshot === null || generating || readOnly) {
        return false;
    }
    if (route?.phase !== 'ready' && route?.phase !== 'filling') {
        return false;
    }
    return snapshotLocale(snapshot.provenance) !== uiLocale && keptSnapshotId !== snapshot.snapshotId;
}

export interface RouteLocaleBannerProps {
    /** Язык, на котором построен маршрут. */
    readonly routeLocale: Locale;
    /** Перестройка недоступна (идёт генерация, малый PR, нет хоста) — кнопка гаснет с причиной. */
    readonly rebuildDisabledReason?: string;
    readonly onRebuild: () => void;
    readonly onKeep: () => void;
}

export function RouteLocaleBanner({
    routeLocale,
    rebuildDisabledReason,
    onRebuild,
    onKeep,
}: RouteLocaleBannerProps) {
    const t = useT();
    const uiLocale = useLocale();
    const disabled = rebuildDisabledReason !== undefined;
    return (
        <div className="route-locale-banner" role="status" aria-label={t('route.locale.banner.aria')}>
            <span className="route-locale-banner__text">
                {t('route.locale.banner.title', t(localeOnKey(routeLocale)), t(localeOnKey(uiLocale)))}
            </span>
            <button
                type="button"
                className="ctl ctl--attention route-locale-banner__action"
                disabled={disabled}
                {...(disabled ? { title: rebuildDisabledReason } : {})}
                onClick={onRebuild}
            >
                {t('route.locale.rebuild', t(localeOnKey(uiLocale)))}
            </button>
            <button type="button" className="ctl ctl--ghost ctl--topbar route-locale-banner__secondary" onClick={onKeep}>
                {t('route.locale.keep')}
            </button>
        </div>
    );
}

import { routeFixtures } from '@sherpa/fixtures';
import type { Locale, RouteSnapshot } from '@sherpa/protocol';
import type { ReactNode } from 'react';

import { RouteLocaleBanner } from '../../components/route-locale-banner.tsx';
import { LocaleProvider, useLocale, useT } from '../../i18n/index.js';
import { provenanceLine, snapshotLocale } from '../../route/generation.js';

/**
 * Язык генерации: индикатор провенанса с языком маршрута и плашка «перестроить».
 * Данные — фикстура `medium` с подменённым `provenance.locale`; сервера в галерее нет.
 */

function snapshotWith(locale: Locale | null): RouteSnapshot {
    const ready = routeFixtures('medium')?.states.ready?.snapshot;
    if (ready === undefined || ready === null) {
        throw new Error('фикстуре medium нужен готовый снапшот маршрута');
    }
    return { ...ready, provenance: { ...ready.provenance, locale } };
}

/** Индикатор провенанса и плашка рядом: ровно то, что ревьюер видит на Обзоре. */
function LocaleState({
    snapshot,
    rebuildDisabledReason,
}: {
    readonly snapshot: RouteSnapshot;
    readonly rebuildDisabledReason?: string;
}) {
    const t = useT();
    const uiLocale = useLocale();
    return (
        <div className="route-locale-stack">
            <p className="summary-card__provenance">{provenanceLine(snapshot, t, uiLocale)}</p>
            <RouteLocaleBanner
                routeLocale={snapshotLocale(snapshot.provenance)}
                {...(rebuildDisabledReason === undefined ? {} : { rebuildDisabledReason })}
                onRebuild={() => undefined}
                onKeep={() => undefined}
            />
        </div>
    );
}

function Localized({ locale, children }: { readonly locale: Locale; readonly children: ReactNode }) {
    return <LocaleProvider locale={locale}>{children}</LocaleProvider>;
}

export const ROUTE_LOCALE_STATES: readonly { readonly id: string; readonly title: string; readonly render: () => ReactNode }[] =
    [
        {
            id: 'route-locale-en-route-ru-ui',
            title: 'английский маршрут на русской вкладке',
            render: () => (
                <Localized locale="ru">
                    <LocaleState snapshot={snapshotWith('en')} />
                </Localized>
            ),
        },
        {
            id: 'route-locale-rebuild-unavailable',
            title: 'перестроить недоступно',
            render: () => (
                <Localized locale="ru">
                    <LocaleState
                        snapshot={snapshotWith('en')}
                        rebuildDisabledReason="Пока маршрут заполняется, перестроить его нельзя."
                    />
                </Localized>
            ),
        },
        {
            id: 'route-locale-legacy-snapshot-en-ui',
            title: 'снапшот без языка на английской вкладке',
            render: () => (
                <Localized locale="en">
                    <LocaleState snapshot={snapshotWith(null)} />
                </Localized>
            ),
        },
    ];

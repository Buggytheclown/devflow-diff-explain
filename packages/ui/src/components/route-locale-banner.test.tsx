import { routeFixtures } from '@sherpa/fixtures';
import type { RouteSnapshot, UiRouteState } from '@sherpa/protocol';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { LocaleProvider } from '../i18n/index.js';
import { RouteLocaleBanner, routeLocaleBannerVisible } from './route-locale-banner.tsx';

/** Язык маршрута: условия показа плашки и её кнопки. */

function snapshot(): RouteSnapshot {
    const ready = routeFixtures('medium')?.states.ready?.snapshot;
    if (ready === undefined || ready === null) {
        throw new Error('фикстуре medium нужен готовый снапшот');
    }
    return ready;
}

function routeWith(overrides: Partial<UiRouteState> = {}, locale: 'ru' | 'en' | null = null): UiRouteState {
    const ready = snapshot();
    return {
        phase: 'ready',
        smallPr: false,
        stale: null,
        failure: null,
        snapshot: { ...ready, provenance: { ...ready.provenance, locale } },
        ...overrides,
    };
}

function markup(node: Parameters<typeof renderToStaticMarkup>[0], locale: 'ru' | 'en'): string {
    return renderToStaticMarkup(<LocaleProvider locale={locale}>{node}</LocaleProvider>);
}

describe('условие показа плашки языка маршрута', () => {
    it('поднимается, когда язык снапшота не совпадает с языком вкладки', () => {
        expect(
            routeLocaleBannerVisible({
                route: routeWith({}, 'en'),
                uiLocale: 'ru',
                generating: false,
                keptSnapshotId: null,
                readOnly: false,
            }),
        ).toBe(true);
    });

    it('снапшот без языка (`locale: null`) считается русским', () => {
        const route = routeWith({}, null);
        const args = { generating: false, keptSnapshotId: null, readOnly: false };
        expect(routeLocaleBannerVisible({ route, uiLocale: 'en', ...args })).toBe(true);
        expect(routeLocaleBannerVisible({ route, uiLocale: 'ru', ...args })).toBe(false);
    });

    it('молчит на совпадении языков, во время генерации и без снапшота', () => {
        expect(
            routeLocaleBannerVisible({
                route: routeWith({}, 'en'),
                uiLocale: 'en',
                generating: false,
                keptSnapshotId: null,
                readOnly: false,
            }),
        ).toBe(false);
        expect(
            routeLocaleBannerVisible({
                route: routeWith({}, 'en'),
                uiLocale: 'ru',
                generating: true,
                keptSnapshotId: null,
                readOnly: false,
            }),
        ).toBe(false);
        expect(
            routeLocaleBannerVisible({
                route: { phase: 'none', smallPr: false, snapshot: null, failure: null, stale: null },
                uiLocale: 'ru',
                generating: false,
                keptSnapshotId: null,
                readOnly: false,
            }),
        ).toBe(false);
        expect(
            routeLocaleBannerVisible({
                route: null,
                uiLocale: 'ru',
                generating: false,
                keptSnapshotId: null,
                readOnly: false,
            }),
        ).toBe(false);
    });

    it('живёт и в фазе заполнения: маршрут уже читают', () => {
        expect(
            routeLocaleBannerVisible({
                route: routeWith({ phase: 'filling' }, 'en'),
                uiLocale: 'ru',
                generating: false,
                keptSnapshotId: null,
                readOnly: false,
            }),
        ).toBe(true);
        expect(
            routeLocaleBannerVisible({
                route: routeWith({ phase: 'reading' }, 'en'),
                uiLocale: 'ru',
                generating: false,
                keptSnapshotId: null,
                readOnly: false,
            }),
        ).toBe(false);
    });

    it('молчит на просмотре прошлой итерации: «Перестроить» строит не её', () => {
        const route = routeWith({}, 'en');
        expect(
            routeLocaleBannerVisible({
                route,
                uiLocale: 'ru',
                generating: false,
                keptSnapshotId: null,
                readOnly: true,
            }),
        ).toBe(false);
    });

    it('«Оставить» держится за id снапшота: новый снапшот спрашивает заново', () => {
        const route = routeWith({}, 'en');
        const id = route.snapshot?.snapshotId ?? '';
        expect(
            routeLocaleBannerVisible({ route, uiLocale: 'ru', generating: false, keptSnapshotId: id, readOnly: false }),
        ).toBe(false);
        expect(
            routeLocaleBannerVisible({
                route,
                uiLocale: 'ru',
                generating: false,
                keptSnapshotId: 'другой-снапшот',
                readOnly: false,
            }),
        ).toBe(true);
    });
});

describe('плашка языка маршрута', () => {
    it('называет оба языка и предлагает перестроить на языке вкладки', () => {
        const html = markup(
            <RouteLocaleBanner routeLocale="en" onRebuild={() => undefined} onKeep={() => undefined} />,
            'ru',
        );

        expect(html).toContain('Маршрут построен на английском — перестроить на русском?');
        expect(html).toContain('Перестроить на русском');
        expect(html).toContain('Оставить');
        expect(html).not.toContain('disabled');
    });

    it('на английской вкладке говорит по-английски', () => {
        const html = markup(
            <RouteLocaleBanner routeLocale="ru" onRebuild={() => undefined} onKeep={() => undefined} />,
            'en',
        );

        expect(html).toContain('The route was built in Russian — rebuild it in English?');
        expect(html).toContain('Rebuild in English');
        expect(html).toContain('Keep it');
    });

    it('недоступная перестройка гасит кнопку и объясняет причину в title', () => {
        const html = markup(
            <RouteLocaleBanner
                routeLocale="en"
                rebuildDisabledReason="Пока маршрут заполняется, перестроить его нельзя."
                onRebuild={() => undefined}
                onKeep={() => undefined}
            />,
            'ru',
        );

        expect(html).toContain('disabled=""');
        expect(html).toContain('title="Пока маршрут заполняется, перестроить его нельзя."');
    });
});

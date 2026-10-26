import type { RouteCarried, RouteSnapshot, RouteStop, UiRouteStale } from '@sherpa/protocol';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import {
    NotesLostBanner,
    notesLostBannerVisible,
    notesLostKey,
    RouteSecondPassBanner,
    RouteStaleBanner,
    secondPassBannerVisible,
    staleBannerVisible,
} from './iteration-banners.tsx';

const ROUTE_COMMIT = '9f3c1ab6d4e2705c8a1b3f9d6e4c2a08b7d5f316';
const PR_COMMIT = 'a71d4e2c9b8f5301d6e4a2c7b09f8e3d5a4c6b21';

function stop(id: string, planIndex: number): RouteStop {
    return {
        id,
        planIndex,
        tier: 'medium',
        title: id,
        status: 'ready',
        paragraph: null,
        bridge: null,
        anchors: [],
        tests: [],
        droppedClaims: 0,
        validationNotes: [],
        provenance: null,
        change: null,
    };
}

const STOPS: readonly RouteStop[] = [stop('s02', 2), stop('s03', 3), stop('s07', 7)];

function stale(patch: Partial<UiRouteStale> = {}): UiRouteStale {
    return {
        routeCommit: ROUTE_COMMIT,
        prCommit: PR_COMMIT,
        prDiffId: '182801',
        newIterations: 2,
        affectedStopIds: ['s02', 's03', 's07'],
        ...patch,
    };
}

function snapshot(patch: Partial<RouteSnapshot> = {}): RouteSnapshot {
    return {
        snapshotId: 'route-medium-a71d4e2',
        commit: PR_COMMIT,
        baseCommit: ROUTE_COMMIT,
        diffId: '182801',
        createdAt: '2026-09-01T10:00:00.000Z',
        provenance: { harness: 'claude-code', model: 'opus-5', locale: null },
        previousSnapshotId: 'route-medium-9f3c1ab',
        carried: { kept: 4, total: 7, zeroReason: null },
        summary: '',
        stops: [...STOPS],
        tourOrder: STOPS.map((item) => item.id),
        contentHash: 'hash',
        ...patch,
    };
}

describe('баннер «маршрут устарел»', () => {
    it('называет оба коммита, склоняет итерации и перечисляет затронутые остановки', () => {
        const html = renderToStaticMarkup(
            <RouteStaleBanner stale={stale()} stops={STOPS} onRegenerate={() => undefined} />,
        );

        expect(html).toContain('Маршрут построен для');
        expect(html).toContain(`title="${ROUTE_COMMIT}"`);
        expect(html).toContain('>9f3c1ab<');
        expect(html).toContain('>a71d4e2<');
        expect(html).toContain('2 новые итерации');
        expect(html).toContain('затронуты остановки 02, 03 и 07');
    });

    it('склонение по числу новых итераций', () => {
        const text = (newIterations: number) =>
            renderToStaticMarkup(
                <RouteStaleBanner
                    stale={stale({ newIterations, affectedStopIds: [] })}
                    stops={STOPS}
                    onRegenerate={() => undefined}
                />,
            );

        expect(text(1)).toContain('1 новая итерация');
        expect(text(5)).toContain('5 новых итераций');
    });

    it('затронутых остановок нет — фраза про них опускается', () => {
        const html = renderToStaticMarkup(
            <RouteStaleBanner
                stale={stale({ affectedStopIds: [] })}
                stops={STOPS}
                onRegenerate={() => undefined}
            />,
        );

        expect(html).not.toContain('затронуты остановки');
        expect(html).toContain('Перестроить маршрут');
    });

    it('без колбэка переключения итерации secondary-кнопки нет', () => {
        const without = renderToStaticMarkup(
            <RouteStaleBanner stale={stale()} stops={STOPS} onRegenerate={() => undefined} />,
        );
        const withCallback = renderToStaticMarkup(
            <RouteStaleBanner
                stale={stale()}
                stops={STOPS}
                onRegenerate={() => undefined}
                onOpenDiffWithoutRoute={() => undefined}
            />,
        );

        expect(without).not.toContain('без маршрута');
        expect(withCallback).toContain('Открыть дифф a71d4e2 без маршрута');
    });
});

describe('баннер второго захода', () => {
    function secondPass(carried: RouteCarried | null, changedStops = 3): string {
        return renderToStaticMarkup(
            <RouteSecondPassBanner
                commit={PR_COMMIT}
                carried={carried}
                changedStops={changedStops}
                onShowNew={() => undefined}
                onDismiss={() => undefined}
            />,
        );
    }

    it('печатает числа переноса отметок и предлагает фильтр', () => {
        const html = secondPass({ kept: 3, total: 6, zeroReason: null });

        expect(html).toContain('Маршрут перестроен для');
        expect(html).toContain('Просмотренными остались 3 остановки из 6.');
        expect(html).toContain('Изменились 3 остановки; комментарии на изменившихся диапазонах закреплены');
        expect(html).toContain('Что нового с прошлого захода');
    });

    it('склоняет и перенесённые остановки, и изменившиеся', () => {
        expect(secondPass({ kept: 1, total: 6, zeroReason: null }, 1)).toContain(
            'Просмотренной осталась 1 остановка из 6.',
        );
        expect(secondPass({ kept: 1, total: 6, zeroReason: null }, 1)).toContain('Изменилась 1 остановка;');
        expect(secondPass({ kept: 5, total: 6, zeroReason: null }, 6)).toContain(
            'Просмотренными остались 5 остановок из 6.',
        );
        expect(secondPass({ kept: 5, total: 6, zeroReason: null }, 6)).toContain('Изменились 6 остановок;');
    });

    it('нулевой перенос называет причину, а не выдаёт её за отсутствие изменений', () => {
        expect(secondPass({ kept: 0, total: 6, zeroReason: 'no_marks' })).toContain(
            'Отметок просмотра с прошлого захода не было — переносить нечего.',
        );
        expect(secondPass({ kept: 0, total: 6, zeroReason: 'no_overlap' })).toContain(
            'Отметки просмотра с прошлого захода были, но целиком просмотренной не осталась ни одна остановка.',
        );
        expect(secondPass({ kept: 0, total: 6, zeroReason: 'no_interdiff' })).toContain(
            'Перенести отметки просмотра не вышло: разницу между итерациями посчитать не удалось.',
        );
        // Снапшот без причины: говорим только число.
        expect(secondPass({ kept: 0, total: 6, zeroReason: null })).toContain(
            'Просмотренной не осталось ни одной остановки из 6.',
        );
    });

    it('переносить было не от чего — предложение о переносе опускается', () => {
        const html = secondPass(null);

        expect(html).not.toContain('осталась');
        expect(html).not.toContain('остались');
        expect(html).toContain('Изменились 3 остановки; комментарии на изменившихся диапазонах закреплены');
    });

    it('изменений в остановках нет — фильтровать нечего, primary-кнопки нет', () => {
        const html = secondPass({ kept: 6, total: 6, zeroReason: null }, 0);

        expect(html).toContain('Изменений в остановках нет');
        expect(html).not.toContain('Что нового с прошлого захода');
    });

    it('крестик зовёт дизмисс, и закрытый снапшот баннер больше не показывает', () => {
        const onDismiss = vi.fn();
        renderToStaticMarkup(
            <RouteSecondPassBanner
                commit={PR_COMMIT}
                carried={null}
                changedStops={3}
                onShowNew={() => undefined}
                onDismiss={onDismiss}
            />,
        );
        const current = snapshot();

        expect(secondPassBannerVisible('route', current, null, null)).toBe(true);
        expect(secondPassBannerVisible('route', current, null, current.snapshotId)).toBe(false);
        // Дизмисс прошлого снапшота новый не гасит: перестроили — новость снова новая.
        expect(secondPassBannerVisible('route', current, null, 'route-medium-9f3c1ab')).toBe(true);
    });

    it('первый снапшот и устаревший маршрут баннера не дают', () => {
        expect(secondPassBannerVisible('route', snapshot({ previousSnapshotId: null }), null, null)).toBe(false);
        expect(secondPassBannerVisible('route', snapshot(), stale(), null)).toBe(false);
        expect(secondPassBannerVisible('route', null, null, null)).toBe(false);
    });

    it('вне вкладки маршрута баннера нет: его действие — фильтр маршрута', () => {
        expect(secondPassBannerVisible('overview', snapshot(), null, null)).toBe(false);
        expect(secondPassBannerVisible('diff', snapshot(), null, null)).toBe(false);
    });
});

describe('видимость stale-баннера', () => {
    it('держится на любой вкладке, пока маршрут не перестраивают', () => {
        expect(staleBannerVisible('ready', stale(), snapshot())).toBe(true);
        expect(staleBannerVisible('failed', stale(), snapshot())).toBe(true);
        expect(staleBannerVisible('ready', null, snapshot())).toBe(false);
        expect(staleBannerVisible('ready', stale(), null)).toBe(false);
    });

    it('в фазах перестройки уступает баннерам перестройки и заполнения', () => {
        expect(staleBannerVisible('reading', stale(), snapshot())).toBe(false);
        expect(staleBannerVisible('filling', stale(), snapshot())).toBe(false);
    });
});

describe('баннер потерянных заметок', () => {
    it('склоняет число и предлагает показать первую', () => {
        const onShow = vi.fn();
        const html = renderToStaticMarkup(
            <NotesLostBanner count={2} onShow={onShow} onDismiss={() => undefined} />,
        );

        expect(html).toContain('2 заметки потеряли якорь после нового пуша');
        expect(html).toContain('Показать');
        expect(renderToStaticMarkup(<NotesLostBanner count={1} onShow={onShow} onDismiss={() => undefined} />))
            .toContain('1 заметка потеряла якорь после нового пуша');
        expect(renderToStaticMarkup(<NotesLostBanner count={5} onShow={onShow} onDismiss={() => undefined} />))
            .toContain('5 заметок потеряли якорь после нового пуша');
    });

    it('держится, пока не закрыт ровно этот набор заметок', () => {
        expect(notesLostBannerVisible('ready', [7, 3], null)).toBe(true);
        // Ключ не зависит от порядка: набор тот же — баннер закрыт.
        expect(notesLostBannerVisible('ready', [7, 3], notesLostKey([3, 7]))).toBe(false);
        // Якорь потеряла ещё одна — новость новая, закрытый баннер возвращается.
        expect(notesLostBannerVisible('ready', [7, 3, 9], notesLostKey([3, 7]))).toBe(true);
    });

    it('без потерянных заметок, в режиме чтения и в фазах перестройки его нет', () => {
        expect(notesLostBannerVisible('ready', [], null)).toBe(false);
        expect(notesLostBannerVisible('ready', [7], null, true)).toBe(false);
        expect(notesLostBannerVisible('reading', [7], null)).toBe(false);
        expect(notesLostBannerVisible('filling', [7], null)).toBe(false);
    });

    it('фазы без маршрута баннеру не мешают: заметки живут и без него', () => {
        expect(notesLostBannerVisible('none', [7], null)).toBe(true);
        expect(notesLostBannerVisible(null, [7], null)).toBe(true);
    });
});

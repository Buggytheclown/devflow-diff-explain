import { readFileSync } from 'node:fs';

import { routeFixtures } from '@sherpa/fixtures';
import type { UiRouteState, UiTask } from '@sherpa/protocol';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { generationIsLong, LONG_GENERATION_MS } from '../../route/generation.js';
import type { OtherStopFacts } from '../../route/other-stop.js';
import {
    GenerationCard,
    GenerationFailedBanner,
    RouteActionErrorBanner,
    RouteFillingBanner,
    RouteRegeneratingBanner,
} from './generation-card.tsx';

/** Карточка генерации: что видит ревьюер в каждой фазе и откуда берутся её числа. */

function state(phase: 'none' | 'reading' | 'filling' | 'ready' | 'failed'): UiRouteState {
    const fixture = routeFixtures('medium')?.states[phase] ?? null;
    if (fixture === null) {
        throw new Error(`фикстуре medium нужно состояние ${phase}`);
    }
    return fixture;
}

const NOOP = (): void => undefined;

function render(
    route: UiRouteState,
    extra: { diffFiles?: number; longRunning?: boolean; other?: OtherStopFacts } = {},
): string {
    return renderToStaticMarkup(
        <GenerationCard
            route={route}
            {...(extra.other === undefined ? {} : { other: extra.other })}
            diffFiles={extra.diffFiles ?? null}
            longRunning={extra.longRunning ?? false}
            onOpenRoute={NOOP}
            onOpenDiff={NOOP}
            onRetry={NOOP}
            onCancel={NOOP}
        />,
    );
}

describe('карточка генерации маршрута', () => {
    it('фаза A: спиннер, три строки прогресса и честная нота — без счётчика остановок', () => {
        const html = render(state('reading'), { diffFiles: 18 });

        expect(html).toContain('Читаю дифф, планирую маршрут');
        expect(html).toContain('~40 c');
        expect(html).toContain('Читаю весь дифф · 18 файлов');
        expect(html).toContain('Решаю, сколько будет остановок и в каком порядке');
        expect(html).toContain('Заполняю остановки по одной');
        expect(html).toContain('Сначала план — пока его нет, счётчику остановок неоткуда взяться');
        expect(html).toContain('Открыть скелет маршрута');
        // Ни счётчика, ни сегмент-бара в этой фазе быть не может: плана ещё нет (docs/design/README.md §6).
        expect(html).not.toContain('gen-bar');
        expect(html).not.toContain('готовы');
    });

    it('перестройка в фазе A честно оставляет точку входа в прежний маршрут', () => {
        const html = render({ ...state('reading'), snapshot: state('ready').snapshot });

        expect(html).toContain('Строю новый маршрут');
        expect(html).toContain('Прежний маршрут остаётся доступен');
        expect(html).toContain('Открыть прежний маршрут');
        expect(html).toContain('новый план заменит его целиком только после приёмки');
    });

    it('фаза B: «3 из 6 готовы», сегмент по слоту и план-лист со статусами — без «Прочего»', () => {
        const html = render(state('filling'), { other: { uncovered: 300, conflictFiles: 0 } });

        expect(html).toContain('Заполняю маршрут');
        expect(html).toContain('3 из 6 готовы');
        expect(count(html, 'class="gen-bar__segment')).toBe(6);
        expect(count(html, 'gen-bar__segment--ready')).toBe(3);
        expect(count(html, 'gen-bar__segment--filling')).toBe(1);
        expect(count(html, 'gen-bar__segment--queued')).toBe(2);
        expect(count(html, 'class="gen-plan__item')).toBe(6);
        expect(html).not.toContain('Прочее');
        expect(html).toContain('План зафиксирован — остановки валидируются независимо');
        expect(html).toContain('3 остановки уже можно читать, 3 — плейсхолдера');
    });

    it('дольше минуты — «всё ещё работаю» со счётчиком фазы и отменой (docs/design/SPEC-elements.md §3)', () => {
        expect(render(state('filling'), { longRunning: true })).toContain('всё ещё работаю · 3 из 6');
        // В фазе чтения счётчику взяться неоткуда — строка остаётся без него.
        expect(render(state('reading'), { longRunning: true })).toContain('всё ещё работаю<');
        expect(render(state('reading'), { longRunning: true })).toContain('Отменить');
        expect(render(state('filling'))).not.toContain('всё ещё работаю');
    });

    it('порог 60 с считается по самой старой открытой задаче маршрута (docs/design/SPEC-elements.md §3)', () => {
        const created = Date.parse('2026-09-01T10:00:00.000Z');
        const task = (createdAt: string): UiTask => ({
            id: 1,
            type: 'route.section',
            priority: 'background',
            status: 'leased',
            heldByWorker: true,
            attempt: 1,
            instructions: 'заполни стоп',
            progressText: null,
            result: null,
            failReason: null,
            createdAt,
            updatedAt: createdAt,
        });
        const tasks = [task(new Date(created).toISOString())];

        expect(generationIsLong(tasks, created + LONG_GENERATION_MS - 1)).toBe(false);
        expect(generationIsLong(tasks, created + LONG_GENERATION_MS)).toBe(true);
        // Ровно этот флаг и зажигает строку с отменой — считает его App по тикающим часам.
        const html = render(state('filling'), { longRunning: generationIsLong(tasks, created + LONG_GENERATION_MS) });
        expect(html).toContain('всё ещё работаю · 3 из 6');
        expect(html).toContain('>Отменить</button>');
    });

    it('готовый маршрут — число остановок, их список и «Открыть маршрут»', () => {
        const ready = state('ready');
        const html = render(ready, { other: { uncovered: 38, conflictFiles: 0 } });
        const titles = ready.snapshot?.stops.map((stop) => stop.title) ?? [];

        expect(html).toContain('Маршрут готов · 7 остановок');
        expect(html).toContain('Открыть маршрут');
        expect(titles.length).toBe(7);
        // Заголовки идут через markdown-профиль маршрута, поэтому сверяются номера и чистый текст.
        expect([...html.matchAll(/gen-plan__number">(\d+)</gu)].map((match) => match[1])).toEqual([
            '01',
            '02',
            '03',
            '04',
            '05',
            '06',
            '07',
        ]);
        expect(html).toContain(titles[0]);
        expect(html).toContain('Прочее — модель не разместила эти строки');
        expect(html).toContain('gen-plan__item--ready');
        // Полоса, заметка и подсказка про плейсхолдеры — про заполнение, в готовом маршруте им нечего сказать.
        expect(html).not.toContain('gen-bar');
        expect(html).not.toContain('gen-card__note');
        expect(html).not.toContain('gen-card__hint');
    });

    it('готовый маршрут, где модель разместила всё, — «Прочего» нет ни в счёте, ни в плане', () => {
        const html = render(state('ready'), { other: { uncovered: 0, conflictFiles: 0 } });

        expect(html).toContain('Маршрут готов · 6 остановок');
        expect(count(html, 'class="gen-plan__item')).toBe(6);
        expect(html).not.toContain('Прочее');
    });

    it('пока непокрытое не посчитано, число остановок не называется: оно может вырасти на «Прочее»', () => {
        for (const other of [{ uncovered: null, conflictFiles: 0 }, undefined]) {
            const html = render(state('ready'), other === undefined ? {} : { other });

            expect(html).toContain('<h2 class="gen-card__title">Маршрут готов</h2>');
            expect(html).not.toContain('Маршрут готов ·');
            expect(html).not.toContain('Прочее');
        }
    });

    it('провал — компактная красная карточка без сырого вывода и футера', () => {
        const html = render(state('failed'));

        expect(html).toContain('gen-failed--compact');
        expect(html).toContain('2 стопа ссылаются на services/orders/src/domain/order-state.ts');
        expect(html).toContain('Повторить');
        expect(html).not.toContain('Показать сырой вывод');
        expect(html).not.toContain('Ридер ниже не пострадал');
    });

    it('провал перестройки называет новым маршрут, а не старый читаемый', () => {
        const html = render({ ...state('failed'), snapshot: state('ready').snapshot });

        expect(html).toContain('Новый маршрут не построился');
    });

    it('генерацию не запускали — карточке нечего сказать', () => {
        expect(render(state('none'))).toBe('');
    });
});

describe('план-лист фазы B', () => {
    const css = readFileSync(new URL('./generation.css', import.meta.url), 'utf8');

    it('пункт в очереди читается: текст берёт свой токен, а не заливку сегмента', () => {
        // docs/design/README.md §7 разводит два цвета: `#5c6288` — текст очередного пункта, `#2a2e4a` — фон
        // незажжённого сегмента полосы. Склеенные, они дают невидимые строки на фоне карточки.
        const title = /\.gen-plan__title,\s*\.gen-plan__state\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';

        expect(title).toContain('var(--accent-text-queued)');
        expect(title).not.toContain('var(--tier-unfilled)');
        expect(/\.gen-bar__segment\s*\{[^}]*var\(--tier-unfilled\)/.test(css)).toBe(true);
    });

    it('пер-статусные переопределения есть только у заполненных и заполняемых пунктов', () => {
        const html = render(state('filling'));

        expect(count(html, 'gen-plan__item--queued')).toBe(2);
        expect(count(html, 'gen-plan__item--ready')).toBe(3);
        expect(html).toContain('в очереди');
    });
});

describe('баннеры генерации', () => {
    it('ошибка ручки, которой негде встать в месте вызова, показывается баннером', () => {
        const html = renderToStaticMarkup(
            <RouteActionErrorBanner message="У этого PR нет хост-адаптера: маршрут строить не по чему." />,
        );

        expect(html).toContain('Действие с маршрутом не выполнено.');
        expect(html).toContain('У этого PR нет хост-адаптера');
    });

    it('баннер заполнения считает слоты по снапшоту и уводит к полному диффу', () => {
        const snapshot = state('filling').snapshot;
        if (snapshot === null) {
            throw new Error('состоянию filling нужен снапшот');
        }
        const html = renderToStaticMarkup(<RouteFillingBanner snapshot={snapshot} onReadDiff={NOOP} />);

        expect(html).toContain('Заполняю маршрут · 3 из 6 остановок готовы');
        expect(html).toContain('остановки появляются не по порядку');
        expect(html).toContain('Пока можно читать полный дифф');
    });

    it('баннер перестройки предупреждает об отметках и даёт отмену', () => {
        const html = renderToStaticMarkup(<RouteRegeneratingBanner onCancel={NOOP} />);

        expect(html).toContain('Строю новый маршрут — отметки остановок уйдут, когда он приедет');
        expect(html).toContain('>Отменить</button>');
    });

    it('баннер провала несёт причину и ровно одно действие', () => {
        const html = renderToStaticMarkup(
            <GenerationFailedBanner message="Генерация остановлена на валидации." onRetry={NOOP} />,
        );

        expect(html).toContain('Маршрут не построился.');
        expect(html).toContain('Генерация остановлена на валидации.');
        expect(count(html, '<button')).toBe(1);
    });

    it('провал перестройки называет новым именно несостоявшийся маршрут', () => {
        const html = renderToStaticMarkup(
            <GenerationFailedBanner
                message="Генерация остановлена на валидации."
                rebuilding
                onRetry={NOOP}
            />,
        );

        expect(html).toContain('Новый маршрут не построился.');
    });
});

function count(html: string, needle: string): number {
    return html.split(needle).length - 1;
}

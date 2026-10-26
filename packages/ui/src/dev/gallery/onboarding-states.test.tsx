import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { ONBOARDING_STATES } from './onboarding-states.tsx';

/**
 * Галерея тура: состав состояний и то, что видно в статичной разметке. Позиция карточки
 * здесь всегда запасная — замер живёт в эффекте и в браузере; проверяются тексты, счётчик,
 * состав футера и цели шагов в каркасе.
 */
function markup(id: string): string {
    const state = ONBOARDING_STATES.find((candidate) => candidate.id === id);
    if (state === undefined) {
        throw new Error(`нет состояния ${id}`);
    }
    return renderToStaticMarkup(<>{state.render()}</>);
}

describe('галерея онбординга', () => {
    it('регистрирует ровно те id, что объявлены в файле', () => {
        expect(ONBOARDING_STATES.map((state) => state.id)).toEqual([
            'tour-step-01-narrative',
            'tour-step-02-fold',
            'tour-step-03-stopdiff',
            'tour-step-04-progress',
            'tour-step-05-presets',
            'tour-step-06-chat',
            'tour-step-07-fulldiff',
            'tour-step-08-ship',
            'tour-offline-counter',
            'tour-fallback-missing',
            'tour-scaffold-reading',
            'tour-scaffold-progress',
            'tour-scaffold-invitation',
        ]);
    });

    it('над скелетом генерации цель на полосе покрытия задвоена — обводится верхняя, из каркаса', () => {
        const html = markup('tour-scaffold-progress');

        expect(html.match(/data-tour="progress"/gu)).toHaveLength(2);
        // Каркас идёт в разметке вторым, поэтому цель шага берётся из него, а не из скелета.
        expect(html.indexOf('tour-scaffold')).toBeGreaterThan(html.indexOf('data-tour="progress"'));
    });

    it('первый шаг: счётчик 01 / 08, кикер и текст спеки, «Назад» нет', () => {
        const html = markup('tour-step-01-narrative');

        expect(html).toContain('01 / 08');
        expect(html).toContain('КАК УСТРОЕНА ШЕРПА');
        expect(html).toContain('Маршрут решает, что читать первым');
        expect(html).toContain('Остановки отсортированы по тому, насколько они могут навредить');
        expect(html).toContain('Пропустить');
        expect(html).toContain('tour-card__next');
        expect(html).not.toContain('tour-card__back');
    });

    it('карточка — нефокус-ловушка с подписью и описанием для скринридера', () => {
        const html = markup('tour-step-01-narrative');

        expect(html).toContain('role="dialog"');
        expect(html).toContain('aria-modal="false"');
        expect(html).toContain('aria-labelledby="tour-card-title"');
        expect(html).toContain('aria-describedby="tour-card-body"');
        expect(html).toContain('aria-live="polite"');
        expect(html).toContain('шаг 1 из 8');
    });

    it('последний шаг зовётся «Начать ревью» и держит «Назад»', () => {
        const html = markup('tour-step-08-ship');

        expect(html).toContain('08 / 08');
        expect(html).toContain('Начать ревью');
        expect(html).toContain('tour-card__back');
        expect(html).not.toContain('>Дальше<');
    });

    it('без агента счётчик становится / 07, а шаг про полный дифф — шестым', () => {
        const html = markup('tour-offline-counter');

        expect(html).toContain('06 / 07');
        expect(html).toContain('Классическая читалка — в одном клике');
    });

    it('цели шагов стоят на настоящих элементах кадра', () => {
        const html = markup('tour-step-01-narrative');

        expect(html).toContain('data-tour="narrative"');
        expect(html).toContain('data-tour="stopdiff"');
        expect(html).toContain('data-tour="progress"');
        expect(html).toContain('data-tour="presets"');
        expect(html).toContain('data-tour="fulldiff"');
        expect(html).toContain('data-tour="ship"');
        expect(html).toMatch(/data-tour="fold-s\d+"/u);
    });

    it('шаг про агента показывает панель чата — единственное состояние, которое тур меняет', () => {
        expect(markup('tour-step-06-chat')).toContain('data-tour="chat"');
        expect(markup('tour-step-05-presets')).not.toContain('data-tour="chat"');
    });

    it('каркас подставляет заглушку остановки и свёртки, без выдуманных чисел', () => {
        const html = markup('tour-scaffold-reading');

        expect(html).toContain('tour-scaffold');
        expect(html).toContain('Здесь появится первая остановка маршрута');
        expect(html).toContain('data-tour="fold-stub"');
        expect(html).toContain('здесь встанет свёрнутая остановка низкой важности');
        // Заглушка вне модели маршрута: `data-stop` у неё нет, и навигация её не видит.
        expect(html).not.toContain('data-stop="tour-stub"');
    });

    it('запасное размещение «цели нет»: карточка по центру низа, кольца нет', () => {
        const html = markup('tour-fallback-missing');

        expect(html).toContain('tour-card--fallback');
        expect(html).not.toContain('tour-ring');
        expect(html).not.toContain('data-tour="narrative"');
    });
});

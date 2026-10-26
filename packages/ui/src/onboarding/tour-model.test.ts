import { describe, expect, it } from 'vitest';

import {
    canonicalIndex,
    nextStep,
    prevStep,
    stepAt,
    stepAtCanonical,
    stepIndex,
    tourAnchorEpoch,
    tourStepCount,
    tourSteps,
} from './tour-model.js';

/** Порядок и состав шагов — docs/design/SPEC-onboarding-2026-09-02.md §2; выпадение шага про чат — §5. */
describe('модель тура', () => {
    it('идёт восемью шагами в порядке пути ревьюера', () => {
        expect(tourStepCount(true)).toBe(8);
        expect(tourSteps(true).map((step) => step.id)).toEqual([
            'narrative',
            'fold',
            'stopdiff',
            'progress',
            'presets',
            'chat',
            'fulldiff',
            'ship',
        ]);
    });

    it('без агента шаг про чат выпадает, а остальные сдвигаются', () => {
        const offline = tourSteps(false);

        expect(offline).toHaveLength(7);
        expect(tourStepCount(false)).toBe(7);
        expect(offline.map((step) => step.id)).not.toContain('chat');
        // Счётчик `/ 07`: шаг про полный дифф стал шестым, а не седьмым.
        expect(stepIndex(offline, 'fulldiff')).toBe(5);
        expect(stepIndex(tourSteps(true), 'fulldiff')).toBe(6);
    });

    it('первые три шага скроллят к цели, липкие — нет', () => {
        const byId = new Map(tourSteps(true).map((step) => [step.id, step.fixed]));

        expect([byId.get('narrative'), byId.get('fold'), byId.get('stopdiff')]).toEqual([false, false, false]);
        expect([byId.get('progress'), byId.get('presets'), byId.get('chat')]).toEqual([true, true, true]);
        expect([byId.get('fulldiff'), byId.get('ship')]).toEqual([true, true]);
    });

    it('свёртка адресуется префиксом: её цель несёт id остановки', () => {
        expect(tourSteps(true)[1]?.selector).toBe('[data-tour^="fold-"]');
    });

    it('переходы упираются в края списка', () => {
        const steps = tourSteps(true);

        expect(nextStep(steps, 'narrative')?.id).toBe('fold');
        expect(prevStep(steps, 'fold')?.id).toBe('narrative');
        // Первый шаг — без «Назад», последний — «Начать ревью» вместо «Дальше».
        expect(prevStep(steps, 'narrative')).toBeNull();
        expect(nextStep(steps, 'ship')).toBeNull();
    });

    it('без агента переход через выпавший шаг ведёт сразу к следующему', () => {
        expect(nextStep(tourSteps(false), 'presets')?.id).toBe('fulldiff');
        expect(prevStep(tourSteps(false), 'fulldiff')?.id).toBe('presets');
    });

    it('персистенный номер клампится: он мог прийти от прохода другой длины', () => {
        const offline = tourSteps(false);

        expect(stepAt(offline, 7).id).toBe('ship');
        expect(stepAt(offline, -1).id).toBe('narrative');
        expect(stepAt(offline, 3).id).toBe('progress');
    });

    it('метка целей не реагирует на каждую следующую остановку', () => {
        const base = {
            view: 'route',
            routeKind: 'workspace',
            anyStopFilled: true,
            chatOpen: false,
            completed: false,
            diffMode: 'unified',
            locale: 'ru',
        };

        // Первая заполненная остановка — событие; вторая, третья и седьмая — уже нет.
        expect(tourAnchorEpoch({ ...base, anyStopFilled: false })).not.toBe(tourAnchorEpoch(base));
        expect(tourAnchorEpoch(base)).toBe(tourAnchorEpoch({ ...base }));
        // Каркас уступил место маршруту, сменился вид, открылась панель — всё это дозамер.
        expect(tourAnchorEpoch({ ...base, routeKind: 'reading' })).not.toBe(tourAnchorEpoch(base));
        expect(tourAnchorEpoch({ ...base, view: 'diff' })).not.toBe(tourAnchorEpoch(base));
        expect(tourAnchorEpoch({ ...base, chatOpen: true })).not.toBe(tourAnchorEpoch(base));
        expect(tourAnchorEpoch({ ...base, completed: true })).not.toBe(tourAnchorEpoch(base));
        // Смена режима диффа меняет ширину код-панелей, а с ней и рамку вокруг цели шага.
        expect(tourAnchorEpoch({ ...base, diffMode: 'split' })).not.toBe(tourAnchorEpoch(base));
        // Смена языка меняет подписи целей: карточка тура обязана перезамериться (§8 спеки тем).
        expect(tourAnchorEpoch({ ...base, locale: 'en' })).not.toBe(tourAnchorEpoch(base));
    });

    it('номер персиста канонический: он не зависит от того, был ли в проходе шаг про чат', () => {
        // Полный дифф — седьмой шаг с агентом и шестой без него, а в персист уезжает одно число.
        expect(canonicalIndex('fulldiff')).toBe(6);
        expect(stepIndex(tourSteps(false), 'fulldiff')).toBe(5);

        expect(stepAtCanonical(tourSteps(true), 6).id).toBe('fulldiff');
        expect(stepAtCanonical(tourSteps(false), 6).id).toBe('fulldiff');
    });

    it('шага нет в этом проходе — встаём на следующий доступный', () => {
        // Тур оставили на шаге про чат, а на следующем заходе агента нет.
        expect(stepAtCanonical(tourSteps(false), canonicalIndex('chat')).id).toBe('fulldiff');
        expect(stepAtCanonical(tourSteps(false), 99).id).toBe('ship');
        expect(stepAtCanonical(tourSteps(true), -3).id).toBe('narrative');
    });
});

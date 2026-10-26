import type { MessageKey } from '../i18n/index.js';

/**
 * Модель тура первого захода (docs/design/SPEC-onboarding-2026-09-02.md §2, §5): восемь шагов, их цели
 * и переходы между ними. Чистый модуль — ни React, ни DOM: порядок шагов, выпадение шага
 * про агента и счётчик обязаны проверяться без экрана.
 *
 * Шаг адресуется идентификатором, а не номером: в offline список короче на один шаг, и номер
 * того же шага в нём другой. Индекс живёт только на границах — в персисте и в счётчике.
 */

export type TourStepId = 'narrative' | 'fold' | 'stopdiff' | 'progress' | 'presets' | 'chat' | 'fulldiff' | 'ship';

export interface TourStep {
    readonly id: TourStepId;
    /** Селектор цели шага: `data-tour` на наших элементах (§2). */
    readonly selector: string;
    readonly title: MessageKey;
    readonly body: MessageKey;
    /**
     * Цель липкая или фиксированная (тулбар, панель чата, таб, панель действий): такой шаг
     * страницу не скроллит вовсе (§3, «Скролл к цели»).
     */
    readonly fixed: boolean;
}

/**
 * Порядок — путь ревьюера (§2): что читать (01–03) → чем мерить прогресс (04) → чем управлять
 * порядком и как спросить (05–06) → путь наружу (07) → завершение (08).
 */
const STEPS: readonly TourStep[] = [
    {
        id: 'narrative',
        selector: '[data-tour="narrative"]',
        title: 'tour.step.narrative.title',
        body: 'tour.step.narrative.body',
        fixed: false,
    },
    {
        id: 'fold',
        selector: '[data-tour^="fold-"]',
        title: 'tour.step.fold.title',
        body: 'tour.step.fold.body',
        fixed: false,
    },
    {
        id: 'stopdiff',
        selector: '[data-tour="stopdiff"]',
        title: 'tour.step.stopdiff.title',
        body: 'tour.step.stopdiff.body',
        fixed: false,
    },
    {
        id: 'progress',
        selector: '[data-tour="progress"]',
        title: 'tour.step.progress.title',
        body: 'tour.step.progress.body',
        fixed: true,
    },
    {
        id: 'presets',
        selector: '[data-tour="presets"]',
        title: 'tour.step.presets.title',
        body: 'tour.step.presets.body',
        fixed: true,
    },
    {
        id: 'chat',
        selector: '[data-tour="chat"]',
        title: 'tour.step.chat.title',
        body: 'tour.step.chat.body',
        fixed: true,
    },
    {
        id: 'fulldiff',
        selector: '[data-tour="fulldiff"]',
        title: 'tour.step.fulldiff.title',
        body: 'tour.step.fulldiff.body',
        fixed: true,
    },
    {
        id: 'ship',
        selector: '[data-tour="ship"]',
        title: 'tour.step.ship.title',
        body: 'tour.step.ship.body',
        fixed: true,
    },
];

/** Из чего складывается расстановка целей шагов на экране. */
export interface TourAnchorEpoch {
    readonly view: string;
    /** Состояние вкладки маршрута: каркас тура уступает место настоящему маршруту. */
    readonly routeKind: string;
    /** Появилась ли хоть одна заполненная остановка — на ней встают цели шагов 01–03. */
    readonly anyStopFilled: boolean;
    readonly chatOpen: boolean;
    readonly completed: boolean;
    /**
     * Фактический режим диффа: он меняет потолок код-панелей (`--diff-max`), то есть ширину
     * колонки диффа и карточек — целей шагов 03 и 07.
     */
    readonly diffMode: string;
    /** Язык интерфейса: подписи табов и кнопок меняют ширину, а с ней и рамку вокруг цели шага. */
    readonly locale: string;
}

/**
 * Метка расстановки целей шагов: её смена заставляет тур перезамерить текущий шаг. Только крупные
 * события — приезд каждой следующей остановки сюда не входит, иначе тур дозамерялся бы на каждой
 * секции стрима, а карточка ездила бы у ревьюера под руками.
 */
export function tourAnchorEpoch(epoch: TourAnchorEpoch): string {
    return [
        epoch.view,
        epoch.routeKind,
        epoch.anyStopFilled ? 'filled' : '',
        epoch.chatOpen ? 'chat' : '',
        epoch.completed ? 'done' : '',
        epoch.diffMode,
        epoch.locale,
    ].join('|');
}

/**
 * Шаги тура для текущего состояния агента (§5): без агента шаг про панель чата выпадает,
 * счётчик становится `/ 07`, номера остальных шагов сдвигаются.
 */
export function tourSteps(withChat: boolean): readonly TourStep[] {
    return withChat ? STEPS : STEPS.filter((step) => step.id !== 'chat');
}

/**
 * Длина прохода: восемь шагов с агентом, семь без него. Отдельная функция, потому что число
 * шагов обещают два входа сразу — строка меню настроек и команда палитры, — и разойтись им нельзя.
 */
export function tourStepCount(withChat: boolean): number {
    return tourSteps(withChat).length;
}

/** Позиция шага в списке; `-1` — шага в этом списке нет (агент отвалился до него). */
export function stepIndex(steps: readonly TourStep[], id: TourStepId): number {
    return steps.findIndex((step) => step.id === id);
}

/**
 * Номер шага для персиста: позиция в полном списке. Номер в списке прохода для этого не годится —
 * его длина зависит от агента, и после перезапуска с другим состоянием агента то же число
 * указывало бы на другой шаг.
 */
export function canonicalIndex(id: TourStepId): number {
    return STEPS.findIndex((step) => step.id === id);
}

/**
 * Шаг прохода по сохранённому каноническому номеру. Шага может не быть в этом проходе (номер
 * сохранён с агентом, а сейчас его нет) — тогда встаём на следующий доступный по общему порядку.
 */
export function stepAtCanonical(steps: readonly TourStep[], index: number): TourStep {
    const clamped = Math.min(Math.max(index, 0), STEPS.length - 1);
    return steps.find((step) => canonicalIndex(step.id) >= clamped) ?? stepAt(steps, steps.length - 1);
}

/** Шаг по индексу с клампом: номер за краями списка приводится к его границам. */
export function stepAt(steps: readonly TourStep[], index: number): TourStep {
    const first = steps[0];
    if (first === undefined) {
        throw new Error('Sherpa: the tour step list is empty');
    }
    return steps[Math.min(Math.max(index, 0), steps.length - 1)] ?? first;
}

/** Следующий шаг; `null` — текущий последний, дальше только завершение тура. */
export function nextStep(steps: readonly TourStep[], id: TourStepId): TourStep | null {
    const index = stepIndex(steps, id);
    return index === -1 ? null : (steps[index + 1] ?? null);
}

/** Предыдущий шаг; `null` — текущий первый, кнопки «Назад» на нём нет (§4). */
export function prevStep(steps: readonly TourStep[], id: TourStepId): TourStep | null {
    const index = stepIndex(steps, id);
    return index <= 0 ? null : (steps[index - 1] ?? null);
}

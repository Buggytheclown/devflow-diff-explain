import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useUiSettings, useUiSettingsLoaded, useUiSettingsStore } from '../settings/context.tsx';
import { useShortcut } from '../shortcuts/context.tsx';
import type { TourStep, TourStepId } from './tour-model.js';
import {
    canonicalIndex,
    nextStep,
    prevStep,
    stepAt,
    stepAtCanonical,
    stepIndex,
    tourStepCount,
    tourSteps,
} from './tour-model.js';

/**
 * Состояние тура первого захода (docs/design/SPEC-onboarding-2026-09-02.md §5–§6).
 *
 * Персист — `settings.onboarding`: `step` пишется на каждом переходе, `completedAt` — на
 * «Пропустить» и «Начать ревью». Незавершённый тур продолжается с того же шага на любом PR
 * и после перезапуска сервера; `localStorage` для этого не годится — порт у каждого PR свой.
 *
 * Тур идёт ровно пока `useTourActive` даёт `true`, а проход (на каком шаге стоим) живёт
 * в состоянии смонтированного слоя: монтирование слоя и есть старт прохода, размонтирование —
 * его конец. Отдельного эффекта «пора стартовать» поэтому нет.
 */

/**
 * Идёт ли тур: непройденный и данные готовы. Тур стартует сразу при первом открытии UI,
 * не дожидаясь маршрута, — недостающие цели шагов подставляет каркас (`tour-scaffold.tsx`).
 *
 * Настройки обязаны быть настоящими, а не умолчаниями: рендер стартует по таймауту загрузки,
 * и на умолчаниях `completedAt` пуст. Показать по ним тур мало того что неверно — первый же
 * переход записал бы «не пройден» поверх пройденного на сервере.
 */
export function useTourActive(dataReady: boolean): boolean {
    const { onboarding } = useUiSettings();
    const loaded = useUiSettingsLoaded();
    return dataReady && loaded && onboarding.completedAt === null;
}

/**
 * «Показать онбординг заново» (§6): сбрасывает флаг и номер шага. Одно действие на два входа —
 * команду палитры и строку меню настроек. `onReplay` перезапускает уже идущий проход: слой
 * пересоздаётся и начинает с 01.
 */
export function useTourReplay(onReplay: () => void): () => void {
    const settings = useUiSettingsStore();
    const latest = useRef(onReplay);
    useEffect(() => {
        latest.current = onReplay;
    });
    return useCallback(() => {
        settings.update({ onboarding: { completedAt: null, step: 0 } });
        latest.current();
    }, [settings]);
}

/**
 * Команда палитры «Показать онбординг заново». Живёт всегда, а не только во время тура, —
 * это единственный путь назад после «Пропустить». Число шагов в подписи считается по текущему
 * состоянию агента: строка меню настроек обещает то же самое действие и то же число.
 */
export function useTourReplayCommand(onReplay: () => void, agentConnected: boolean): void {
    const replay = useTourReplay(onReplay);
    useShortcut({
        id: 'tour.replay',
        keys: [],
        group: 'palette.group.sherpa',
        label: 'shortcut.tour.replay',
        scope: 'global',
        section: 'navigation',
        consequence: 'shortcut.tour.replay.consequence',
        consequenceArg: tourStepCount(agentConnected),
        action: replay,
    });
}

/** Один проход тура: где стоим и был ли в нём шаг про чат. */
interface TourRun {
    readonly stepId: TourStepId;
    /** Агент был подключён на старте прохода: иначе шага про чат в нём нет вовсе (§5). */
    readonly startedWithAgent: boolean;
    /** Шаг про чат уже показали — обратно его не отзываем, даже если агент умер (§5). */
    readonly visitedChat: boolean;
}

export interface TourRunOptions {
    /** Агент подключён прямо сейчас: от этого зависит шаг про панель чата (§5). */
    readonly agentConnected: boolean;
    /** Шаг 06 открывает панель чата и закрывает её на переходе к 07. */
    readonly onOpenChat: () => void;
    readonly onCloseChat: () => void;
}

export interface TourRunState {
    /** Шаги текущего прохода: без агента их семь. */
    readonly steps: readonly TourStep[];
    readonly step: TourStep;
    /** Номер текущего шага с нуля. */
    readonly index: number;
    readonly next: () => void;
    readonly back: () => void;
    /** «Пропустить» — единственное «закрыть навсегда» наравне с «Начать ревью» (§6). */
    readonly skip: () => void;
}

/**
 * Проход тура. Стартовый шаг читается из настроек один раз — при монтировании: это и есть
 * продолжение незавершённого тура с того места, где его оставили.
 */
export function useTourRun(options: TourRunOptions): TourRunState {
    const settings = useUiSettingsStore();
    const { agentConnected } = options;
    const [run, setRun] = useState<TourRun>(() => {
        const initial = stepAtCanonical(tourSteps(agentConnected), settings.getSnapshot().onboarding.step);
        return { stepId: initial.id, startedWithAgent: agentConnected, visitedChat: initial.id === 'chat' };
    });

    /*
     * Агент умер посреди тура: показанный шаг про чат остаётся, непоказанный выпадает. Агент,
     * появившийся посреди тура, шаг не возвращает — иначе счётчик дребезжал бы на глазах.
     */
    const withChat = run.startedWithAgent && (agentConnected || run.visitedChat);
    const steps = useMemo(() => tourSteps(withChat), [withChat]);
    const step = steps.find((candidate) => candidate.id === run.stepId) ?? stepAt(steps, 0);
    const index = stepIndex(steps, step.id);

    // В персист уезжает канонический номер шага: следующий заход может собрать проход другой
    // длины (агента не будет), и номер из этого прохода указал бы в нём на другой шаг.
    const goTo = useCallback(
        (target: TourStep) => {
            setRun((current) => ({
                ...current,
                stepId: target.id,
                visitedChat: current.visitedChat || target.id === 'chat',
            }));
            settings.update({ onboarding: { completedAt: null, step: canonicalIndex(target.id) } });
        },
        [settings],
    );
    const finish = useCallback(() => {
        settings.update({ onboarding: { completedAt: new Date().toISOString(), step: 0 } });
    }, [settings]);

    const next = useCallback(() => {
        const target = nextStep(steps, step.id);
        if (target === null) {
            finish();
            return;
        }
        goTo(target);
    }, [finish, goTo, step.id, steps]);
    const back = useCallback(() => {
        const target = prevStep(steps, step.id);
        if (target !== null) {
            goTo(target);
        }
    }, [goTo, step.id, steps]);

    // Единственное исключение из правила «тур ничего не переключает» (§2): шаг про чат
    // открывает панель и закрывает её, уходя с шага — в том числе завершением тура.
    const chatOpenRef = useRef(options.onOpenChat);
    const chatCloseRef = useRef(options.onCloseChat);
    useEffect(() => {
        chatOpenRef.current = options.onOpenChat;
        chatCloseRef.current = options.onCloseChat;
    });
    const onChatStep = step.id === 'chat';
    useEffect(() => {
        if (!onChatStep) {
            return;
        }
        chatOpenRef.current();
        return () => {
            chatCloseRef.current();
        };
    }, [onChatStep]);

    return { steps, step, index, next, back, skip: finish };
}

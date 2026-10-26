import type { RefObject } from 'react';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

import { flashRow } from '../../diff-view/line-target.js';
import type { RoutePreset } from '../../session/session-store.js';
import type { JumpStep } from './scroll.js';
import {
    animateScrollTo,
    cssEscape,
    JUMP_DURATION,
    JUMP_STEPS,
    jumpTarget,
    pickTopStop,
    targetScrollTop,
} from './scroll.js';
import { stopBoxes } from './stop-dom.js';

export type RequestJump = (
    stopId: string,
    fileId: string | null,
    line?: number | null,
    side?: 'old' | 'new' | null,
    highlight?: boolean,
) => void;

export interface RouteJump {
    readonly containerRef: RefObject<HTMLElement | null>;
    /** Ref-колбэк контейнера: он же держит хост поповера выделения. */
    readonly setContainer: (element: HTMLElement | null) => void;
    readonly popoverHost: HTMLElement | null;
    /** Идёт своя доводка прокрутки: пока счётчик не ноль, событие scroll — не жест ревьюера. */
    readonly settling: RefObject<number>;
    readonly topStopRef: RefObject<{ stopId: string; offset: number } | null>;
    readonly keyboardStopRef: RefObject<string | null>;
    readonly flashStopId: string | null;
    readonly jumpStopId: string | null;
    readonly updateTopStop: () => void;
    readonly requestJump: RequestJump;
    readonly stopJump: () => void;
}

/**
 * Прокрутка маршрута: прыжок к остановке, карточке или строке лесенкой с доводкой, флеш цели
 * и якорь вьюпорта на смене пресета. Всё это правит `scrollTop` контейнера, поэтому геометрию
 * и отмену держит один хук.
 */
export function useRouteJump(preset: RoutePreset): RouteJump {
    const containerRef = useRef<HTMLElement | null>(null);
    const [popoverHost, setPopoverHost] = useState<HTMLElement | null>(null);
    const setContainer = useCallback((element: HTMLElement | null) => {
        containerRef.current = element;
        setPopoverHost(element);
    }, []);
    /** Верхняя остановка вьюпорта и её смещение от кромки контейнера: якорь смены пресета. */
    const topStopRef = useRef<{ stopId: string; offset: number } | null>(null);
    const settling = useRef(0);
    const [flashStopId, setFlashStopId] = useState<string | null>(null);
    /** Цель незакончившегося прыжка: её колонку диффа снимать с DOM нельзя — лестница ищет в ней. */
    const [jumpStopId, setJumpStopId] = useState<string | null>(null);

    const updateTopStop = useCallback(() => {
        const container = containerRef.current;
        if (container === null) {
            return;
        }
        const top = container.getBoundingClientRect().top;
        // Липкий тулбар закрывает верхнюю полосу контейнера — читаемое начинается под ним.
        const toolbar = container.querySelector<HTMLElement>('.route-toolbar');
        const line = toolbar === null ? top : Math.max(top, toolbar.getBoundingClientRect().bottom);
        const anchor = pickTopStop(top, line, stopBoxes(container));
        if (anchor !== null) {
            topStopRef.current = anchor;
        }
    }, []);
    /**
     * Остановка, к которой последней увела клавиатура. Отсчитывать `j`/`k`/`n`/`p` от одной
     * лишь верхней видимой нельзя: прыжок ставит цель на 150px ниже кромки, и «верхней» в этот
     * момент остаётся предыдущая остановка — клавиши ходили бы между двумя соседями.
     * Прокрутка ревьюера якорь снимает: дальше отсчёт снова от того, что на экране.
     */
    const keyboardStopRef = useRef<string | null>(null);

    // Доводка и флеш переживают перерисовки: их отменяет только следующий прыжок или уход вью.
    // Гасить их на каждом изменении зависимостей нельзя — прокрутка обрывалась бы на полпути.
    const running = useRef<JumpRun | null>(null);
    const stopJump = useCallback(() => {
        const current = running.current;
        if (current === null) {
            return;
        }
        running.current = null;
        current.cancel();
        if (current.frame !== null) {
            cancelAnimationFrame(current.frame);
        }
        for (const timer of current.timers) {
            clearTimeout(timer);
        }
        settling.current = Math.max(0, settling.current - 1);
        setJumpStopId(null);
    }, []);

    /**
     * Прыжок к остановке, карточке файла или строке (docs/design/README.md §Interactions & behaviour): своя прокрутка
     * контейнера, −150px от верха цели, флеш.
     *
     * Цель почти никогда не готова в тот же кадр: остановка могла быть спрятана фильтром,
     * карточка — отложена ленивым рендером до появления остановки на экране (docs/design/SPEC-elements.md §2.9), строка —
     * ждать разбора файла. Поэтому прыжок доезжает лесенкой «секция → карточка → строка»: каждая
     * найденная ступень немедленно тянет прокрутку к себе (доехав до секции, вью показывает её —
     * и отложенные карточки дорисовываются), следующие ищутся покадрово до дедлайна. Не доехали —
     * остаёмся на последней достигнутой ступени: это честная деградация, а не молчание.
     *
     * `side` обязателен вместе с `line`: без стороны гаттера переход к удалённой строке
     * перехватила бы добавленная с тем же номером.
     */
    const requestJump = useCallback(
        (
            stopId: string,
            fileId: string | null,
            line: number | null = null,
            side: 'old' | 'new' | null = null,
            highlight = true,
        ) => {
            stopJump();
            const container = containerRef.current;
            if (container === null) {
                return;
            }

            settling.current += 1;
            // Цель прыжка держится смонтированной, пока лестница ищет в ней карточку и строку.
            setJumpStopId(stopId);
            const run: JumpRun = { cancel: () => undefined, timers: [], frame: null, reached: 'none' };
            running.current = run;
            const deadline = Date.now() + JUMP_SEARCH_MS;
            // Момент последнего прицеливания: от него считается остаток длительности доводки.
            let aimedAt = Date.now();

            const goTo = (step: JumpStep, element: HTMLElement): void => {
                if (JUMP_STEPS[step] <= JUMP_STEPS[run.reached]) {
                    return;
                }
                run.reached = step;
                run.cancel();
                aimedAt = Date.now();
                run.cancel = animateScrollTo(container, targetScrollTop(container, element));
            };
            /**
             * Пересчёт цели уже на подъезде к ней. Отметка сворачивает остановку не в один кадр
             * (ленивый рендер, ResizeObserver, поздний разбор), документ над целью продолжает
             * ужиматься во время анимации — и одноразовый расчёт даёт перелёт. Доводка укладывается
             * в остаток от ~320ms (docs/design/README.md §Design tokens, «Motion») с прошлого прицеливания, но не короче
             * `REAIM_MIN_DURATION`: цель нередко находится через сотни миллисекунд после начала
             * поиска, и остаток «от начала прыжка» выродился бы в телепорт.
             */
            const reaim = (): void => {
                if (running.current !== run) {
                    return;
                }
                const again = jumpTarget(container, stopId, fileId, line, side);
                if (again === null || JUMP_STEPS[again.step] < JUMP_STEPS[run.reached]) {
                    return;
                }
                const duration = Math.max(REAIM_MIN_DURATION, JUMP_DURATION - (Date.now() - aimedAt));
                run.cancel();
                aimedAt = Date.now();
                run.cancel = animateScrollTo(container, targetScrollTop(container, again.element), duration);
            };
            const finish = (): void => {
                run.frame = null;
                run.timers.push(
                    setTimeout(() => {
                        // Своя доводка кончилась: следующая прокрутка снова считается жестом ревьюера.
                        if (running.current === run) {
                            running.current = null;
                            settling.current = Math.max(0, settling.current - 1);
                            setJumpStopId(null);
                        }
                    }, JUMP_DURATION + SETTLE_TAIL),
                );
            };
            /** Цель найдена: доводим её ещё дважды — следующим кадром и после `ANCHOR_SETTLE`. */
            const settle = (): void => {
                run.frame = requestAnimationFrame(() => {
                    run.frame = null;
                    reaim();
                    run.timers.push(
                        setTimeout(() => {
                            reaim();
                            finish();
                        }, ANCHOR_SETTLE),
                    );
                });
            };

            const step = (): void => {
                if (running.current !== run) {
                    return;
                }
                const target = jumpTarget(container, stopId, fileId, line, side);
                if (target !== null) {
                    if (run.reached === 'none' && highlight) {
                        setFlashStopId(stopId);
                        run.timers.push(
                            setTimeout(() => {
                                setFlashStopId(null);
                            }, FLASH_MS),
                        );
                    }
                    goTo(target.step, target.element);
                    // Финальная ступень зависит от заказа: строку ищут, только если её просили.
                    const done =
                        target.step === 'row' ||
                        (target.step === 'card' && line === null) ||
                        (target.step === 'section' && fileId === null);
                    if (target.step === 'row' && highlight) {
                        flashRow(target.element);
                    }
                    if (done) {
                        settle();
                        return;
                    }
                }
                if (Date.now() >= deadline) {
                    finish();
                    return;
                }
                run.frame = requestAnimationFrame(step);
            };

            // Первая попытка — со следующего кадра: раскрытие остановки и сброс фильтра
            // заказываются тем же обработчиком, и до перерисовки цели в разметке ещё нет.
            run.frame = requestAnimationFrame(step);
        },
        [stopJump],
    );

    // Своя правка прокрутки не считается жестом ревьюера, пока идёт доводка якоря: событие
    // scroll браузер рассылает следующей задачей, поэтому окно закрывается таймером.
    const anchoring = useRef<{ frames: number[]; timers: ReturnType<typeof setTimeout>[] } | null>(null);
    const endAnchoring = useCallback(() => {
        const run = anchoring.current;
        if (run === null) {
            return;
        }
        anchoring.current = null;
        for (const frame of run.frames) {
            cancelAnimationFrame(frame);
        }
        for (const timer of run.timers) {
            clearTimeout(timer);
        }
        settling.current = Math.max(0, settling.current - 1);
    }, []);
    useEffect(
        () => () => {
            stopJump();
            endAnchoring();
        },
        [endAnchoring, stopJump],
    );

    /**
     * Смена пресета якорит вьюпорт на верхней остановке (docs/design/SPEC-elements.md §2.5): тот же stop id остаётся
     * на экране, к началу прокрутка не сбрасывается. Восстановление — layout-эффектом, до
     * отрисовки нового порядка, и без анимации: это не переход, а та же точка чтения.
     */
    const presetRef = useRef(preset);
    useAnchorEffect(() => {
        if (presetRef.current === preset) {
            return;
        }
        presetRef.current = preset;
        const anchor = topStopRef.current;
        if (anchor === null || containerRef.current === null) {
            return;
        }
        const apply = (): void => {
            const container = containerRef.current;
            const section = container?.querySelector<HTMLElement>(`[data-stop="${cssEscape(anchor.stopId)}"]`) ?? null;
            if (container === null || section === null) {
                return;
            }
            const delta = section.getBoundingClientRect().top - container.getBoundingClientRect().top;
            container.scrollTop += delta - anchor.offset;
        };

        // Незавершённая доводка прошлого прыжка тянула бы контейнер к старой цели.
        stopJump();
        endAnchoring();
        apply();
        settling.current += 1;
        const run: { frames: number[]; timers: ReturnType<typeof setTimeout>[] } = { frames: [], timers: [] };
        anchoring.current = run;
        // Соседние остановки дорисовывают свои карточки, побывав на экране, — и растут над
        // якорем уже после перестановки. Поэтому позиция подтверждается ещё несколько раз.
        run.frames.push(
            requestAnimationFrame(() => {
                apply();
                run.frames.push(requestAnimationFrame(apply));
            }),
        );
        run.timers.push(
            setTimeout(() => {
                apply();
                // Последняя правка прокрутки тоже своя: её событие придёт следующей задачей,
                // и до тех пор окно доводки закрывать нельзя — иначе снимется kept-in-view.
                run.timers.push(setTimeout(endAnchoring, SETTLE_TAIL));
            }, ANCHOR_SETTLE),
        );
    }, [endAnchoring, preset, stopJump]);

    return {
        containerRef,
        setContainer,
        popoverHost,
        settling,
        topStopRef,
        keyboardStopRef,
        flashStopId,
        jumpStopId,
        updateTopStop,
        requestJump,
        stopJump,
    };
}

/**
 * Якорь прокрутки правится до отрисовки кадра — иначе новый порядок мигнул бы не с той позиции.
 * В статическом рендере (тесты, SSR) layout-эффектов нет: там берётся обычный, чтобы React
 * не предупреждал о layout-эффекте на сервере.
 */
const useAnchorEffect = typeof document === 'undefined' ? useEffect : useLayoutEffect;

const FLASH_MS = 900;
/** Запас после анимации: события прокрутки браузер рассылает уже после последнего шага. */
const SETTLE_TAIL = 50;

interface JumpRun {
    /** Отмена текущей прокрутки: следующая ступень перехватывает её на полпути. */
    cancel: () => void;
    timers: ReturnType<typeof setTimeout>[];
    /** Кадр очередного поиска цели; `null` — поиск кончился. */
    frame: number | null;
    reached: JumpStep;
}

/**
 * Сколько ждать появления цели прыжка. Секция могла быть спрятана фильтром, карточка —
 * отложена ленивым рендером до появления остановки на экране, строка — ждать разбора файла.
 * За дедлайном прыжок остаётся на последней достигнутой ступени.
 */
const JUMP_SEARCH_MS = 1500;
/**
 * Сколько держать якорь смены пресета: успевает отработать ленивый рендер соседних остановок
 * (наблюдатель видимости и его перерисовка), но не настолько долго, чтобы спорить с прокруткой
 * самого ревьюера.
 */
const ANCHOR_SETTLE = 120;
/** Нижняя граница длительности доводки прыжка: правка цели остаётся движением, а не телепортом. */
const REAIM_MIN_DURATION = 120;

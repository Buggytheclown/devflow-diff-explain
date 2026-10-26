import { useCallback, useEffect, useRef, useState } from 'react';

import { useT } from '../i18n/index.js';
import { useShortcut } from '../shortcuts/context.tsx';
import type { TourPlacement, TourRect } from './placement.js';
import {
    easeInOutCubic,
    needsScroll,
    offscreen,
    placeTour,
    TOUR_RETRIES_MS,
    TOUR_SCROLL_MARGIN_TOP,
    TOUR_SCROLL_MS,
} from './placement.js';
import { TOUR_CARD_BODY_ID, TourCard } from './tour-card.tsx';
import { TourRing } from './tour-ring.tsx';
import type { TourStep } from './tour-model.js';
import { TOUR_SCAFFOLD_SELECTOR } from './tour-scaffold.tsx';
import './tour.css';

/**
 * Слой тура: кольцо, карточка, замер позиции и клавиатура (docs/design/SPEC-onboarding-2026-09-02.md §3, §7).
 * Монтируется только пока тур идёт — состояние держит `tour-store.ts`.
 *
 * Замер живёт здесь, потому что он про DOM: цель шага ищется по `data-tour` заново на каждом
 * замере, а сама геометрия считается чистыми функциями `placement.ts`.
 */

export interface TourLayerProps {
    readonly step: TourStep;
    readonly index: number;
    readonly total: number;
    /**
     * Метка «эпохи целей шагов»: её смена (каркас → маршрут, появление первой заполненной
     * остановки, смена вида) заставляет шаг перезамериться. Явный сигнал, а не наблюдение
     * за DOM: так дозамер детерминирован и виден в тестах. Меняться она обязана редко —
     * каждая смена это дозамер, а прокрутку ревьюера дозамер уже не трогает.
     */
    readonly epoch: string;
    readonly onNext: () => void;
    readonly onBack: () => void;
    readonly onSkip: () => void;
}

export function TourLayer({ step, index, total, epoch, onNext, onBack, onSkip }: TourLayerProps) {
    const t = useT();
    const cardRef = useRef<HTMLDivElement | null>(null);
    const stepId = step.id;
    const selector = step.selector;
    const fixed = step.fixed;
    /*
     * Прошлая позиция держится до успеха нового замера: между сменой шага (или эпохи целей шагов)
     * и первым замером карточка едет к новой цели переездом .18s, а не мигает запасной позицией по центру
     * низа — там `top` переключался бы px↔auto, то есть прыгал бы без анимации (§4).
     */
    const [placement, setPlacement] = useState<TourPlacement | null>(null);
    /** Шаг, чей начальный замер уже отработал: только он имеет право доводить прокрутку (§3). */
    const scrolledFor = useRef<string | null>(null);
    /** Ключ замера: на его смену эффект ищет цель заново. */
    const measureKey = `${stepId}|${epoch}`;

    useEffect(() => {
        let cancelled = false;
        /** Идёт доводка скролла: до её конца карточку не перерисовываем (§4, «без дребезга»). */
        let scrolling = false;
        /** Позиция найдена: цепочка дозамеров гасится сразу после успеха. */
        let placed = false;
        // Ноль — свободный идентификатор таймера и кадра: снимать его безопасно и без проверок.
        let retryTimer = 0;
        let frame = 0;
        let moveFrame = 0;
        /** Элемент, которому одолжили `aria-describedby` на тело карточки (§7). */
        let described: HTMLElement | null = null;
        let previousDescription: string | null = null;

        const describe = (element: HTMLElement | null): void => {
            if (described === element) {
                return;
            }
            if (described !== null) {
                if (previousDescription === null) {
                    described.removeAttribute('aria-describedby');
                } else {
                    described.setAttribute('aria-describedby', previousDescription);
                }
            }
            described = element;
            previousDescription = element === null ? null : element.getAttribute('aria-describedby');
            element?.setAttribute('aria-describedby', TOUR_CARD_BODY_ID);
        };

        const scrollTo = (target: HTMLElement, rect: TourRect, done: () => void): void => {
            const scroller = scrollerOf(target);
            const documentScroller =
                scroller === document.scrollingElement ||
                scroller === document.documentElement ||
                scroller === document.body;
            const base = documentScroller ? 0 : scroller.getBoundingClientRect().top;
            const to = Math.max(0, scroller.scrollTop + rect.top - base - TOUR_SCROLL_MARGIN_TOP);
            const from = scroller.scrollTop;
            const distance = to - from;
            if (Math.abs(distance) < 2) {
                done();
                return;
            }
            if (reducedMotion()) {
                scroller.scrollTop = to;
                done();
                return;
            }
            scrolling = true;
            const started = performance.now();
            const tick = (): void => {
                if (cancelled) {
                    return;
                }
                const progress = Math.min(1, (performance.now() - started) / TOUR_SCROLL_MS);
                scroller.scrollTop = from + distance * easeInOutCubic(progress);
                if (progress < 1) {
                    frame = requestAnimationFrame(tick);
                    return;
                }
                scrolling = false;
                done();
            };
            frame = requestAnimationFrame(tick);
        };

        /**
         * `first` — единственный замер, которому разрешено скроллить к цели; `after` — замер
         * после скролла, он же дозамер по таймеру: скроллить второй раз нельзя, иначе рекурсия.
         */
        const place = (mode: 'first' | 'after' | 'passive'): void => {
            if (cancelled || (scrolling && mode !== 'after')) {
                return;
            }
            const target = anchorOf(selector);
            if (target === null) {
                describe(null);
                placed = false;
                setPlacement(null);
                return;
            }
            const box = target.getBoundingClientRect();
            const rect: TourRect = { left: box.left, top: box.top, width: box.width, height: box.height };
            const viewport = { width: window.innerWidth, height: window.innerHeight };
            if (mode === 'first' && !fixed && needsScroll(rect, viewport)) {
                scrollTo(target, rect, () => {
                    place('after');
                });
                return;
            }
            describe(target);
            if (offscreen(rect, viewport)) {
                placed = false;
                setPlacement(null);
                return;
            }
            placed = true;
            setPlacement(placeTour(rect, viewport));
        };

        const retry = (attempt: number): void => {
            const delay = TOUR_RETRIES_MS[attempt];
            if (delay === undefined) {
                return;
            }
            retryTimer = window.setTimeout(() => {
                if (cancelled) {
                    return;
                }
                if (!placed) {
                    place('after');
                }
                if (!placed) {
                    retry(attempt + 1);
                }
            }, delay);
        };

        const onMove = (): void => {
            if (moveFrame !== 0) {
                return;
            }
            moveFrame = requestAnimationFrame(() => {
                moveFrame = 0;
                place('passive');
            });
        };

        // Первый замер — следующим тиком: разметка шага (каркас, открытая панель чата)
        // должна успеть встать до того, как её меряют.
        const startTimer = window.setTimeout(() => {
            // Дозамер по смене эпохи целей шагов — не начало шага: прокрутку он не трогает, иначе
            // приехавшая по SSE остановка утаскивала бы маршрут назад к цели шага.
            const initial = scrolledFor.current !== stepId;
            scrolledFor.current = stepId;
            place(initial ? 'first' : 'after');
        }, 0);
        retry(0);

        window.addEventListener('scroll', onMove, true);
        window.addEventListener('resize', onMove);
        window.addEventListener('load', onMove);
        // В jsdom `document.fonts` нет вовсе, а тип это скрывает — отсюда явное приведение.
        const fonts = document.fonts as FontFaceSet | undefined;
        void fonts?.ready.then(onMove, () => undefined);

        return () => {
            cancelled = true;
            window.removeEventListener('scroll', onMove, true);
            window.removeEventListener('resize', onMove);
            window.removeEventListener('load', onMove);
            clearTimeout(retryTimer);
            clearTimeout(startTimer);
            cancelAnimationFrame(frame);
            cancelAnimationFrame(moveFrame);
            describe(null);
        };
    }, [fixed, measureKey, selector, stepId]);

    /*
     * Фокус на карточку при старте шага (§7): без него стрелки тура некуда адресовать. Повтор
     * следующим тактом — из-за шага 06: он открывает панель чата, и её композер забирает фокус
     * себе уже после наших эффектов. На дозамере фокус не трогаем: тур не блокирующий,
     * и ревьюер мог уже уйти в интерфейс.
     */
    useEffect(() => {
        cardRef.current?.focus();
        const timer = window.setTimeout(() => {
            cardRef.current?.focus();
        }, 0);
        return () => {
            clearTimeout(timer);
        };
    }, [stepId]);

    /*
     * Стрелки и Enter принадлежат туру, только пока сфокусирована сама карточка (§7). Ушли
     * табом на её кнопку — клавиши принадлежат кнопке: реестр гасит нажатие `preventDefault`,
     * и иначе Enter на «Пропустить» вёл бы вперёд вместо выхода из тура.
     */
    const focusOnCard = useCallback(() => document.activeElement === cardRef.current, []);
    useShortcut({
        id: 'tour.next',
        keys: ['arrowright', 'enter'],
        label: 'shortcut.tour.next',
        scope: 'global',
        section: 'navigation',
        when: focusOnCard,
        action: onNext,
    });
    useShortcut({
        id: 'tour.back',
        keys: ['arrowleft'],
        label: 'shortcut.tour.back',
        scope: 'global',
        section: 'navigation',
        when: focusOnCard,
        action: onBack,
    });

    return (
        <>
            {placement === null ? null : <TourRing ring={placement.ring} />}
            <TourCard
                step={step}
                index={index}
                total={total}
                placement={placement}
                cardRef={cardRef}
                onSkip={onSkip}
                onBack={onBack}
                onNext={onNext}
            />
            <span className="visually-hidden" role="status" aria-live="polite">
                {t('tour.live', index + 1, total, t(step.title))}
            </span>
        </>
    );
}

/**
 * Цель шага. Каркас тура стоит непрозрачным слоем поверх приглашения или скелета генерации,
 * и у них бывает своя цель с тем же именем (полоса покрытия) — тогда искать надо в каркасе:
 * в порядке документа он второй, а обводить кольцом надо видимое.
 */
function anchorOf(selector: string): HTMLElement | null {
    return (
        document.querySelector<HTMLElement>(`${TOUR_SCAFFOLD_SELECTOR} ${selector}`) ??
        document.querySelector<HTMLElement>(selector)
    );
}

/** Ближайший предок с настоящей вертикальной прокруткой; в нашем UI это `main` вью (§3). */
function scrollerOf(element: HTMLElement): HTMLElement {
    let node = element.parentElement;
    while (node !== null && node !== document.body) {
        const overflow = getComputedStyle(node).overflowY;
        if (/(auto|scroll)/.test(overflow) && node.scrollHeight > node.clientHeight + 4) {
            return node;
        }
        node = node.parentElement;
    }
    return (document.scrollingElement as HTMLElement | null) ?? document.documentElement;
}

function reducedMotion(): boolean {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

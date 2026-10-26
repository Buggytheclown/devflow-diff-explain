/**
 * Позиционирование карточки тура (docs/design/SPEC-onboarding-2026-09-02.md §3). Чистая геометрия: на входе
 * прямоугольник цели и размеры окна, на выходе кольцо, сторона, координаты карточки и смещение
 * клюва. DOM сюда не заходит — все четыре стороны и клампы проверяются юнитами.
 *
 * Формулы — из спеки; прототип (`Sherpa.dc.html`, `tourPlace`) сверен с ними числом в число.
 * Расходится только клюв: у прототипа его смещение от начала кольца ограничено 60/40px, спека
 * же требует центр цели, и приоритет документов ставит спеку выше прототипа.
 */

/** Зазор кольца вокруг цели. */
export const TOUR_PAD = 5;
/** Расстояние от кольца до карточки. */
export const TOUR_GAP = 14;
export const TOUR_CARD_WIDTH = 350;
/** Расчётная высота карточки: по ней выбирается сторона и клампится верх. */
export const TOUR_CARD_HEIGHT = 200;

/** Удобная зона цели по вертикали: выше или ниже неё первый замер шага доскроллит страницу. */
export const TOUR_SCROLL_MARGIN_TOP = 150;
export const TOUR_SCROLL_MARGIN_BOTTOM = 180;

/** Цепочка дозамеров после старта шага (§3): холодная загрузка устаивается позже первого кадра. */
export const TOUR_RETRIES_MS: readonly number[] = [340, 640, 1000, 1600, 2400, 3400];

/** Длительность доводки скролла к цели; под `prefers-reduced-motion` — мгновенный прыжок. */
export const TOUR_SCROLL_MS = 320;

export interface TourRect {
    readonly left: number;
    readonly top: number;
    readonly width: number;
    readonly height: number;
}

export interface TourViewport {
    readonly width: number;
    readonly height: number;
}

export type TourSide = 'below' | 'above' | 'right' | 'left';

export interface TourRing {
    readonly left: number;
    readonly top: number;
    readonly width: number;
    readonly height: number;
}

export interface TourPlacement {
    readonly ring: TourRing;
    readonly side: TourSide;
    /** Координаты карточки в системе `position: fixed`. */
    readonly left: number;
    readonly top: number;
    /** Смещение клюва вдоль стороны карточки, обращённой к цели. */
    readonly beak: number;
}

/** Цель уехала за край окна: кольца нет, карточка встаёт по центру низа (§4). */
export function offscreen(rect: TourRect, viewport: TourViewport): boolean {
    return (
        rect.top + rect.height < 8 ||
        rect.top > viewport.height - 8 ||
        rect.left + rect.width < 8 ||
        rect.left > viewport.width - 8
    );
}

/**
 * Цель вне удобной зоны — первый замер шага доскроллит к ней. Верх цели уезжает на
 * `TOUR_SCROLL_MARGIN_TOP` от верха вьюпорта; дозамер после скролла скроллить уже не имеет права.
 */
export function needsScroll(rect: TourRect, viewport: TourViewport): boolean {
    return rect.top < TOUR_SCROLL_MARGIN_TOP || rect.top > viewport.height - TOUR_SCROLL_MARGIN_BOTTOM;
}

/**
 * Кольцо вокруг цели: цель плюс `pad`, прижатое к краям окна. Отрезанное слева не растягивает
 * кольцо вправо (иначе прижатая к краю цель обводилась бы со сдвигом), а высота клампится
 * вьюпортом — у высокой цели кольцо иначе уехало бы за экран.
 */
export function ringOf(rect: TourRect, viewport: TourViewport): TourRing {
    const left = Math.max(4, rect.left - TOUR_PAD);
    const top = Math.max(-2, rect.top - TOUR_PAD);
    const cutLeft = left - (rect.left - TOUR_PAD);
    return {
        left,
        top,
        width: Math.min(rect.width + TOUR_PAD * 2 - cutLeft, viewport.width - left - 4),
        height: Math.min(rect.height + TOUR_PAD * 2, viewport.height - 24),
    };
}

/** Сторона карточки: снизу по умолчанию, дальше сверху, справа и — последним — слева. */
export function sideOf(ring: TourRing, viewport: TourViewport): TourSide {
    if (ring.top + ring.height + TOUR_GAP + TOUR_CARD_HEIGHT < viewport.height - 12) {
        return 'below';
    }
    if (ring.top - TOUR_GAP - TOUR_CARD_HEIGHT > 12) {
        return 'above';
    }
    if (ring.left + ring.width + TOUR_GAP + TOUR_CARD_WIDTH < viewport.width - 12) {
        return 'right';
    }
    return 'left';
}

/** Полное размещение шага: кольцо, сторона, координаты карточки и клюв. */
export function placeTour(rect: TourRect, viewport: TourViewport): TourPlacement {
    const ring = ringOf(rect, viewport);
    const side = sideOf(ring, viewport);

    let left: number;
    let top: number;
    if (side === 'below') {
        left = clamp(ring.left, 16, viewport.width - TOUR_CARD_WIDTH - 16);
        top = ring.top + ring.height + TOUR_GAP;
    } else if (side === 'above') {
        left = clamp(ring.left, 16, viewport.width - TOUR_CARD_WIDTH - 16);
        top = ring.top - TOUR_GAP - TOUR_CARD_HEIGHT;
    } else if (side === 'right') {
        left = ring.left + ring.width + TOUR_GAP;
        top = ring.top;
    } else {
        left = Math.max(12, ring.left - TOUR_GAP - TOUR_CARD_WIDTH);
        top = ring.top;
    }
    top = Math.min(Math.max(14, top), Math.max(14, viewport.height - TOUR_CARD_HEIGHT - 14));

    /*
     * Клюв смотрит в центр цели (§3) — не кольца: у прижатой к краю окна цели кольцо срезано,
     * а указывать надо всё равно на середину самой цели. Единственное ограничение — скругления
     * карточки: дальше 14px от её углов клюв не уходит, даже если центр цели остался в стороне.
     */
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;
    const beak =
        side === 'below' || side === 'above'
            ? clamp(centerX - left - 4.5, 14, TOUR_CARD_WIDTH - 23)
            : clamp(centerY - top - 4.5, 14, TOUR_CARD_HEIGHT - 23);

    return { ring, side, left, top, beak: Math.round(beak) };
}

/** Кривая доводки скролла — «ease-in-out cubic» спеки. */
export function easeInOutCubic(progress: number): number {
    return progress < 0.5 ? 4 * progress * progress * progress : 1 - Math.pow(-2 * progress + 2, 3) / 2;
}

function clamp(value: number, min: number, max: number): number {
    return Math.min(Math.max(min, value), max);
}

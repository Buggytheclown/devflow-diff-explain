import { describe, expect, it } from 'vitest';

import { easeInOutCubic, needsScroll, offscreen, placeTour, ringOf } from './placement.js';

/**
 * Геометрия карточки тура — docs/design/SPEC-onboarding-2026-09-02.md §3. Числа сверены с реализацией
 * в прототипе (`docs/design/Sherpa.dc.html`, `tourPlace`): расхождение здесь — расхождение с дизайном.
 */

/** Вьюпорт приёмки: все ожидания ниже посчитаны для него. */
const VIEWPORT = { width: 1440, height: 900 };

describe('кольцо', () => {
    it('обводит цель с зазором 5px', () => {
        expect(ringOf({ left: 100, top: 200, width: 300, height: 100 }, VIEWPORT)).toEqual({
            left: 95,
            top: 195,
            width: 310,
            height: 110,
        });
    });

    it('прижатую к левому краю цель не растягивает вправо на отрезанное', () => {
        const ring = ringOf({ left: -20, top: 200, width: 100, height: 40 }, VIEWPORT);

        expect(ring.left).toBe(4);
        // 100 + 2·5 минус 29px, срезанных слева: правый край кольца остаётся на месте.
        expect(ring.width).toBe(81);
    });

    it('высокую цель клампит вьюпортом: кольцо не уезжает за экран', () => {
        expect(ringOf({ left: 100, top: 0, width: 300, height: 2000 }, VIEWPORT).height).toBe(876);
    });
});

describe('сторона и координаты карточки', () => {
    it('по умолчанию встаёт под целью, клюв смотрит в её центр', () => {
        const placement = placeTour({ left: 100, top: 200, width: 300, height: 100 }, VIEWPORT);

        expect(placement.side).toBe('below');
        expect(placement.left).toBe(95);
        expect(placement.top).toBe(319);
        // Центр цели — 250, минус левый край карточки и половина клюва.
        expect(placement.beak).toBe(151);
    });

    it('под целью не помещается — встаёт над ней', () => {
        const placement = placeTour({ left: 100, top: 700, width: 300, height: 150 }, VIEWPORT);

        expect(placement.side).toBe('above');
        expect(placement.top).toBe(481);
        expect(placement.beak).toBe(151);
    });

    it('клюв широкой цели едет за её центром, а не за краем кольца', () => {
        // Полоса покрытия во всю ширину вью: центр далеко от начала цели.
        const placement = placeTour({ left: 40, top: 120, width: 1200, height: 40 }, VIEWPORT);

        expect(placement.side).toBe('below');
        expect(placement.left).toBe(35);
        // Центр — 640; клюв упирается в дальний кламп карточки, а не стоит у её левого угла.
        expect(placement.beak).toBe(327);
    });

    it('у высокой цели уходит вправо, клюв тянется к её центру, пока пускают скругления', () => {
        const placement = placeTour({ left: 100, top: 0, width: 300, height: 880 }, VIEWPORT);

        expect(placement.side).toBe('right');
        expect(placement.left).toBe(419);
        // Верх карточки клампится 14px от края окна; центр цели ниже её низа — клюв в нижнем клампе.
        expect(placement.top).toBe(14);
        expect(placement.beak).toBe(177);
    });

    it('справа места нет — уходит влево', () => {
        const placement = placeTour({ left: 1100, top: 0, width: 300, height: 880 }, VIEWPORT);

        expect(placement.side).toBe('left');
        expect(placement.left).toBe(731);
        expect(placement.beak).toBe(177);
    });

    it('прижатая к правому краю карточка всё равно указывает клювом на цель', () => {
        const placement = placeTour({ left: 1300, top: 100, width: 100, height: 50 }, VIEWPORT);

        expect(placement.side).toBe('below');
        // 1440 − 350 − 16: дальше вправо карточка не едет.
        expect(placement.left).toBe(1074);
        expect(placement.beak).toBe(272);
    });

    it('клюв никогда не выходит за скругления карточки', () => {
        const nearLeft = placeTour({ left: 0, top: 200, width: 20, height: 20 }, VIEWPORT);
        const farRight = placeTour({ left: 1439, top: 200, width: 1, height: 20 }, VIEWPORT);

        expect(nearLeft.beak).toBeGreaterThanOrEqual(14);
        expect(farRight.beak).toBeLessThanOrEqual(327);
    });
});

describe('скролл к цели', () => {
    it('доскроллит только цель вне удобной зоны', () => {
        expect(needsScroll({ left: 0, top: 100, width: 10, height: 10 }, VIEWPORT)).toBe(true);
        expect(needsScroll({ left: 0, top: 800, width: 10, height: 10 }, VIEWPORT)).toBe(true);
        expect(needsScroll({ left: 0, top: 300, width: 10, height: 10 }, VIEWPORT)).toBe(false);
    });

    it('цель за краем окна — запасное размещение без кольца', () => {
        expect(offscreen({ left: 100, top: 910, width: 10, height: 10 }, VIEWPORT)).toBe(true);
        expect(offscreen({ left: 100, top: -20, width: 10, height: 10 }, VIEWPORT)).toBe(true);
        expect(offscreen({ left: 1450, top: 100, width: 10, height: 10 }, VIEWPORT)).toBe(true);
        expect(offscreen({ left: 100, top: 100, width: 10, height: 10 }, VIEWPORT)).toBe(false);
    });

    it('кривая доводки симметрична и упирается в края', () => {
        expect(easeInOutCubic(0)).toBe(0);
        expect(easeInOutCubic(1)).toBe(1);
        expect(easeInOutCubic(0.5)).toBeCloseTo(0.5, 10);
        expect(easeInOutCubic(0.25)).toBeCloseTo(1 - easeInOutCubic(0.75), 10);
    });
});

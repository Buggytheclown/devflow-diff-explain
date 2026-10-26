import { describe, expect, it } from 'vitest';

import type { PixelSurface } from './image-diff.js';
import { diffPixels } from './image-diff.js';

/**
 * Попиксельная разница: что считается изменением (порог, прозрачность, разные размеры) и как
 * выглядит выход. Цвет акцента приходит параметром, поэтому проверяется буквально.
 */

const ACCENT: readonly [number, number, number] = [255, 0, 128];

/** Растр из явных пикселей: `fill` отдаёт RGBA точки. */
function surface(
    width: number,
    height: number,
    fill: (x: number, y: number) => readonly [number, number, number, number],
): PixelSurface {
    const data = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
            const at = (y * width + x) * 4;
            const [r, g, b, a] = fill(x, y);
            data[at] = r;
            data[at + 1] = g;
            data[at + 2] = b;
            data[at + 3] = a;
        }
    }
    return { width, height, data };
}

function solid(width: number, height: number, pixel: readonly [number, number, number, number]): PixelSurface {
    return surface(width, height, () => pixel);
}

/** RGBA пикселя выхода по координатам. */
function pixelAt(result: PixelSurface, x: number, y: number): number[] {
    const at = (y * result.width + x) * 4;
    return [...result.data.slice(at, at + 4)];
}

describe('попиксельная разница', () => {
    it('одинаковые стороны: изменённых нет, фон уходит в приглушённую подложку', () => {
        const side = solid(2, 2, [100, 100, 100, 255]);
        const result = diffPixels(side, solid(2, 2, [100, 100, 100, 255]), { accent: ACCENT });

        expect(result.changed).toBe(0);
        expect(result.total).toBe(4);
        expect(result.sizeMismatch).toBe(false);
        expect(result.width).toBe(2);
        expect(result.height).toBe(2);
        // Обесцвеченный `after` с альфой × 0,35: 255 × 0,35 = 89,25.
        expect(pixelAt(result, 0, 0)).toEqual([100, 100, 100, 89]);
    });

    it('один отличающийся пиксель: счётчик единица, акцент ровно на его месте', () => {
        const before = solid(2, 2, [10, 20, 30, 255]);
        const after = surface(2, 2, (x, y) => (x === 1 && y === 0 ? [10, 20, 200, 255] : [10, 20, 30, 255]));

        const result = diffPixels(before, after, { accent: ACCENT });

        expect(result.changed).toBe(1);
        expect(pixelAt(result, 1, 0)).toEqual([255, 0, 128, 255]);
        expect(pixelAt(result, 0, 0)[3]).toBe(89);
    });

    it('разные размеры: пометка о размерах, хвост одной стороны — изменение', () => {
        const before = solid(2, 1, [10, 10, 10, 255]);
        const after = solid(4, 1, [10, 10, 10, 255]);

        const result = diffPixels(before, after, { accent: ACCENT });

        expect(result.sizeMismatch).toBe(true);
        expect(result.width).toBe(4);
        expect(result.total).toBe(4);
        expect(result.changed).toBe(2);
        expect(pixelAt(result, 3, 0)).toEqual([255, 0, 128, 255]);
    });

    it('пиксель, которого нет ни на одной стороне, изменением не считается', () => {
        // Стороны разъехались крест-накрест: правый нижний угол общего прямоугольника пуст.
        const result = diffPixels(solid(4, 1, [0, 0, 0, 255]), solid(1, 4, [0, 0, 0, 255]), { accent: ACCENT });

        expect(result.total).toBe(16);
        // Общий у сторон один пиксель (0, 0); ещё у шести сторона ровно одна — они и изменение,
        // а оставшиеся девять не принадлежат никому.
        expect(result.changed).toBe(6);
        expect(pixelAt(result, 2, 2)).toEqual([0, 0, 0, 0]);
    });

    it('два полностью прозрачных пикселя равны при любом RGB', () => {
        const result = diffPixels(solid(1, 1, [255, 0, 0, 0]), solid(1, 1, [0, 0, 255, 0]), { accent: ACCENT });

        expect(result.changed).toBe(0);
        // Пиксель остаётся прозрачным: RGB под нулевой альфой ни на что не влияет.
        expect(pixelAt(result, 0, 0)[3]).toBe(0);
    });

    it('порог: канал в пределах допуска тем же и остаётся', () => {
        const before = solid(1, 1, [100, 100, 100, 255]);
        const within = diffPixels(before, solid(1, 1, [105, 100, 100, 255]), { accent: ACCENT, threshold: 8 });
        const beyond = diffPixels(before, solid(1, 1, [110, 100, 100, 255]), { accent: ACCENT, threshold: 8 });
        const exact = diffPixels(before, solid(1, 1, [105, 100, 100, 255]), { accent: ACCENT });

        expect(within.changed).toBe(0);
        expect(beyond.changed).toBe(1);
        // Порог по умолчанию — ноль: точное равенство.
        expect(exact.changed).toBe(1);
    });
});

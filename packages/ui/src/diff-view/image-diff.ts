/**
 * Попиксельная разница двух сторон картинки. Чистая функция без DOM и без цветов темы:
 * растеризует карточка, акцент приезжает параметром — в этом же виде счёт уезжает в веб-воркер.
 */

/** Растр стороны: то же, что `ImageData`, но без привязки к canvas — так его берёт и воркер. */
export interface PixelSurface {
    readonly width: number;
    readonly height: number;
    readonly data: Uint8ClampedArray;
}

export interface DiffPixelsOptions {
    /** Цвет изменённых пикселей: вычисленный токен `--accent` карточки. */
    readonly accent: readonly [number, number, number];
    /** Допуск по каналу RGBA: канал считается тем же, пока разница не больше порога. */
    readonly threshold?: number;
}

export interface ImageDiffResult extends PixelSurface {
    readonly changed: number;
    readonly total: number;
    /** Стороны разного разрешения: счёт шёл по общему прямоугольнику, и это надо сказать вслух. */
    readonly sizeMismatch: boolean;
}

/** Доля, с которой неизменённый фон уходит в подложку: контекст виден, но не спорит с акцентом. */
const CONTEXT_ALPHA = 0.35;

/**
 * Разница по общему прямоугольнику (`max` ширины и высоты, выравнивание по левому верхнему углу —
 * как слои Swipe). Изменённый пиксель — тот, что есть лишь на одной стороне или отличается хотя бы
 * по одному каналу RGBA больше порога; два полностью прозрачных пикселя равны при любом RGB.
 * Пиксель, которого нет ни на одной стороне (стороны разъехались и по ширине, и по высоте),
 * изменением не считается и остаётся в выходе прозрачным.
 */
export function diffPixels(before: PixelSurface, after: PixelSurface, options: DiffPixelsOptions): ImageDiffResult {
    const threshold = options.threshold ?? 0;
    const accentR = options.accent[0];
    const accentG = options.accent[1];
    const accentB = options.accent[2];
    const width = Math.max(before.width, after.width);
    const height = Math.max(before.height, after.height);
    const data = new Uint8ClampedArray(width * height * 4);
    let changed = 0;

    for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
            const out = (y * width + x) * 4;
            const hasBefore = x < before.width && y < before.height;
            const hasAfter = x < after.width && y < after.height;
            const b = (y * before.width + x) * 4;
            const a = (y * after.width + x) * 4;

            let differs = hasBefore !== hasAfter;
            if (hasBefore && hasAfter) {
                const beforeAlpha = before.data[b + 3] ?? 0;
                const afterAlpha = after.data[a + 3] ?? 0;
                differs =
                    (beforeAlpha !== 0 || afterAlpha !== 0) &&
                    (Math.abs((before.data[b] ?? 0) - (after.data[a] ?? 0)) > threshold ||
                        Math.abs((before.data[b + 1] ?? 0) - (after.data[a + 1] ?? 0)) > threshold ||
                        Math.abs((before.data[b + 2] ?? 0) - (after.data[a + 2] ?? 0)) > threshold ||
                        Math.abs(beforeAlpha - afterAlpha) > threshold);
            }

            if (differs) {
                changed += 1;
                data[out] = accentR;
                data[out + 1] = accentG;
                data[out + 2] = accentB;
                data[out + 3] = 255;
            } else if (hasAfter) {
                // Обесцвеченный `after` подложкой: `Uint8ClampedArray` сам округлит и обрежет.
                const luma =
                    0.2126 * (after.data[a] ?? 0) + 0.7152 * (after.data[a + 1] ?? 0) + 0.0722 * (after.data[a + 2] ?? 0);
                data[out] = luma;
                data[out + 1] = luma;
                data[out + 2] = luma;
                data[out + 3] = (after.data[a + 3] ?? 0) * CONTEXT_ALPHA;
            }
        }
    }

    return {
        width,
        height,
        data,
        changed,
        total: width * height,
        sizeMismatch: before.width !== after.width || before.height !== after.height,
    };
}

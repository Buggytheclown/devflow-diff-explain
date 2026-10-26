import type { UiGenerationCap } from '@sherpa/protocol';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import {
    generationCapBannerVisible,
    generationCapMissingFiles,
    GenerationCapBanner,
} from './generation-cap-banner.tsx';

/** Баннер капа генерации: docs/design/SPEC-elements.md §4.1 — план строился по неполному диффу. */

const CAP: UiGenerationCap = { filesCovered: 120, filesTotal: 505, machineFiles: 380, truncated: true };

describe('баннер капа генерации', () => {
    it('поднимается только когда под обрезку попали не машинные файлы', () => {
        expect(generationCapBannerVisible(CAP)).toBe(true);
        expect(generationCapBannerVisible({ ...CAP, truncated: false })).toBe(false);
        expect(generationCapBannerVisible(null)).toBe(false);
    });

    it('считает пропавшие файлы за вычетом машинной группы', () => {
        expect(generationCapMissingFiles(CAP)).toBe(5);
        // Машинных больше, чем выброшено: отрицательного числа быть не должно.
        expect(generationCapMissingFiles({ ...CAP, machineFiles: 500 })).toBe(0);
    });

    it('называет число файлов и отправляет в полный дифф, кнопок не предлагает', () => {
        const html = renderToStaticMarkup(<GenerationCapBanner cap={CAP} />);

        expect(html).toContain('Маршрут построен не по всему диффу');
        expect(html).toContain('5 файлов не влезли');
        expect(html).toContain('Полном диффе');
        expect(html).not.toContain('<button');
    });
});

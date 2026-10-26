// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';

import { TOUR_CARD_BODY_ID } from './tour-card.tsx';
import { TourLayer } from './tour-layer.tsx';
import type { TourStep } from './tour-model.js';
import { tourSteps } from './tour-model.js';

/**
 * Выбор цели шага слоем тура. Геометрию тут не проверить — в jsdom у всего нулевые прямоугольники,
 * — зато видно, кого слой выбрал целью: он одалживает ей `aria-describedby` на тело карточки (§7).
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const PROGRESS: TourStep = step('progress');

const mounted: (() => void)[] = [];

afterEach(() => {
    for (const unmount of mounted.splice(0)) {
        unmount();
    }
    document.body.innerHTML = '';
});

function step(id: TourStep['id']): TourStep {
    const found = tourSteps(true).find((candidate) => candidate.id === id);
    if (found === undefined) {
        throw new Error(`нет шага ${id}`);
    }
    return found;
}

/** Разметка страницы под слоем: цели шагов расставляются в порядке документа. */
function page(html: string): void {
    document.body.innerHTML = html;
}

async function mountLayer(current: TourStep): Promise<() => void> {
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    act(() => {
        root.render(<TourLayer step={current} index={0} total={8} epoch="test" {...NOOPS} />);
    });
    // Первый замер отложен на такт: разметка шага должна успеть встать до того, как её меряют.
    await act(async () => {
        await new Promise((resolve) => {
            setTimeout(resolve, 5);
        });
    });
    const unmount = (): void => {
        act(() => {
            root.unmount();
        });
        host.remove();
    };
    mounted.push(unmount);
    return unmount;
}

const NOOPS = {
    onNext: (): void => undefined,
    onBack: (): void => undefined,
    onSkip: (): void => undefined,
};

function described(id: string): boolean {
    return document.getElementById(id)?.getAttribute('aria-describedby') === TOUR_CARD_BODY_ID;
}

describe('цель шага', () => {
    it('берётся из каркаса тура, когда тот стоит поверх вью с такой же целью', async () => {
        // Скелет генерации несёт свою полосу покрытия, каркас — свою; видна вторая.
        page(`
            <div class="route-skeleton__bar"><div id="under" data-tour="progress"></div></div>
            <div class="tour-scaffold"><div id="scaffold" data-tour="progress"></div></div>
        `);

        await mountLayer(PROGRESS);

        expect(described('scaffold')).toBe(true);
        expect(described('under')).toBe(false);
    });

    it('без каркаса берётся цель самого вью', async () => {
        page('<div class="route-toolbar"><div id="under" data-tour="progress"></div></div>');

        await mountLayer(PROGRESS);

        expect(described('under')).toBe(true);
    });

    it('одолженный `aria-describedby` снимается вместе со слоем', async () => {
        page('<div id="under" data-tour="progress"></div>');

        const unmount = await mountLayer(PROGRESS);
        expect(described('under')).toBe(true);

        unmount();
        expect(document.getElementById('under')?.hasAttribute('aria-describedby')).toBe(false);
    });
});

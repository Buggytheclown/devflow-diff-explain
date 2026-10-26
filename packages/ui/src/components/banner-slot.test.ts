import { describe, expect, it } from 'vitest';

import type { BannerSource } from './banner-slot.tsx';
import { BANNER_PRIORITY, selectBanners } from './banner-slot.tsx';

function source(id: string, priority: number, active = true): BannerSource {
    return { id, priority, active: () => active, render: () => id };
}

describe('слот баннеров', () => {
    it('выбирает активный баннер с наибольшим приоритетом и оставляет остальные свёрнутыми', () => {
        const selection = selectBanners([
            source('audit-scope', 100),
            source('route-stale', 200, false),
            source('generation-failed', 400),
        ]);

        expect(selection.primary?.id).toBe('generation-failed');
        expect(selection.hidden.map((item) => item.id)).toEqual(['audit-scope']);
    });

    it('не включает источники, чьё условие закончилось', () => {
        const selection = selectBanners([
            source('generation-failed', 400, false),
            source('audit-scope', 100),
        ]);

        expect(selection.primary?.id).toBe('audit-scope');
        expect(selection.hidden).toEqual([]);
    });

    it('лестница приоритетов целиком: провал → провал действия → перестройка → устарел → второй заход → недообъяснён → заполнение → аудит', () => {
        const selection = selectBanners([
            source('audit-scope', BANNER_PRIORITY.auditScope),
            source('route-filling', BANNER_PRIORITY.routeFilling),
            source('route-under-explained', BANNER_PRIORITY.routeUnderExplained),
            source('route-second-pass', BANNER_PRIORITY.routeSecondPass),
            source('route-stale', BANNER_PRIORITY.routeStale),
            source('route-regenerating', BANNER_PRIORITY.routeRegenerating),
            source('route-action-error', BANNER_PRIORITY.routeActionError),
            source('generation-failed', BANNER_PRIORITY.generationFailed),
        ]);

        expect([selection.primary?.id, ...selection.hidden.map((item) => item.id)]).toEqual([
            'generation-failed',
            'route-action-error',
            'route-regenerating',
            'route-stale',
            'route-second-pass',
            'route-under-explained',
            'route-filling',
            'audit-scope',
        ]);
        expect(BANNER_PRIORITY.routeStale).toBe(250);
        expect(BANNER_PRIORITY.routeSecondPass).toBe(220);
    });

    it('кап генерации стоит ниже аудит-скоупа — в самом низу лестницы', () => {
        const selection = selectBanners([
            source('audit-scope', BANNER_PRIORITY.auditScope),
            source('generation-cap', BANNER_PRIORITY.generationCap),
            source('notes-lost', BANNER_PRIORITY.notesLost),
        ]);

        expect([selection.primary?.id, ...selection.hidden.map((item) => item.id)]).toEqual([
            'notes-lost',
            'audit-scope',
            'generation-cap',
        ]);
        expect(BANNER_PRIORITY.generationCap).toBeLessThan(BANNER_PRIORITY.auditScope);
    });

    it('язык маршрута стоит между капом генерации и чужим шипом', () => {
        const selection = selectBanners([
            source('ship-verdict', BANNER_PRIORITY.shipVerdict),
            source('route-locale-mismatch', BANNER_PRIORITY.routeLocaleMismatch),
            source('generation-cap', BANNER_PRIORITY.generationCap),
        ]);

        expect([selection.primary?.id, ...selection.hidden.map((item) => item.id)]).toEqual([
            'generation-cap',
            'route-locale-mismatch',
            'ship-verdict',
        ]);
        expect(BANNER_PRIORITY.routeLocaleMismatch).toBeLessThan(BANNER_PRIORITY.generationCap);
        expect(BANNER_PRIORITY.routeLocaleMismatch).toBeGreaterThan(BANNER_PRIORITY.shipVerdict);
    });

    it('ручка не отработала при живом агенте: причина действия наверху слота', () => {
        const selection = selectBanners([
            source('audit-scope', BANNER_PRIORITY.auditScope),
            source('route-action-error', BANNER_PRIORITY.routeActionError),
            source('generation-failed', BANNER_PRIORITY.generationFailed, false),
        ]);

        expect(selection.primary?.id).toBe('route-action-error');
    });

    it('маршрут недообъяснён посреди заполнения: сверху недообъяснённость, остальное свёрнуто', () => {
        const selection = selectBanners([
            source('audit-scope', BANNER_PRIORITY.auditScope),
            source('route-filling', BANNER_PRIORITY.routeFilling),
            source('route-under-explained', BANNER_PRIORITY.routeUnderExplained),
            source('generation-failed', BANNER_PRIORITY.generationFailed, false),
        ]);

        expect(selection.primary?.id).toBe('route-under-explained');
        expect(selection.hidden.map((item) => item.id)).toEqual(['route-filling', 'audit-scope']);
    });

    it('отключение агента слоту не источник: статус живёт в индикаторе', () => {
        expect(Object.keys(BANNER_PRIORITY)).not.toContain('agentDisconnected');
    });
});

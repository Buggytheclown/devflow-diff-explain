import { describe, expect, it } from 'vitest';

import { auditScopeBannerVisible } from './audit-banner.tsx';

describe('баннер аудит-скоупа', () => {
    it('показывается там, где фильтр скрывает файлы: Full diff и маршрут', () => {
        expect(auditScopeBannerVisible('diff', 'pci', false, 3)).toBe(true);
        expect(auditScopeBannerVisible('route', 'pci', false, 3)).toBe(true);
        expect(auditScopeBannerVisible('overview', 'pci', false, 3)).toBe(false);
        expect(auditScopeBannerVisible('diff', 'all', false, 3)).toBe(false);
    });

    it('скрывается после dismiss и для пустого скоупа', () => {
        expect(auditScopeBannerVisible('diff', 'pci', true, 3)).toBe(false);
        expect(auditScopeBannerVisible('diff', 'pci', false, 0)).toBe(false);
    });
});

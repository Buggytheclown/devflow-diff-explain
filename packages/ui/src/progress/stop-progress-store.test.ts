import { describe, expect, it } from 'vitest';

import { createStopProgressStore } from './stop-progress-store.js';

/** Отметки остановок: оптимистичный слой, откат и замена серверным снимком. */
describe('стор отметок остановок', () => {
    it('отметка видна подписчику, а серверный снимок заменяет состояние целиком', () => {
        const store = createStopProgressStore([{ stopId: 's01', viewed: true }]);
        let notified = 0;
        store.subscribe(() => {
            notified += 1;
        });

        expect(store.isViewed('s01')).toBe(true);
        store.setViewed('s02', true);
        expect(notified).toBe(1);

        store.setAll([{ stopId: 's03', viewed: true }]);

        expect(store.isViewed('s01')).toBe(false);
        expect(store.isViewed('s03')).toBe(true);
        expect(notified).toBe(2);
    });

    it('повторная отметка тем же значением подписчиков не будит', () => {
        const store = createStopProgressStore();
        let notified = 0;
        store.subscribe(() => {
            notified += 1;
        });

        store.setViewed('s01', true);
        store.setViewed('s01', true);

        expect(notified).toBe(1);
    });

    it('откат к «записи не было» убирает ключ, а не пишет false', () => {
        const store = createStopProgressStore();
        store.setViewed('s01', true);

        store.restore('s01', null);

        expect(store.getSnapshot().has('s01')).toBe(false);
        expect(store.isViewed('s01')).toBe(false);
    });
});

import { describe, expect, it } from 'vitest';

import type { StopBox } from './scroll.js';
import { pickTopStop } from './scroll.js';

/**
 * Выбор якоря прокрутки (docs/design/SPEC-elements.md §2.5): от него зависят и удержание остановки при смене фильтра,
 * и восстановление позиции при смене пресета. Координаты берутся как есть — DOM тут не нужен.
 */

/** Контейнер начинается на 100px, липкий тулбар высотой 99px закрывает полосу до 199px. */
const CONTAINER_TOP = 100;
const LINE = 199;

function boxes(...rows: readonly [string, number, number][]): StopBox[] {
    return rows.map(([stopId, top, bottom]) => ({ stopId, top, bottom }));
}

describe('pickTopStop', () => {
    it('берёт первую остановку, видимую под тулбаром', () => {
        const anchor = pickTopStop(CONTAINER_TOP, LINE, boxes(['s01', -400, 250], ['s02', 250, 900]));

        expect(anchor).toEqual({ stopId: 's01', offset: -500 });
    });

    it('не берёт остановку, чей хвост целиком спрятан под тулбаром', () => {
        // Хвост s01 (30px) виден только в полосе тулбара — читают уже s02.
        const anchor = pickTopStop(CONTAINER_TOP, LINE, boxes(['s01', -400, 169], ['s02', 169, 900]));

        expect(anchor).toEqual({ stopId: 's02', offset: 69 });
    });

    it('смещение считается от кромки контейнера, а не от тулбара', () => {
        const anchor = pickTopStop(CONTAINER_TOP, LINE, boxes(['s03', 140, 800]));

        // Остановка начинается под тулбаром — восстановление вернёт её ровно на те же 40px.
        expect(anchor).toEqual({ stopId: 's03', offset: 40 });
    });

    it('без видимых остановок якоря нет — прежний не переписывается', () => {
        expect(pickTopStop(CONTAINER_TOP, LINE, boxes())).toBeNull();
        expect(pickTopStop(CONTAINER_TOP, LINE, boxes(['s07', -900, 150]))).toBeNull();
    });
});

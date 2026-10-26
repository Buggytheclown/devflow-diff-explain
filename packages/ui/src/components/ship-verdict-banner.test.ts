import type { ReviewerVerdict } from '@sherpa/protocol';
import { describe, expect, it } from 'vitest';

import { INITIAL_SHIP_VERDICT_WATCH, newShipVerdict, observeShipVerdicts } from './ship-verdict-banner.tsx';

/** «Кто-то шипнул раньше»: событие — появление чужого шипа, а не сам факт шипа. */

function verdict(login: string, value: ReviewerVerdict['verdict']): ReviewerVerdict {
    return { user: { login, displayName: null, bot: false, avatarUrl: null }, verdict: value };
}

const NOW = Date.parse('2026-09-03T12:00:00.000Z');

describe('новый чужой шип', () => {
    it('первый снапшот — базовая линия, события из него не бывает', () => {
        expect(newShipVerdict(null, [verdict('lead', 'ship')], NOW)).toBeNull();
    });

    it('появившийся ship даёт событие с моментом наблюдения', () => {
        expect(newShipVerdict([], [verdict('lead', 'ship')], NOW)).toEqual({
            login: 'lead',
            displayName: null,
            observedAt: NOW,
        });
    });

    it('sticky_ship считается тем же событием', () => {
        expect(newShipVerdict([], [verdict('lead', 'sticky_ship')], NOW)?.login).toBe('lead');
    });

    it('уже виденный шип события не даёт, а request_changes им и не был', () => {
        expect(newShipVerdict([verdict('lead', 'ship')], [verdict('lead', 'ship')], NOW)).toBeNull();
        expect(newShipVerdict([], [verdict('picky', 'request_changes')], NOW)).toBeNull();
    });

    it('шип второго ревьюера — новое событие', () => {
        expect(
            newShipVerdict([verdict('lead', 'ship')], [verdict('lead', 'ship'), verdict('peer', 'ship')], NOW)?.login,
        ).toBe('peer');
    });
});

describe('наблюдение за вердиктами', () => {
    it('свой шип после своей публикации баннера не даёт, следующий чужой — даёт', () => {
        const base = observeShipVerdicts(INITIAL_SHIP_VERDICT_WATCH, [], NOW);
        expect(base.event).toBeNull();

        // Публикация из Шерпы: свой вердикт вот-вот приедет в мете.
        const published = { ...base.watch, ownShipPending: true };
        const own = observeShipVerdicts(published, [verdict('alice', 'ship')], NOW);
        expect(own.event).toBeNull();

        const other = observeShipVerdicts(own.watch, [verdict('alice', 'ship'), verdict('lead', 'ship')], NOW);
        expect(other.event?.login).toBe('lead');
    });

    it('своя публикация не глушит шипы, которых после неё не было', () => {
        const base = observeShipVerdicts(INITIAL_SHIP_VERDICT_WATCH, [], NOW);
        const published = { ...base.watch, ownShipPending: true };

        // Снапшоты без новых вердиктов ожидание своего шипа не расходуют.
        const quiet = observeShipVerdicts(published, [], NOW);
        expect(quiet.watch.ownShipPending).toBe(true);
    });
});

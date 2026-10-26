import { describe, expect, it } from 'vitest';

import { updateFragment } from '../fragment.js';
import type { Viewing } from '../iterations/viewing.js';
import { VIEWING_CURRENT } from '../iterations/viewing.js';
import { sessionFragmentPatch } from './session-fragment.js';
import { createSessionStore } from './session-store.js';

/**
 * Что выбор итерации пишет в адрес: срез уезжает парой `base`/`head`,
 * смена выбора уносит с собой якоря прошлого, возврат к активной итерации чистит адрес.
 */

const SLICE: Viewing = { kind: 'slice', base: '182799', head: '182801' };

function fragmentAfter(steps: readonly Viewing[], initialHash: string): string {
    let hash = initialHash;
    let previous: Viewing = VIEWING_CURRENT;
    const session = createSessionStore({
        initial: { view: 'diff', filter: 'all' },
        persist: (state) => {
            hash = updateFragment(hash, sessionFragmentPatch(state, previous));
            previous = state.viewing;
        },
    });
    for (const viewing of steps) {
        session.setViewing(viewing);
    }
    return hash;
}

describe('выбор итерации в адресе', () => {
    it('срез пишется парой base/head и уносит якоря прошлого выбора', () => {
        const hash = fragmentAfter([SLICE], '#t=токен&view=diff&file=f1&line=12&thread=t1');
        const params = new URLSearchParams(hash.slice(1));

        expect(params.get('base')).toBe('182799');
        expect(params.get('head')).toBe('182801');
        expect(params.get('file')).toBeNull();
        expect(params.get('line')).toBeNull();
        expect(params.get('thread')).toBeNull();
        expect(params.get('diff')).toBeNull();
    });

    it('возврат к активной итерации убирает срез из адреса', () => {
        const hash = fragmentAfter([SLICE, VIEWING_CURRENT], '#t=токен&view=diff');
        const params = new URLSearchParams(hash.slice(1));

        expect(params.get('base')).toBeNull();
        expect(params.get('head')).toBeNull();
        expect(params.get('t')).toBe('токен');
    });

    it('переход со среза на прошлую итерацию оставляет только её', () => {
        const hash = fragmentAfter([SLICE, { kind: 'diff', diffId: '182799' }], '#t=токен&view=diff');
        const params = new URLSearchParams(hash.slice(1));

        expect(params.get('diff')).toBe('182799');
        expect(params.get('base')).toBeNull();
        expect(params.get('head')).toBeNull();
    });
});

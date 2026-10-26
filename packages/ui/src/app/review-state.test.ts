import { describe, expect, it } from 'vitest';

import { createT } from '../i18n/index.js';

import { draftDestinationOf, hostDisplayName, isLocalHost } from './review-state.js';

/**
 * Имя хоста в текстах UI. Локальных адаптеров два — arc и git, — но ревьюеру на экране
 * видно одно: чекаут у него под рукой, а какая за ним VCS, в подписи не участвует.
 */

describe('локальный хост в текстах UI', () => {
    it('локальными считаются оба адаптера, чужие — нет', () => {
        expect(isLocalHost('local-arc')).toBe(true);
        expect(isLocalHost('local-git')).toBe(true);
        expect(isLocalHost('arcanum')).toBe(false);
        expect(isLocalHost('fixture')).toBe(false);
        expect(isLocalHost(null)).toBe(false);
    });

    it('подпись локального чекаута одна на оба адаптера', () => {
        const t = createT('ru');

        expect(hostDisplayName('local-git', t)).toBe(hostDisplayName('local-arc', t));
        expect(hostDisplayName('local-git', t)).toBe(t('host.local'));
        expect(hostDisplayName('arcanum', t)).toBe(t('host.arcanum'));
        expect(hostDisplayName('fixture', t)).toBe('FixtureHost');
    });

    it('черновики локального ревью уходят агенту, у остальных хостов — в PR', () => {
        expect(draftDestinationOf('local-arc')).toBe('agent');
        expect(draftDestinationOf('local-git')).toBe('agent');
        expect(draftDestinationOf('arcanum')).toBe('pr');
        expect(draftDestinationOf('github')).toBe('pr');
    });
});

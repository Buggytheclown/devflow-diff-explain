import { describe, expect, it } from 'vitest';

import { fuzzyMatch } from './fuzzy.js';

describe('fuzzyMatch', () => {
    it('ищет порядковую подпоследовательность без учёта регистра', () => {
        expect(fuzzyMatch('market/Handlers.ts', 'hdt')).toBe(true);
        expect(fuzzyMatch('market/Handlers.ts', 'HDR')).toBe(true);
    });

    it('не принимает переставленные или недостающие символы', () => {
        expect(fuzzyMatch('handlers.ts', 'hred')).toBe(false);
        expect(fuzzyMatch('handlers.ts', 'handlerz')).toBe(false);
    });

    it('пустой запрос совпадает с любым текстом', () => {
        expect(fuzzyMatch('a.ts', '   ')).toBe(true);
    });
});

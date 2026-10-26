import { describe, expect, it } from 'vitest';

import { parsePaletteQuery } from './query.js';

describe('parsePaletteQuery', () => {
    it('обычный текст остаётся fuzzy-запросом', () => {
        expect(parsePaletteQuery(' handlers ')).toEqual({ kind: 'browse', text: 'handlers' });
    });

    it('@ включает поиск по истории чата', () => {
        expect(parsePaletteQuery('@ окно ')).toEqual({ kind: 'chat', text: 'окно' });
        expect(parsePaletteQuery('@')).toEqual({ kind: 'chat', text: '' });
    });

    it('/ включает поиск по содержимому диффа', () => {
        expect(parsePaletteQuery('/ orderId ')).toEqual({ kind: 'diff', text: 'orderId' });
        expect(parsePaletteQuery('/')).toEqual({ kind: 'diff', text: '' });
    });

    it(': принимает только положительный целый номер строки', () => {
        expect(parsePaletteQuery(': 42')).toEqual({ kind: 'line', line: 42 });
        expect(parsePaletteQuery(':0')).toEqual({ kind: 'line', line: null });
        expect(parsePaletteQuery(':abc')).toEqual({ kind: 'line', line: null });
    });
});

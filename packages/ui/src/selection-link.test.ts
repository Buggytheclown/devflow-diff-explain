import { describe, expect, it } from 'vitest';

import { readSelectionLink, selectionLinkHash } from './selection-link.js';

describe('ссылка на диапазон диффа', () => {
    it('добавляет параметры, сохраняя токен, вью и остальные параметры', () => {
        expect(
            selectionLinkHash('#t=secret&view=route&filter=mine&thread=42&stop=s01', {
                fileId: 'f/1',
                path: 'src/cache.ts',
                side: 'new',
                start: 11,
                end: 14,
            }),
        ).toBe('#t=secret&view=route&filter=mine&file=f%2F1&side=new&line=11&end=14');
    });

    it('читает только полный валидный диапазон', () => {
        expect(readSelectionLink('#file=f1&side=old&line=7&end=9')).toEqual({
            fileId: 'f1',
            side: 'old',
            start: 7,
            end: 9,
        });
        expect(readSelectionLink('#file=f1&side=new&line=9&end=7')).toBeNull();
        expect(readSelectionLink('#file=f1&side=new&line=x&end=9')).toBeNull();
    });
});

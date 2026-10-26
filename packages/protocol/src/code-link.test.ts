import { describe, expect, it } from 'vitest';

import { codeLink, parseCodeLink } from './code-link.js';

describe('адрес кода в сохранённой версии вопроса', () => {
    it('сохраняет пробелы, кириллицу и сторону диапазона', () => {
        const location = { path: 'src/папка с пробелом/a.ts', side: 'old' as const, start: 14, end: 18 };
        expect(parseCodeLink(codeLink(location))).toEqual(location);
    });
    it.each([
        '#code?path=../secret&side=new&start=1&end=1',
        '#code?path=%2Fetc%2Fpasswd&side=new&start=1&end=1',
        '#code?path=a&side=new&start=0&end=1',
        '#code?path=a&side=new&start=2&end=1',
        '#code?path=a&side=new&start=1&end=1000000000',
        '#code?path=a&side=new&start=1&end=1&path=b',
        '#code?path=a&side=new&start=1&end=1&diffId=other',
        'https://example.com/file.ts:1',
    ])('отвергает чужие/неоднозначные координаты: %s', (href) => {
        expect(parseCodeLink(href)).toBeNull();
    });
});

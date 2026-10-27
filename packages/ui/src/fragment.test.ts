import { describe, expect, it } from 'vitest';

import { parseFragment, readFragmentParam, readToken, updateFragment } from './fragment.js';

describe('readToken', () => {
    it('читает короткий параметр t первым', () => {
        expect(readToken('#t=abc123')).toBe('abc123');
        expect(readToken('#token=old&t=new')).toBe('new');
    });

    it('читает старый token для совместимости с живым сервером', () => {
        expect(readToken('#pr=arcanum-1&token=abc123')).toBe('abc123');
        expect(readToken('token=abc123')).toBe('abc123');
    });

    it('нет токена или он пустой — null', () => {
        expect(readToken('')).toBeNull();
        expect(readToken('#')).toBeNull();
        expect(readToken('#t=&token=')).toBeNull();
        expect(readToken('#other=1')).toBeNull();
    });
});

describe('readFragmentParam', () => {
    it('читает произвольный параметр', () => {
        expect(readFragmentParam('#token=abc&view=route', 'view')).toBe('route');
        expect(readFragmentParam('#token=abc', 'view')).toBeNull();
    });

    it('значения декодируются', () => {
        expect(readFragmentParam('#path=src%2Fapp.ts', 'path')).toBe('src/app.ts');
    });
});

describe('updateFragment', () => {
    it('добавляет параметр, не трогая остальные', () => {
        expect(updateFragment('#token=abc', { view: 'route' })).toBe('#token=abc&view=route');
    });

    it('заменяет значение на месте', () => {
        expect(updateFragment('#t=abc&view=overview', { view: 'diff' })).toBe('#t=abc&view=diff');
    });

    it('не оставляет одновременно t и старый token', () => {
        expect(updateFragment('#token=old&view=route', { t: 'new' })).toBe('#t=new&view=route');
        expect(updateFragment('#t=new&token=old&view=route', { view: 'diff' })).toBe('#t=new&view=diff');
        expect(updateFragment('#t=new', { token: 'old' })).toBe('#token=old');
    });

    it('ссылка на тред сохраняет token и view, но убирает конфликтующую цель file', () => {
        expect(updateFragment('#token=abc&view=diff&file=f1', { thread: 'thread-7', file: null })).toBe(
            '#token=abc&view=diff&thread=thread-7',
        );
    });

    it('null убирает параметр', () => {
        expect(updateFragment('#token=abc&view=diff', { view: null })).toBe('#token=abc');
    });

    it('пустой фрагмент остаётся пустым, а не «#»', () => {
        expect(updateFragment('', { view: null })).toBe('');
    });

    it('работает от пустого фрагмента', () => {
        expect(updateFragment('', { view: 'route' })).toBe('#view=route');
    });
});

describe('parseFragment', () => {
    it('разбирает фрагмент как URLSearchParams', () => {
        expect([...parseFragment('#a=1&b=2')]).toEqual([
            ['a', '1'],
            ['b', '2'],
        ]);
    });
});

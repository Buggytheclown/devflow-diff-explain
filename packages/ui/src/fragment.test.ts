import { describe, expect, it } from 'vitest';

import { DEFAULT_ROUTE_FILTER, parseRouteFilter } from './session/session-store.js';
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

/**
 * Фильтр «что нового» ходит через фрагмент так же, как пресет: main.tsx читает его при старте
 * и пишет обратно в `persist`. Тест держит ровно эту композицию — сам main.tsx рендерит корень
 * и в vitest не поднимается.
 */
describe('фильтр маршрута во фрагменте', () => {
    const read = (hash: string) => parseRouteFilter(readFragmentParam(hash, 'routeFilter')) ?? DEFAULT_ROUTE_FILTER;
    const write = (hash: string, routeFilter: 'all' | 'new') =>
        updateFragment(hash, { routeFilter: routeFilter === DEFAULT_ROUTE_FILTER ? null : routeFilter });

    it('читается из адреса, мусор и отсутствие дают дефолт', () => {
        expect(read('#t=abc&routeFilter=new')).toBe('new');
        expect(read('#t=abc&routeFilter=мусор')).toBe('all');
        expect(read('#t=abc')).toBe('all');
    });

    it('пишется обратно, дефолт в адрес не уходит', () => {
        expect(write('#t=abc&view=route', 'new')).toBe('#t=abc&view=route&routeFilter=new');
        expect(write('#t=abc&view=route&routeFilter=new', 'all')).toBe('#t=abc&view=route');
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

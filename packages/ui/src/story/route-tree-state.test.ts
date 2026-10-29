import { expect, it } from 'vitest';
import { createRouteTree, routeTreeReducer as reduce } from './route-tree-state.js';

it('новое открытие свёрнуто, восстановленное место раскрывает только свой блок', () => {
    expect(createRouteTree(null, 0).blocks.size).toBe(0);
    expect([...createRouteTree('b', 0).blocks.keys()]).toEqual(['b']);
    expect(createRouteTree('b', 0).blocks.get('b')?.open).toBe(true);
});

it('ручное сворачивание переживает смену файла того же блока и обновление пояснений', () => {
    const open = createRouteTree('a', 1);
    const manual = reduce(open, { kind: 'block', id: 'a' });
    expect(reduce(manual, { kind: 'activate', id: 'a', reveal: 1 })).toBe(manual);
    const next = reduce(manual, { kind: 'activate', id: 'b', reveal: 1 });
    expect(next.blocks.get('a')?.open).toBe(false); expect(next.blocks.get('b')?.open).toBe(true);
    expect(reduce(next, { kind: 'activate', id: 'a', reveal: 2 }).blocks.get('a')?.open).toBe(true);
});

it('новый блок не сворачивает прежние, явный переход раскрывает его каталоги', () => {
    const start = createRouteTree('a', 0);
    const closed = reduce(start, { kind: 'directory', id: 'a', path: 'src:one' });
    const next = reduce(closed, { kind: 'activate', id: 'b', reveal: 0 });
    expect(next.blocks.get('a')?.open).toBe(true); expect(next.blocks.get('a')?.toggled.has('src:one')).toBe(true);
    const back = reduce(next, { kind: 'activate', id: 'a', reveal: 1 });
    expect(back.blocks.get('a')?.toggled.size).toBe(0); expect(back.blocks.get('b')?.open).toBe(true);
});

it('свернуть и развернуть всё не меняет текущий блок и не отменяется слежением', () => {
    const all = reduce(createRouteTree('a', 1), { kind: 'all', ids: ['a', 'b'], open: true });
    const none = reduce(all, { kind: 'all', ids: ['a', 'b'], open: false });
    expect([...none.blocks.values()].every((block) => !block.directoriesOpen)).toBe(true);
    expect([...all.blocks.values()].every((block) => block.directoriesOpen)).toBe(true);
    expect(none.active).toBe('a'); expect([...none.blocks.values()].every((block) => !block.open)).toBe(true);
    expect(reduce(none, { kind: 'activate', id: 'a', reveal: 1 })).toBe(none);
    const next = reduce(none, { kind: 'activate', id: 'b', reveal: 1 });
    expect(next.blocks.get('a')?.open).toBe(false); expect(next.blocks.get('b')?.open).toBe(true);
});

it('идентификаторы блоков не зависят от свойств Object', () => {
    const start = createRouteTree(null, 0);
    for (const id of ['constructor', '__proto__']) {
        const expanded = reduce(start, { kind: 'block', id });
        expect(expanded.blocks.get(id)?.open).toBe(true);
        expect(start.blocks.has(id)).toBe(false);
    }
});

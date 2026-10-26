import { describe, expect, it } from 'vitest';

import { neighbourId, unreadNeighbourId } from './navigation.js';

interface Item {
    readonly id: string;
    readonly viewed: boolean;
}

const idOf = (item: Item): string => item.id;
const unread = (item: Item): boolean => !item.viewed;

function items(...spec: readonly (readonly [string, boolean])[]): readonly Item[] {
    return spec.map(([id, viewed]) => ({ id, viewed }));
}

describe('neighbourId', () => {
    const list = items(['a', false], ['b', false], ['c', false]);

    it('ведёт вперёд и назад по списку', () => {
        expect(neighbourId(list, 'a', 1, idOf)).toBe('b');
        expect(neighbourId(list, 'b', -1, idOf)).toBe('a');
    });

    it('на краях списка возвращает null — цикла нет', () => {
        expect(neighbourId(list, 'c', 1, idOf)).toBeNull();
        expect(neighbourId(list, 'a', -1, idOf)).toBeNull();
    });

    it('без текущей записи целью становится первая', () => {
        expect(neighbourId(list, null, 1, idOf)).toBe('a');
        expect(neighbourId(list, 'нет такой', -1, idOf)).toBe('a');
    });

    it('пустой список — null', () => {
        expect(neighbourId([], null, 1, idOf)).toBeNull();
    });
});

describe('unreadNeighbourId', () => {
    it('пропускает просмотренные', () => {
        const list = items(['a', false], ['b', true], ['c', false]);

        expect(unreadNeighbourId(list, 'a', 1, idOf, unread)).toBe('c');
        expect(unreadNeighbourId(list, 'c', -1, idOf, unread)).toBe('a');
    });

    it('с конца списка продолжает с начала', () => {
        const list = items(['a', false], ['b', true], ['c', true]);

        expect(unreadNeighbourId(list, 'c', 1, idOf, unread)).toBe('a');
        expect(unreadNeighbourId(list, 'a', -1, idOf, unread)).toBe('a');
    });

    it('без непросмотренных возвращает null', () => {
        const list = items(['a', true], ['b', true]);

        expect(unreadNeighbourId(list, 'a', 1, idOf, unread)).toBeNull();
    });

    it('без текущей записи ищет от края: вперёд с начала, назад с конца', () => {
        const list = items(['a', false], ['b', true], ['c', false]);

        expect(unreadNeighbourId(list, null, 1, idOf, unread)).toBe('a');
        expect(unreadNeighbourId(list, null, -1, idOf, unread)).toBe('c');
    });
});

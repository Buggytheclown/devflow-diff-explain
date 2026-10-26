import { afterEach, describe, expect, it, vi } from 'vitest';

import { newUuid } from './uuid.js';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Счётчик вместо энтропии: значения предсказуемы, а версия и вариант всё равно обязаны встать. */
function countingRandomValues(): (array: Uint8Array) => Uint8Array {
    let next = 0;
    return (array) => {
        for (let index = 0; index < array.length; index += 1) {
            array[index] = next;
            next = (next + 1) % 256;
        }
        return array;
    };
}

describe('newUuid', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('в безопасном контексте отдаёт UUID v4 родного crypto', () => {
        expect(newUuid()).toMatch(UUID_V4);
        expect(newUuid()).not.toBe(newUuid());
    });

    it('без randomUUID собирает UUID v4 из getRandomValues', () => {
        const getRandomValues = vi.fn(countingRandomValues());
        vi.stubGlobal('crypto', { getRandomValues });

        const first = newUuid();
        expect(first).toMatch(UUID_V4);
        expect(newUuid()).not.toBe(first);
        // Иначе тест прошёл бы и на родном randomUUID, не проверив фолбэк.
        expect(getRandomValues).toHaveBeenCalledTimes(2);
    });
});

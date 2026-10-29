import { expect, it } from 'vitest';
import { numberedBlockTitle } from './block-title.js';

it.each(['Контракт', '1. Контракт', '1.Контракт', '1) Контракт', '1.1. Контракт', '1. 1. Контракт'])('показывает один порядковый номер: %s', (title) => {
    expect(numberedBlockTitle(title, 2)).toBe('3. Контракт');
});
it('не удаляет значимое число или версию в названии', () => {
    expect(numberedBlockTitle('API 2.0', 0)).toBe('1. API 2.0');
    expect(numberedBlockTitle('2.0 секунды ожидания', 0)).toBe('1. 2.0 секунды ожидания');
    expect(numberedBlockTitle('30 минут', 0)).toBe('1. 30 минут');
});

import { describe, expect, it } from 'vitest';

import { en } from './en.js';
import { formatCount, formatDateTime, plural } from './format.js';
import { ru } from './ru.js';
import { createT, relativeTime, resolveLocale } from './translate.js';

describe('выбор языка', () => {
    it('при auto подсказка агента главнее браузера', () => {
        expect(resolveLocale('auto', 'ru', ['en-US'])).toBe('ru');
        expect(resolveLocale('auto', 'en', ['ru-RU'])).toBe('en');
    });

    it('без подсказки агента auto смотрит только на первый язык браузера', () => {
        expect(resolveLocale('auto', undefined, ['ru-RU', 'en-US'])).toBe('ru');
        expect(resolveLocale('auto', undefined, ['RU'])).toBe('ru');
        expect(resolveLocale('auto', undefined, ['en-US', 'ru-RU'])).toBe('en');
        expect(resolveLocale('auto', undefined, [])).toBe('en');
    });

    it('явный выбор перебивает и агента, и браузер', () => {
        expect(resolveLocale('en', 'ru', ['ru-RU'])).toBe('en');
        expect(resolveLocale('ru', 'en', ['en-US'])).toBe('ru');
        expect(resolveLocale('ru', undefined, ['en-US'])).toBe('ru');
    });
});

describe('словари', () => {
    it('совпадают по ключам и по числу параметров', () => {
        const ruKeys = Object.keys(ru).toSorted();
        const enKeys = Object.keys(en).toSorted();
        expect(enKeys).toEqual(ruKeys);

        const mismatched = ruKeys.filter((key) => {
            const left = ru[key as keyof typeof ru] as unknown;
            const right = en[key as keyof typeof en] as unknown;
            if (typeof left === 'function' && typeof right === 'function') {
                return left.length !== right.length;
            }
            return typeof left !== typeof right;
        });
        expect(mismatched, 'ключи с разной сигнатурой').toEqual([]);
    });

    it('ни одна запись не пустая', () => {
        const empty = Object.entries(en).filter(([, value]) => typeof value === 'string' && value.trim() === '');
        expect(empty).toEqual([]);
    });

    it('t подставляет параметры на выбранном языке', () => {
        expect(createT('ru')('chat.history.failed', 'offline')).toContain('offline');
        expect(createT('en')('chat.history.failed', 'offline')).toContain('offline');
    });
});

describe('форматирование', () => {
    it('разряды: неразрывный пробел в русском, запятая в английском', () => {
        expect(formatCount(2412, 'ru')).toBe('2 412');
        expect(formatCount(2412, 'en')).toBe('2,412');
        expect(formatCount(999, 'ru')).toBe('999');
        expect(formatCount(1234567, 'ru')).toBe('1 234 567');
    });

    it('русские словоформы идут по правилам Intl, английские — по одной и остальным', () => {
        const forms = { one: 'файл', few: 'файла', many: 'файлов', other: 'файлов' };
        expect([1, 2, 5, 11, 21].map((value) => plural(value, forms, 'ru'))).toEqual([
            'файл',
            'файла',
            'файлов',
            'файлов',
            'файл',
        ]);

        const enForms = { one: 'file', other: 'files' };
        expect([1, 2, 5, 11, 21].map((value) => plural(value, enForms, 'en'))).toEqual([
            'file',
            'files',
            'files',
            'files',
            'files',
        ]);
    });

    it('относительное время держит шкалу мин/ч/дн/нед/мес/г на обеих локалях', () => {
        const now = Date.parse('2026-09-03T12:00:00.000Z');
        const ago = (seconds: number): string => new Date(now - seconds * 1000).toISOString();

        expect(relativeTime(ago(30), now, 'ru')).toBe('только что');
        expect(relativeTime(ago(30), now, 'en')).toBe('just now');
        expect(relativeTime(ago(60), now, 'ru')).toBe('1 мин. назад');
        expect(relativeTime(ago(60 * 6), now, 'en')).toBe('6 min. ago');
        expect(relativeTime(ago(3600 * 6), now, 'ru')).toBe('6 ч назад');
        expect(relativeTime(ago(3600 * 6), now, 'en')).toBe('6 hr. ago');
        expect(relativeTime(ago(86_400 * 3), now, 'ru')).toBe('3 дн. назад');
        expect(relativeTime(ago(86_400 * 3), now, 'en')).toBe('3 days ago');
        expect(relativeTime(ago(86_400 * 14), now, 'ru')).toBe('2 нед. назад');
        expect(relativeTime(ago(86_400 * 14), now, 'en')).toBe('2 wk. ago');
        expect(relativeTime(ago(86_400 * 120), now, 'ru')).toBe('4 мес. назад');
        expect(relativeTime(ago(86_400 * 120), now, 'en')).toBe('4 mo. ago');
        expect(relativeTime(ago(86_400 * 800), now, 'ru')).toBe('2 г. назад');
        expect(relativeTime(ago(86_400 * 800), now, 'en')).toBe('2 yr. ago');
    });

    it('абсолютная дата идёт по правилам локали, а неразобранная возвращается как есть', () => {
        const iso = '2026-09-03T10:00:00.000Z';
        expect(formatDateTime(iso, 'ru')).not.toBe(formatDateTime(iso, 'en'));
        expect(formatDateTime(iso, 'ru')).toContain('2026');
        expect(formatDateTime('не дата', 'ru')).toBe('не дата');
    });

    it('битая дата и будущее не ломают подпись', () => {
        const now = Date.parse('2026-09-03T12:00:00.000Z');
        expect(relativeTime('не дата', now, 'ru')).toBe('только что');
        expect(relativeTime(new Date(now + 60_000).toISOString(), now, 'en')).toBe('just now');
    });
});

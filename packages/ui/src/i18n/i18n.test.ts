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
        expect(createT('ru')('ship.progress', 12, 2412)).toBe('12 / 2 412 файлов');
        expect(createT('en')('ship.progress', 12, 2412)).toBe('12 / 2,412 files');
    });

    it('заметка второго захода согласована по числу на обоих языках', () => {
        // «N из M остановок»: существительное считается по M, а не по числу перенесённых.
        expect(createT('en')('iteration.secondPass.carried.kept', 1, 6)).toBe('1 of 6 stops stayed viewed. ');
        expect(createT('en')('iteration.secondPass.carried.kept', 1, 1)).toBe('1 of 1 stop stayed viewed. ');
        expect(createT('en')('iteration.secondPass.carried.none', 1)).toBe('None of the 1 stop stayed viewed. ');
        expect(createT('ru')('iteration.secondPass.carried.kept', 1, 6)).toBe(
            'Просмотренной осталась 1 остановка из 6. ',
        );
        expect(createT('ru')('iteration.secondPass.carried.kept', 3, 6)).toBe(
            'Просмотренными остались 3 остановки из 6. ',
        );
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

/**
 * Числительные: шаблоны, где сказуемое, местоимение или единица счёта раньше стояли
 * в фиксированной форме и расходились с числом. Проверяем именно единицу — множественное
 * число у этих строк было верным и до правки.
 */
describe('согласование с числом', () => {
    const t = createT('ru');
    const e = createT('en');

    it('русские шаблоны согласуются в единственном числе', () => {
        expect(t('route.gen.filling.counter', 1, 7)).toBe('1 из 7 готова');
        expect(t('route.filling.banner', 1, 7)).toContain('1 из 7 остановок готова');
        expect(t('route.gen.step.diffFiles', 1)).toBe('Читаю весь дифф · 1 файл');
        expect(t('route.lazyMore', 1)).toBe('ещё 1 карточка — появится при прокрутке');
        expect(t('route.stopFile.collapsed', 1)).toBe('1 изменённая строка свёрнута моделью');
        expect(t('route.other.counted', 1, 1)).toContain('осталась без остановки');
        expect(t('route.other.counted', 1, 1)).toContain('она не пропала, а собралась здесь');
        expect(t('route.other.failedFiles', 1)).toContain('— его непокрытые строки');
        expect(t('margin.footer.failed', 1)).toContain('— его строки');
        expect(t('diff.expand.loaded', 1)).toBe('догружено 1 строка');
        expect(t('diff.gap.hiddenCount', 1)).toBe('1 строка скрыта');
        expect(t('diff.gap.loadAll', 1, '…')).toBe('догрузить 1 строку, …');
        expect(t('audit.line', 1, 1, 2)).toMatch(/^Показан только 1 файл/u);
        expect(t('prComments.buffered.title', 1)).toContain('пока не сохранится');
        expect(t('ship.disabled.buffered', 1)).toContain('пока не сохранится');
        expect(t('complete.outsideRoute.value', 1)).toBe('1 строка, которую модель не разместила');
        expect(t('route.stop.conflicts', 1)).toContain('разрешить его можно только вне Шерпы');
        expect(t('route.other.conflicts', 1)).toContain('разрешить его можно только вне Шерпы, в покрытие он не входит');
        expect(t('banner.generationCap', 1)).toContain('проверьте его в Полном диффе');
        expect(t('overview.ownership.stats', 'CODEOWNERS', 1, 1, 5, 21)).toBe(
            'CODEOWNERS · 1 из 1 файла · 5 из 21 строки — ваши',
        );
        expect(t('palette.truncated', 21)).toBe('Показаны первые 21 совпадение');
    });

    it('русские шаблоны с безличным сказуемым не сбиваются на «строки не объяснены»', () => {
        expect(t('coverage.legend.unexplained', 5)).toBe('5 строк не объяснено');
        expect(t('complete.openThreads', 5)).toMatch(/^5 тредов ещё открыто/u);
        expect(t('ship.guard.stops', 2)).toBe('2 остановки не просмотрены — всё равно шипнуть?');
        expect(t('ship.guard.files', 2)).toBe('2 файла не просмотрены — всё равно шипнуть?');
    });

    it('английские шаблоны согласуются в единственном числе', () => {
        expect(e('route.gen.step.diffFiles', 1)).toBe('Reading the whole diff · 1 file');
        expect(e('route.lazyMore', 1)).toBe('1 more card — it appears as you scroll');
        expect(e('route.other.counted', 1, 1)).toContain('so it is not lost — it collects here');
        expect(e('route.other.failedFiles', 1)).toContain('— its uncovered lines');
        expect(e('margin.footer.failed', 1)).toContain('— its lines');
        expect(e('diff.expand.loaded', 1)).toBe('1 line loaded');
        expect(e('diff.gap.hiddenCount', 1)).toBe('1 line hidden');
        expect(e('audit.line', 1, 1, 2)).toMatch(/^Showing only 1 audit-scope file/u);
        expect(e('prComments.buffered.title', 1)).toContain('until it is saved');
        expect(e('ship.disabled.buffered', 1)).toContain('until it is');
        expect(e('route.stop.conflicts', 1)).toContain('resolve it outside Sherpa');
        expect(e('route.other.conflicts', 1)).toContain('resolve it outside Sherpa; it is out of coverage');
        expect(e('banner.generationCap', 1)).toContain('check it in the full diff');
        expect(e('palette.truncated', 1)).toBe('Showing the first 1 match');
    });
});

import { STOP_PARAGRAPH_MAX_CHARS } from '@sherpa/protocol';
import { describe, expect, it } from 'vitest';

import { asRawText, mediumRawResults } from './fixture-support.js';
import { paragraphMarkupErrors } from './paragraph-markup.js';
import { validateSkeleton } from './skeleton.js';

/** Ошибку читает модель: проверяем и сам факт отказа, и то, чем он назван. */
function errors(text: string): string[] {
    return paragraphMarkupErrors('section.stops[0].paragraph', 3, text);
}

describe('словарь разметки описания остановки', () => {
    it('принимает весь словарь: абзацы, ul, ol, код, жирный и ссылку', () => {
        const text = [
            'Окно правки стало доменным понятием: `EditWindow` считает остаток по инжектируемым часам.',
            '',
            'Укорачивают окно три случая:',
            '- свежие продукты — 10 минут',
            '- аптека — 5 минут',
            '',
            'В корзине выигрывает **самое короткое** окно.',
            '',
            '1. политика получает окно',
            '2. ручка отдаёт остаток',
            '',
            'Правила записаны в [docs/edit-window.md](#file-services/orders/docs/edit-window.md).',
        ].join('\n');

        expect(errors(text)).toEqual([]);
    });

    it('непарные звёздочки, тильды и скобки — литеральный текст, не ошибка', () => {
        expect(errors('Площадь a * b, путь ~/dir и [битая ссылка(')).toEqual([]);
    });

    it('курсив, зачёркивание и горизонтальная черта вне словаря — ошибка', () => {
        expect(errors('Площадь *a* × *b*, ~~почти~~.')).toEqual([
            'section.stops[0].paragraph: paragraph of stop 3 uses italics; allowed: paragraphs, `- `/`* `/`1. ` lists up to 4 items, `code`, **bold**, [links](url).',
            'section.stops[0].paragraph: paragraph of stop 3 uses strikethrough; allowed: paragraphs, `- `/`* `/`1. ` lists up to 4 items, `code`, **bold**, [links](url).',
        ]);
        expect(errors('Раз.\n\n---\n\nДва.')).toEqual([
            'section.stops[0].paragraph: paragraph of stop 3 uses a horizontal rule; allowed: paragraphs, `- `/`* `/`1. ` lists up to 4 items, `code`, **bold**, [links](url).',
        ]);
    });

    it('заголовок подчёркиванием — тоже заголовок', () => {
        expect(errors('Что изменилось\n---\n\nОкно.')).toEqual([
            'section.stops[0].paragraph: paragraph of stop 3 uses a heading; allowed: paragraphs, `- `/`* `/`1. ` lists up to 4 items, `code`, **bold**, [links](url).',
        ]);
    });

    it('маркер `* ` — из словаря, как и `- `', () => {
        expect(errors('* раз\n* два')).toEqual([]);
    });

    it('маркер списка не из словаря — ошибка', () => {
        expect(errors('+ раз\n+ два')).toEqual([
            'section.stops[0].paragraph: paragraph of stop 3 uses a list marker other than `- `, `* ` and `1. `; allowed: paragraphs, `- `/`* `/`1. ` lists up to 4 items, `code`, **bold**, [links](url).',
        ]);
        expect(errors('1) раз\n2) два')).toHaveLength(1);
    });

    it('ссылка на адрес вне словаря — ошибка', () => {
        expect(errors('См. [файл](src/a.ts).')).toEqual([
            'section.stops[0].paragraph: paragraph of stop 3 links to an address other than http(s), `#stop-<planIndex>` or `#file-<path>`; allowed: paragraphs, `- `/`* `/`1. ` lists up to 4 items, `code`, **bold**, [links](url).',
        ]);
        expect(errors('[тикет](https://example.test/T-1), [остановка](#stop-2), [файл](#file-a.ts)')).toEqual([]);
    });

    it('заголовок не проходит', () => {
        expect(errors('## Что изменилось\n\nОкно стало доменным понятием.')).toEqual([
            'section.stops[0].paragraph: paragraph of stop 3 uses a heading; allowed: paragraphs, `- `/`* `/`1. ` lists up to 4 items, `code`, **bold**, [links](url).',
        ]);
    });

    it('блок кода не проходит ни забором, ни отступом', () => {
        expect(errors('Пример:\n\n```ts\nconst a = 1;\n```')).toHaveLength(1);
        expect(errors('Пример:\n\n    const a = 1;')).toEqual([
            'section.stops[0].paragraph: paragraph of stop 3 uses a code block; allowed: paragraphs, `- `/`* `/`1. ` lists up to 4 items, `code`, **bold**, [links](url).',
        ]);
    });

    it('вложенный пункт не проходит', () => {
        expect(errors('- корень\n  - вложенный')).toEqual([
            'section.stops[0].paragraph: paragraph of stop 3 uses a nested list item; allowed: paragraphs, `- `/`* `/`1. ` lists up to 4 items, `code`, **bold**, [links](url).',
        ]);
    });

    it('второй абзац в пункте списка не проходит', () => {
        expect(errors('- a\n\n  продолжение пункта')).toEqual([
            'section.stops[0].paragraph: paragraph of stop 3 puts more than one paragraph into a list item; allowed: paragraphs, `- `/`* `/`1. ` lists up to 4 items, `code`, **bold**, [links](url).',
        ]);
    });

    it('определение ссылки не проходит, а описание без видимого текста — ошибка', () => {
        expect(errors('[ref]: https://example.test')).toEqual([
            'section.stops[0].paragraph: paragraph of stop 3 has no visible text: the reviewer would see an empty description.',
            'section.stops[0].paragraph: paragraph of stop 3 uses a link reference definition `[label]: url`; write links inline as [text](url); allowed: paragraphs, `- `/`* `/`1. ` lists up to 4 items, `code`, **bold**, [links](url).',
        ]);
        expect(errors('См. [тикет][t].\n\n[t]: https://example.test/T-1')).toHaveLength(1);
        expect(errors('[](https://example.test)')).toEqual([
            'section.stops[0].paragraph: paragraph of stop 3 has no visible text: the reviewer would see an empty description.',
        ]);
    });

    it('таблица, картинка и цитата не проходят', () => {
        expect(errors('| a | b |\n| --- | --- |\n| 1 | 2 |')).toHaveLength(1);
        expect(errors('Схема: ![диаграмма](https://example.test/d.png)')).toHaveLength(1);
        expect(errors('> Цитата из тикета.')).toHaveLength(1);
    });

    it('труба без строки-разделителя таблицей не считается', () => {
        expect(errors('Регулярка `^a|b$` осталась прежней.')).toEqual([]);
    });

    it('пять пунктов не проходят, четыре — проходят', () => {
        const items = (count: number) =>
            Array.from({ length: count }, (_, index) => `- пункт ${String(index + 1)}`).join('\n');

        expect(errors(items(4))).toEqual([]);
        expect(errors(items(5))).toEqual([
            'section.stops[0].paragraph: paragraph of stop 3 has a list of 5 items, at most 4 are allowed. A list is for enumerating like things; move the rest into the prose.',
        ]);
    });

    it('пустые строки между пунктами потолок не обходят', () => {
        expect(errors('- a\n\n- b\n\n- c\n\n- d\n\n- e')).toEqual([
            'section.stops[0].paragraph: paragraph of stop 3 has a list of 5 items, at most 4 are allowed. A list is for enumerating like things; move the rest into the prose.',
        ]);
    });

    it('абзац между списками их не склеивает', () => {
        expect(errors('- a\n- b\n- c\n\nВывод по списку.\n\n- d\n- e\n- f')).toEqual([]);
    });

    it('бюджет: 840 символов проходит, 841 — нет', () => {
        expect(errors('я'.repeat(STOP_PARAGRAPH_MAX_CHARS))).toEqual([]);
        expect(errors('я'.repeat(STOP_PARAGRAPH_MAX_CHARS + 1))).toEqual([
            'section.stops[0].paragraph: paragraph of stop 3 is 841 chars, limit is 840. Cut it down, do not split it across stops.',
        ]);
    });

    it('бюджет считает видимый текст: адрес ссылки и разметка не в счёт', () => {
        const url = `https://example.test/${'a'.repeat(STOP_PARAGRAPH_MAX_CHARS)}`;
        const prose = 'я'.repeat(STOP_PARAGRAPH_MAX_CHARS - 20);
        const fits = `**${prose}** [тикет](${url}) и \`код\``;

        expect(fits.length).toBeGreaterThan(STOP_PARAGRAPH_MAX_CHARS);
        expect(errors(fits)).toEqual([]);
        expect(errors(`- ${prose}\n- ${'я'.repeat(21)}`)).toEqual([
            'section.stops[0].paragraph: paragraph of stop 3 is 841 chars, limit is 840. Cut it down, do not split it across stops.',
        ]);
    });
});

describe('summary PR — тот же словарь, без бюджета длины', () => {
    const ALLOWED = 'allowed: paragraphs, `- `/`* `/`1. ` lists up to 4 items, `code`, **bold**, [links](url)';

    function summaryErrors(summary: string): readonly string[] {
        const result = validateSkeleton(asRawText({ ...mediumRawResults().skeleton, summary }));
        return result.ok ? [] : result.errors;
    }

    it('принимает абзацы, список, код, жирный и ссылки на остановку и файл', () => {
        const summary = [
            'PR вводит `EditWindow`: заказ можно править **30 минут** после оформления.',
            '',
            'Окно укорачивают:',
            '- свежие продукты',
            '- аптека',
            '',
            'Начать стоит с [доменной модели](#stop-1), правила — в [README](#file-services/orders/README.md).',
        ].join('\n');

        expect(summaryErrors(summary)).toEqual([]);
    });

    it('длиннее бюджета описания остановки — проходит', () => {
        expect(summaryErrors('я'.repeat(STOP_PARAGRAPH_MAX_CHARS * 3))).toEqual([]);
    });

    it('заголовок и блок кода — ошибка скелета', () => {
        expect(summaryErrors('## Итог\n\nОкно стало доменным понятием.')).toEqual([
            `skeleton.summary: summary uses a heading; ${ALLOWED}.`,
        ]);
        expect(summaryErrors('Пример:\n\n```ts\nconst a = 1;\n```')).toEqual([
            `skeleton.summary: summary uses a code block; ${ALLOWED}.`,
        ]);
    });

    it('список из пяти пунктов — ошибка', () => {
        const items = Array.from({ length: 5 }, (_, index) => `- пункт ${String(index + 1)}`).join('\n');
        expect(summaryErrors(items)).toEqual([
            'skeleton.summary: summary has a list of 5 items, at most 4 are allowed. A list is for enumerating like things; move the rest into the prose.',
        ]);
    });

    it('без видимого текста — ошибка', () => {
        expect(summaryErrors('[](https://example.test)')).toEqual([
            'skeleton.summary: summary has no visible text: the reviewer would see an empty description.',
        ]);
    });
});

import { describe, expect, it } from 'vitest';

import {
    appendParagraph,
    BODY_PLACEHOLDER,
    parseReviewBody,
    removeParagraph,
    renderReviewBody,
    replaceParagraph,
} from './drafts.js';

describe('тело pending-ревью GitHub', () => {
    it('пустое тело абзацев не даёт', () => {
        expect(parseReviewBody('')).toEqual({ marked: false, paragraphs: [] });
        expect(parseReviewBody('\n\n   \n')).toEqual({ marked: false, paragraphs: [] });
    });

    it('тело из одной заглушки абзацев не даёт', () => {
        expect(parseReviewBody(BODY_PLACEHOLDER)).toEqual({ marked: false, paragraphs: [] });
        expect(parseReviewBody(`\n${BODY_PLACEHOLDER}\n`)).toEqual({ marked: false, paragraphs: [] });
    });

    it('строка вида заглушки внутри текста ревьюера сохраняется', () => {
        // Рядом с абзацами заглушку никто не пишет, значит такая строка — текст ревьюера
        // (например, обсуждение самих маркеров Шерпы), и выбрасывать её нельзя.
        const text = `Шерпа метит пустое тело строкой\n${BODY_PLACEHOLDER}\nи по ней его узнаёт`;
        const body = `<!-- devflow-diff-explain:draft 1 -->\n${text}`;

        expect(parseReviewBody(body)).toEqual({ marked: true, paragraphs: [{ n: 1, body: text }] });
        // Перезапись тела соседним абзацем текста не теряет.
        expect(parseReviewBody(appendParagraph(body, 'Второй').body).paragraphs).toEqual([
            { n: 1, body: text },
            { n: 2, body: 'Второй' },
        ]);
    });

    it('тело без абзацев собирается заглушкой, а не пустой строкой', () => {
        expect(renderReviewBody([])).toBe(BODY_PLACEHOLDER);
        // Первый же абзац заглушку вытесняет: она нужна только пустому телу.
        expect(appendParagraph(BODY_PLACEHOLDER, 'Первый')).toEqual({
            body: '<!-- devflow-diff-explain:draft 1 -->\nПервый',
            n: 1,
        });
    });

    it('тело без маркеров — один абзац с номером 0', () => {
        expect(parseReviewBody('Написано на вебе GitHub.\n\nВ два абзаца.')).toEqual({
            marked: false,
            paragraphs: [{ n: 0, body: 'Написано на вебе GitHub.\n\nВ два абзаца.' }],
        });
    });

    it('маркеры режут тело на абзаца со своими номерами', () => {
        const body = '<!-- devflow-diff-explain:draft 1 -->\nПервый\n\n<!-- devflow-diff-explain:draft 4 -->\nВторой\nс переносом';

        expect(parseReviewBody(body)).toEqual({
            marked: true,
            paragraphs: [
                { n: 1, body: 'Первый' },
                { n: 4, body: 'Второй\nс переносом' },
            ],
        });
    });

    it('текст до первого маркера остаётся абзацем 0', () => {
        expect(parseReviewBody('Хвост с веба\n\n<!-- devflow-diff-explain:draft 2 -->\nЧерновик')).toEqual({
            marked: true,
            paragraphs: [
                { n: 0, body: 'Хвост с веба' },
                { n: 2, body: 'Черновик' },
            ],
        });
    });

    it('сборка и разбор — обратные друг другу', () => {
        const paragraphs = [
            { n: 1, body: 'Раз' },
            { n: 7, body: 'Два' },
        ];
        expect(parseReviewBody(renderReviewBody(paragraphs)).paragraphs).toEqual(paragraphs);
    });

    it('новый абзац получает номер «максимум + 1», а не следующий по порядку', () => {
        const first = appendParagraph('', 'Раз');
        expect(first.n).toBe(1);

        const second = appendParagraph(first.body, 'Два');
        expect(second.n).toBe(2);

        // Удалили первый — номер второго не поехал, а третий всё равно больше обоих.
        const afterRemoval = removeParagraph(second.body, 1) ?? '';
        expect(parseReviewBody(afterRemoval).paragraphs).toEqual([{ n: 2, body: 'Два' }]);
        expect(appendParagraph(afterRemoval, 'Три').n).toBe(3);
    });

    it('тело с веба при первой дописке получает маркер', () => {
        const { body } = appendParagraph('Старый текст', 'Черновик');

        expect(parseReviewBody(body)).toEqual({
            marked: true,
            paragraphs: [
                { n: 0, body: 'Старый текст' },
                { n: 1, body: 'Черновик' },
            ],
        });
    });

    it('правка и удаление по номеру; чужой номер — null', () => {
        const body = renderReviewBody([
            { n: 1, body: 'Раз' },
            { n: 2, body: 'Два' },
        ]);

        expect(parseReviewBody(replaceParagraph(body, 2, 'Два с половиной') ?? '').paragraphs).toEqual([
            { n: 1, body: 'Раз' },
            { n: 2, body: 'Два с половиной' },
        ]);
        expect(replaceParagraph(body, 9, 'нет такого')).toBeNull();
        expect(removeParagraph(body, 9)).toBeNull();
        // Удаление последнего абзаца пишет заглушку: пустое тело сломало бы ревью навсегда.
        expect(removeParagraph(renderReviewBody([{ n: 1, body: 'Раз' }]), 1)).toBe(BODY_PLACEHOLDER);
    });
});

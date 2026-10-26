import { describe, expect, it } from 'vitest';

import type { QuestionRange } from './chat-prompts.js';
import { MAX_LISTED_RANGES, placeRangeQuestion, placeRangesQuestion } from './chat-prompts.js';
import { createT } from '../i18n/index.js';

const t = createT('ru');

function range(patch: Partial<QuestionRange> = {}): QuestionRange {
    return { path: 'src/cache.ts', side: 'new', start: 18, end: 26, ...patch };
}

describe('вопрос «разложи диапазоны» из «Прочего»', () => {
    it('перечисляет один диапазон и просит объяснить каждый', () => {
        expect(placeRangesQuestion([range()], t)).toBe(
            'Разложи по остановкам маршрута диапазоны, которые модель не разместила: src/cache.ts:18–26. ' +
                'Для каждого — к какой остановке он относится и почему, или что это отдельная тема.',
        );
    });

    it('одну строку называет одним номером', () => {
        expect(placeRangesQuestion([range({ start: 18, end: 18 })], t)).toContain('src/cache.ts:18.');
    });

    it('старую сторону помечает: номера строк у сторон разные', () => {
        expect(placeRangesQuestion([range({ side: 'old', start: 4, end: 9 })], t)).toContain(
            'src/cache.ts:4–9 (удалённые)',
        );
    });

    it('сохраняет порядок диапазонов', () => {
        const question = placeRangesQuestion([
            range({ path: 'a.ts', start: 1, end: 2 }),
            range({ path: 'b.ts', start: 3, end: 4 }),
        ], t);

        expect(question).toContain('a.ts:1–2, b.ts:3–4.');
    });

    it('обрезает список на 20 диапазонах и честно считает хвост', () => {
        const many = Array.from({ length: 23 }, (_, index) =>
            range({ path: `f${String(index)}.ts`, start: index + 1, end: index + 1 }),
        );

        const question = placeRangesQuestion(many, t);

        expect(question).toContain(`f${String(MAX_LISTED_RANGES - 1)}.ts:${String(MAX_LISTED_RANGES)} и ещё 3.`);
        expect(question).not.toContain('f20.ts');
    });

    it('без диапазонов остаётся осмысленным вопросом', () => {
        expect(placeRangesQuestion([], t)).toBe(
            'Разложи по остановкам маршрута диапазоны, которые модель не разместила. ' +
                'Для каждого — к какой остановке он относится и почему, или что это отдельная тема.',
        );
    });
});

describe('вопрос о диапазоне штрихованной полосы', () => {
    it('новая сторона — диапазон строк', () => {
        expect(placeRangeQuestion(range(), t)).toBe(
            'К какой остановке маршрута относятся строки 18–26 в src/cache.ts? Модель их не разместила.',
        );
    });

    it('старая сторона называет строки удалёнными', () => {
        expect(placeRangeQuestion(range({ side: 'old' }), t)).toBe(
            'К какой остановке маршрута относятся удалённые строки 18–26 в src/cache.ts? Модель их не разместила.',
        );
    });

    it('одна строка согласуется в числе', () => {
        expect(placeRangeQuestion(range({ start: 18, end: 18 }), t)).toBe(
            'К какой остановке маршрута относится строка 18 в src/cache.ts? Модель её не разместила.',
        );
        expect(placeRangeQuestion(range({ side: 'old', start: 4, end: 4 }), t)).toBe(
            'К какой остановке маршрута относится удалённая строка 4 в src/cache.ts? Модель её не разместила.',
        );
    });
});

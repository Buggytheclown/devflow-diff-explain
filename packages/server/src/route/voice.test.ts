import { describe, expect, it } from 'vitest';

import { bannedPhrases, voiceErrors } from './voice.js';

describe('стоп-лист голоса', () => {
    it('чистый текст проходит', () => {
        expect(voiceErrors('at', 'Обработчик переписан: окно правки теперь 30 минут.', 'ru')).toEqual([]);
        expect(voiceErrors('at', null, 'ru')).toEqual([]);
        expect(voiceErrors('at', undefined, 'ru')).toEqual([]);
    });

    it('фразы-заполнители ловятся без учёта регистра, путь — в ошибке', () => {
        const errors = voiceErrors('section.stops[2].paragraph', 'Важно отметить: код стал проще.', 'ru');
        expect(errors).toEqual([
            'section.stops[2].paragraph: drop the filler phrase "важно отметить" and state the fact directly (see Voice in the methodology).',
        ]);
    });

    it('несколько нарушений — все в списке', () => {
        const errors = voiceErrors('at', 'Стоит понимать, что это важно отметить 🎉', 'ru');
        expect(errors).toHaveLength(3);
    });

    it('эмодзи ловятся', () => {
        expect(voiceErrors('at', 'Готово ✨', 'ru')).toEqual([
            'at: contains emoji — route texts are plain prose (see Voice in the methodology).',
        ]);
    });

    it('обычная пунктуация и типографика не считаются эмодзи', () => {
        expect(voiceErrors('at', 'Диапазон 1–40, стрелка →, «кавычки», `код`.', 'ru')).toEqual([]);
    });
});

describe('стоп-лист голоса на английской генерации', () => {
    it('свои фразы-заполнители ловятся, эмодзи — общее правило', () => {
        expect(voiceErrors('answer', 'It is worth noting that the handler was rewritten.', 'en')).toEqual([
            'answer: drop the filler phrase "it is worth noting" and state the fact directly (see Voice in the methodology).',
        ]);
        expect(voiceErrors('answer', 'As we can see, the window is 30 minutes now.', 'en')).toHaveLength(1);
        expect(voiceErrors('answer', 'Done ✨', 'en')).toEqual([
            'answer: contains emoji — route texts are plain prose (see Voice in the methodology).',
        ]);
    });

    it('чистый английский текст проходит', () => {
        expect(voiceErrors('at', 'The handler now rejects edits later than 30 minutes.', 'en')).toEqual([]);
    });

    it('чужеязычная фраза нарушением не считается: стоп-лист принадлежит локали генерации', () => {
        expect(voiceErrors('at', 'Важно отметить: the diff is small.', 'en')).toEqual([]);
        expect(voiceErrors('at', 'It is worth noting — цитата из обсуждения.', 'ru')).toEqual([]);
    });

    it('в наборе каждой локали не меньше шести фраз', () => {
        expect(bannedPhrases('ru').length).toBeGreaterThanOrEqual(6);
        expect(bannedPhrases('en').length).toBeGreaterThanOrEqual(6);
    });
});

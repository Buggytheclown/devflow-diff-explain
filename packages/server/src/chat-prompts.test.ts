import type { Locale } from '@sherpa/protocol';
import { describe, expect, it } from 'vitest';

import { chatGuide, chatInstructions } from './chat-prompts.js';
import { bannedPhrases, quoted } from './route/voice.js';

/**
 * Методичка чата: язык ответа и стоп-лист. Формулировка про стоп-фразы закрытая,
 * поэтому список обязан совпадать с тем, за что сервер отказывает, — иначе модель сжигает
 * попытку на фразе, о которой её не предупредили.
 */

const LOCALES: readonly Locale[] = ['ru', 'en'];

describe('методичка чата', () => {
    it('называет все стоп-фразы своей локали и ни одной чужой', () => {
        for (const locale of LOCALES) {
            const guide = chatGuide(locale);
            for (const phrase of bannedPhrases(locale)) {
                expect(guide).toContain(quoted(locale)(phrase));
            }
            const foreign = locale === 'ru' ? 'en' : 'ru';
            for (const phrase of bannedPhrases(foreign)) {
                expect(guide).not.toContain(phrase);
            }
        }
    });

    it('требует ровно один язык ответа', () => {
        expect(chatGuide('ru')).toContain('Write in Russian.');
        expect(chatGuide('ru')).not.toContain('Write in English.');
        expect(chatGuide('en')).toContain('Write in English.');
        expect(chatGuide('en')).not.toContain('in Russian');
        expect(chatInstructions('ru')).toContain('in Russian');
        expect(chatInstructions('en')).toContain('in English');
    });
});

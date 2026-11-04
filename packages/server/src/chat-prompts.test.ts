import type { Locale } from '@sherpa/protocol';
import { describe, expect, it } from 'vitest';

import { chatGuide, chatInstructions } from './chat-prompts.js';

/** Проверяем язык и самостоятельный выбор контекста. */

const LOCALES: readonly Locale[] = ['ru', 'en'];

describe('методичка чата', () => {
    it('требует ровно один язык ответа', () => {
        expect(chatGuide('ru')).toContain('Write in Russian.');
        expect(chatGuide('ru')).not.toContain('Write in English.');
        expect(chatGuide('en')).toContain('Write in English.');
        expect(chatGuide('en')).not.toContain('in Russian');
        expect(chatInstructions('ru')).toContain('in Russian');
        expect(chatInstructions('en')).toContain('in English');
    });

    it('оставляет выбор чтения агенту, сохраняя требования к версии и доказательствам', () => {
        for (const locale of LOCALES) {
            expect(chatGuide(locale)).toContain('Choose what to read yourself.');
            expect(chatInstructions(locale)).toContain('Read context selectively');
            expect(chatGuide(locale)).toContain('You do not need to read every context file.');
            expect(chatGuide(locale)).toContain('Do not concatenate all');
            expect(chatGuide(locale)).toContain('same pinned version');
            expect(chatGuide(locale)).toContain('unavailable or truncated evidence');
        }
    });
});

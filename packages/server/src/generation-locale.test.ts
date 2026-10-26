import { describe, expect, it } from 'vitest';

import { resolveGenerationLocale } from './generation-locale.js';

describe('язык генерации', () => {
    it('запрос UI перебивает всё остальное', () => {
        expect(resolveGenerationLocale({ requested: 'en', setting: 'ru', agentLang: 'ru' })).toBe('en');
        expect(resolveGenerationLocale({ requested: 'ru', setting: 'en', agentLang: 'en' })).toBe('ru');
    });

    it('без запроса берётся явный выбор в настройках', () => {
        expect(resolveGenerationLocale({ setting: 'en', agentLang: 'ru' })).toBe('en');
        expect(resolveGenerationLocale({ setting: 'ru', agentLang: 'en' })).toBe('ru');
    });

    it('`auto` в настройках отдаёт решение подсказке агента', () => {
        expect(resolveGenerationLocale({ setting: 'auto', agentLang: 'en' })).toBe('en');
        expect(resolveGenerationLocale({ agentLang: 'en' })).toBe('en');
    });

    it('никто ничего не сказал — русский', () => {
        expect(resolveGenerationLocale({})).toBe('ru');
        expect(resolveGenerationLocale({ setting: 'auto' })).toBe('ru');
        expect(resolveGenerationLocale({ setting: 'auto', agentLang: undefined })).toBe('ru');
    });
});

import { describe, expect, it } from 'vitest';

import { createToken, extractBearerToken, tokenMatches } from './auth.js';

describe('bearer-аутентификация', () => {
    it('токен — 6 случайных байт, 8 символов base64url', () => {
        const token = createToken();

        expect(token).toMatch(/^[A-Za-z0-9_-]{8}$/);
        expect(createToken()).not.toBe(token);
    });

    it('схема разбирается регистронезависимо, мусор — null', () => {
        expect(extractBearerToken('Bearer abc')).toBe('abc');
        expect(extractBearerToken('bearer\tabc')).toBe('abc');
        expect(extractBearerToken('  Bearer   abc  ')).toBe('abc');
        expect(extractBearerToken('Basic abc')).toBeNull();
        expect(extractBearerToken('abc')).toBeNull();
        expect(extractBearerToken('Bearer ')).toBeNull();
        expect(extractBearerToken(undefined)).toBeNull();
    });

    it('сравнение переживает старый 64-символьный токен и отсутствие токена', () => {
        const token = createToken();

        expect(tokenMatches(token, token)).toBe(true);
        expect(tokenMatches(token, 'f'.repeat(64))).toBe(false);
        expect(tokenMatches(token, 'коротко')).toBe(false);
        expect(tokenMatches(token, null)).toBe(false);
    });
});

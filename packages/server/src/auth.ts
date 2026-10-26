import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/** 48 бит дают 8 символов base64url без padding (docs/protocol.md §8). */
const TOKEN_BYTES = 6;

export function createToken(): string {
    return randomBytes(TOKEN_BYTES).toString('base64url');
}

/** Достаёт токен из заголовка `Authorization: Bearer <token>`; схема регистронезависима. */
export function extractBearerToken(header: string | undefined): string | null {
    if (header === undefined) {
        return null;
    }

    const match = /^Bearer[ \t]+(\S+)$/i.exec(header.trim());
    return match?.[1] ?? null;
}

/**
 * Сравнение токенов за постоянное время. Сравниваем хеши, а не сами строки:
 * timingSafeEqual требует равной длины, а хеш выравнивает её и не выдаёт длину настоящего токена.
 */
export function tokenMatches(expected: string, provided: string | null): boolean {
    if (provided === null) {
        return false;
    }
    return timingSafeEqual(sha256(expected), sha256(provided));
}

function sha256(value: string): Buffer {
    return createHash('sha256').update(value, 'utf8').digest();
}

/**
 * Случайный UUID одной функцией: `crypto.randomUUID` есть только в безопасном контексте, а по
 * HTTP на имени виртуалки (`SHERPA_LISTEN_HOST=::`) его не существует — прямой вызов упал бы
 * исключением. `crypto.getRandomValues` доступен и там, поэтому фолбэк собирает UUID v4 сам.
 */

export function newUuid(): string {
    const randomUUID = (crypto as unknown as { readonly randomUUID?: () => string }).randomUUID;
    if (randomUUID !== undefined) {
        return randomUUID.call(crypto);
    }

    const hex = Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte, index) =>
        withFixedBits(byte, index).toString(16).padStart(2, '0'),
    ).join('');
    return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join('-');
}

/** Байт 6 несёт номер версии в старшем полубайте, байт 8 — вариант RFC 4122; остальные случайны. */
function withFixedBits(byte: number, index: number): number {
    if (index === 6) {
        return (byte & 0x0f) | 0x40;
    }
    if (index === 8) {
        return (byte & 0x3f) | 0x80;
    }
    return byte;
}

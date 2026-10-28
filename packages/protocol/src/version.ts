import { z } from 'zod';

/**
 * Версия протокола сессия↔сервер (`docs/protocol.md §9`).
 * Канон совместимости: в линии 0.x минор считается ломающим; с 1.0 достаточно совпадения мажора.
 */
export const PROTOCOL_VERSION = '0.19.0';

/** Строка semver без пре-релизов и метаданных — для версий протокола, CLI и сервера. */
export const semverSchema = z.string().regex(/^\d+\.\d+\.\d+$/, 'ожидается версия вида X.Y.Z');

/** Проверка совместимости двух версий протокола по канону выше. Нераспознанные строки несовместимы. */
export function protocolVersionsCompatible(a: string, b: string): boolean {
    const pa = parseVersion(a);
    const pb = parseVersion(b);
    if (pa === null || pb === null) {
        return false;
    }
    if (pa.major !== pb.major) {
        return false;
    }
    return pa.major > 0 || pa.minor === pb.minor;
}

function parseVersion(version: string): { major: number; minor: number } | null {
    const match = /^(\d+)\.(\d+)\.\d+$/.exec(version);
    if (match === null) {
        return null;
    }
    return { major: Number(match[1] ?? ''), minor: Number(match[2] ?? '') };
}

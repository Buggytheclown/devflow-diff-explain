import fs from 'node:fs';
import path from 'node:path';

import { verdictsInstructionSchema } from '@sherpa/protocol';
import { z } from 'zod';

import { localHostStatePathFor } from '../../paths.js';

/**
 * Что за каталог ревьюирует локальный ключ (`local-arc-*`, `local-git-*`). Файл нужен перезапуску:
 * `devflow-diff-explain up --local` называет каталог только при первом старте, а демон после самоостановки
 * поднимается уже без него.
 */

const FILE_MODE = 0o600;
const DIR_MODE = 0o700;

export interface LocalHostState {
    /** Абсолютный путь каталога проекта. */
    readonly repo: string;
    /** Ветка, на которой заведено ревью; null — первый снимок её ещё не зафиксировал. */
    readonly branch: string | null;
    /** Явная база сравнения; null — считается merge-base с базовой веткой по умолчанию. */
    readonly base: string | null;
    /**
     * Поручение пользователя на исход ревью (`--verdicts`): с ним ревью завершается Ship или Request
     * changes вместо Comment; null — режим выключен.
     */
    readonly verdicts: string | null;
}

const stateSchema = z.object({
    repo: z.string().min(1),
    branch: z.string().min(1).nullable(),
    base: z.string().min(1).nullable(),
    // Файлы до режима вердиктов поля не знают — это режим без вердиктов.
    verdicts: verdictsInstructionSchema.nullable().default(null),
});

/** Сохранённое состояние ключа; null — файла нет или он не прошёл схему (fail-closed). */
export function readLocalHostState(sherpaDir: string, prKey: string): LocalHostState | null {
    let raw: string;
    try {
        raw = fs.readFileSync(localHostStatePathFor(sherpaDir, prKey), 'utf8');
    } catch {
        return null;
    }

    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return null;
    }
    const state = stateSchema.safeParse(parsed);
    return state.success ? state.data : null;
}

export function writeLocalHostState(sherpaDir: string, prKey: string, state: LocalHostState): void {
    const filePath = localHostStatePathFor(sherpaDir, prKey);
    fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: DIR_MODE });
    fs.writeFileSync(filePath, `${JSON.stringify(state, null, 2)}\n`, { mode: FILE_MODE });
    // writeFileSync применяет mode с оглядкой на umask и только при создании — права доводим явно.
    fs.chmodSync(filePath, FILE_MODE);
}

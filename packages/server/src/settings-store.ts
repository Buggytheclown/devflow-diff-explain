import fs from 'node:fs';

import type { UiSettings, UiSettingsPatch } from '@sherpa/protocol';
import { uiSettingsSchema } from '@sherpa/protocol';

import { settingsPathFor } from './paths.js';

/**
 * Глобальные настройки UI в `<sherpaDir>/settings.json`. Файл общий для серверов всех PR,
 * поэтому истина всегда на диске: и чтение, и слияние патча берут свежее содержимое.
 * Нет файла, битый JSON, поле не прошло схему — дефолты схемы: настройки не повод отказать UI.
 */
export class SettingsStore {
    private readonly file: string;
    /** Права файла: настройки лежат рядом с токенами, режим тот же, что у каталогов стейта. */
    private static readonly FILE_MODE = 0o600;

    constructor(sherpaDir: string) {
        this.file = settingsPathFor(sherpaDir);
    }

    read(): UiSettings {
        return parseSettings(this.readRaw());
    }

    /** Сливает переданные поля со свежим содержимым файла и пишет результат целиком. */
    patch(partial: UiSettingsPatch): UiSettings {
        // Ключ без значения — это «не трогай поле», а не «верни дефолт».
        const changes = Object.fromEntries(Object.entries(partial).filter(([, value]) => value !== undefined));
        const next = uiSettingsSchema.parse({ ...this.read(), ...changes });
        this.write(next);
        return next;
    }

    private readRaw(): string | null {
        try {
            return fs.readFileSync(this.file, 'utf8');
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
                process.stderr.write(`Настройки ${this.file} не прочитались (${messageOf(error)}) — беру дефолты.\n`);
            }
            return null;
        }
    }

    /**
     * Атомарная запись: временный файл в том же каталоге и `rename`. Иначе сервер соседнего PR
     * прочитал бы файл в середине записи.
     */
    private write(settings: UiSettings): void {
        const temp = `${this.file}.${String(process.pid)}.${Date.now().toString(36)}.tmp`;
        try {
            fs.writeFileSync(temp, `${JSON.stringify(settings, null, 4)}\n`, {
                mode: SettingsStore.FILE_MODE,
            });
            // writeFileSync применяет mode с учётом umask, а файл мог остаться от прошлой попытки.
            fs.chmodSync(temp, SettingsStore.FILE_MODE);
            fs.renameSync(temp, this.file);
        } catch (error) {
            fs.rmSync(temp, { force: true });
            throw error;
        }
    }
}

function parseSettings(raw: string | null): UiSettings {
    if (raw === null) {
        return uiSettingsSchema.parse({});
    }

    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch (error) {
        process.stderr.write(`Настройки не разобрались как JSON (${messageOf(error)}) — беру дефолты.\n`);
        return uiSettingsSchema.parse({});
    }

    // Неизвестные поля zod отбрасывает сам: схема — истина, чужое в файле не переживает запись.
    const result = uiSettingsSchema.safeParse(parsed);
    if (result.success) {
        return result.data;
    }
    process.stderr.write('Настройки не сошлись со схемой — беру дефолты.\n');
    return uiSettingsSchema.parse({});
}

function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

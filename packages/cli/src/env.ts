import os from 'node:os';
import path from 'node:path';

/** Сохраняем локальную настройку каталога данных при обновлении дистрибутива. */
export function loadSherpaEnv(filePath = path.join(os.homedir(), '.sherpa', '.env')): void {
    try {
        process.loadEnvFile(filePath);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
}

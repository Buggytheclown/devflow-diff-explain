import fs from 'node:fs/promises';
import path from 'node:path';

/** Собранный UI по умолчанию: `packages/ui/dist` рядом с пакетом сервера. */
const DEFAULT_UI_DIR = path.resolve(import.meta.dirname, '../../ui/dist');

/** Что делать, если UI не собран, — текст один и тот же для дев-запуска, скилла и ошибок. */
export const UI_BUILD_HINT = 'собери UI: `pnpm --filter @sherpa/ui build`';

export function readOption(argv: readonly string[], name: string): string | null {
    const index = argv.indexOf(name);
    if (index === -1) {
        return null;
    }
    return argv[index + 1] ?? null;
}

/**
 * Каталог UI: явный `--ui` (несуществующий — ошибка, иначе опечатку молча съедим)
 * или дефолтная сборка, если она уже есть.
 */
export async function resolveUiDir(option: string | null): Promise<string | null> {
    if (option !== null) {
        const dir = path.resolve(option);
        if (!(await isDirectory(dir))) {
            throw new Error(`Каталог UI ${dir} не существует — ${UI_BUILD_HINT}.`);
        }
        return dir;
    }
    return (await isDirectory(DEFAULT_UI_DIR)) ? DEFAULT_UI_DIR : null;
}

export async function isDirectory(dir: string): Promise<boolean> {
    try {
        return (await fs.stat(dir)).isDirectory();
    } catch {
        return false;
    }
}

/**
 * Ссылка на UI для дев-запуска. Токен во фрагменте: на сервер он не уходит, но переживает
 * перезагрузку страницы. Ту же ссылку ревьюеру печатает `devflow-diff-explain up` — она строится в CLI.
 */
export function formatUiUrl(port: number, token: string, host = '127.0.0.1'): string {
    const authority = host.includes(':') ? `[${host}]` : host;
    return `UI: http://${authority}:${String(port)}/#t=${token}`;
}

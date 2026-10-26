import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { prKeySchema } from '@sherpa/protocol';

/** Корень стейта Шерпы по умолчанию; в тестах и дев-запусках переопределяется. */
export const DEFAULT_SHERPA_DIR = path.join(os.homedir(), '.sherpa');

/** Права каталогов стейта: содержимое (токены, драфты, история) видит только владелец (docs/architecture.md §6). */
const DIR_MODE = 0o700;

export function assertValidPrKey(prKey: string): string {
    if (!prKeySchema.safeParse(prKey).success) {
        throw new Error(
            `Некорректный ключ PR: ${JSON.stringify(prKey)}. ` +
                'Ожидается вида `<host>-<pr>` из букв, цифр, точки, дефиса и подчёркивания.',
        );
    }
    return prKey;
}

/**
 * Глобальные настройки UI: один файл на пользователя рядом с `servers/` и `prs/`.
 * Не per-PR: сервер каждого PR слушает случайный порт, и `localStorage` браузера каждый раз пуст.
 */
export function settingsPathFor(sherpaDir: string): string {
    return path.join(sherpaDir, 'settings.json');
}

/**
 * Кэш проверки новой версии: один файл на пользователя рядом с настройками —
 * перезапуски серверов любых PR не должны долбить Арканум чаще раза в 30 минут.
 */
export function updateCheckPathFor(sherpaDir: string): string {
    return path.join(sherpaDir, 'update-check.json');
}

/** Каталог манифестов discovery (docs/protocol.md §8). */
export function serversDirOf(sherpaDir: string): string {
    return path.join(sherpaDir, 'servers');
}

/** Каталог стейта одного PR: SQLite-файл и всё, что появится позже (docs/architecture.md §1). */
export function prStateDirOf(sherpaDir: string, prKey: string): string {
    return path.join(sherpaDir, 'prs', assertValidPrKey(prKey));
}

export function manifestPathFor(sherpaDir: string, prKey: string): string {
    return path.join(serversDirOf(sherpaDir), `${assertValidPrKey(prKey)}.json`);
}

/** Кэш байтов картинок диффа: содержательно адресуемые блобы этого PR. */
export function blobsDirOf(sherpaDir: string, prKey: string): string {
    return path.join(prStateDirOf(sherpaDir, prKey), 'blobs');
}

export function databasePathFor(sherpaDir: string, prKey: string): string {
    return path.join(prStateDirOf(sherpaDir, prKey), 'sherpa.db');
}

/** Какой каталог ревьюирует ключ локального хоста: каталог проекта, ветка и база. */
export function localHostStatePathFor(sherpaDir: string, prKey: string): string {
    return path.join(prStateDirOf(sherpaDir, prKey), 'local-host.json');
}

/** Карта «ключ повтора черновика → комментарий GitHub»: ключей идемпотентности GitHub не знает. */
export function githubDraftsPathFor(sherpaDir: string, prKey: string): string {
    return path.join(prStateDirOf(sherpaDir, prKey), 'github-drafts.json');
}

/** Комментарии локального ревью: удалённого хоста у них нет — они живут здесь. */
export function localReviewPathFor(sherpaDir: string, prKey: string): string {
    return path.join(prStateDirOf(sherpaDir, prKey), 'local-review.json');
}

/** История итераций локального ревью: индекс и блобы новых сторон текстовых файлов. */
export function localIterationsDirOf(sherpaDir: string, prKey: string): string {
    return path.join(prStateDirOf(sherpaDir, prKey), 'local-iterations');
}

/** Корень payload задач PR; писатели маршрута и чата получают отдельные подкаталоги. */
export function payloadDirOf(sherpaDir: string, prKey: string): string {
    return path.join(prStateDirOf(sherpaDir, prKey), 'payload');
}

/** Payload генерации маршрута: внутри — один очищаемый подкаталог на генерацию. */
export function routePayloadDirOf(sherpaDir: string, prKey: string): string {
    return path.join(payloadDirOf(sherpaDir, prKey), 'route');
}

/** Payload вопросов чата: отдельный неизменяемый подкаталог на каждую задачу. */
export function chatPayloadDirOf(sherpaDir: string, prKey: string): string {
    return path.join(payloadDirOf(sherpaDir, prKey), 'chat');
}

/** Payload раундов локального ревью: свой подкаталог на каждый раунд. */
export function feedbackPayloadDirOf(sherpaDir: string, prKey: string): string {
    return path.join(payloadDirOf(sherpaDir, prKey), 'feedback');
}

/**
 * Общий контекст задач: то, что между задачами не меняется (дифф, файлы, методички), лежит здесь
 * по стабильному пути — модель по пути видит, что этот файл в сессии уже читала.
 */
export function sharedPayloadDirOf(sherpaDir: string, prKey: string): string {
    return path.join(payloadDirOf(sherpaDir, prKey), 'shared');
}

/**
 * Файл с идентичностью воркера PR: его пишет сервер при регистрации, а читает CLI — env не
 * переживает отдельные вызовы харнеса. Путь обязан совпадать с `workerIdPathFor` в CLI.
 */
export function workerIdPathFor(sherpaDir: string, prKey: string): string {
    return path.join(prStateDirOf(sherpaDir, prKey), 'worker-id');
}

/** Создаёт каталог вместе с родителями и выставляет 0700 каждому уровню внутри `sherpaDir`. */
export async function ensurePrivateDir(sherpaDir: string, dir: string): Promise<void> {
    await fs.mkdir(dir, { recursive: true, mode: DIR_MODE });

    // mkdir применяет mode с учётом umask, а каталоги могли существовать и раньше — досоздаём права явно.
    for (const level of levelsWithin(sherpaDir, dir)) {
        await fs.chmod(level, DIR_MODE);
    }
}

/** Пути от `sherpaDir` (включительно) до `dir` (включительно). */
function levelsWithin(sherpaDir: string, dir: string): string[] {
    const relative = path.relative(sherpaDir, dir);
    const levels = [sherpaDir];
    if (relative === '' || relative.startsWith('..')) {
        return levels;
    }

    let current = sherpaDir;
    for (const segment of relative.split(path.sep)) {
        current = path.join(current, segment);
        levels.push(current);
    }
    return levels;
}

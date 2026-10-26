import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

import type { Task } from '@sherpa/protocol';
import { prKeySchema } from '@sherpa/protocol';

import { CliError } from './errors.js';

export function assertValidPrKey(prKey: string): string {
    if (!prKeySchema.safeParse(prKey).success) {
        throw new CliError(
            `devflow-diff-explain: invalid PR key ${JSON.stringify(prKey)}.\n` +
                'Expected the form `<host>-<pr>` made of letters, digits, dot, dash and underscore.',
        );
    }
    return prKey;
}

/** Корень стейта Шерпы: `SHERPA_DIR` для тестов и дев-запусков, иначе `~/.sherpa`. */
export function sherpaDirFrom(env: Readonly<Record<string, string | undefined>>): string {
    return sherpaDirOverrideFrom(env) ?? path.join(os.homedir(), '.sherpa');
}

/** Явный корень стейта из `SHERPA_DIR`, без дефолта; undefined — не задан. */
function sherpaDirOverrideFrom(env: Readonly<Record<string, string | undefined>>): string | undefined {
    const override = env.SHERPA_DIR?.trim();
    return override === undefined || override === '' ? undefined : override;
}

/**
 * Явный путь к модулю сервера из `SHERPA_SERVER_BIN`; undefined — не задан.
 * Обычно сервер лежит соседним файлом в каталоге скилла, оверрайд нужен дев-запускам; им же `up`
 * передаёт демону найденный модуль.
 */
export function serverBinOverrideFrom(env: Readonly<Record<string, string | undefined>>): string | undefined {
    const override = env.SHERPA_SERVER_BIN?.trim();
    return override === undefined || override === '' ? undefined : override;
}

/** Манифест discovery, который пишет сервер (`docs/protocol.md §8`). */
export function manifestPathFor(sherpaDir: string, prKey: string): string {
    return path.join(sherpaDir, 'servers', `${assertValidPrKey(prKey)}.json`);
}

/** Каталог стейта одного PR: идентичность воркера, лог сервера и всё, что появится позже. */
function prStateDirOf(sherpaDir: string, prKey: string): string {
    return path.join(sherpaDir, 'prs', assertValidPrKey(prKey));
}

/**
 * Идентичность сессии-воркера живёт в файле стейта PR: env не переживает отдельные вызовы харнеса.
 * CLI его читает, а пишет при регистрации сервер (`workerIdPathFor` в пакете server) — путь общий.
 */
export function workerIdPathFor(sherpaDir: string, prKey: string): string {
    return path.join(prStateDirOf(sherpaDir, prKey), 'worker-id');
}

/** Лог демона сервера: его пишет сам сервер, читает — CLI, когда сервер не поднялся. */
export function serverLogPathFor(sherpaDir: string, prKey: string): string {
    return path.join(prStateDirOf(sherpaDir, prKey), 'server.log');
}

/**
 * Корень файлов результатов во временном каталоге системы (`tmpRoot` — обычно `os.tmpdir()`).
 * На Linux это общий `/tmp`: uid в имени разводит пользователей, владельца и права CLI проверяет сам.
 */
export function taskResultRootFor(tmpRoot: string): string {
    const uid = process.getuid?.();
    return path.join(tmpRoot, uid === undefined ? 'sherpa' : `sherpa-${String(uid)}`);
}

/**
 * Каталог результатов одной сессии-воркера: хеш корня стейта и workerId. Нумерация задач своя
 * у каждого экземпляра сервера, поэтому одинаковые номера разных сессий и серверов в один файл не сходятся.
 */
export function taskResultDirFor(tmpRoot: string, sherpaDir: string, prKey: string, workerId: string): string {
    const session = createHash('sha256').update(`${sherpaDir}\n${workerId}`).digest('hex').slice(0, 16);
    return path.join(taskResultRootFor(tmpRoot), assertValidPrKey(prKey), session);
}

/**
 * Файл результата одной попытки задачи в каталоге сессии: путь выдаёт CLI, чтобы сессии не делили
 * файл. `json` — у задачи есть схема результата, иначе ответ — markdown.
 */
export function taskResultFileFor(dir: string, task: Pick<Task, 'id' | 'attempt' | 'resultSchemaFile'>): string {
    const ext = task.resultSchemaFile === undefined ? 'md' : 'json';
    return path.join(dir, `${String(task.id)}-${String(task.attempt)}.${ext}`);
}

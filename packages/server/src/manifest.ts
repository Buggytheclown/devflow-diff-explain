import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import type { ServerManifest } from '@sherpa/protocol';
import { serverManifestSchema } from '@sherpa/protocol';

/** Права файла манифеста: в нём лежит bearer-токен (docs/protocol.md §8, docs/architecture.md §6). */
const MANIFEST_MODE = 0o600;

/** Проба живости соседнего сервера — локальный запрос, ждать дольше нечего. */
const HEALTH_PROBE_TIMEOUT_MS = 1000;

/**
 * Заявка на PR: манифест появляется по пути целиком и только если пути ещё никто не занял.
 * `link` на уже готовый временный файл — единственная атомарная в POSIX связка «создай, если нет».
 * Возвращает `false`, если манифест уже есть: место занял другой сервер.
 */
export async function claimManifest(manifestPath: string, manifest: ServerManifest): Promise<boolean> {
    const tmpPath = await stageManifest(manifestPath, manifest);
    try {
        await fs.link(tmpPath, manifestPath);
        return true;
    } catch (error) {
        if (isErrnoCode(error, 'EEXIST')) {
            return false;
        }
        throw error;
    } finally {
        await fs.rm(tmpPath, { force: true });
    }
}

/**
 * Снимает чужой манифест, признанный протухшим (`stale` — то, по чему принималось решение;
 * `null`, если по пути лежит не манифест вовсе). Файл уводится в сторону атомарным rename,
 * после чего проверяется, что увели именно его: иначе место успел занять живой сервер и файл
 * возвращается назад.
 */
export async function releaseStaleManifest(manifestPath: string, stale: ServerManifest | null): Promise<void> {
    const asidePath = path.join(
        path.dirname(manifestPath),
        `.${path.basename(manifestPath)}.${randomUUID()}.stale`,
    );

    try {
        await fs.rename(manifestPath, asidePath);
    } catch {
        // Кто-то убрал манифест раньше нас — работа уже сделана.
        return;
    }

    const moved = await readManifest(asidePath);
    if (!sameManifest(moved, stale)) {
        try {
            await fs.link(asidePath, manifestPath);
        } catch {
            // Место занято ещё более свежим манифестом — возвращать нечего.
        }
    }
    await fs.rm(asidePath, { force: true });
}

/** Готовый к публикации манифест во временном файле рядом с целевым: те же права, тот же раздел ФС. */
async function stageManifest(manifestPath: string, manifest: ServerManifest): Promise<string> {
    const parsed = serverManifestSchema.parse(manifest);
    const tmpPath = path.join(path.dirname(manifestPath), `.${path.basename(manifestPath)}.${randomUUID()}.tmp`);

    await fs.writeFile(tmpPath, `${JSON.stringify(parsed, null, 2)}\n`, { mode: MANIFEST_MODE });
    try {
        // writeFile применяет mode с учётом umask — доводим права до 0600 явно.
        await fs.chmod(tmpPath, MANIFEST_MODE);
    } catch (error) {
        await fs.rm(tmpPath, { force: true });
        throw error;
    }
    return tmpPath;
}

function sameManifest(left: ServerManifest | null, right: ServerManifest | null): boolean {
    if (left === null || right === null) {
        return left === right;
    }
    return (
        left.pid === right.pid &&
        left.port === right.port &&
        left.token === right.token &&
        left.createdAt === right.createdAt
    );
}

function isErrnoCode(error: unknown, code: string): boolean {
    return error instanceof Error && 'code' in error && error.code === code;
}

/** Читает манифест; отсутствующий, битый и не прошедший схему — одинаково `null` (fail-closed). */
export async function readManifest(manifestPath: string): Promise<ServerManifest | null> {
    let raw: string;
    try {
        raw = await fs.readFile(manifestPath, 'utf8');
    } catch {
        return null;
    }

    let json: unknown;
    try {
        json = JSON.parse(raw);
    } catch {
        return null;
    }

    const parsed = serverManifestSchema.safeParse(json);
    return parsed.success ? parsed.data : null;
}

/** Удаляет манифест, только если он всё ещё описывает этот процесс — чужой не трогаем. */
export async function removeOwnManifest(manifestPath: string, manifest: ServerManifest): Promise<void> {
    const current = await readManifest(manifestPath);
    if (current?.pid !== manifest.pid || current.port !== manifest.port) {
        return;
    }
    await fs.rm(manifestPath, { force: true });
}

/** Жив ли процесс с таким PID. Сигнал 0 ничего не шлёт, только проверяет существование. */
export function isProcessAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        // EPERM: процесс есть, но чужой — для наших целей это «жив».
        return isErrnoCode(error, 'EPERM');
    }
}

/**
 * Сервер из манифеста действительно работает: PID жив И `/healthz` отвечает
 * тем же prKey с токеном из манифеста (иначе порт мог занять кто угодно).
 */
export async function isManifestServerAlive(manifest: ServerManifest): Promise<boolean> {
    if (!isProcessAlive(manifest.pid)) {
        return false;
    }
    return probeHealth(manifest);
}

async function probeHealth(manifest: ServerManifest): Promise<boolean> {
    try {
        const response = await fetch(`http://127.0.0.1:${String(manifest.port)}/healthz`, {
            headers: { authorization: `Bearer ${manifest.token}` },
            signal: AbortSignal.timeout(HEALTH_PROBE_TIMEOUT_MS),
        });
        if (!response.ok) {
            return false;
        }

        const body: unknown = await response.json();
        return isRecord(body) && body.ok === true && body.prKey === manifest.prKey;
    } catch {
        return false;
    }
}

/**
 * Удаляет протухшие манифесты: не проходящие схему и оставшиеся от мёртвых процессов.
 * Вызывается при старте сервера и при запуске скилла (docs/protocol.md §8). Возвращает удалённые файлы.
 */
export async function cleanStaleManifests(serversDir: string): Promise<string[]> {
    let entries: string[];
    try {
        entries = await fs.readdir(serversDir);
    } catch {
        return [];
    }

    const removed: string[] = [];
    for (const entry of entries) {
        if (!entry.endsWith('.json')) {
            continue;
        }

        const manifestPath = path.join(serversDir, entry);
        const manifest = await readManifest(manifestPath);
        if (manifest !== null && isProcessAlive(manifest.pid)) {
            continue;
        }

        await fs.rm(manifestPath, { force: true });
        removed.push(manifestPath);
    }
    return removed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

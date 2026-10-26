import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

import { RpcFailure } from './errors.js';

const execFileAsync = promisify(execFile);

/** Источники OAuth-токена Трекера в порядке приоритета. */
export const TRACKER_TOKEN_ENV_VARS = ['SHERPA_TRACKER_TOKEN', 'TRACKER_TOKEN', 'STARTREK_TOKEN'] as const;

/** Запасной источник: `ya tool fetch-token` добывает токен по SSH-ключу, без браузера. */
export const YA_FETCH_TOKEN_ARGS = ['tool', 'fetch-token', '-preset', 'startrek'] as const;

/** Маркер корня чекаута Аркадии: `ya` лежит рядом с ним. */
const ARCADIA_ROOT_MARKER = '.arcadia.root';

/** Первый запуск `ya tool` докачивает инструмент — держим запас сверх обычных секунд. */
const FETCH_TOKEN_TIMEOUT_MS = 30_000;

export type TrackerTokenSource = () => Promise<string | null>;

/** Запуск `ya` с аргументами; возвращает stdout. */
export type RunYa = (ya: string, args: readonly string[]) => Promise<string>;

export interface TrackerTokenOptions {
    readonly env?: NodeJS.ProcessEnv;
    /** Путь к `ya` для запасного источника; не задан или null — токен берётся только из окружения. */
    readonly ya?: string | null;
    readonly runYa?: RunYa;
}

/** Ленивый источник токена: результат кэшируется, неудача кэш не отравляет. */
export function trackerTokenSource(options: TrackerTokenOptions = {}): TrackerTokenSource {
    let cached: Promise<string | null> | null = null;
    return () => {
        cached ??= Promise.resolve()
            .then(() => resolveTrackerToken(options))
            .catch((error: unknown) => {
                cached = null;
                throw tokenResolutionFailure(error);
            });
        return cached;
    };
}

/**
 * Окружение, затем `ya tool fetch-token -preset startrek`. Провал `ya` — `RpcFailure`
 * с причиной, но без значения токена и без stdout команды.
 */
export async function resolveTrackerToken(options: TrackerTokenOptions = {}): Promise<string | null> {
    const fromEnv = trackerTokenFromEnv(options.env ?? process.env);
    if (fromEnv !== null) {
        return fromEnv;
    }
    const ya = options.ya ?? null;
    if (ya === null) {
        return null;
    }
    return fetchTokenWithYa(ya, options.runYa ?? defaultRunYa);
}

/** Читает только окружение, без файлов и процессов. */
export function trackerTokenFromEnv(env: NodeJS.ProcessEnv): string | null {
    for (const name of TRACKER_TOKEN_ENV_VARS) {
        const token = (env[name] ?? '').trim();
        if (token !== '') {
            return token;
        }
    }
    return null;
}

/**
 * Доступность для UI-снапшота: синхронно и без запуска процессов. Найденный `ya` считается
 * достаточным — сработает ли `fetch-token`, выяснится при первой отправке.
 */
export function trackerTokenAvailable(options: TrackerTokenOptions = {}): boolean {
    return trackerTokenFromEnv(options.env ?? process.env) !== null || (options.ya ?? null) !== null;
}

export interface LocateYaOptions {
    readonly env?: NodeJS.ProcessEnv;
    /** Каталоги, от которых подниматься к корню чекаута Аркадии; по умолчанию cwd процесса. */
    readonly startDirs?: readonly string[];
}

/**
 * Путь к `ya`: сначала PATH, затем корень чекаута Аркадии над каждым из стартовых каталогов.
 * `ya` в PATH бывает не у всех, а сервер обычно запущен из чекаута или установлен в него.
 */
export function locateYa(options: LocateYaOptions = {}): string | null {
    const env = options.env ?? process.env;
    for (const dir of (env.PATH ?? '').split(path.delimiter)) {
        if (dir === '') {
            continue;
        }
        const candidate = path.join(dir, 'ya');
        if (isExecutable(candidate)) {
            return candidate;
        }
    }

    for (const start of options.startDirs ?? [process.cwd()]) {
        const root = findArcadiaRoot(path.resolve(start));
        if (root === null) {
            continue;
        }
        const candidate = path.join(root, 'ya');
        if (isExecutable(candidate)) {
            return candidate;
        }
    }
    return null;
}

function findArcadiaRoot(start: string): string | null {
    let dir = start;
    for (;;) {
        if (fs.existsSync(path.join(dir, ARCADIA_ROOT_MARKER))) {
            return dir;
        }
        const parent = path.dirname(dir);
        if (parent === dir) {
            return null;
        }
        dir = parent;
    }
}

function isExecutable(file: string): boolean {
    try {
        fs.accessSync(file, fs.constants.X_OK);
        return fs.statSync(file).isFile();
    } catch {
        return false;
    }
}

async function fetchTokenWithYa(ya: string, runYa: RunYa): Promise<string> {
    let stdout: string;
    try {
        stdout = await runYa(ya, YA_FETCH_TOKEN_ARGS);
    } catch (error) {
        throw fetchTokenFailure(messageOf(error));
    }
    const token = stdout.trim();
    if (token === '') {
        throw fetchTokenFailure('команда вернула пустой вывод');
    }
    if (!/^\S+$/u.test(token)) {
        throw fetchTokenFailure('вывод команды не похож на токен');
    }
    return token;
}

async function defaultRunYa(ya: string, args: readonly string[]): Promise<string> {
    const { stdout } = await execFileAsync(ya, [...args], { timeout: FETCH_TOKEN_TIMEOUT_MS });
    return stdout;
}

function fetchTokenFailure(reason: string): RpcFailure {
    return new RpcFailure(
        'host_unavailable',
        `Нет OAuth-токена Трекера: не удалось получить его через \`ya ${YA_FETCH_TOKEN_ARGS.join(' ')}\`.`,
        [reason],
    );
}

function tokenResolutionFailure(error: unknown): RpcFailure {
    if (error instanceof RpcFailure) {
        return error;
    }
    return new RpcFailure(
        'host_unavailable',
        'Не удалось проверить OAuth-токен Яндекс Трекера в окружении.',
    );
}

/**
 * Текст ошибки `execFile` содержит команду и stderr, но не токен (он уходит в stdout) —
 * на всякий случай режем длину, чтобы случайный вывод не уехал в лог целиком.
 */
function messageOf(error: unknown): string {
    const message = (error instanceof Error ? error.message : String(error)).replaceAll(/\s+/gu, ' ').trim();
    return message.length > 200 ? `${message.slice(0, 200)}…` : message;
}

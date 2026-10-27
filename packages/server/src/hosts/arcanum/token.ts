import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { RpcFailure } from '../../errors.js';

/**
 * Токен Арканума берётся цепочкой arc (`docs/architecture.md` §Токен): `$ARC_TOKEN` → `~/.arc/token` →
 * `arc token show --json`. Никакого браузерного OAuth: сервер читает токен ровно так же, как `arc`.
 *
 * Значение токена нигде не логируется и не попадает в тексты ошибок (`docs/architecture.md`) — наружу выходит
 * только то, какой источник сработал и почему остальные не подошли.
 */

const execFileAsync = promisify(execFile);

/** Ленивый источник токена: результат кэшируется, неудача кэш не отравляет. */
export type TokenSource = () => Promise<string>;

export interface ArcTokenOptions {
    readonly env?: NodeJS.ProcessEnv;
    /** Путь к файлу токена arc; по умолчанию `~/.arc/token`. */
    readonly tokenFile?: string;
    readonly readFile?: (file: string) => Promise<string>;
    /** Запуск `arc token show --json`; возвращает stdout. */
    readonly runArc?: () => Promise<string>;
}

const ENV_VAR = 'ARC_TOKEN';

export function arcTokenSource(options: ArcTokenOptions = {}): TokenSource {
    let cached: Promise<string> | null = null;
    return () => {
        cached ??= resolveArcToken(options).catch((error: unknown) => {
            // Иначе одна неудача (сеть, отсутствующий arc) залипла бы на весь процесс.
            cached = null;
            throw error;
        });
        return cached;
    };
}

export async function resolveArcToken(options: ArcTokenOptions = {}): Promise<string> {
    const env = options.env ?? process.env;
    const tokenFile = options.tokenFile ?? path.join(os.homedir(), '.arc', 'token');
    const readFile = options.readFile ?? ((file: string) => fs.readFile(file, 'utf8'));
    const runArc = options.runArc ?? defaultRunArc;
    const misses: string[] = [];

    const fromEnv = (env[ENV_VAR] ?? '').trim();
    if (fromEnv !== '') {
        return fromEnv;
    }
    misses.push(`${ENV_VAR} не задан`);

    try {
        const fromFile = (await readFile(tokenFile)).trim();
        if (fromFile !== '') {
            return fromFile;
        }
        misses.push(`${tokenFile} пуст`);
    } catch (error) {
        misses.push(`${tokenFile}: ${messageOf(error)}`);
    }

    try {
        const token = parseArcTokenJson(await runArc());
        if (token !== '') {
            return token;
        }
        misses.push('`arc token show --json` вернул пустой токен');
    } catch (error) {
        misses.push(`\`arc token show --json\`: ${messageOf(error)}`);
    }

    throw new RpcFailure(
        'host_unavailable',
        'Не удалось получить токен arc для Арканума.',
        misses,
    );
}

/** Из stdout `arc token show --json` берётся только поле `token`; остальное не нужно. */
function parseArcTokenJson(stdout: string): string {
    let parsed: unknown;
    try {
        parsed = JSON.parse(stdout);
    } catch {
        throw new Error('вывод не является JSON');
    }
    if (typeof parsed !== 'object' || parsed === null || !('token' in parsed)) {
        throw new Error('в выводе нет поля `token`');
    }
    const token: unknown = parsed.token;
    if (typeof token !== 'string') {
        throw new Error('поле `token` не строка');
    }
    return token.trim();
}

async function defaultRunArc(): Promise<string> {
    const { stdout } = await execFileAsync('arc', ['token', 'show', '--json'], { timeout: 20_000 });
    return stdout;
}

/**
 * Текст чужой ошибки для списка причин. Сообщения `execFile` и `fs` содержат команду и путь,
 * но не значение токена — на всякий случай режем длину, чтобы случайный вывод не уехал в лог целиком.
 */
function messageOf(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    return message.length > 200 ? `${message.slice(0, 200)}…` : message;
}

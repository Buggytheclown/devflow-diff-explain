import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { RpcFailure } from '../../errors.js';

/**
 * Токен GitHub берётся цепочкой `gh` (`docs/research/github-api.md` §Токен): `$GITHUB_TOKEN` →
 * `$GH_TOKEN` → `gh auth token`. Своего входа в OAuth у Шерпы нет: она читает токен ровно там,
 * где его держит официальный CLI.
 *
 * Значение токена нигде не логируется и не попадает в тексты ошибок (`docs/architecture.md §6`) —
 * наружу выходит только то, какой источник сработал и почему остальные не подошли.
 */

const execFileAsync = promisify(execFile);

/** Ленивый источник токена: результат кэшируется, неудача кэш не отравляет. */
export type TokenSource = () => Promise<string>;

export interface GithubTokenOptions {
    readonly env?: NodeJS.ProcessEnv;
    /** Запуск `gh auth token`; возвращает stdout. */
    readonly runGh?: () => Promise<string>;
}

const ENV_VARS = ['GITHUB_TOKEN', 'GH_TOKEN'] as const;

export function githubTokenSource(options: GithubTokenOptions = {}): TokenSource {
    let cached: Promise<string> | null = null;
    return () => {
        cached ??= resolveGithubToken(options).catch((error: unknown) => {
            // Иначе одна неудача (нет `gh`, протухшая сессия) залипла бы на весь процесс.
            cached = null;
            throw error;
        });
        return cached;
    };
}

export async function resolveGithubToken(options: GithubTokenOptions = {}): Promise<string> {
    const env = options.env ?? process.env;
    const runGh = options.runGh ?? defaultRunGh;
    const misses: string[] = [];

    for (const name of ENV_VARS) {
        const value = (env[name] ?? '').trim();
        if (value !== '') {
            return value;
        }
        misses.push(`${name} не задан`);
    }

    try {
        const token = (await runGh()).trim();
        if (token !== '') {
            return token;
        }
        misses.push('`gh auth token` вернул пустой токен');
    } catch (error) {
        misses.push(`\`gh auth token\`: ${messageOf(error)}`);
    }

    throw new RpcFailure('host_unavailable', 'Не удалось получить токен GitHub.', misses);
}

async function defaultRunGh(): Promise<string> {
    const { stdout } = await execFileAsync('gh', ['auth', 'token'], { timeout: 20_000 });
    return stdout;
}

/**
 * Текст чужой ошибки для списка причин. Сообщения `execFile` содержат команду, но не значение
 * токена — на всякий случай режем длину, чтобы случайный вывод не уехал в лог целиком.
 */
function messageOf(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    return message.length > 200 ? `${message.slice(0, 200)}…` : message;
}

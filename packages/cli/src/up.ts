import type { ChildProcess } from 'node:child_process';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

import type { ServerManifest } from '@sherpa/protocol';

import { readManifestFile } from './discovery.js';
import { CliError } from './errors.js';
import { formatUiUrl } from './format.js';
import { manifestPathFor, serverLogPathFor } from './paths.js';

/** Модуль сервера лежит соседним файлом в каталоге скилла — там же, где сам CLI. */
const SERVER_BIN_NAME = 'devflow-diff-explain-server.mjs';

/** Сколько ждём, пока демон опубликует живой манифест. */
const STARTUP_TIMEOUT_MS = 10_000;
const POLL_INTERVAL_MS = 200;

/** Проба живости соседнего сервера — локальный запрос, ждать дольше нечего. */
const HEALTH_PROBE_TIMEOUT_MS = 1_000;

/** Сколько строк лога показываем, когда демон не поднялся. */
const LOG_TAIL_LINES = 20;

/** Права каталогов стейта: содержимое видит только владелец (`docs/architecture.md §6`). */
const STATE_DIR_MODE = 0o700;

/** Сколько ждём завершения после каждого сигнала в `terminateChild`. */
const TERMINATE_GRACE_MS = 2_000;
const EXIT_POLL_INTERVAL_MS = 20;

export interface EnsureServerResult {
    readonly uiUrl: string;
    readonly started: boolean;
}

export interface EnsureServerOptions {
    readonly prKey: string;
    /** Корень стейта: сервер `SHERPA_DIR` не читает, путь ему передаёт CLI. */
    readonly sherpaDir: string;
    /**
     * Путь к файлу запущенного CLI (`process.argv[1]`): его же `up` спавнит демоном `devflow-diff-explain server`. Рядом
     * лежит модуль сервера, а на каталог выше — корень дистрибутива, который уезжает серверу в `--install-dir`.
     */
    readonly entry: string | undefined;
    /** Явный путь к модулю сервера из `SHERPA_SERVER_BIN` — для дев-сценариев. */
    readonly serverBin?: string | undefined;
    /**
     * Флаги Node для процесса демона; те, что текущий рантайм не знает, молча отбрасываются.
     * Значения задаёт композиционный корень CLI (`index.ts`).
     */
    readonly nodeFlags?: readonly string[];
    /**
     * Локальное ревью: каталог проекта, база сравнения, ветка, на которой построен ключ, и поручение
     * на исход ревью. Всё это знает только CLI — серверу оно уезжает аргументами и сохраняется в стейте
     * ключа, чтобы перезапуск обошёлся без них.
     */
    readonly repo?: string | undefined;
    readonly base?: string | undefined;
    readonly branch?: string | undefined;
    /** Поручение на исход ревью (`--verdicts`): с ним ревью завершается Ship или Request changes. */
    readonly verdicts?: string | undefined;
    /** Сколько ждём публикации манифеста; в тестах сокращается. */
    readonly startupTimeoutMs?: number;
}

/** Что CLI ждёт от модуля сервера; типы `@sherpa/server` в CLI не импортируются. */
export interface ServerModule {
    readonly runServer: (argv: readonly string[]) => Promise<number>;
}

/** Заспавненный демон вместе с ошибкой spawn: она приходит асинхронно, отдельным событием. */
interface Daemon {
    readonly process: ChildProcess;
    spawnError: Error | null;
}

/**
 * Сервер PR на месте — и ссылка на UI для ревьюера. Идемпотентно: живой сервер этого PR находится
 * по манифесту (`docs/protocol.md §8`) и переиспользуется, иначе поднимается демон `devflow-diff-explain server`,
 * переживающий выход CLI. Ни pnpm, ни чекаута репозитория для этого не нужно.
 */
export async function ensureServer(options: EnsureServerOptions): Promise<EnsureServerResult> {
    const manifestPath = manifestPathFor(options.sherpaDir, options.prKey);

    const running = await readManifestFile(manifestPath);
    if (running !== null && running.prKey === options.prKey && (await isManifestServerAlive(running))) {
        return { uiUrl: formatUiUrl(running.port, running.token, running.uiHost), started: false };
    }

    const entry = await realEntry(options.entry);
    if (entry === null) {
        throw new CliError(INCOMPLETE_DISTRIBUTION);
    }
    const serverBin = await resolveServerBin(entry, options.serverBin);
    const logPath = await prepareLogPath(options.sherpaDir, options.prKey);
    const daemon = await spawnDaemon(entry, serverBin, options, logPath);

    const timeoutMs = options.startupTimeoutMs ?? STARTUP_TIMEOUT_MS;
    const manifest = await waitForLiveManifest(manifestPath, options.prKey, daemon, timeoutMs);
    if (manifest === null) {
        // Манифеста нет — по нему демона не найдут ни следующий запуск, ни человек: снимаем сами.
        const reaped = await terminateChild(daemon.process);
        throw new CliError(await startupFailed(options.prKey, daemon, logPath, timeoutMs, reaped));
    }

    const started = daemon.process.pid !== undefined && manifest.pid === daemon.process.pid;
    return { uiUrl: formatUiUrl(manifest.port, manifest.token, manifest.uiHost), started };
}

/**
 * Путь к модулю сервера. Обычный ход — соседний файл в каталоге скилла; реальный путь берётся
 * через realpath, потому что каталог скилла ставится симлинком (`~/.claude/skills/devflow-diff-explain`).
 * `SHERPA_SERVER_BIN` перебивает поиск — им пользуются дев-запуски и тесты.
 */
export async function resolveServerBin(entry: string | undefined, override: string | undefined): Promise<string> {
    if (override !== undefined && override.trim() !== '') {
        const explicit = path.resolve(override.trim());
        if (!(await isFile(explicit))) {
            throw new CliError(
                `devflow-diff-explain: SHERPA_SERVER_BIN points at ${explicit}, but there is no file there.\n` +
                    'Fix the path or unset the variable to take the server from the skill directory.',
            );
        }
        return explicit;
    }

    const neighbour = await neighbourServerBin(entry);
    if (neighbour === null || !(await isFile(neighbour))) {
        throw new CliError(INCOMPLETE_DISTRIBUTION);
    }
    return neighbour;
}

async function neighbourServerBin(entry: string | undefined): Promise<string | null> {
    const real = await realEntry(entry);
    return real === null ? null : path.join(path.dirname(real), SERVER_BIN_NAME);
}

/** Реальный путь файла CLI; null — пути нет или он никуда не ведёт. */
async function realEntry(entry: string | undefined): Promise<string | null> {
    if (entry === undefined || entry.trim() === '') {
        return null;
    }
    try {
        return await fs.realpath(entry);
    } catch {
        return null;
    }
}

/**
 * Грузит модуль сервера. Зовётся только из `devflow-diff-explain server`: путь вычисляется в рантайме, поэтому
 * esbuild сервер в бандл CLI не тянет, а остальные команды его не грузят.
 */
export async function loadServerModule(file: string): Promise<ServerModule> {
    let loaded: unknown;
    try {
        loaded = await import(/* @vite-ignore */ pathToFileURL(file).href);
    } catch (error) {
        // Битый файл (например, недописанный релизом) — путь и причина нужны в server.log, а не «повтори команду».
        const detail = error instanceof Error ? error.message : String(error);
        throw new CliError(
            `devflow-diff-explain: the Sherpa server module ${file} failed to load — ${detail}.\n${REINSTALL_HINT}`,
        );
    }
    if (!isRecord(loaded) || typeof loaded.runServer !== 'function') {
        throw new CliError(INCOMPLETE_DISTRIBUTION);
    }
    return loaded as unknown as ServerModule;
}

/**
 * Сервер из манифеста действительно работает: PID жив И `/healthz` отвечает тем же prKey
 * с токеном из манифеста (иначе порт мог занять кто угодно). Та же проверка, что на сервере.
 */
export async function isManifestServerAlive(manifest: ServerManifest): Promise<boolean> {
    if (!isProcessAlive(manifest.pid)) {
        return false;
    }

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

/** Жив ли процесс с таким PID. Сигнал 0 ничего не шлёт, только проверяет существование. */
function isProcessAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        // EPERM: процесс есть, но чужой — для наших целей это «жив».
        return error instanceof Error && 'code' in error && error.code === 'EPERM';
    }
}

/**
 * Демон сервера — этот же CLI командой `devflow-diff-explain server`: detached + unref, чтобы он пережил выход CLI.
 * Найденный модуль сервера уезжает ребёнку в `SHERPA_SERVER_BIN`: он грузит ровно то, что проверил
 * родитель. stdio уходит в лог-файл — его никто не читает в рантайме, зато он остаётся человеку,
 * когда сервер не поднялся. Токена в логе нет: ссылку с токеном строит CLI, прочитав манифест.
 *
 * `--install-dir` — каталог дистрибутива (родитель `bin/`): откуда скилл установлен, знает только
 * CLI, а серверу это нужно для проверки новой версии в trunk.
 */
async function spawnDaemon(
    entry: string,
    serverBin: string,
    options: EnsureServerOptions,
    logPath: string,
): Promise<Daemon> {
    const installDir = path.dirname(path.dirname(await fs.realpath(serverBin)));
    const args = [
        ...supportedNodeFlags(options.nodeFlags ?? []),
        entry,
        'server',
        '--pr',
        options.prKey,
        '--sherpa-dir',
        options.sherpaDir,
        '--install-dir',
        installDir,
        ...(options.repo === undefined ? [] : ['--repo', options.repo]),
        ...(options.base === undefined ? [] : ['--base', options.base]),
        ...(options.branch === undefined ? [] : ['--branch', options.branch]),
        ...(options.verdicts === undefined ? [] : ['--verdicts', options.verdicts]),
    ];

    const log = await fs.open(logPath, 'a');
    try {
        const child = spawn(process.execPath, args, {
            detached: true,
            stdio: ['ignore', log.fd, log.fd],
            env: { ...process.env, SHERPA_SERVER_BIN: serverBin },
        });
        const daemon: Daemon = { process: child, spawnError: null };
        // Без подписки событие 'error' (например, ENOENT на execPath) свалило бы CLI исключением.
        child.once('error', (error: Error) => {
            daemon.spawnError = error;
        });
        child.unref();
        return daemon;
    } finally {
        // Дескриптор продублирован в дочерний процесс при spawn — свой можно закрывать.
        await log.close();
    }
}

/** Флаги Node, которые текущий рантайм знает: незнакомый уронил бы демона на старте. */
function supportedNodeFlags(flags: readonly string[]): readonly string[] {
    return flags.filter((flag) => process.allowedNodeEnvironmentFlags.has(flag));
}

/** Ждём, пока демон опубликует манифест и ответит на `/healthz`; умер или не стартовал — ждать нечего. */
async function waitForLiveManifest(
    manifestPath: string,
    prKey: string,
    daemon: Daemon,
    timeoutMs: number,
): Promise<ServerManifest | null> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        await delay(POLL_INTERVAL_MS);

        const manifest = await readManifestFile(manifestPath);
        if (manifest !== null && manifest.prKey === prKey && (await isManifestServerAlive(manifest))) {
            return manifest;
        }
        if (hasExited(daemon.process) || daemon.spawnError !== null) {
            return null;
        }
    }
    return null;
}

async function startupFailed(
    prKey: string,
    daemon: Daemon,
    logPath: string,
    timeoutMs: number,
    reaped: boolean,
): Promise<string> {
    const lines = [
        `devflow-diff-explain: the server for PR ${prKey} did not start within ${String(Math.round(timeoutMs / 1000))} s.`,
    ];
    if (daemon.spawnError !== null) {
        lines.push(`The process could not be started: ${daemon.spawnError.message}`);
    }
    if (!reaped && daemon.process.pid !== undefined) {
        lines.push(`Process ${String(daemon.process.pid)} did not exit — kill it manually.`);
    }
    lines.push(
        `Log: ${logPath}`,
        await readLogTail(logPath),
        'Show this text to the user and stop — do not start the worker loop.',
    );
    return lines.join('\n');
}

async function prepareLogPath(sherpaDir: string, prKey: string): Promise<string> {
    const logPath = serverLogPathFor(sherpaDir, prKey);
    try {
        await fs.mkdir(path.dirname(logPath), { recursive: true, mode: STATE_DIR_MODE });
    } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new CliError(
            `devflow-diff-explain: could not prepare the state directory for the log ${logPath} — ${detail}.\n` +
                'Check the permissions on the Sherpa state directory and call the command again.',
        );
    }
    return logPath;
}

/** Хвост лога: важен конец с ошибкой, а не вся история запусков. */
async function readLogTail(logPath: string): Promise<string> {
    let text: string;
    try {
        text = await fs.readFile(logPath, 'utf8');
    } catch {
        return '(the log is empty)';
    }
    const tail = text.split('\n').slice(-LOG_TAIL_LINES).join('\n').trim();
    return tail === '' ? '(the log is empty)' : tail;
}

/**
 * Снимает дочерний процесс: SIGTERM, а если не умер за отведённое время — SIGKILL.
 * Нужен демону, который так и не опубликовал манифест: искать его потом не по чему,
 * а detached-процесс переживёт CLI и останется висеть на порту.
 * Возвращает false, если процесс пережил даже SIGKILL.
 */
export async function terminateChild(child: ChildProcess, graceMs = TERMINATE_GRACE_MS): Promise<boolean> {
    if (hasExited(child)) {
        return true;
    }

    child.kill('SIGTERM');
    if (await waitForExit(child, graceMs)) {
        return true;
    }

    child.kill('SIGKILL');
    return waitForExit(child, graceMs);
}

/** Процесс отвязан от event loop через unref, но события выхода нам всё равно доставляются. */
export function hasExited(child: ChildProcess): boolean {
    return child.exitCode !== null || child.signalCode !== null;
}

async function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (!hasExited(child) && Date.now() < deadline) {
        await delay(EXIT_POLL_INTERVAL_MS);
    }
    return hasExited(child);
}

const REINSTALL_HINT =
    'Reinstall the Sherpa skill as a whole (the directory with SKILL.md and bin/). ' +
    'Show this text to the user and stop — do not start the worker loop.';

const INCOMPLETE_DISTRIBUTION =
    `devflow-diff-explain: the skill distribution is incomplete — ${SERVER_BIN_NAME} must sit next to devflow-diff-explain.mjs.\n${REINSTALL_HINT}`;

async function isFile(filePath: string): Promise<boolean> {
    try {
        return (await fs.stat(filePath)).isFile();
    } catch {
        return false;
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

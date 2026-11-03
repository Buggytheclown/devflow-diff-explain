import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';

import type { WorkerNextResponse, WorkerRegisterResponse } from '@sherpa/protocol';
import { RESULT_MAX_BYTES, ARTIFACT_ENDPOINTS, codeSnapshotInputSchema, sourcesInputSchema, codeSnapshotReceiptSchema } from '@sherpa/protocol';

import type { Command } from './args.js';
import { parseArgs } from './args.js';
import type { OpenBrowserOptions } from './browser.js';
import { openBrowser } from './browser.js';
import type { WorkerLabels } from './client.js';
import { requestComplete, requestFail, requestNext, requestProgress, requestRegister } from './client.js';
import type { ServerConnection } from './discovery.js';
import { connect, connectAs, freshWorkerId, resolvePrKey, readServerManifest } from './discovery.js';
import { CliError, userMessage } from './errors.js';
import {
    formatCompleteResponse,
    formatDone,
    formatFailResponse,
    formatOversizedResult,
    formatProgressResponse,
    formatTask,
    formatUpReady,
    helpText,
} from './format.js';
import {
    serverBinOverrideFrom,
    sherpaDirFrom,
    taskResultDirFor,
    taskResultFileFor,
    taskResultRootFor,
} from './paths.js';
import type { EnsureServerOptions, EnsureServerResult } from './up.js';
import { ensureServer, loadServerModule, resolveServerBin } from './up.js';
import { CLI_VERSION } from './version.js';

/** Окружение вызова: тесты подставляют своё, чтобы гонять команды функциями, а не процессами. */
export interface CliIo {
    readonly env: Readonly<Record<string, string | undefined>>;
    readonly out: (text: string) => void;
    readonly err: (text: string) => void;
    /** Путь к запущенному файлу CLI: рядом с ним лежит модуль сервера. По умолчанию — `process.argv[1]`. */
    readonly entry?: string;
    /** Флаги Node для демона сервера, который поднимает `up`; по умолчанию — никаких. */
    readonly daemonNodeFlags?: readonly string[];
    /** Тестовая подмена discovery/старта сервера. */
    readonly ensureServer?: (options: EnsureServerOptions) => Promise<EnsureServerResult>;
    /** Тестовая подмена системного opener: реальный браузер тесты не запускают. */
    readonly openBrowser?: (options: OpenBrowserOptions) => void;
    /** Корень для файлов результатов задач; по умолчанию — `os.tmpdir()`. */
    readonly tmpDir?: string;
}

/**
 * Один запуск CLI. Код возврата: 0 — нормальный протокольный ход (включая `rejected`:
 * это диалог с моделью, а не сбой), 1 — всё, после чего команда не состоялась.
 */
export async function run(argv: readonly string[], io: CliIo): Promise<number> {
    try {
        const command = parseArgs(argv);
        switch (command.kind) {
            case 'artifact-schema':
                io.out(JSON.stringify(z.toJSONSchema(command.sources ? sourcesInputSchema : codeSnapshotInputSchema, { io: 'input' }), null, 2));
                return 0;
            case 'artifact-import': {
                const data = command.sources ? sourcesInputSchema.parse(JSON.parse(await fs.readFile(command.file, 'utf8')) as unknown) : codeSnapshotInputSchema.parse(JSON.parse(await fs.readFile(command.file, 'utf8')) as unknown);
                const prKey = await resolvePrKey(command.prKey ?? data.project, io.env);
                await importArtifacts(prKey, command.file, command.sources, io);
                return 0;
            }
            case 'version':
                io.out(CLI_VERSION);
                return 0;
            case 'help':
                io.out(helpText());
                return 0;
            case 'server':
                return await server(command, io);
            case 'up':
                return await up(command, io);
            case 'worker-register':
                return await workerRegister(command, io);
            case 'worker-next':
                return await workerNext(command, io);
            case 'task-complete':
                return await taskComplete(command, io);
            case 'task-progress':
                return await taskProgress(command, io);
            case 'task-fail':
                return await taskFail(command, io);
        }
    } catch (error) {
        io.err(userMessage(error));
        return 1;
    }
}

/**
 * Весь бутстрап сессии одной командой (`docs/protocol.md §3`): поднять сервер PR, зарегистрироваться
 * воркером и отдать ссылку на UI. Модель про сервер и регистрацию не знает — она видит только ссылку
 * и следующий шаг петли.
 */
async function up(command: Extract<Command, { kind: 'up' }>, io: CliIo): Promise<number> {
    // Явный manifest или сохранённый ключ; cwd не меняет цель.
    const snapshot = command.snapshot === undefined ? null : codeSnapshotInputSchema.parse(JSON.parse(await fs.readFile(command.snapshot, 'utf8')) as unknown);
    if (command.local !== undefined || command.base !== undefined) throw new CliError('Export the local changes with your native tools, then use `up --snapshot <manifest.json>`.');
    const prKey = await resolvePrKey(command.prKey ?? snapshot?.project, io.env);

    const server = await (io.ensureServer ?? ensureServer)({
        prKey,
        sherpaDir: sherpaDirFrom(io.env),
        entry: io.entry ?? process.argv[1],
        serverBin: serverBinOverrideFrom(io.env),
        nodeFlags: io.daemonNodeFlags ?? [],

    });
    if (command.snapshot !== undefined) await importArtifacts(prKey, command.snapshot, false, io);
    // Новый up передаёт слот воркера текущей сессии.
    await registerWorker(prKey, labelsOf(command), io);

    io.out(
        formatUpReady(
            server.uiUrl,
            prKey,
        ),
    );
    if (server.started && !command.noOpen) {
        try {
            (io.openBrowser ?? openBrowser)({ uiUrl: server.uiUrl });
        } catch {
            // Ссылка уже напечатана: headless/ssh и сбой opener не превращают успешный up в ошибку.
        }
    }
    return 0;
}

async function importArtifacts(prKey: string, file: string, sources: boolean, io: CliIo): Promise<void> {
    const manifest = await readServerManifest(sherpaDirFrom(io.env), prKey);
    const response = await fetch(`http://127.0.0.1:${String(manifest.port)}${sources ? ARTIFACT_ENDPOINTS.sources : ARTIFACT_ENDPOINTS.snapshot}`, {
        method: 'POST', headers: { authorization: `Bearer ${manifest.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ manifest: path.resolve(file) }),
    });
    const body: unknown = await response.json();
    if (!response.ok) throw new CliError(`Artifact import failed: ${JSON.stringify(body)}`);
    io.out(JSON.stringify(codeSnapshotReceiptSchema.parse(body)));
}

/** Процесс сервера PR, который демонизирует `up`. */
async function server(command: Extract<Command, { kind: 'server' }>, io: CliIo): Promise<number> {
    const serverBin = await resolveServerBin(io.entry ?? process.argv[1], serverBinOverrideFrom(io.env));
    const serverModule = await loadServerModule(serverBin);
    return serverModule.runServer(command.argv);
}

async function workerRegister(command: Extract<Command, { kind: 'worker-register' }>, io: CliIo): Promise<number> {
    const response = await registerWorker(command.prKey, labelsOf(command), io);

    // Текст сервера уже содержит следующий шаг петли — CLI печатает его как есть.
    io.out(response.message);
    return 0;
}

/**
 * Регистрация сессии воркером PR: у каждой сессии свежая идентичность.
 * В файл стейта её записывает сервер, пока обрабатывает `register` (`worker-id-file.ts`):
 * писателей на общий файл двух параллельных сессий должно быть ровно столько же, сколько
 * распорядителей слота, — один.
 */
async function registerWorker(
    prKeyArg: string | undefined,
    labels: WorkerLabels,
    io: CliIo,
): Promise<WorkerRegisterResponse> {
    const connection = await connectAs(prKeyArg, io.env, freshWorkerId(io.env));
    return requestRegister(connection, labels);
}

/** Метки сессии из аргументов команды: `up` и `worker register` объявляют их одинаково. */
function labelsOf(command: Extract<Command, { kind: 'up' | 'worker-register' }>): WorkerLabels {
    return { harness: command.harness, model: command.model, lang: command.lang };
}

async function workerNext(command: Extract<Command, { kind: 'worker-next' }>, io: CliIo): Promise<number> {
    const connection = await connect(command.prKey, io.env);
    return nextForConnection(connection, io);
}

/** Complete-and-next сохраняет workerId, даже если другая сессия уже перехватила слот. */
async function nextForConnection(connection: ServerConnection, io: CliIo): Promise<number> {
    const resultDir = await prepareResultDir(io.tmpDir ?? os.tmpdir(), sherpaDirFrom(io.env), connection);
    const response = await awaitTask(connection);

    switch (response.kind) {
        case 'task':
            io.out(formatTask(response.task, taskResultFileFor(resultDir, response.task), connection.prKey));
            return 0;
        case 'done':
            io.out(formatDone(response.message));
            return 0;
    }
}

/**
 * Каталог результатов сессии — до аренды: сбой не оставляет задачу висеть за воркером. Путь файла
 * уникален для аренды, поэтому файл, уже лежащий по нему, — от той же аренды (повторный `next`) и
 * не трогается.
 */
async function prepareResultDir(tmpRoot: string, sherpaDir: string, connection: ServerConnection): Promise<string> {
    const root = taskResultRootFor(tmpRoot);
    const dir = taskResultDirFor(tmpRoot, sherpaDir, connection.prKey, connection.workerId);
    try {
        await fs.mkdir(root, { recursive: true, mode: RESULT_DIR_MODE });
        await assertPrivateDir(root);
        await fs.mkdir(dir, { recursive: true, mode: RESULT_DIR_MODE });
    } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new CliError(
            `devflow-diff-explain: cannot prepare the directory for task results ${dir} — ${detail}.\n` +
                `Fix it or point TMPDIR to a private directory, then call \`devflow-diff-explain worker next --pr ${connection.prKey}\` again.`,
        );
    }
    return dir;
}

/** Результаты задач читает только своя сессия. */
const RESULT_DIR_MODE = 0o700;

/**
 * Корень лежит в общем tmp, и его мог заранее создать кто-то другой: симлинк, чужой или открытый
 * каталог дал бы читать и подменять результаты. `mkdir` существующий каталог принимает молча.
 */
async function assertPrivateDir(dir: string): Promise<void> {
    const uid = process.getuid?.();
    if (uid === undefined) {
        // Windows: tmp у каждого пользователя свой, POSIX-прав нет.
        return;
    }
    const stats = await fs.lstat(dir);
    if (!stats.isDirectory()) {
        throw new Error(`${dir} is not a directory`);
    }
    if (stats.uid !== uid) {
        throw new Error(`${dir} belongs to another user`);
    }
    if ((stats.mode & 0o077) !== 0) {
        throw new Error(`${dir} is open to other users (mode ${(stats.mode & 0o777).toString(8)})`);
    }
}

/**
 * Ждёт задачу без срока: `idle` сервера глотается, и сразу уходит следующий `next`; наружу —
 * только задача, `done` или ошибка.
 */
async function awaitTask(connection: ServerConnection): Promise<Exclude<WorkerNextResponse, { kind: 'idle' }>> {
    for (;;) {
        const response = await requestNext(connection);
        if (response.kind !== 'idle') {
            return response;
        }
    }
}

async function taskComplete(command: Extract<Command, { kind: 'task-complete' }>, io: CliIo): Promise<number> {
    const prKey = await resolvePrKey(command.prKey, io.env);
    const result = await readResultFile(command.file, command.taskId, prKey);

    const connection = await connect(prKey, io.env);
    const response = await requestComplete(connection, command.taskId, result);
    if (command.next === true && response.kind !== 'rejected') {
        io.out(response.message);
        return nextForConnection(connection, io);
    }
    io.out(formatCompleteResponse(response, command.taskId, command.file, connection.prKey));
    return 0;
}

async function taskProgress(command: Extract<Command, { kind: 'task-progress' }>, io: CliIo): Promise<number> {
    const connection = await connect(command.prKey, io.env);
    const response = await requestProgress(connection, command.taskId, command.text);
    io.out(formatProgressResponse(response, command.taskId, connection.prKey));
    return 0;
}

async function taskFail(command: Extract<Command, { kind: 'task-fail' }>, io: CliIo): Promise<number> {
    const connection = await connect(command.prKey, io.env);
    const response = await requestFail(connection, command.taskId, command.reason);
    io.out(formatFailResponse(response, command.taskId, connection.prKey));
    return 0;
}

/**
 * Читает файл результата с пре-чеком размера: перебор лимита отбивается локально,
 * до отправки, — задача остаётся в аренде, и у модели есть попытка сократить результат.
 */
export async function readResultFile(file: string, taskId: number, prKey: string): Promise<string> {
    const stats = await fs.stat(file).catch(() => null);
    if (stats === null) {
        throw new CliError(
            `devflow-diff-explain: there is no file ${file}.\nWrite the result to ${file} and call ` +
                `\`devflow-diff-explain task complete ${String(taskId)} --file ${file} --pr ${prKey}\` again.`,
        );
    }
    if (!stats.isFile()) {
        throw new CliError(`devflow-diff-explain: ${file} is not a file.\nPass the path of the file with the task result.`);
    }
    if (stats.size > RESULT_MAX_BYTES) {
        throw new CliError(formatOversizedResult(taskId, file, stats.size, prKey));
    }

    let result: string;
    try {
        result = await fs.readFile(file, 'utf8');
    } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new CliError(`devflow-diff-explain: cannot read ${file} — ${detail}.\nCheck the path and the file permissions.`);
    }

    // Размер файла и длина строки расходятся на битой кодировке: считаем ещё раз по тому, что уйдёт в тело.
    const bytes = Buffer.byteLength(result, 'utf8');
    if (bytes > RESULT_MAX_BYTES) {
        throw new CliError(formatOversizedResult(taskId, file, bytes, prKey));
    }
    return result;
}

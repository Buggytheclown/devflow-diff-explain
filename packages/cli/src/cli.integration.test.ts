import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { PROGRESS_TEXT_MAX_CHARS, RESULT_MAX_BYTES } from '@sherpa/protocol';
import type { SherpaServer } from '@sherpa/server';
import { selectReviewHost, startServer } from '@sherpa/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CliIo } from './cli.js';
import { run } from './cli.js';
import { localPrKey } from './local.js';
import { taskResultDirFor, taskResultFileFor, taskResultRootFor } from './paths.js';

const PR_KEY = 'arcanum-777';

/** Собранный CLI (`src/bundle.global-setup.ts`): его же `up` спавнит демоном. */
const CLI_BUNDLE = path.resolve(import.meta.dirname, '..', 'dist', 'devflow-diff-explain.mjs');

interface Invocation {
    readonly code: number;
    readonly stdout: string;
    readonly stderr: string;
}

/** Полная петля против настоящего сервера: команды зовутся функциями, HTTP — настоящий. */
describe('CLI против сервера', () => {
    let sherpaDir: string;
    let workDir: string;
    let server: SherpaServer | null;

    beforeEach(async () => {
        sherpaDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sherpa-cli-state-'));
        workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sherpa-cli-work-'));
        server = null;
    });

    afterEach(async () => {
        await server?.close();
        await fs.rm(sherpaDir, { recursive: true, force: true });
        await fs.rm(workDir, { recursive: true, force: true });
    });

    async function start(longPollSeconds = 0.2): Promise<SherpaServer> {
        // Живой Арканум в тестах запрещён: без хоста прогрев маршрута не ходит в сеть,
        // а этому набору важен только протокол CLI↔сервер.
        server = await startServer({ prKey: PR_KEY, sherpaDir, longPollSeconds, reviewHostFactory: () => null });
        return server;
    }

    async function sherpa(...argv: string[]): Promise<Invocation> {
        return sherpaWithEnv({}, ...argv);
    }

    /** Тот же вызов, но с добавкой к окружению: так изображается вторая сессия на том же PR. */
    async function sherpaWithEnv(
        extraEnv: Record<string, string>,
        ...argv: string[]
    ): Promise<Invocation> {
        return sherpaWith({ extraEnv }, ...argv);
    }

    interface Overrides {
        readonly extraEnv?: Record<string, string>;
        readonly entry?: string;
        readonly ensureServer?: NonNullable<CliIo['ensureServer']>;
        readonly openBrowser?: NonNullable<CliIo['openBrowser']>;
        readonly runCommand?: NonNullable<CliIo['runCommand']>;
        readonly tmpDir?: string;
    }

    async function sherpaWith(overrides: Overrides, ...argv: string[]): Promise<Invocation> {
        const stdout: string[] = [];
        const stderr: string[] = [];
        const io: CliIo = {
            env: { SHERPA_DIR: sherpaDir, SHERPA_PR: PR_KEY, ...overrides.extraEnv },
            out: (text) => stdout.push(text),
            err: (text) => stderr.push(text),
            // Рядом с файлом теста модуля сервера нет: там, где сервер уже поднят, он и не нужен.
            entry: overrides.entry ?? fileURLToPath(import.meta.url),
            // Файлы результатов — в рабочий каталог теста, а не в системный tmp.
            tmpDir: overrides.tmpDir ?? workDir,
            ...(overrides.ensureServer === undefined ? {} : { ensureServer: overrides.ensureServer }),
            ...(overrides.openBrowser === undefined ? {} : { openBrowser: overrides.openBrowser }),
            ...(overrides.runCommand === undefined ? {} : { runCommand: overrides.runCommand }),
        };

        const code = await run(argv, io);
        return { code, stdout: stdout.join('\n'), stderr: stderr.join('\n') };
    }

    /** Подмена модуля сервера: настоящий сервер этим тестам не нужен. */
    async function fakeServerBin(source: string): Promise<string> {
        const file = path.join(workDir, 'devflow-diff-explain-server.mjs');
        await fs.writeFile(file, `${source}\n`);
        return file;
    }

    async function readManifestPid(): Promise<number> {
        const raw = await fs.readFile(path.join(sherpaDir, 'servers', `${PR_KEY}.json`), 'utf8');
        return (JSON.parse(raw) as { pid: number }).pid;
    }

    async function readWorkerIdFile(): Promise<string> {
        return (await fs.readFile(path.join(sherpaDir, 'prs', PR_KEY, 'worker-id'), 'utf8')).trim();
    }

    function enqueueEcho(running: SherpaServer, instructions = 'Верни содержимое файла как есть.'): number {
        return running.queue.enqueue({
            type: 'echo',
            priority: 'interactive',
            instructions,
            contextFiles: ['/tmp/sherpa/task-context.md'],
        }).id;
    }

    /** Путь, который `worker next` выдаёт текущей сессии под результат задачи. */
    async function resultFileOf(taskId: number, attempt = 1): Promise<string> {
        const dir = taskResultDirFor(workDir, sherpaDir, PR_KEY, await readWorkerIdFile());
        return taskResultFileFor(dir, { id: taskId, attempt });
    }

    async function writeFile(name: string, content: string): Promise<string> {
        const file = path.join(workDir, name);
        await fs.writeFile(file, content);
        return file;
    }

    it('up находит живой сервер, не открывает новую вкладку и печатает ссылку с инструкцией', async () => {
        const running = await start();
        const opened: string[] = [];

        const result = await sherpaWith(
            { openBrowser: ({ uiUrl }) => opened.push(uiUrl) },
            'up',
            '--harness',
            'claude-code',
        );

        expect(result.code).toBe(0);
        expect(result.stdout).toContain(`http://127.0.0.1:${String(running.port)}/#t=`);
        expect(result.stdout).toContain('Show this link to the user in full');
        expect(result.stdout).toContain(`devflow-diff-explain worker next --pr ${PR_KEY}`);
        // Сервер и регистрация в выводе не всплывают — модели про них знать нечего.
        expect(result.stdout).not.toContain('register');
        expect(opened).toEqual([]);

        expect(running.workerRegistry.status()).toMatchObject({
            kind: 'connected',
            workerId: await readWorkerIdFile(),
            harness: 'claude-code',
        });
    });

    // `--local` называет каталог, а не PR: ключ считается из каталога и ветки и бьёт даже SHERPA_PR.
    it('up --local поднимает ревью каталога и называет его в выводе', async () => {
        const localKey = localPrKey('arc', await fs.realpath(workDir), 'feature', 'trunk~3');
        server = await startServer({
            prKey: localKey,
            sherpaDir,
            longPollSeconds: 0.2,
            reviewHostFactory: () => null,
        });
        const arc: NonNullable<CliIo['runCommand']> = (_command, args) =>
            Promise.resolve({
                exitCode: 0,
                stdout:
                    args[0] === 'root'
                        ? `${workDir}\n`
                        : JSON.stringify({ branch: 'feature', user_login: 'alice', hash: 'a'.repeat(40) }),
                stderr: '',
                failure: null,
            });

        const result = await sherpaWith({ runCommand: arc }, 'up', '--local', workDir, '--base', 'trunk~3');

        expect(result.code).toBe(0);
        expect(result.stdout).toContain(`http://127.0.0.1:${String(server.port)}/#t=`);
        expect(result.stdout).toContain('Reviewing the working tree of');
        expect(result.stdout).toContain('on branch feature, base trunk~3');
        expect(result.stdout).toContain(`devflow-diff-explain worker next --pr ${localKey}`);
        expect(server.workerRegistry.status()).toMatchObject({ kind: 'connected' });
    });

    // Живой сервер аргументов запуска не видит: поручение называет каждый `up --local`, побеждает последний.
    it('up --local передаёт поручение живому серверу, worker register его не трогает', async () => {
        const localKey = localPrKey('arc', await fs.realpath(workDir), 'feature');
        const calls: (string | null)[] = [];
        const fixture = selectReviewHost('fixture-small');
        if (fixture === null) {
            throw new Error('фикстурный хост не выбрался');
        }
        server = await startServer({
            prKey: localKey,
            sherpaDir,
            longPollSeconds: 0.2,
            reviewHostFactory: () => ({
                ...fixture,
                setLocalVerdicts: (instruction) => {
                    calls.push(instruction);
                    return true;
                },
            }),
        });
        const arc: NonNullable<CliIo['runCommand']> = (_command, args) =>
            Promise.resolve({
                exitCode: 0,
                stdout: args[0] === 'root' ? `${workDir}\n` : JSON.stringify({ branch: 'feature' }),
                stderr: '',
                failure: null,
            });

        const withVerdicts = await sherpaWith(
            { runCommand: arc },
            'up',
            '--local',
            workDir,
            '--verdicts',
            'on ship, commit and open a PR',
        );
        await sherpaWith({ runCommand: arc }, 'worker', 'register', '--pr', localKey);
        const changed = await sherpaWith({ runCommand: arc }, 'up', '--local', workDir, '--verdicts', 'on ship, merge');
        const without = await sherpaWith({ runCommand: arc }, 'up', '--local', workDir);

        expect(withVerdicts.code).toBe(0);
        expect(withVerdicts.stdout).toContain('The reviewer finishes with Ship or Request changes');
        expect(withVerdicts.stdout).toContain('"on ship, commit and open a PR"');
        expect(changed.stdout).toContain('"on ship, merge"');
        expect(without.code).toBe(0);
        expect(without.stdout).not.toContain('Ship or Request changes');
        expect(calls).toEqual(['on ship, commit and open a PR', 'on ship, merge', null]);
    });

    // Сервер без режима вердиктов изображает живой сервер старой сборки: поле он отбрасывает, эха нет.
    it('up --local --verdicts против сервера, который режим не применил, падает и вердиктов не обещает', async () => {
        const localKey = localPrKey('arc', await fs.realpath(workDir), 'feature');
        server = await startServer({ prKey: localKey, sherpaDir, longPollSeconds: 0.2, reviewHostFactory: () => null });
        const arc: NonNullable<CliIo['runCommand']> = (_command, args) =>
            Promise.resolve({
                exitCode: 0,
                stdout: args[0] === 'root' ? `${workDir}\n` : JSON.stringify({ branch: 'feature' }),
                stderr: '',
                failure: null,
            });

        const withVerdicts = await sherpaWith({ runCommand: arc }, 'up', '--local', workDir, '--verdicts', 'on ship, merge');
        const without = await sherpaWith({ runCommand: arc }, 'up', '--local', workDir);

        expect(withVerdicts.code).toBe(1);
        expect(withVerdicts.stderr).toContain('older than this CLI and ignores `--verdicts`');
        expect(withVerdicts.stderr).toContain(path.join(sherpaDir, 'servers', `${localKey}.json`));
        expect(withVerdicts.stdout).not.toContain('Ship or Request changes');
        // Без флага сверять нечего: Comment старый сервер и так показывает.
        expect(without.code).toBe(0);
        expect(without.stdout).not.toContain('Ship or Request changes');
    });

    it('браузер открывается только при холодном старте и без --no-open', async () => {
        const running = await start();
        const uiUrl = `http://127.0.0.1:${String(running.port)}/#t=${running.token}`;
        const open = vi.fn();

        const cold = await sherpaWith(
            { ensureServer: () => Promise.resolve({ uiUrl, started: true }), openBrowser: open },
            'up',
        );
        expect(cold.code).toBe(0);
        expect(open).toHaveBeenCalledWith({ uiUrl });

        open.mockClear();
        await sherpaWith({ ensureServer: () => Promise.resolve({ uiUrl, started: false }), openBrowser: open }, 'up');
        expect(open).not.toHaveBeenCalled();

        await sherpaWith(
            { ensureServer: () => Promise.resolve({ uiUrl, started: true }), openBrowser: open },
            'up',
            '--no-open',
        );
        expect(open).not.toHaveBeenCalled();
    });

    it('провал opener не роняет up и ссылка остаётся в stdout', async () => {
        const running = await start();
        const uiUrl = `http://127.0.0.1:${String(running.port)}/#t=${running.token}`;

        const result = await sherpaWith(
            {
                ensureServer: () => Promise.resolve({ uiUrl, started: true }),
                openBrowser: () => {
                    throw new Error('нет графической сессии');
                },
            },
            'up',
        );

        expect(result.code).toBe(0);
        expect(result.stdout).toContain(uiUrl);
        expect(result.stderr).toBe('');
    });

    it('модель из --model доезжает до статуса воркера, обрамление срезается', async () => {
        const running = await start();

        // Модель называет себя сама и приносит значение как придётся — здесь в бэктиках.
        const result = await sherpaWith({}, 'up', '--harness', 'claude-code', '--model', '`claude-opus-5[1m]`');

        expect(result.code).toBe(0);
        expect(running.workerRegistry.status()).toMatchObject({
            kind: 'connected',
            harness: 'claude-code',
            model: 'claude-opus-5[1m]',
        });
    });

    it('без --model и с пустым --model статус остаётся без модели', async () => {
        const running = await start();

        const blank = await sherpaWith({}, 'up', '--harness=claude-code', '--model=   ');

        expect(blank.code).toBe(0);
        expect(running.workerRegistry.status()).not.toHaveProperty('model');
    });

    it('повторный up перехватывает собственный слот, второй сервер не поднимается', async () => {
        const running = await start();
        // Без пина идентичности: каждый запуск CLI берёт свежий id, как в жизни.
        await sherpaWith({}, 'up', '--harness', 'claude-code');
        const workerId = await readWorkerIdFile();

        const again = await sherpaWith({}, 'up', '--harness', 'claude-code');

        expect(again.code).toBe(0);
        expect(again.stdout).toContain('http://127.0.0.1:');
        // Слот занят живой сессией — и всё равно достаётся свежей: конфликта здесь больше нет.
        const renewed = await readWorkerIdFile();
        expect(renewed).not.toBe(workerId);
        expect(running.workerRegistry.status()).toMatchObject({ kind: 'connected', workerId: renewed });
        // Второй сервер не поднялся: манифест PR всё ещё описывает тот же процесс.
        expect(await readManifestPid()).toBe(process.pid);
    });

    it('up после обрыва сессии перехватывает живой слот прошлой, не дожидаясь её смерти', async () => {
        const running = await start();
        // Прошлая сессия зарегистрировалась и оборвалась; сервер ещё считает её живой.
        running.workerRegistry.register('сессия-из-прошлой-жизни', 'claude-code');
        await fs.mkdir(path.join(sherpaDir, 'prs', PR_KEY), { recursive: true });
        await fs.writeFile(path.join(sherpaDir, 'prs', PR_KEY, 'worker-id'), 'сессия-из-прошлой-жизни\n');

        const result = await sherpaWith({}, 'up', '--harness', 'codex');

        expect(result.code).toBe(0);
        expect(result.stdout).toContain('http://127.0.0.1:');
        // Идентичность из файла не переиспользуется: слот занимает свежая, и файл теперь её.
        const workerId = await readWorkerIdFile();
        expect(workerId).not.toBe('сессия-из-прошлой-жизни');
        expect(running.workerRegistry.status()).toMatchObject({
            kind: 'connected',
            workerId,
            harness: 'codex',
        });
    });

    it('up при живом чужом воркере забирает слот себе: новая сессия всегда права', async () => {
        const running = await start();
        running.workerRegistry.register('чужая-сессия', 'codex');

        const second = await sherpaWith({}, 'up', '--harness', 'claude-code');

        expect(second.code).toBe(0);
        expect(second.stdout).toContain('http://127.0.0.1:');
        expect(second.stderr).toBe('');
        expect(running.workerRegistry.status()).toMatchObject({
            kind: 'connected',
            workerId: await readWorkerIdFile(),
            harness: 'claude-code',
        });
    });

    it('две сессии подряд: второй up отбирает слот у первой, файл воркера переезжает к ней', async () => {
        const running = await start();
        await sherpaWith({ extraEnv: { SHERPA_WORKER_ID: 'сессия-1' } }, 'up', '--harness', 'claude-code');
        expect(await readWorkerIdFile()).toBe('сессия-1');

        const second = await sherpaWith({ extraEnv: { SHERPA_WORKER_ID: 'сессия-2' } }, 'up', '--harness', 'codex');

        expect(second.code).toBe(0);
        expect(await readWorkerIdFile()).toBe('сессия-2');
        expect(running.workerRegistry.status()).toMatchObject({ workerId: 'сессия-2', harness: 'codex' });

        // Первая сессия, продолжившая петлю, упирается в терминальную инструкцию.
        const displaced = await sherpaWith({ extraEnv: { SHERPA_WORKER_ID: 'сессия-1' } }, 'worker', 'next');
        expect(displaced.code).toBe(1);
        expect(displaced.stderr).toContain('stop the loop');
    });

    it('up без сервера рядом с CLI: ошибка про неполный дистрибутив, петля не начинается', async () => {
        // Сервер не поднят и рядом с CLI его бандла нет — дальше идти некуда.
        const result = await sherpaWith({}, 'up');

        expect(result.code).toBe(1);
        expect(result.stderr).toContain('skill distribution is incomplete');
        expect(result.stderr).toContain('do not start the worker loop');
    });

    it('up с упавшим сервером: его вывод доходит до модели как есть', async () => {
        const failing = await fakeServerBin(
            "export async function runServer() { console.error('нечем открыть хранилище'); return 1; }",
        );

        const result = await sherpaWith({ extraEnv: { SHERPA_SERVER_BIN: failing }, entry: CLI_BUNDLE }, 'up');

        expect(result.code).toBe(1);
        expect(result.stderr).toContain('нечем открыть хранилище');
        expect(result.stderr).toContain('do not start the worker loop');
    }, 20_000);

    it('server отдаёт аргументы модулю сервера как есть и возвращает его код', async () => {
        const recorded = path.join(workDir, 'argv.json');
        const echo = await fakeServerBin(
            `import fs from 'node:fs';\n` +
                `export async function runServer(argv) { fs.writeFileSync(${JSON.stringify(recorded)}, JSON.stringify(argv)); return 7; }`,
        );

        const result = await sherpaWith(
            { extraEnv: { SHERPA_SERVER_BIN: echo } },
            'server',
            '--pr',
            PR_KEY,
            '--help',
            '--version',
        );

        expect(result.code).toBe(7);
        expect(JSON.parse(await fs.readFile(recorded, 'utf8'))).toEqual(['--pr', PR_KEY, '--help', '--version']);
    });

    it('server с модулем без runServer — ошибка про неполный дистрибутив', async () => {
        const broken = await fakeServerBin('export const version = 1;');

        const result = await sherpaWith({ extraEnv: { SHERPA_SERVER_BIN: broken } }, 'server', '--pr', PR_KEY);

        expect(result.code).toBe(1);
        expect(result.stderr).toContain('skill distribution is incomplete');
    });

    it('server без модуля рядом с CLI и с несуществующим SHERPA_SERVER_BIN — понятные ошибки', async () => {
        const lonely = await sherpaWith({}, 'server', '--pr', PR_KEY);
        const missing = await sherpaWith(
            { extraEnv: { SHERPA_SERVER_BIN: path.join(workDir, 'нет-такого.mjs') } },
            'server',
            '--pr',
            PR_KEY,
        );

        expect(lonely.code).toBe(1);
        expect(lonely.stderr).toContain('skill distribution is incomplete');
        expect(missing.code).toBe(1);
        expect(missing.stderr).toContain('SHERPA_SERVER_BIN points at');
    });

    it('register заводит сессию воркером и запоминает её в файле стейта', async () => {
        const running = await start();

        const result = await sherpa('worker', 'register', '--harness', 'claude-code');

        expect(result.code).toBe(0);
        expect(result.stdout).toContain('devflow-diff-explain worker next');
        const workerId = await readWorkerIdFile();
        expect(running.workerRegistry.status()).toMatchObject({
            kind: 'connected',
            workerId,
            harness: 'claude-code',
        });

        const stats = await fs.stat(path.join(sherpaDir, 'prs', PR_KEY, 'worker-id'));
        expect(stats.mode & 0o777).toBe(0o600);
    });

    // Третья метка сессии: агент говорит, на каком языке общается с ревьюером, UI берёт её подсказкой.
    it('register передаёт --lang в статус воркера, без флага метки нет, чужой язык отбивается', async () => {
        const running = await start();

        expect((await sherpa('worker', 'register', '--harness', 'claude-code', '--lang', 'ru')).code).toBe(0);
        expect(running.workerRegistry.status()).toMatchObject({ harness: 'claude-code', lang: 'ru' });

        expect((await sherpaWithEnv({ SHERPA_WORKER_ID: 'сессия-без-языка' }, 'worker', 'register')).code).toBe(0);
        expect(running.workerRegistry.status()).not.toHaveProperty('lang');

        const rejected = await sherpa('worker', 'register', '--lang', 'de');
        expect(rejected.code).toBe(1);
        expect(rejected.stderr).toContain('--lang expects `ru` or `en`, got `de`');
    });

    it('реконнект — новая идентичность: register не переиспользует прежний id', async () => {
        const running = await start();
        await fs.mkdir(path.join(sherpaDir, 'prs', PR_KEY), { recursive: true });
        await fs.writeFile(path.join(sherpaDir, 'prs', PR_KEY, 'worker-id'), 'сессия-из-прошлой-жизни\n');

        await sherpa('worker', 'register');

        const workerId = await readWorkerIdFile();
        expect(workerId).not.toBe('сессия-из-прошлой-жизни');
        expect(running.workerRegistry.status()).toMatchObject({ kind: 'connected', workerId });

        // Следующие команды ходят под записанным id — сервер видит того же воркера.
        enqueueEcho(running);
        await sherpa('worker', 'next');
        expect(running.workerRegistry.status()).toMatchObject({ kind: 'connected', workerId });
    });

    it('вторая живая сессия забирает слот, файл воркера переезжает к ней', async () => {
        const running = await start();
        await sherpa('worker', 'register', '--harness', 'claude-code');
        const first = await readWorkerIdFile();

        const second = await sherpa('worker', 'register', '--harness', 'codex');

        expect(second.code).toBe(0);
        expect(second.stdout).toContain('devflow-diff-explain worker next');
        const workerId = await readWorkerIdFile();
        expect(workerId).not.toBe(first);
        expect(running.workerRegistry.status()).toMatchObject({
            kind: 'connected',
            workerId,
            harness: 'codex',
        });
    });

    it('две сессии регистрируются одновременно: файл воркера описывает владельца слота', async () => {
        const running = await start();

        // Обе регистрации проходят, слот достаётся одной из них — и файл обязан остаться за ней:
        // порядок ответов по сети порядка регистраций не задаёт, поэтому файл пишет сервер.
        const [first, second] = await Promise.all([
            sherpaWithEnv({ SHERPA_WORKER_ID: 'сессия-1' }, 'worker', 'register', '--harness', 'claude-code'),
            sherpaWithEnv({ SHERPA_WORKER_ID: 'сессия-2' }, 'worker', 'register', '--harness', 'codex'),
        ]);

        expect(first.code).toBe(0);
        expect(second.code).toBe(0);
        const status = running.workerRegistry.status();
        expect(await readWorkerIdFile()).toBe(status.kind === 'never' ? null : status.workerId);

        // Владелец слота продолжает петлю: его следующая команда берёт id из файла и конфликта не ловит.
        enqueueEcho(running);
        const next = await sherpa('worker', 'next');
        expect(next.code).toBe(0);
        expect(next.stderr).toBe('');
    });

    it('вытесненная сессия получает терминальную инструкцию, а не совет повторить', async () => {
        const running = await start();
        await sherpa('worker', 'register');
        const taskId = enqueueEcho(running);

        const displaced = await sherpaWithEnv({ SHERPA_WORKER_ID: 'чужая-сессия' }, 'worker', 'next');

        expect(displaced.code).toBe(1);
        expect(displaced.stderr).toContain('stop the loop');
        expect(displaced.stderr).not.toContain('worker_conflict');
        expect(running.queue.getTask(taskId)).toMatchObject({ status: 'queued', workerId: null });
    });

    it('пустая очередь: next молча переживает серию idle и выходит на первой задаче', async () => {
        // Окно сервера — 0,1 с: пока тест ждёт, сервер несколько раз подряд отвечает idle.
        const running = await start(0.1);
        let settled = false;
        const pending = sherpa('worker', 'next').finally(() => {
            settled = true;
        });

        await delay(600);
        expect(settled).toBe(false);
        const taskId = enqueueEcho(running, 'Задача пришла после нескольких пустых окон.');

        const issued = await pending;
        expect(issued.code).toBe(0);
        expect(issued.stdout).toContain(`TASK sherpa/${String(taskId)} (echo), attempt 1`);
        expect(issued.stdout).not.toContain('No tasks');
        expect(issued.stderr).toBe('');
    });

    it('петля: задача — работа — сдача — следующий next', async () => {
        const running = await start();
        const taskId = enqueueEcho(running, 'Перескажи дифф одним абзацем.');

        const issued = await sherpa('worker', 'next');
        expect(issued.code).toBe(0);
        expect(issued.stdout).toContain(`TASK sherpa/${String(taskId)} (echo), attempt 1`);
        expect(issued.stdout).toContain('Перескажи дифф одним абзацем.');
        expect(issued.stdout).toContain('Context: /tmp/sherpa/task-context.md');
        const resultFile = await resultFileOf(taskId);
        expect(issued.stdout).toContain(`Write the result to ${resultFile} and submit it:`);
        expect(issued.stdout).toContain(`devflow-diff-explain task complete ${String(taskId)} --file ${resultFile}`);

        const progress = await sherpa('task', 'progress', String(taskId), '--text', 'читаю дифф');
        expect(progress.code).toBe(0);
        expect(running.queue.getTask(taskId)?.progressText).toBe('читаю дифф');

        await fs.writeFile(resultFile, 'Готовый ответ.');
        const completed = await sherpa('task', 'complete', String(taskId), '--file', resultFile);
        expect(completed.code).toBe(0);
        expect(completed.stdout).toContain('accepted');
        expect(completed.stdout).toContain('devflow-diff-explain worker next');
        expect(running.queue.getTask(taskId)).toMatchObject({ status: 'done', result: 'Готовый ответ.' });

        // Сданная задача повторно не выдаётся: следующий next берёт новую.
        const nextTaskId = enqueueEcho(running, 'Вторая задача.');
        const again = await sherpa('worker', 'next');
        expect(again.stdout).toContain(`TASK sherpa/${String(nextTaskId)} (echo), attempt 1`);
    });

    it('выданный путь: каталоги создаются только для себя', async () => {
        const running = await start();
        const taskId = enqueueEcho(running);

        const issued = await sherpa('worker', 'next');

        expect(issued.code).toBe(0);
        const resultFile = await resultFileOf(taskId);
        expect(issued.stdout).toContain(`--file ${resultFile}`);
        expect(path.dirname(path.dirname(resultFile))).toBe(path.join(taskResultRootFor(workDir), PR_KEY));
        expect((await fs.stat(taskResultRootFor(workDir))).mode & 0o777).toBe(0o700);
        expect((await fs.stat(path.dirname(resultFile))).mode & 0o777).toBe(0o700);
    });

    it('повторная выдача той же аренды не трогает уже записанный результат', async () => {
        const running = await start();
        const taskId = enqueueEcho(running);
        await sherpa('worker', 'next');
        const resultFile = await resultFileOf(taskId);
        await fs.writeFile(resultFile, 'Готовый ответ.');

        const again = await sherpa('worker', 'next');

        expect(again.stdout).toContain(`TASK sherpa/${String(taskId)} (echo), attempt 1`);
        expect(again.stdout).toContain(`--file ${resultFile}`);
        expect(await fs.readFile(resultFile, 'utf8')).toBe('Готовый ответ.');
    });

    it('повторная попытка в новой сессии получает другой путь в другом каталоге', async () => {
        const running = await start();
        await sherpa('worker', 'register');
        const taskId = enqueueEcho(running);
        const first = await sherpa('worker', 'next');
        const firstFile = await resultFileOf(taskId, 1);
        expect(first.stdout).toContain(`--file ${firstFile}`);

        // Новая сессия перехватывает слот, аренда прежней возвращается в очередь следующей попыткой.
        await sherpa('worker', 'register');
        const second = await sherpa('worker', 'next');

        expect(second.stdout).toContain(`TASK sherpa/${String(taskId)} (echo), attempt 2`);
        const secondFile = await resultFileOf(taskId, 2);
        expect(path.dirname(secondFile)).not.toBe(path.dirname(firstFile));
        expect(second.stdout).toContain(`--file ${secondFile}`);
    });

    it('корень результатов открыт другим или это симлинк — задача не выдаётся, следующий шаг назван', async () => {
        const running = await start();
        const taskId = enqueueEcho(running);
        const root = taskResultRootFor(workDir);
        await fs.mkdir(root);
        await fs.chmod(root, 0o777);

        const open = await sherpa('worker', 'next');

        expect(open.code).toBe(1);
        expect(open.stderr).toContain(`${root} is open to other users`);
        expect(open.stderr).toContain('call `devflow-diff-explain worker next` again');
        expect(running.queue.getTask(taskId)?.status).toBe('queued');

        await fs.rm(root, { recursive: true });
        const target = await fs.mkdtemp(path.join(workDir, 'target-'));
        await fs.symlink(target, root);

        const linked = await sherpa('worker', 'next');

        expect(linked.code).toBe(1);
        expect(linked.stderr).toContain(`${root} is not a directory`);
        expect(await fs.readdir(target)).toEqual([]);
        expect(running.queue.getTask(taskId)?.status).toBe('queued');
    });

    it('каталог результата не создать — задача не выдаётся, следующий шаг назван', async () => {
        const running = await start();
        const taskId = enqueueEcho(running);
        const notADir = await writeFile('not-a-dir', '');

        const result = await sherpaWith({ tmpDir: notADir }, 'worker', 'next');

        expect(result.code).toBe(1);
        expect(result.stderr).toContain('cannot prepare the directory for task results');
        expect(result.stderr).toContain('call `devflow-diff-explain worker next` again');
        expect(running.queue.getTask(taskId)?.status).toBe('queued');
    });

    it('пустой результат отбивается сервером: список ошибок, задача остаётся в аренде', async () => {
        const running = await start();
        const taskId = enqueueEcho(running);
        await sherpa('worker', 'next');

        const file = await writeFile('empty.md', '   \n');
        const rejected = await sherpa('task', 'complete', String(taskId), '--file', file);

        // rejected — диалог с моделью, а не сбой: код возврата нулевой.
        expect(rejected.code).toBe(0);
        expect(rejected.stdout).toContain('rejected');
        expect(rejected.stdout).toContain('1. ');
        expect(rejected.stdout).toContain(`devflow-diff-explain task complete ${String(taskId)} --file ${file}`);
        expect(running.queue.getTask(taskId)?.status).toBe('leased');
    });

    it('результат больше лимита отбивается локально, до отправки', async () => {
        const running = await start();
        const taskId = enqueueEcho(running);
        await sherpa('worker', 'next');

        const file = await writeFile('big.md', 'я'.repeat(RESULT_MAX_BYTES));
        const refused = await sherpa('task', 'complete', String(taskId), '--file', file);

        expect(refused.code).toBe(1);
        expect(refused.stderr).toContain('the limit is 256 KB');
        expect(refused.stderr).toContain('The task stays yours');
        // Сервер о попытке не узнал: задача всё ещё в аренде, а не завершена ошибкой.
        expect(running.queue.getTask(taskId)).toMatchObject({ status: 'leased', result: null });
    });

    it('слишком длинный --text отбивается по контракту до отправки', async () => {
        const running = await start();
        const taskId = enqueueEcho(running);
        await sherpa('worker', 'next');

        const long = 'т'.repeat(PROGRESS_TEXT_MAX_CHARS + 1);
        const result = await sherpa('task', 'progress', String(taskId), '--text', long);

        expect(result.code).toBe(1);
        expect(result.stderr).toContain('contract');
        expect(running.queue.getTask(taskId)?.progressText).toBe(null);
    });

    it('повторный complete по закрытой задаче — no-op', async () => {
        const running = await start();
        const taskId = enqueueEcho(running);
        await sherpa('worker', 'next');
        const file = await writeFile('answer.md', 'Ответ.');
        await sherpa('task', 'complete', String(taskId), '--file', file);

        const repeated = await sherpa('task', 'complete', String(taskId), '--file', file);

        expect(repeated.code).toBe(0);
        expect(repeated.stdout).toContain('is already finished');
        expect(repeated.stdout).toContain('devflow-diff-explain worker next');
    });

    it('отказ по задаче доходит до очереди с причиной', async () => {
        const running = await start();
        const taskId = enqueueEcho(running);
        await sherpa('worker', 'next');

        const failed = await sherpa('task', 'fail', String(taskId), '--reason', 'нет доступа к репозиторию');

        expect(failed.code).toBe(0);
        expect(failed.stdout).toContain('refusal');
        expect(running.queue.getTask(taskId)).toMatchObject({
            status: 'failed',
            failReason: 'нет доступа к репозиторию',
        });
    });

    it('чужой номер задачи — ошибка сервера человеческим текстом, код 1', async () => {
        await start();

        const result = await sherpa('task', 'fail', '999', '--reason', 'x');

        expect(result.code).toBe(1);
        expect(result.stderr).toContain('sherpa/999');
        expect(result.stderr).not.toContain('unknown_task');
    });

    it('нет файла результата — понятная ошибка, на сервер ничего не уходит', async () => {
        const running = await start();
        const taskId = enqueueEcho(running);
        await sherpa('worker', 'next');
        const missing = await resultFileOf(taskId);

        const result = await sherpa('task', 'complete', String(taskId), '--file', missing);

        expect(result.code).toBe(1);
        expect(result.stderr).toContain(`Write the result to ${missing}`);
        expect(result.stderr).toContain(`devflow-diff-explain task complete ${String(taskId)} --file ${missing}`);
        expect(running.queue.getTask(taskId)).toMatchObject({ status: 'leased', result: null });
    });

    it('сервера нет — CLI говорит перезапустить скилл', async () => {
        const result = await sherpa('worker', 'next');

        expect(result.code).toBe(1);
        expect(result.stderr).toContain(`the Sherpa server for PR ${PR_KEY} is not found or not responding`);
        expect(result.stderr).toContain('Run the Sherpa skill again');
    });

    it('манифест есть, а сервер мёртв — та же ошибка', async () => {
        const running = await start();
        const manifest = JSON.parse(
            await fs.readFile(path.join(sherpaDir, 'servers', `${PR_KEY}.json`), 'utf8'),
        ) as Record<string, unknown>;
        await running.close();
        server = null;
        await fs.mkdir(path.join(sherpaDir, 'servers'), { recursive: true });
        await fs.writeFile(path.join(sherpaDir, 'servers', `${PR_KEY}.json`), JSON.stringify(manifest));

        const result = await sherpa('worker', 'next');

        expect(result.code).toBe(1);
        expect(result.stderr).toContain('not found or not responding');
    });

    it('чужой токен — сервер отбивает, CLI не показывает код ошибки', async () => {
        const running = await start();
        const manifestPath = path.join(sherpaDir, 'servers', `${PR_KEY}.json`);
        const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8')) as Record<string, unknown>;
        await fs.writeFile(manifestPath, JSON.stringify({ ...manifest, token: 'не тот токен' }));
        enqueueEcho(running);

        const result = await sherpa('worker', 'next');

        expect(result.code).toBe(1);
        expect(result.stderr).toContain('devflow-diff-explain:');
        expect(result.stderr).not.toContain('unauthorized');
    });
});

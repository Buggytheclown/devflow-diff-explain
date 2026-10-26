import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import type { Locale } from '@sherpa/protocol';

const execFileAsync = promisify(execFile);

/** Результат одного шелл-вызова бандла — ровно то, что видит модель в харнесе. */
export interface WorkerRun {
    readonly code: number;
    readonly stdout: string;
    readonly stderr: string;
}

/** Вывод `worker next` плюс разобранная шапка выданной задачи, если она в нём была. */
export interface NextRun extends WorkerRun {
    /** null — задачи не дали (`done`, ошибка или отказ сервера). */
    readonly taskId: number | null;
    /** Тип задачи из шапки (`route.skeleton`, `route.section`, `echo`, …); null — задачи не дали. */
    readonly type: string | null;
    /** Номер попытки из шапки; null — задачи не дали. */
    readonly attempt: number | null;
    /**
     * Плановые номера стопов, которые просит заполнить `route.section`.
     * Пусто у задач других типов: у них целей в инструкции нет.
     */
    readonly planIndexes: readonly number[];
}

export interface FakeWorkerOptions {
    /** Собранный `dist/devflow-diff-explain.mjs`: сессия ходит через тот же артефакт, что и в проде. */
    readonly bundlePath: string;
    readonly sherpaDir: string;
    readonly prKey: string;
    /** Куда сессия кладёт файлы результатов перед `task complete`. */
    readonly workDir: string;
    /** Отладочный оверрайд идентичности: им изображается «старая» сессия после реконнекта. */
    readonly workerId?: string;
}

/**
 * Эмулятор сессии-воркера для протокольных тестов: каждая команда — отдельный процесс голого
 * node с бандлом CLI, память между вызовами только в файлах стейта (`docs/protocol.md §1`).
 * «Смерть» сессии изображается прекращением вызовов, реконнект — новым `register`.
 */
export class FakeWorker {
    private readonly options: FakeWorkerOptions;
    private resultFiles = 0;

    constructor(options: FakeWorkerOptions) {
        this.options = options;
    }

    /** Та же сессия, но с явной идентичностью: так «старая» сессия продолжает ходить после реконнекта. */
    as(workerId: string): FakeWorker {
        return new FakeWorker({ ...this.options, workerId });
    }

    /** id, под которым ходят команды этой сессии: оверрайд либо записанный `register`-ом файл. */
    async workerId(): Promise<string> {
        if (this.options.workerId !== undefined) {
            return this.options.workerId;
        }
        const file = path.join(this.options.sherpaDir, 'prs', this.options.prKey, 'worker-id');
        return (await fs.readFile(file, 'utf8')).trim();
    }

    /** Метки сессии: те же, что у настоящего скилла, — каждая необязательна. */
    async register(harness?: string, lang?: Locale): Promise<WorkerRun> {
        return this.run(
            'worker',
            'register',
            ...(harness === undefined ? [] : ['--harness', harness]),
            ...(lang === undefined ? [] : ['--lang', lang]),
        );
    }

    /** Ждёт задачу без срока: звать, только когда задача заведомо будет. */
    async next(): Promise<NextRun> {
        const run = await this.run('worker', 'next');
        return { ...run, ...parseTaskHead(run.stdout), planIndexes: parsePlanIndexes(run.stdout) };
    }

    /** Сдача результата: файл пишется сам, как это делает модель перед вызовом команды. */
    async complete(taskId: number, content: string): Promise<WorkerRun> {
        this.resultFiles += 1;
        const file = path.join(this.options.workDir, `result-${String(this.resultFiles)}.md`);
        await fs.writeFile(file, content);
        return this.run('task', 'complete', String(taskId), '--file', file);
    }

    async progress(taskId: number, text: string): Promise<WorkerRun> {
        return this.run('task', 'progress', String(taskId), '--text', text);
    }

    async fail(taskId: number, reason: string): Promise<WorkerRun> {
        return this.run('task', 'fail', String(taskId), '--reason', reason);
    }

    /** Произвольный вызов бандла: сюда сходятся все команды сценариев. */
    async run(...argv: string[]): Promise<WorkerRun> {
        const env: Record<string, string> = {
            ...(process.env as Record<string, string>),
            SHERPA_DIR: this.options.sherpaDir,
            SHERPA_PR: this.options.prKey,
            // Выданные CLI файлы результатов — в рабочий каталог сессии, а не в системный tmp.
            TMPDIR: this.options.workDir,
        };
        if (this.options.workerId === undefined) {
            // Иначе унаследованный оверрайд разработчика подменил бы идентичность сессии.
            delete env.SHERPA_WORKER_ID;
        } else {
            env.SHERPA_WORKER_ID = this.options.workerId;
        }

        try {
            const { stdout, stderr } = await execFileAsync(process.execPath, [this.options.bundlePath, ...argv], {
                env,
                cwd: this.options.workDir,
                encoding: 'utf8',
            });
            return { code: 0, stdout, stderr };
        } catch (error) {
            return failedRun(error);
        }
    }
}

/**
 * Шапка `TASK sherpa/<id> (<type>), attempt <n>` из промпт-формата (`format.ts`);
 * формат тестовый, жёсткого контракта нет.
 */
function parseTaskHead(stdout: string): Pick<NextRun, 'taskId' | 'type' | 'attempt'> {
    const match = /TASK sherpa\/(\d+) \(([^)]+)\), attempt (\d+)/.exec(stdout);
    if (match?.[1] === undefined || match[2] === undefined || match[3] === undefined) {
        return { taskId: null, type: null, attempt: null };
    }
    return { taskId: Number(match[1]), type: match[2], attempt: Number(match[3]) };
}

/**
 * Целевые стопы задачи заполнения из её инструкции (`sectionInstructions`): петля сдаёт ровно
 * те номера, которые просят, и не полагается на порядок постановки задач в очереди.
 */
function parsePlanIndexes(stdout: string): readonly number[] {
    const match = /Fill in (?:this stop|these stops) of the review route: ([\d, ]+)\./.exec(stdout);
    if (match?.[1] === undefined) {
        return [];
    }
    return match[1]
        .split(',')
        .map((part) => Number(part.trim()))
        .filter((value) => Number.isInteger(value));
}

interface ExecFileFailure {
    code?: number;
    stdout?: string;
    stderr?: string;
}

/** Ненулевой код — нормальный исход протокола (`sherpa` так сообщает модели об отказе), не сбой теста. */
function failedRun(error: unknown): WorkerRun {
    if (!(error instanceof Error)) {
        throw new Error(`Запуск sherpa упал не ошибкой: ${String(error)}`);
    }

    const failure = error as Error & ExecFileFailure;
    if (typeof failure.stdout !== 'string' || typeof failure.stderr !== 'string') {
        throw error;
    }
    return { code: failure.code ?? 1, stdout: failure.stdout, stderr: failure.stderr };
}

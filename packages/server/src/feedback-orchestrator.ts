import fs from 'node:fs';
import path from 'node:path';

import type { Locale, ReviewUser } from '@sherpa/protocol';
import { reviewFeedbackResultSchema } from '@sherpa/protocol';

import { buildFeedbackPayload, materializeFeedbackPayload } from './feedback-payload.js';
import type { FeedbackStore } from './feedback-store.js';
import { resolveGenerationLocale } from './generation-locale.js';
import type { FeedbackHost, FeedbackReply } from './hosts/select.js';
import type { TaskQueue, TaskRecord, TaskResultAcceptance } from './queue.js';
import { voiceErrors } from './route/voice.js';
import { holdsPayload } from './shared-payload.js';
import type { SettingsStore } from './settings-store.js';
import type { WorkerRegistry } from './worker-registry.js';

/**
 * Раунд публикации локального ревью → задача `review.feedback` агенту. Агент правит код,
 * отвечает в тредах, и его ответы становятся обычными комментариями; дальше петлю замыкает
 * опрос рабочего дерева — правки агента заводят новую итерацию, и маршрут устаревает.
 *
 * Состояние раунда живёт у хоста, связь с очередью — в SQLite (`feedback-store.ts`),
 * и восстанавливается сверкой: журнала событий нет.
 */

export interface FeedbackOrchestratorOptions {
    readonly host: FeedbackHost;
    readonly queue: TaskQueue;
    readonly store: FeedbackStore;
    /** Корень payload раундов: внутри — подкаталог на раунд. */
    readonly payloadDir: string;
    /** Настройки UI: из них берётся язык, на котором агент пишет ответы ревьюеру. */
    readonly settings?: Pick<SettingsStore, 'read'> | null;
    /** Реестр воркеров: его харнес и модель подписывают ответы агента, `lang` — ступень лестницы языка. */
    readonly registry?: Pick<WorkerRegistry, 'status'> | null;
}

/** Что приёмщик знает о раунде, не спрашивая хост: проверка идёт синхронно, в транзакции. */
interface BoundRound {
    readonly roundId: string;
    readonly threadIds: ReadonlySet<string>;
}

export class FeedbackOrchestrator {
    private readonly host: FeedbackHost;
    private readonly queue: TaskQueue;
    private readonly store: FeedbackStore;
    private readonly payloadDir: string;
    private readonly settings: Pick<SettingsStore, 'read'> | null;
    private readonly registry: Pick<WorkerRegistry, 'status'> | null;

    /** Треды живых задач: приёмка синхронна, а хост отвечает промисом. */
    private readonly boundTasks = new Map<number, BoundRound>();

    private closed = false;
    private reconciling = false;
    private reconcileAgain = false;

    constructor(options: FeedbackOrchestratorOptions) {
        this.host = options.host;
        this.queue = options.queue;
        this.store = options.store;
        this.payloadDir = options.payloadDir;
        this.settings = options.settings ?? null;
        this.registry = options.registry ?? null;
    }

    close(): void {
        this.closed = true;
    }

    /**
     * Сверка раундов с очередью: каждому `pending` раунду без живой задачи ставится своя.
     *
     * Судьба провалившейся задачи: раунд остаётся `pending`, но заново по нему никто не ходит —
     * иначе петля крутила бы одну и ту же неподъёмную задачу. Ревьюер не остаётся ни с чем:
     * следующая публикация открывает новый раунд, и старые комментарии едут в нём же.
     *
     * Идемпотентна и зовётся на каждое событие: старт сервера и успешная публикация.
     */
    async reconcile(): Promise<void> {
        if (this.closed) {
            return;
        }
        if (this.reconciling) {
            this.reconcileAgain = true;
            return;
        }

        this.reconciling = true;
        try {
            do {
                this.reconcileAgain = false;
                await this.reconcileOnce();
            } while (this.needsAnotherPass());
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            process.stderr.write(`sherpa-server: сверка раундов ревью не прошла: ${message}\n`);
        } finally {
            this.reconciling = false;
        }
    }

    /** Чтение флагов методом: сужение типов иначе прячет их правки из чужих вызовов. */
    private needsAnotherPass(): boolean {
        return this.reconcileAgain && !this.closed;
    }

    private async reconcileOnce(): Promise<void> {
        const rounds = await this.host.pendingRounds();
        if (this.closed) {
            return;
        }

        const tasks = this.queue.listTasks();
        const byId = new Map(tasks.map((task) => [task.id, task]));
        this.cancelOrphanTasks(tasks);
        // Чистка идёт до постановки: каталоги этого прохода в снятом списке задач не значатся,
        // и сверка снесла бы только что записанный контекст.
        this.sweepRoundDirs(tasks);

        for (const round of rounds) {
            const binding = this.store.ofRound(round.id);
            // Провал и принятый результат заново не ставятся: раунд доедет до агента следующей
            // публикацией, а повтор крутил бы петлю или задвоил бы ответы.
            if (binding !== null && binding.state !== 'open') {
                continue;
            }

            const task = binding === null ? null : (byId.get(binding.taskId) ?? null);
            if (task !== null && (task.status === 'queued' || task.status === 'leased')) {
                // Задача жива — тредами раунда её приёмка обязана располагать и после рестарта.
                this.boundTasks.set(task.id, { roundId: round.id, threadIds: new Set(round.threadIds) });
                continue;
            }
            if (task !== null && task.status !== 'done') {
                this.store.setState(round.id, 'failed');
                continue;
            }
            await this.enqueueRound(round.id);
        }
    }

    /**
     * Задача раунда, за которой не стоит открытая привязка: так выглядит падение между
     * постановкой и записью привязки. Агенту такая задача уже не нужна — её результат отбила бы
     * приёмка.
     */
    private cancelOrphanTasks(tasks: readonly TaskRecord[]): void {
        const open = new Set(
            this.store
                .list()
                .filter((binding) => binding.state === 'open')
                .map((binding) => binding.taskId),
        );
        for (const task of tasks) {
            const live = task.status === 'queued' || task.status === 'leased';
            if (task.type === 'review.feedback' && live && !open.has(task.id)) {
                this.queue.cancel(task.id);
            }
        }
    }

    /**
     * Каталог раунда живёт ровно столько, сколько его задача: закрытая и никем не удерживаемая
     * задача свой контекст больше не читает (docs/protocol.md §4). Первая сверка идёт на старте
     * сервера — она же убирает каталоги, задач которых рестарт не пережил.
     */
    private sweepRoundDirs(tasks: readonly TaskRecord[]): void {
        let entries: string[];
        try {
            entries = fs.readdirSync(this.payloadDir);
        } catch {
            return;
        }

        const keep = new Set<string>();
        for (const task of tasks) {
            if (!holdsPayload(task)) {
                continue;
            }
            for (const file of task.contextFiles) {
                const dir = roundDirOf(this.payloadDir, file);
                if (dir !== null) {
                    keep.add(dir);
                }
            }
        }

        for (const entry of entries) {
            const dir = path.join(this.payloadDir, entry);
            if (!keep.has(dir)) {
                fs.rmSync(dir, { recursive: true, force: true });
            }
        }
    }

    private async enqueueRound(roundId: string): Promise<void> {
        const context = await this.host.roundContext(roundId);
        if (this.closed) {
            return;
        }

        // Язык фиксируется здесь: задача просит отвечать именно на нём, и по нему же приёмка
        // проверит голос — смена настроек до сдачи результата проверку не перекосит.
        const locale = this.locale();
        const payload = buildFeedbackPayload(context, locale);
        const input = await materializeFeedbackPayload(path.join(this.payloadDir, roundId), payload);
        const task = this.queue.enqueue(input);
        this.store.bind(roundId, task.id, locale);
        this.boundTasks.set(task.id, {
            roundId,
            threadIds: new Set(context.threads.map((thread) => thread.threadId)),
        });
    }

    /** Чужие типы возвращают `null`: составной приёмщик в `server.ts` продолжит диспатч. */
    acceptResult(task: TaskRecord, result: string): TaskResultAcceptance | null {
        if (task.type !== 'review.feedback') {
            return null;
        }

        const binding = this.store.ofTask(task.id);
        if (binding?.state !== 'open') {
            return {
                kind: 'rejected',
                errors: ['This task no longer belongs to an open review round. Call `worker next`.'],
            };
        }

        const bound = this.boundTasks.get(task.id);
        if (bound === undefined) {
            // Треды раунда в память ещё не подняты (рестарт посреди задачи): проверить нечем,
            // и виноват в этом сервер — отказ не тратит бюджет модели.
            void this.reconcile();
            return {
                kind: 'deferred',
                errors: ['The server has not loaded this review round yet. Call `complete` again in a moment.'],
            };
        }

        const parsed = parseResult(result, bound.threadIds, binding.locale);
        if (!parsed.ok) {
            return { kind: 'rejected', errors: parsed.errors };
        }

        const author = this.agentUser(binding.locale);
        const { replies, summary } = parsed.value;
        return {
            kind: 'accepted',
            onCommitted: () => {
                void this.commitRound(task.id, bound, { replies, summary }, author);
            },
        };
    }

    /**
     * Ответы агента в треды и закрытие раунда. Порядок важен: `done` ставится только после
     * успешной записи — иначе отказ хоста (нет места, права, сорвавшийся `arc`) закрыл бы раунд
     * навсегда, потому что принятые и провалившиеся раунды сверка заново не ставит. Отказ
     * оставляет привязку открытой, и ближайшая сверка ставит раунд агенту заново.
     */
    private async commitRound(
        taskId: number,
        bound: BoundRound,
        result: { readonly replies: readonly FeedbackReply[]; readonly summary: string },
        author: ReviewUser,
    ): Promise<void> {
        try {
            await this.host.completeRound(bound.roundId, result, author);
            this.store.setState(bound.roundId, 'done');
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            process.stderr.write(
                `sherpa-server: ответы агента в раунд ${bound.roundId} не записались: ${message}\n`,
            );
            await this.reconcile();
        } finally {
            this.boundTasks.delete(taskId);
        }
    }

    /**
     * Подпись ответов агента: логин — харнес сессии, имя — «Агент» на языке раунда с моделью,
     * если она известна.
     */
    private agentUser(locale: Locale): ReviewUser {
        const status = this.registry?.status();
        const connected = status !== undefined && status.kind !== 'never' ? status : null;
        const model = connected?.model;
        const name = locale === 'ru' ? 'Агент' : 'Agent';
        return {
            login: connected?.harness ?? 'agent',
            displayName: model === undefined ? name : `${name} · ${model}`,
            bot: true,
            avatarUrl: null,
        };
    }

    /**
     * Язык ответов ревьюеру: та же лестница, что у маршрута и чата, без запроса вкладки.
     * Считается один раз, при постановке задачи, и дальше живёт в привязке раунда.
     */
    private locale(): Locale {
        const status = this.registry?.status();
        return resolveGenerationLocale({
            setting: this.settings?.read().locale,
            agentLang: status === undefined || status.kind === 'never' ? undefined : status.lang,
        });
    }
}

/** Каталог раунда, которому принадлежит путь; null — путь не из каталога раундов. */
function roundDirOf(payloadDir: string, file: string): string | null {
    const relative = path.relative(payloadDir, file);
    if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
        return null;
    }
    const [name] = relative.split(path.sep);
    return name === undefined || name === '' ? null : path.join(payloadDir, name);
}

type ParsedResult =
    | { readonly ok: true; readonly value: { readonly replies: FeedbackReply[]; readonly summary: string } }
    | { readonly ok: false; readonly errors: string[] };

/** Fail-closed разбор результата: схема, треды раунда, дубли и голос ответа. */
function parseResult(result: string, threadIds: ReadonlySet<string>, locale: Locale): ParsedResult {
    let raw: unknown;
    try {
        raw = JSON.parse(result);
    } catch {
        return { ok: false, errors: ['The result is not valid JSON. Follow the schema from the task.'] };
    }

    const parsed = reviewFeedbackResultSchema.safeParse(raw);
    if (!parsed.success) {
        return {
            ok: false,
            errors: parsed.error.issues.map(
                (issue) => `${issue.path.join('.') || 'result'}: ${issue.message}`,
            ),
        };
    }

    const errors: string[] = [];
    const seen = new Set<string>();
    for (const reply of parsed.data.replies) {
        if (!threadIds.has(reply.threadId)) {
            errors.push(
                `replies: thread ${reply.threadId} is not in this review round — reply only to the threads listed in feedback.md.`,
            );
        }
        if (seen.has(reply.threadId)) {
            errors.push(`replies: thread ${reply.threadId} is answered twice — one reply per thread.`);
        }
        seen.add(reply.threadId);
        errors.push(...voiceErrors(`replies.${reply.threadId}`, reply.body, locale));
    }
    if (parsed.data.summary.trim() === '') {
        errors.push('summary: write one line about what you did in this round.');
    }
    errors.push(...voiceErrors('summary', parsed.data.summary, locale));

    return errors.length > 0
        ? { ok: false, errors }
        : { ok: true, value: { replies: [...parsed.data.replies], summary: parsed.data.summary } };
}

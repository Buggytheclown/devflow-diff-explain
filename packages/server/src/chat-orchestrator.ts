import { explanationEvidence } from './story-evidence.js';
import fs from 'node:fs';
import path from 'node:path';

import type {
    ChatAnchor,
    ChatExplanation,
    ChatExchange,
    FileContent,
    Locale,
    PrDiff,
    PrMeta,
    ReviewSource,
    UiChatAskAnchor,
    UiChatCancelResponse,
    UiChatRetryResponse,
} from '@sherpa/protocol';

import { buildChatPayload, materializeChatPayload, questionDirIn } from './chat-payload.js';
import { chatCodeLinkErrors } from './chat-code-links.js';
import type { ChatStore, StoredChatExchange } from './chat-store.js';
import { explanationText } from '@sherpa/protocol';
import { RpcFailure } from './errors.js';
import { resolveGenerationLocale } from './generation-locale.js';
import type { IterationFeed } from './iteration-feed.js';
import type { IterationStore } from './iteration-store.js';
import { rememberIterationDiff } from './iteration-store.js';
import { LEGACY_DIFF_ID } from './iterations/index.js';
import type { EnqueueInput, TaskQueue, TaskRecord, TaskResultAcceptance } from './queue.js';
import type { RouteStore } from './route-store.js';
import { voiceErrors } from './route/voice.js';
import type { SettingsStore } from './settings-store.js';
import type { SharedPayloadStore } from './shared-payload.js';
import { holdsPayload } from './shared-payload.js';
import type { WorkerRegistry } from './worker-registry.js';

export interface ChatOrchestratorOptions {
    readonly store: ChatStore;
    readonly route: RouteStore;
    readonly queue: TaskQueue;
    readonly host: ReviewSource | null;
    readonly payloadDir: string;
    /** Локальное хранилище патчей итераций; `null` — сохранять дифф некуда (тесты без БД). */
    readonly iterations?: IterationStore | null;
    /** Итерации PR: по ним видно, спрашивают про активную итерацию или про прошлую. */
    readonly iterationFeed?: IterationFeed | null;
    /** Общий контекст вопросов: методичка, дифф PR и тексты файлов по стабильным путям. */
    readonly shared: SharedPayloadStore;
    /** Настройки UI: из них берётся язык ответа, когда его не назвал запрос. */
    readonly settings?: Pick<SettingsStore, 'read'> | null;
    /** Реестр воркеров: подсказка `--lang` — предпоследняя ступень лестницы языка. */
    readonly registry?: Pick<WorkerRegistry, 'status'> | null;
}

    /**
 * Связывает обмен чата с одной текущей задачей очереди. Состояние восстанавливается сверкой,
 * поэтому рестарт между операциями не требует отдельного журнала событий.
 */
export class ChatOrchestrator {
    private readonly store: ChatStore;
    private readonly route: RouteStore;
    private readonly queue: TaskQueue;
    private readonly host: ReviewSource | null;
    private readonly payloadDir: string;
    private readonly iterations: IterationStore | null;
    private readonly iterationFeed: IterationFeed | null;
    private readonly shared: SharedPayloadStore;
    private readonly settings: Pick<SettingsStore, 'read'> | null;
    private readonly registry: Pick<WorkerRegistry, 'status'> | null;
    /**
     * Каталоги вопросов, задачи которых ещё не поставлены: между записью payload и постановкой
     * есть await, а чистка идёт по задачам очереди и снесла бы свежий каталог.
     */
    private readonly reservedDirs = new Set<string>();

    private unsubscribeQueue: (() => void) | null = null;
    private closed = false;
    private reconciling = false;
    private reconcileAgain = false;

    constructor(options: ChatOrchestratorOptions) {
        this.store = options.store;
        this.route = options.route;
        this.queue = options.queue;
        this.host = options.host;
        this.payloadDir = options.payloadDir;
        this.iterations = options.iterations ?? null;
        this.iterationFeed = options.iterationFeed ?? null;
        this.shared = options.shared;
        this.settings = options.settings ?? null;
        this.registry = options.registry ?? null;
    }

    start(): void {
        this.unsubscribeQueue = this.queue.subscribeChanges(() => {
            this.reconcile();
        });
        this.reconcile();
    }

    close(): void {
        this.closed = true;
        this.unsubscribeQueue?.();
    }

    /** `requestedLocale` — эффективный язык вкладки; без него язык выбирает лестница. */
    async ask(
        question: string,
        requested: UiChatAskAnchor | null,
        requestedLocale?: Locale,
        explanation?: ChatExplanation,
    ): Promise<ChatExchange> {
        if (explanation !== undefined) {
            const focus = explanation.file === undefined ? explanation.sectionId : `file:${explanation.file.fileId}`;
            const shown = explanation.snapshotId === null ? null : this.route.getSnapshot(explanation.snapshotId);
            if ((explanation.snapshotId !== null && (shown?.presentation !== 'story' || shown.diffId !== explanation.diffId ||
                shown.commit !== explanation.commit || explanation.text !== explanationText(shown, focus))) ||
                (explanation.snapshotId === null && (explanation.text !== '' || explanation.sectionId !== undefined)) ||
                (requested?.diffId !== undefined && requested.diffId !== explanation.diffId)) {
                throw new RpcFailure('bad_request', 'Рассказ изменился. Обновите контекст вопроса и отправьте его снова.');
            }
            const { evidence: suppliedEvidence, ...pinned } = explanation;
            void suppliedEvidence;
            const evidence = shown === null ? undefined : explanationEvidence(shown, focus);
            explanation = { ...pinned, ...(evidence === undefined ? {} : { evidence }) };
        }
        const context = await this.loadPrContext(requested, explanation?.diffId);
        if (explanation !== undefined && (context.diff?.diffId !== explanation.diffId || context.headCommit !== explanation.commit)) {
            throw new RpcFailure('bad_request', 'Не удалось получить код показанной версии ПР.');
        }
        const anchor = resolveAskAnchor(requested, context.diff);
        const attached = explanation?.file;
        if (attached !== undefined && (requested !== null || !context.diff?.files.some((file) => file.fileId === attached.fileId && file.path === attached.path))) {
            throw new RpcFailure('bad_request', 'Прикреплённый файл недоступен в выбранной версии ПР.');
        }
        const locale = this.resolveLocale(requestedLocale);
        const taskDir = questionDirIn(this.payloadDir);
        this.reservedDirs.add(taskDir);
        try {
            const input = await this.materialize(taskDir, question, anchor, context, locale, explanation ?? null);
            return this.store.ask(question, anchor, context.headCommit, locale, () =>
                this.queue.enqueueInTransaction(input),
                explanation ?? null,
            );
        } finally {
            this.reservedDirs.delete(taskDir);
        }
    }

    cancel(exchangeId: number): UiChatCancelResponse['outcome'] {
        const stored = this.store.exchange(exchangeId);
        if (stored === null || (stored.exchange.status !== 'queued' && stored.exchange.status !== 'running')) {
            return 'noop';
        }

        if (stored.exchange.taskId !== null) {
            this.queue.cancel(stored.exchange.taskId);
        }
        this.store.cancelExchange(exchangeId);
        return 'cancelled';
    }

    async retry(exchangeId: number): Promise<UiChatRetryResponse['outcome']> {
        const stored = this.store.exchange(exchangeId);
        if (stored === null || (stored.exchange.status !== 'failed' && stored.exchange.status !== 'cancelled')) {
            return 'noop';
        }

        const context = await this.loadPrContext(stored.exchange.anchor, stored.exchange.explanation?.diffId);
        const taskDir = questionDirIn(this.payloadDir);
        this.reservedDirs.add(taskDir);
        try {
            const input = await this.materialize(
                taskDir,
                stored.exchange.question,
                stored.exchange.anchor,
                context,
                // Повтор говорит на языке исходного вопроса: ответ не меняет язык посреди ленты.
                localeOf(stored.exchange),
                stored.exchange.explanation ?? null,
            );
            return this.store.retry(exchangeId, context.headCommit, () => this.queue.enqueueInTransaction(input))
                ? 'retried'
                : 'noop';
        } finally {
            this.reservedDirs.delete(taskDir);
        }
    }

    /** Свои файлы — в каталог вопроса, неизменные — по общему пути (`shared-payload.ts`). */
    private materialize(
        taskDir: string,
        question: string,
        anchor: ChatAnchor | null,
        context: PrContext,
        locale: Locale,
        explanation: ChatExplanation | null,
    ): Promise<EnqueueInput> {
        return materializeChatPayload(
            taskDir,
            this.shared,
            buildChatPayload({
                question,
                anchor,
                pr: context.pr,
                diff: context.diff,
                fileContent: context.fileContent,
                route: this.route.read(),
                history: this.store.read().exchanges.filter((exchange) => explanation === null || exchange.explanation?.diffId === explanation.diffId),
                explanation,
                locale,
            }),
        );
    }

    /** Лестница языка ответа: запрос вкладки → настройки → подсказка агента → русский. */
    private resolveLocale(requested: Locale | undefined): Locale {
        const status = this.registry?.status();
        return resolveGenerationLocale({
            requested,
            setting: this.settings?.read().locale,
            agentLang: status === undefined || status.kind === 'never' ? undefined : status.lang,
        });
    }

    /** Чужие типы возвращают `null`: составной приёмщик в `server.ts` продолжит диспатч. */
    acceptResult(task: TaskRecord, result: string): TaskResultAcceptance | null {
        if (task.type !== 'chat') {
            return null;
        }

        const stored = this.store.exchangeForTask(task.id);
        if (
            stored?.exchange.taskId !== task.id ||
            (stored.exchange.status !== 'queued' && stored.exchange.status !== 'running')
        ) {
            return {
                kind: 'rejected',
                errors: ['This chat task no longer belongs to an active reviewer question. Call `worker next`.'],
            };
        }

        const errors = this.resultErrors(result, stored.exchange);
        if (errors.length > 0) {
            return { kind: 'rejected', errors };
        }
        return {
            kind: 'accepted',
            onCommitted: () => {
                this.store.completeTask(task.id, result);
            },
        };
    }

    private reconcile(): void {
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
                this.reconcileOnce();
            } while (this.needsAnotherPass());
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            process.stderr.write(`sherpa-server: сверка чата не прошла: ${message}\n`);
        } finally {
            this.reconciling = false;
        }
    }

    private needsAnotherPass(): boolean {
        return this.reconcileAgain && !this.closed;
    }

    private reconcileOnce(): void {
        const tasks = this.queue.listTasks();
        const byId = new Map(tasks.map((task) => [task.id, task]));
        const boundTaskIds = new Set(
            this.store.openExchanges().flatMap(({ exchange }) => (exchange.taskId === null ? [] : [exchange.taskId])),
        );

        for (const task of tasks) {
            const open = task.status === 'queued' || task.status === 'leased';
            if (task.type === 'chat' && open && !boundTaskIds.has(task.id)) {
                this.queue.cancel(task.id);
            }
        }

        for (const stored of this.store.openExchanges()) {
            const taskId = stored.exchange.taskId;
            this.reconcileExchange(stored, taskId === null ? null : (byId.get(taskId) ?? null));
        }

        this.sweepQuestionDirs(tasks);
    }

    /**
     * Каталог вопроса живёт ровно столько, сколько его задача: закрытая и никем не удерживаемая
     * задача свой контекст больше не читает. Первая сверка идёт на старте сервера, поэтому она же
     * убирает каталоги, задач которых рестарт не пережил.
     *
     * Список задач берётся до правок этой сверки: устаревшая запись держит каталог лишний проход,
     * и это правильная сторона ошибки — снести контекст живой задачи нельзя.
     */
    private sweepQuestionDirs(tasks: readonly TaskRecord[]): void {
        let entries: string[];
        try {
            entries = fs.readdirSync(this.payloadDir);
        } catch {
            return;
        }

        const keep = new Set(this.reservedDirs);
        for (const task of tasks) {
            if (!holdsPayload(task)) {
                continue;
            }
            for (const file of task.contextFiles) {
                const dir = questionDirOf(this.payloadDir, file);
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

    private reconcileExchange(stored: StoredChatExchange, task: TaskRecord | null): void {
        if (task === null) {
            this.store.failExchange(
                stored.exchange.id,
                'Задача ответа потеряна после перезапуска сервера. Вопрос сохранён — его можно повторить.',
            );
            return;
        }

        if (
            (task.status === 'queued' || task.status === 'leased') &&
            task.lastLeaseReturnReason === 'expired'
        ) {
            this.store.failExchange(
                stored.exchange.id,
                'Агент перестал отвечать во время вопроса. Вопрос сохранён — его можно повторить.',
            );
            this.queue.cancel(task.id);
            return;
        }

        switch (task.status) {
            case 'queued':
                this.store.syncTask(task.id, 'queued', null, null);
                return;
            case 'leased':
                this.store.syncTask(task.id, 'running', task.progressText, null);
                return;
            case 'failed':
                this.store.syncTask(task.id, 'failed', null, chatFailure(task));
                return;
            case 'cancelled':
                this.store.syncTask(task.id, 'cancelled', null, null);
                return;
            case 'done': {
                const result = task.result ?? '';
                const errors = this.resultErrors(result, stored.exchange);
                if (errors.length > 0) {
                    this.store.failExchange(
                        stored.exchange.id,
                        'Сохранённый ответ не прошёл проверку после перезапуска сервера. Вопрос можно повторить.',
                    );
                    return;
                }
                this.store.completeTask(task.id, result);
                return;
            }
        }
    }

    /**
     * Материал вопроса: шапка PR, дифф его итерации и, для якорного вопроса, текст файла.
     * Отказ любой части не отменяет вопрос, а сужает контекст.
     */
    private async loadPrContext(anchor: { fileId: string; diffId?: string | undefined } | null, pinnedDiffId?: string): Promise<PrContext> {
        const host = this.host;
        if (host === null) {
            return { pr: null, diff: null, fileContent: null, headCommit: null };
        }

        // Якорь обмена старого формата итерации не называет (`LEGACY_DIFF_ID`) — такой вопрос про активную.
        const pinned =
            pinnedDiffId ?? (anchor?.diffId === undefined || anchor.diffId === LEGACY_DIFF_ID ? null : anchor.diffId);
        const active = this.iterationFeed?.active() ?? null;
        if (pinned !== null && active !== null && active.diffId !== pinned) {
            return this.loadPinnedContext(host, pinned);
        }

        const getFileContent = host.getFileContent?.bind(host);
        const [pr, diff, fileContent] = await Promise.all([
            host.getPr().then(
                (value) => value,
                () => null,
            ),
            host.getDiff().then(
                (value) => value,
                () => null,
            ),
            anchor === null || getFileContent === undefined
                ? Promise.resolve(null)
                : getFileContent(anchor.fileId).then(
                      (value) => value,
                      () => null,
                  ),
        ]);
        if (this.iterations !== null && diff !== null) {
            // Дифф активной итерации, по которому собран контекст вопроса, оседает в хранилище.
            void rememberIterationDiff(this.iterations, host, diff);
        }
        // Активная итерация могла уехать вперёд, пока грузился дифф (или фид ещё не стартовал):
        // вопрос по прошлой итерации обязан строиться из её патча, а не из свежего. Текст файла
        // из ответа при этом отбрасывается — `getFileContent` знает только активную итерацию.
        if (pinned !== null && diff?.diffId !== pinned) {
            return this.loadPinnedContext(host, pinned, pr);
        }
        return { pr, diff, fileContent, headCommit: diff?.headCommit ?? null };
    }

/**
     * Контекст вопроса по прошлой итерации: её патч лежит локально (docs/spec.md), а содержимого
     * файлов у хоста для неё нет — `getFileContent` знает только активную итерацию.
     */
    private resultErrors(result: string, exchange: ChatExchange): string[] {
        const diffId = exchange.explanation?.diffId ?? exchange.anchor?.diffId;
        const diff = diffId === undefined ? null : this.iterations?.get(diffId)?.diff ?? null;
        return [...chatResultErrors(result, localeOf(exchange)), ...chatCodeLinkErrors(result, diff, exchange.anchor)];
    }

    private async loadPinnedContext(host: ReviewSource, diffId: string, meta?: PrMeta | null): Promise<PrContext> {
        const stored = this.iterations?.get(diffId) ?? null;
        if (stored === null) {
            throw new RpcFailure(
                'bad_request',
                `Дифф итерации ${diffId} не сохранён — вопрос по ней задать не из чего.`,
            );
        }

        const pr =
            meta !== undefined
                ? meta
                : await host.getPr().then(
                      (value) => value,
                      () => null,
                  );
        return { pr, diff: stored.diff, fileContent: null, headCommit: stored.diff.headCommit };
    }
}

/** Якорь из UI без `diffId` относится к активной итерации — её id берётся из загруженного диффа. */
function resolveAskAnchor(anchor: UiChatAskAnchor | null, diff: PrDiff | null): ChatAnchor | null {
    if (anchor === null) {
        return null;
    }
    if (anchor.diffId !== undefined) {
        return { ...anchor, diffId: anchor.diffId };
    }
    if (diff === null) {
        throw new RpcFailure('bad_request', 'Якорь вопроса без diffId, а активной итерации нет: хост недоступен.');
    }
    return { ...anchor, diffId: diff.diffId };
}

/** Что хост дал под этот вопрос; отказ любой части не отменяет вопрос, а сужает контекст. */
interface PrContext {
    readonly pr: PrMeta | null;
    readonly diff: PrDiff | null;
    readonly fileContent: FileContent | null;
    readonly headCommit: string | null;
}

function chatResultErrors(result: string, locale: Locale): string[] {
    if (result.trim() === '') {
        return ['The chat answer is empty. Return a non-empty Markdown answer.'];
    }
    return voiceErrors('answer', result, locale);
}

/** Язык обмена; `null` несут обмены до миграции 020 — они русские. */
function localeOf(exchange: ChatExchange): Locale {
    return exchange.locale ?? 'ru';
}

/** Каталог вопроса, которому принадлежит путь; `null` — путь не из каталога вопросов (общий файл). */
function questionDirOf(payloadDir: string, file: string): string | null {
    const relative = path.relative(payloadDir, file);
    if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
        return null;
    }
    const [name] = relative.split(path.sep);
    return name === undefined || name === '' ? null : path.join(payloadDir, name);
}

function chatFailure(task: TaskRecord): string {
    const reason = (task.failReason ?? '').trim();
    return reason === '' ? 'Агент не ответил и не назвал причину.' : `Агент не ответил: ${reason}`;
}

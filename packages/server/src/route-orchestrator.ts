import { validateArchitectureOverview } from './architecture-story.js';
import { randomUUID } from 'node:crypto';

import type {
    HostId,
    Iteration,
    Locale,
    PrDiff,
    CapturedPr,
    CodeReader,
    RouteProvenance,
    RouteSnapshot,
    UiRouteFillStopResponse,
    UiRouteGenerateResponse,
    WorkerStatus,
    SectionAssignment,
    TaskCompleteResponse,
} from '@sherpa/protocol';

import { checkIndividualFiles, readCheckpoint, internalEvidence, validateArchitectureCheckpoint } from './architecture-checkpoint.js';
import { RpcFailure } from './errors.js';
import { resolveGenerationLocale } from './generation-locale.js';
import type { IterationStore } from './iteration-store.js';
import type { EnqueueInput, TaskQueue, TaskRecord, TaskResultAcceptance } from './queue.js';
import { RoutePayloadWriter } from './route-payload.js';
import { CURRENT_ROUTE_TASK_EPOCH } from './route-store.js';
import type {
    RouteStopStatusUpdate,
    RouteStore,
    RouteTaskBinding,
} from './route-store.js';
import type { RouteStrings } from './route/index.js';
import { routeStrings } from './route/index.js';
import type { SettingsStore } from './settings-store.js';
import type { SharedPayloadStore } from './shared-payload.js';
import type { WorkerRegistry } from './worker-registry.js';

    /**
 * Сколько раз в рамках одной генерации сервер ставит задачу на план. Обычно хватает одной:
 * счётчик страхует от петли «результат принят, но применить его не вышло» — иначе сорванная
 * запись снапшота гоняла бы агента по полной генерации бесконечно.
 */
export const MAX_SKELETON_TASKS = 3;

/** Общее начало типов задач маршрута (`route.skeleton`, `route.section`). */
const ROUTE_TASK_PREFIX = 'route.';

/**
 * Задержка разовой проверки после старта сервера: «дифф на экране меньше двух секунд»,
 * поэтому старт не ждёт `getDiff()` — прогрев уезжает в отложенный таймер, который не держит
 * процесс живым (`unref`) и активностью для учёта простоя не считается.
 */
const WARMUP_DELAY_MS = 200;

export interface RouteOrchestratorOptions {
    readonly store: RouteStore;
    readonly queue: TaskQueue;
    readonly registry: WorkerRegistry;
    /** Ревью-хост PR; `null` — маршрут этому серверу негде взять. */
    readonly host: CodeReader | null;
    /** Каталог, которым единолично владеет `RoutePayloadWriter` (`routePayloadDirOf`). */
    readonly payloadDir: string;
    /** Общий контекст PR: методичка и дифф едут по стабильному пути, а не копией на задачу. */
    readonly shared: SharedPayloadStore;
    /** Локальное хранилище патчей итераций; `null` — сохранять дифф генерации некуда (тесты без БД). */
    readonly iterations?: IterationStore | null;
    /**
     * Глобальные настройки UI: из них берётся язык генерации, когда его не назвал запрос.
     * `null` — настроек нет, лестница падает на подсказку агента и русский.
     */
    readonly settings?: Pick<SettingsStore, 'read'> | null;
    /** Задержка прогрева после старта; в тестах прогрев зовётся явно (`warmup`). */
    readonly warmupDelayMs?: number;
}

export class RouteOrchestrator {
    private readonly store: RouteStore;
    private readonly queue: TaskQueue;
    private readonly registry: WorkerRegistry;
    private readonly host: CodeReader | null;
    private readonly payload: RoutePayloadWriter;
    private readonly iterations: IterationStore | null;
    private readonly settings: Pick<SettingsStore, 'read'> | null;
    private readonly warmupDelayMs: number;

    /**
     * Дифф фиксируется на старте: после пуша идущая генерация заканчивается на своей итерации.
     */
    private generation: PrDiff | null = null;
    private upgradingDiff: string | null = null;
    /**
     * Последний дифф активной итерации: с него начинается следующая генерация. Диффом идущей
     * он не становится — её итерацию называет привязка задачи, а после рестарта только она.
     */
    private activeDiff: PrDiff | null = null;
    /** Идущая загрузка активного диффа: параллельные вызовы делят один запрос к хосту. */
    private diffLoad: Promise<PrDiff> | null = null;
    /** Шапка PR для payload; `null` — хост её не отдал, маршрут строится по одному диффу. */
    private meta: CapturedPr | null = null;

    private unsubscribeQueue: (() => void) | null = null;
    private unsubscribeWorker: (() => void) | null = null;
    private unsubscribeStore: (() => void) | null = null;
    private warmupTimer: NodeJS.Timeout | null = null;

    private closed = false;
    private reconciling = false;
    private reconcileAgain = false;

    constructor(options: RouteOrchestratorOptions) {
        this.store = options.store;
        this.queue = options.queue;
        this.registry = options.registry;
        this.host = options.host;
        this.payload = new RoutePayloadWriter({ payloadDir: options.payloadDir, shared: options.shared });
        this.iterations = options.iterations ?? null;
        this.settings = options.settings ?? null;
        this.warmupDelayMs = options.warmupDelayMs ?? WARMUP_DELAY_MS;
    }

    /** Подписки автомата и разовый прогрев. Зовётся один раз при сборке сервера. */
    start(): void {
        for (const task of this.queue.listTasks()) if (task.type === 'route.diagram' && (task.status === 'queued' || task.status === 'leased')) this.queue.cancel(task.id);
        const state = this.store.read();
        if (this.store.generationTaskEpoch() !== CURRENT_ROUTE_TASK_EPOCH && (state.phase === 'reading' || state.phase === 'filling' || this.hasOpenRouteTask())) {
            const binding = [...this.store.bindings().values()].find((entry) => entry.diffId !== null);
            const pinned = state.phase === 'filling' ? state.snapshot?.diffId : binding?.diffId ?? this.store.generationDiffId();
            this.upgradingDiff = pinned ?? null;
            if (pinned != null) this.store.pinGenerationDiff(pinned);
            this.cancelOpenRouteTasks();
            this.store.clearBindings();
            if (pinned == null) this.store.fail('Снимок незавершённой подготовки неизвестен. Сохранённый текст доступен; повторите построение.', null);
        }
        this.unsubscribeQueue = this.queue.subscribeChanges(() => {
            this.reconcile();
        });
        this.unsubscribeStore = this.store.subscribe(() => { queueMicrotask(() => { this.reconcile(); }); });
        // Подключение агента — момент, когда генерацию есть кому выполнить.
        this.unsubscribeWorker = this.registry.subscribe((status: WorkerStatus) => {
            if (status.kind === 'connected') {
                this.warmupInBackground();
            }
        });

        const timer = setTimeout(() => {
            this.warmupTimer = null;
            this.warmupInBackground();
        }, this.warmupDelayMs);
        timer.unref();
        this.warmupTimer = timer;
    }

    close(): void {
        this.closed = true;
        this.unsubscribeQueue?.();
        this.unsubscribeWorker?.();
        this.unsubscribeStore?.();
        if (this.warmupTimer !== null) {
            clearTimeout(this.warmupTimer);
            this.warmupTimer = null;
        }
    }

    /** Прогрев из таймера и подписки: у него некому поймать исключение, поэтому оно ловится здесь. */
    private warmupInBackground(): void {
        void this.warmup().catch((error: unknown) => {
            const message = error instanceof Error ? error.message : String(error);
            process.stderr.write(`sherpa-server: прогрев маршрута сорвался: ${message}\n`);
        });
    }

    /**
     * Прогрев: считает порог малого PR, доставляет недостающие задачи прерванной генерации
     * и ставит скелет, если маршрута нет, а агент на связи. Ошибки хоста сюда не выходят —
     * прогрев фоновый, и ронять им нечего.
     */
    async warmup(): Promise<void> {
        if (this.isClosed() || this.host === null) {
            return;
        }

        let diff: PrDiff;
        try {
            diff = await this.loadDiff();
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            process.stderr.write(`sherpa-server: маршрут не прогрет — дифф не получен: ${message}\n`);
            return;
        }
        if (this.isClosed()) {
            return;
        }

        this.store.setSmallPr(false);
        if (this.upgradingDiff !== null) {
            const pinned = this.diffOf(this.upgradingDiff);
            if (pinned === null) { this.store.fail(this.lostDiffMessage(this.upgradingDiff), null); this.upgradingDiff = null; return; }
            this.upgradingDiff = null;
            const saved = this.store.current();
            if (this.store.read().phase === 'filling' && saved?.storyContractVersion === 6) {
                this.generation = pinned;
                this.store.upgradeTaskEpoch();
                this.payload.beginGeneration();
            } else this.startSkeleton(pinned, this.skeletonLocale());
        }

        // Починка прерванной генерации идёт до автопостановки: фаза `filling` без задач — это
        // рестарт сервера, а не повод строить маршрут заново.
        this.reconcile();

        const phase = this.store.read().phase;
        // `failed` лечится только кнопкой: иначе сервер бесконечно бился бы о ту же стену.
        if (phase !== 'none' || this.registry.status().kind !== 'connected' || this.hasOpenRouteTask()) {
            return;
        }

        if (this.isClosed() || this.store.read().phase !== 'none' || this.hasOpenRouteTask()) {
            return;
        }
        // Автопостановку затеял сервер: локаль ему никто не называл, работает лестница.
        this.startSkeleton(diff, this.resolveLocale(undefined));
    }

    /**
     * Ручка `review/route/generate`: запуск и перезапуск генерации. Из `ready` старый маршрут
     * остаётся читаемым до приёмки нового скелета.
     *
     * `requestedLocale` — эффективный язык вкладки, которая нажала кнопку. Без него
     * язык выбирает лестница `resolveGenerationLocale`.
     */
    async generate(requestedLocale?: Locale): Promise<UiRouteGenerateResponse['outcome']> {
        if (this.host === null) {
            throw new RpcFailure(
                'no_review_host',
                'Импортируйте снимок кода перед подготовкой разбора.',
            );
        }

        const diff = await this.loadDiff();
        this.store.setSmallPr(false);

        const phase = this.store.read().phase;
        if (phase === 'reading' || phase === 'filling') {
            return 'already_running';
        }

        this.startSkeleton(diff, this.resolveLocale(requestedLocale));
        return 'started';
    }

    /**
     * Точечное дозаполнение failed-стопа через штатную фазу `filling` и сверку. Якоря резолвятся
     * против диффа итерации снапшота: PR мог уйти вперёд, но дозаполняется старый маршрут.
     */
    async fillStop(snapshotId: string, planIndex: number): Promise<UiRouteFillStopResponse['outcome']> {
        if (this.host === null) {
            throw new RpcFailure('no_review_host', 'Импортируйте снимок кода перед подготовкой разбора.');
        }

        const state = this.store.read();
        if (state.phase !== 'ready' && !(state.phase === 'failed' && state.snapshot?.presentation === 'story')) {
            return 'already_running';
        }
        if (state.snapshot?.snapshotId !== snapshotId) {
            return 'stale_snapshot';
        }

        const stop = state.snapshot.stops.find((candidate) => candidate.planIndex === planIndex);
        if (stop?.status !== 'failed') {
            return 'not_unfilled';
        }
        // Дозаполняется маршрут своей итерации: активная могла уехать вперёд, но резолвить
        // якоря против её диффа нельзя.
        const pinned = await this.ensureDiff(state.snapshot.diffId);
        if (state.snapshot.storyContractVersion !== 6) {
            this.startSkeleton(pinned, snapshotLocale(state.snapshot));
            return 'started';
        }

        // Прогресс не чистим: незаполненный стоп нельзя отметить в UI, отметки остальных живут.
        this.store.beginStopFill(planIndex);
        this.store.setGenerationStatus('running');
        this.reconcile();
        return 'started';
    }

    reportDiagramFailure(report: { snapshotId: string; reportVersion?: 1 | undefined; diagramHash?: string | undefined; viewIndex?: number | undefined; missingId?: string | undefined; reason?: string | undefined }): void {
        const snapshot = this.store.current();
        if (snapshot?.snapshotId !== report.snapshotId || snapshot.storyContractVersion !== 6 || snapshot.flow?.status !== 'ready' || !('mermaid' in snapshot.flow.diagram)) return;
        if (report.reportVersion !== 1 || report.diagramHash !== snapshot.flow.diagramHash || report.viewIndex === undefined || report.reason === undefined) return;
        if (report.viewIndex > (snapshot.flow.diagram.views?.length ?? 0)) return;
        if (report.missingId !== undefined && !snapshot.flow.diagram.nodes.some((node) => node.id === report.missingId)
            && !snapshot.flow.diagram.edges.some((edge) => 'id' in edge && edge.id === report.missingId && (edge.viewIndex === undefined || edge.viewIndex === report.viewIndex))) return;
        this.store.setFlow(report.snapshotId, { status: 'unavailable', reason: snapshotLocale(snapshot) === 'ru'
            ? 'Не удалось отобразить архитектурную схему. Описание, блоки и дифф доступны.'
            : 'Could not display the architecture diagram. The description, blocks and diff remain available.' });
    }

    async retryDiagram(snapshotId: string): Promise<void> {
        const snapshot = this.store.current();
        if (snapshot?.snapshotId !== snapshotId) throw new RpcFailure('bad_request', 'Этот разбор уже сменился. Откройте текущий результат.');
        if (this.store.read().phase === 'reading') throw new RpcFailure('bad_request', 'Сейчас готовится новый разбор. Дождитесь описания.');
        if (snapshot.flow?.status !== 'unavailable' && !(snapshot.storyContractVersion === 6 && snapshot.flow?.status === 'ready')) return;
        if (snapshot.storyContractVersion !== 6) {
            const diff = await this.ensureDiff(snapshot.diffId);
            this.startSkeleton(diff, snapshotLocale(snapshot));
            return;
        }
        this.store.setGenerationStatus('running');
        this.store.setFlow(snapshotId, { status: 'pending', taskId: null, round: 0, requests: [], contexts: [], missing: [] });
    }

    cancelGeneration(generationId: string): void {
        if (this.store.generation()?.id !== generationId) throw new RpcFailure('bad_request', 'Подготовка уже сменилась. Обновите экран.');
        this.store.setGenerationStatus('cancelled');
        this.cancelOpenRouteTasks();
        for (const task of this.queue.listTasks()) if (task.type === 'route.diagram' && (task.status === 'queued' || task.status === 'leased')) this.queue.cancel(task.id);
        const current = this.store.current();
        const snapshot = current?.snapshotId === this.store.generation()?.snapshotId ? current : null;
        const updates = new Map<string, RouteStopStatusUpdate>();
        for (const file of snapshot?.stops.flatMap((block) => block.guidedFiles ?? []) ?? []) {
            if (file.explanation === null) updates.set(file.fileId, { status: 'failed', note: 'Подготовка остановлена.' });
        }
        if ((snapshot?.storyContractVersion ?? 0) >= 5) this.store.setFileStatuses(updates);
        if (snapshot?.flow?.status === 'pending') this.store.setFlow(snapshot.snapshotId, { status: 'unavailable', reason: 'Подготовка схемы остановлена.' });
        this.store.fail('Подготовка остановлена. Готовые материалы сохранены.', null);
    }

    /**
     * Какие стопы плана заполняет задача; `null` — задача не из текущей генерации.
     * Наружу это нужно диагностике и тестам: в самой задаче плановые номера едут текстом промпта.
     */
    stopsOfTask(taskId: number): number[] | null {
        return this.store.bindings().get(taskId)?.planIndexes ?? null;
    }

    diffIdForTask(taskId: number): string | null {
        return this.store.bindings().get(taskId)?.diffId ?? null;
    }

    /**
     * Fail-closed приёмка результата генеративной задачи (зовётся очередью внутри транзакции
     * `complete`). Чужие типы задач возвращают `null` — приёмка `echo` не меняется.
     */
    acceptResult(task: TaskRecord, result: string): TaskResultAcceptance | null {
        if (task.type === 'route.diagram') return { kind: 'rejected', errors: ['Legacy diagram task stopped. Use worker next for the current preparation.'] };
        if (task.type === 'route.skeleton' || (task.type === 'route.prepare' && this.store.bindings().get(task.id)?.kind === 'skeleton')) {
            return this.acceptSkeleton(task, result);
        }
        if (task.type === 'route.section' || task.type === 'route.prepare') {
            return this.acceptSection(task, result);
        }
        return null;
    }

    private acceptSkeleton(task: TaskRecord, result: string): TaskResultAcceptance {
        const binding = this.store.bindings().get(task.id);
        if (binding?.kind !== 'skeleton') {
            return { kind: 'rejected', errors: [STALE_GENERATION] };
        }

        // Снапшота ещё нет, и итерацию задачи знает только её привязка: после рестарта сервера
        // взять «активную» значило бы принять план, читанный по другому диффу.
        const diff = binding.diffId === null ? null : this.diffOf(binding.diffId);
        if (diff === null) {
            return this.deferUntilDiff();
        }

        const locale = this.skeletonLocale();
        const parsed = readCheckpoint(result);
        if (!parsed.ok) return { kind: 'rejected', errors: parsed.errors };
        const overview = parsed.value.body.overview;
        if (overview === undefined) return { kind: 'rejected', errors: ['The first checkpoint needs overview with architecture, blocks and every changed file assigned.'] };
        const validation = validateArchitectureOverview(JSON.stringify(internalEvidence(overview)), diff);
        if (!validation.ok) return { kind: 'rejected', errors: validation.errors };
        const skeleton = validation.value;
        const part = checkIndividualFiles(parsed.value.files, diff, skeleton.stops);
        for (const filling of part.files) {
            const block = skeleton.stops.find((entry) => entry.planIndex === filling.planIndex);
            if (block !== undefined) block.guidedFiles = block.guidedFiles?.map((file) => filling.guidedFiles?.find((ready) => ready.fileId === file.fileId) ?? file);
        }
        const provenance = provenanceOf(this.registry.status(), locale);
        return {
            kind: 'accepted',
            receipt: partialReceipt(part),
            persist: () => {
                this.store.recordFileOutcome(task.id, storedFileOutcome(part, diff));
                const previous = this.store.current();
                if (skeleton.storyContractVersion === 6 && previous?.diffId === diff.diffId && previous.storyContractVersion !== 6) {
                    const files = new Map(previous.stops.flatMap((block) => block.guidedFiles ?? []).filter((file) => file.explanation !== null).map((file) => [file.fileId, file]));
                    for (const block of skeleton.stops) block.guidedFiles = block.guidedFiles?.map((file) => files.get(file.fileId) ?? file);
                }
                const snapshotId = randomUUID();
                this.store.acceptSkeleton({
                    skeleton,
                    presentation: 'story',
                    diff,
                    provenance,
                    snapshotId,
                    previousSnapshotId: previous?.snapshotId ?? null,
                });
            },
            onCommitted: () => { this.reconcile(); },
        };
    }

    private acceptSection(task: TaskRecord, result: string): TaskResultAcceptance {
        const snapshot = this.store.read().snapshot;
        const binding = this.store.bindings().get(task.id);
        if (snapshot === null || binding?.kind !== 'section') {
            return { kind: 'rejected', errors: [STALE_GENERATION] };
        }

        const diff = this.diffOf(snapshot.diffId);
        if (diff === null) {
            return this.deferUntilDiff();
        }

        const locale = snapshotLocale(snapshot);
        const parsed = readCheckpoint(result);
        if (!parsed.ok) return { kind: 'rejected', errors: parsed.errors };
        const split = parsed.value;
        const requireFlow = snapshot.flow?.status === 'pending' && snapshot.flow.taskId === task.id;
        const checked = validateArchitectureCheckpoint(split.structure, snapshot, diff, binding.assignment, this.store.flowBeforeRetry(snapshot.snapshotId), requireFlow, true);
        if (!checked.ok) return { kind: 'rejected', errors: checked.errors };
        const provenance = provenanceOf(this.registry.status(), locale);
        const part = checkIndividualFiles(split.files, diff, checked.value.overview?.stops ?? snapshot.stops, binding.assignment);
        return { kind: 'accepted', receipt: partialReceipt(part), persist: () => {
            this.store.recordFileOutcome(task.id, storedFileOutcome(part, diff));
            this.store.applyCheckpoint(checked.value.overview, part.files, provenance, checked.value.overview === undefined ? undefined : snapshot.reviewRevision);
        }, onCommitted: () => { this.reconcile(); } };
    }

    /**
     * Диффа в памяти нет — проверить результат нечем: это временный сбой сервера (рестарт посреди
     * генерации, сорвавшийся прогрев), а не ошибка модели, поэтому отказ бюджет не тратит.
     * Заодно будим загрузку диффа: без неё повтор упёрся бы в ту же стену.
     */
    private deferUntilDiff(): TaskResultAcceptance {
        this.warmupInBackground();
        return { kind: 'deferred', errors: [DIFF_NOT_READY] };
    }

    /**
     * Сверка состояния маршрута с состоянием очереди: статусы стопов, постановка недостающих
     * секций, переходы в `ready`/`failed`. Идемпотентна, поэтому зовётся на любое изменение
     * очереди; повторный вход (постановка задачи будит подписчиков) откладывается на новый проход.
     */
    private reconcile(): void {
        if (this.isClosed()) {
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
            // Сверка живёт в подписчике очереди: её исключение убило бы чужую операцию.
            const message = error instanceof Error ? error.message : String(error);
            process.stderr.write(`sherpa-server: сверка маршрута не прошла: ${message}\n`);
        } finally {
            this.reconciling = false;
        }
    }

    /** Чтение флагов методом, а не полем: иначе сужение типов прячет их изменения из чужих вызовов. */
    private isClosed(): boolean {
        return this.closed;
    }

    private needsAnotherPass(): boolean {
        return this.reconcileAgain && !this.closed;
    }

    private reconcileOnce(): void {
        if (this.upgradingDiff !== null || this.store.generation()?.status === 'cancelled') return;
        this.cancelOrphanRouteTasks();

        const state = this.store.read();
        if (state.snapshot !== null && state.phase !== 'reading') this.reconcileDiagram(state.snapshot);
        if (state.phase === 'reading') {
            this.reconcileSkeleton();
            return;
        }
        if (state.phase !== 'filling' || state.snapshot === null) {
            // `none`/`failed`/`ready` — автомат стоит: его двигает только ручка `generate`.
            return;
        }

        const snapshot = state.snapshot;
        if (snapshot.storyContractVersion !== 6) {
            const diff = this.diffOf(snapshot.diffId);
            if (diff === null) this.awaitOrAbandonDiff(snapshot.diffId);
            else this.startSkeleton(diff, snapshotLocale(snapshot));
            return;
        }
        this.reconcileAllFiles(snapshot);
    }

    /** Один проход по всем блокам; неполный результат продолжает тот же список оставшихся файлов. */
    private reconcileAllFiles(snapshot: RouteSnapshot): void {
        const assignments = new Map<string, TaskRecord>();
        for (const { record, binding } of this.routeTasks()) for (const file of binding.assignment?.files ?? []) assignments.set(file, record);
        const corrections = this.store.fileCorrections();
        const exhausted = new Set(corrections.filter((entry) => entry.attempts >= 3 || assignments.get(entry.path)?.status === 'failed').map((entry) => entry.path));
        const unscheduledCorrections = corrections.filter((entry) => { const task = assignments.get(entry.path); return !exhausted.has(entry.path) && (task === undefined || task.status === 'done'); });
        const pending: string[] = [];
        const targets: number[] = [];
        const updates = new Map<string, RouteStopStatusUpdate>();
        const strings = routeStrings(snapshotLocale(snapshot));
        for (const block of snapshot.stops) {
            for (const file of block.guidedFiles ?? []) {
                if (exhausted.has(file.path)) {
                    updates.set(file.fileId, { status: 'failed', note: 'Пояснение требует отдельного повтора.' });
                    continue;
                }
                if (file.explanation !== null && !(file.status === 'queued' && file.failure != null)
                    && !corrections.some((entry) => entry.path === file.path)) continue;
                const task = assignments.get(file.path);
                if (task === undefined || task.status === 'done') {
                    pending.push(file.path);
                    if (!targets.includes(block.planIndex)) targets.push(block.planIndex);
                    updates.set(file.fileId, { status: 'queued' });
                } else updates.set(file.fileId, stopStatusOf(task, strings));
            }
        }
        this.store.setFileStatuses(updates);
        if (pending.length > 0 || unscheduledCorrections.length > 0) {
            const diff = this.diffOf(snapshot.diffId);
            if (diff === null) { this.awaitOrAbandonDiff(snapshot.diffId); return; }
            const assignment = { files: [...new Set([...pending, ...unscheduledCorrections.map((entry) => entry.path)])], introduction: false };
            const input = this.payload.sectionTask({ diff, meta: this.meta, locale: snapshotLocale(snapshot), version: 6,
                snapshotId: snapshot.snapshotId, ...(snapshot.reviewRevision === undefined ? {} : { reviewRevision: snapshot.reviewRevision }),
                introduction: snapshot.summary, introductionEvidence: snapshot.summaryEvidence, flow: snapshot.flow, assignment },
                targets, snapshot.stops, this.store.stopIntents());
            this.enqueueRouteTask('section', snapshot.diffId, targets, { ...input, instructions: input.instructions + (corrections.length === 0 ? '' : `\nCorrections still needed: ${JSON.stringify(corrections)}`) }, assignment);
            return;
        }
        if (corrections.some((entry) => !exhausted.has(entry.path))) return;
        const current = this.store.current();
        if (current?.stops.every((block) => block.status === 'ready')) this.store.markReady();
        else if (!current?.stops.flatMap((block) => block.guidedFiles ?? []).some((file) => file.status === 'queued' || file.status === 'filling')) this.store.fail('Часть пояснений не готова. Повторите незавершённый блок.', null);
    }

    /** Повтор схемы — обычная подготовка с требованием вернуть архитектуру. */
    private reconcileDiagram(snapshot: RouteSnapshot): void {
        const flow = snapshot.flow;
        if (flow?.status !== 'pending') return;
        const unavailable = () => { this.store.setFlow(snapshot.snapshotId, { status: 'unavailable', reason: snapshotLocale(snapshot) === 'ru'
            ? 'Схема недоступна. Описание и файлы сохранены; повторите построение.'
            : 'Architecture unavailable. The explanation and files are saved; retry preparation.' }); };
        if (snapshot.storyContractVersion !== 6) { unavailable(); return; }
        if (flow.taskId !== null) {
            const task = this.queue.getTask(flow.taskId);
            if (task === null || task.status === 'failed' || task.status === 'cancelled' || task.status === 'done') unavailable();
            return;
        }
        const diff = this.diffOf(snapshot.diffId);
        if (diff === null) { unavailable(); return; }
        const input = this.payload.sectionTask({ diff, meta: this.meta, locale: snapshotLocale(snapshot), version: 6,
            snapshotId: snapshot.snapshotId, ...(snapshot.reviewRevision === undefined ? {} : { reviewRevision: snapshot.reviewRevision }),
            introduction: snapshot.summary, introductionEvidence: snapshot.summaryEvidence,
            flow: this.store.flowBeforeRetry(snapshot.snapshotId) ?? undefined }, [], snapshot.stops, this.store.stopIntents());
        this.store.enqueueTask(this.queue, { ...input, instructions: `Help repair or refine the PR architecture. Choose your research using ordinary PR/code tools. Return update.flow and any block changes needed to preserve architecture-block-file links. You may correct files in the same checkpoint.\n${input.instructions}` },
            { kind: 'section', diffId: snapshot.diffId, planIndexes: [] },
            (id) => { this.store.setFlow(snapshot.snapshotId, { ...flow, taskId: id }); });
    }

    /** Фаза `reading`: живём ровно до судьбы задачи скелета. */
    private reconcileSkeleton(): void {
        const skeletons = this.routeTasks().filter((task) => task.binding.kind === 'skeleton');
        if (skeletons.some(({ record }) => record.status === 'queued' || record.status === 'leased')) {
            return;
        }

        const last = skeletons.at(-1)?.record;
        if (last === undefined) {
            // Рестарт сервера застал фазу без задачи — ставим скелет заново.
            this.restartSkeletonTask(skeletons.length, null);
            return;
        }
        if (last.status === 'failed') {
            this.store.fail(skeletonFailureMessage(last, routeStrings(this.skeletonLocale())), last.result);
            return;
        }
        if (last.status === 'cancelled') {
            this.store.cancelSkeleton();
            return;
        }
        // `done`, а фаза всё ещё `reading`: применить принятый результат не вышло (сервер умер
        // между приёмкой и записью снапшота либо запись сорвалась). Принятого результата больше
        // нет — план строится заново.
        this.restartSkeletonTask(skeletons.length, last.result);
    }

    /**
     * Перепостановка плана после сорвавшегося применения. Число уже поставленных задач считается
     * по привязкам, а они живут ровно одну генерацию, — поэтому счётчик не нужно ни хранить,
     * ни сбрасывать: `generate` стирает привязки и даёт полный набор попыток заново.
     */
    private restartSkeletonTask(alreadyEnqueued: number, rawOutput: string | null): void {
        if (alreadyEnqueued >= MAX_SKELETON_TASKS) {
            this.store.fail(
                routeStrings(this.skeletonLocale()).skeletonNotApplied(MAX_SKELETON_TASKS),
                rawOutput,
            );
            return;
        }
        this.startSkeletonTask();
    }

    /** Новая генерация: прежние задачи отменяются, живой снапшот остаётся до приёмки нового. */
    private startSkeleton(diff: PrDiff, locale: Locale): void {
        this.generation = diff;
        // Язык — в хранилище, а не в поле: задачу скелета может принять уже следующий процесс.
        this.cancelOpenRouteTasks();
        this.store.clearBindings();
        this.store.beginSkeleton({ locale, presentation: 'story', version: 6, commit: diff.headCommit, diffId: diff.diffId });
        // Payload прошлой генерации больше никому не нужен: её задачи только что отменены.
        this.payload.beginGeneration();
        if (diff.files.length === 0) {
            const summary = locale === 'ru' ? 'В этой версии изменений нет.' : 'There are no changes in this version.';
            this.store.acceptSkeleton({
                skeleton: { storyContractVersion: 6, summary,
                    summaryEvidence: { claims: [{ sources: [], limitation: locale === 'ru'
                        ? 'Сохранённый снимок не содержит изменённых файлов.' : 'The saved snapshot contains no changed files.' }] },
                    flow: { status: 'not_applicable', reason: locale === 'ru'
                        ? 'Нет изменений для архитектурной схемы.' : 'There are no changes to diagram.' },
                    stops: [], tourOrder: [], intents: new Map() },
                presentation: 'story', diff, provenance: provenanceOf(this.registry.status(), locale),
                snapshotId: randomUUID(), previousSnapshotId: this.store.current()?.snapshotId ?? null,
            });
            this.store.markReady();
            return;
        }
        this.startSkeletonTask();
    }

    private startSkeletonTask(): void {
        // Перезапуск использует сохранённую цель, даже если active head уже сменился.
        const pinnedId = this.store.generationDiffId() ?? [...this.store.bindings().values()].find((binding) => binding.kind === 'skeleton')?.diffId;
        const diff = this.generation ?? (pinnedId == null ? null : this.diffOf(pinnedId));
        if (diff === null) {
            if (pinnedId != null) this.awaitOrAbandonDiff(pinnedId);
            else this.store.fail('Снимок подготовки неизвестен. Сохранённый текст доступен; повторите построение.', null);
            return;
        }
        this.generation ??= diff;
        this.enqueueRouteTask(
            'skeleton',
            diff.diffId,
            [],
            this.payload.skeletonTask({
                diff,
                meta: this.meta,
                locale: this.skeletonLocale(),
                version: 6,
            }),
        );
    }

    /**
     * Постановка задачи маршрута вместе с её привязкой к стопам. Сверка на время постановки
     * приглушена: между `enqueue` и записью привязки задача выглядит чужой, и сверка,
     * разбуженная постановкой, поставила бы дубль. Две записи идут разными транзакциями
     * (вложенных у `node:sqlite` нет), поэтому смерть процесса между ними оставляет сироту —
     * её ловит `cancelOrphanRouteTasks`.
     */
    private enqueueRouteTask(
        kind: RouteTaskBinding['kind'],
        diffId: HostId,
        planIndexes: readonly number[],
        input: EnqueueInput,
        assignment?: SectionAssignment,
    ): void {
        const outer = this.reconciling;
        this.reconciling = true;
        try {
            this.store.enqueueTask(this.queue, input, { kind, diffId, planIndexes: [...planIndexes], ...(assignment === undefined ? {} : { assignment }) });
        } finally {
            this.reconciling = outer;
        }

        if (outer) {
            this.reconcileAgain = true;
        } else {
            this.reconcile();
        }
    }

    private cancelOpenRouteTasks(): void {
        for (const { record } of this.routeTasks()) {
            if (record.status === 'queued' || record.status === 'leased') {
                this.queue.cancel(record.id);
            }
        }
    }

    /**
     * Задача маршрута без привязки — сирота: процесс умер между постановкой и записью привязки
     * (две транзакции подряд, атомарности между ними нет). Такую задачу автомат не видит,
     * а очередь всё равно выдала бы её агенту — поэтому открытые сироты отменяются.
     */
    private cancelOrphanRouteTasks(): void {
        const bindings = this.store.bindings();
        for (const record of this.queue.listTasks()) {
            const open = record.status === 'queued' || record.status === 'leased';
            if (open && record.type !== 'route.diagram' && record.type.startsWith(ROUTE_TASK_PREFIX) && !bindings.has(record.id)) {
                this.queue.cancel(record.id);
            }
        }
    }

    private hasOpenRouteTask(): boolean {
        return this.routeTasks().some(
            ({ record }) => record.status === 'queued' || record.status === 'leased',
        );
    }

    /** Задачи маршрута текущей генерации со своими привязками, в порядке постановки. */
    private routeTasks(): { record: TaskRecord; binding: RouteTaskBinding }[] {
        const bindings = this.store.bindings();
        if (bindings.size === 0) {
            return [];
        }

        // `listTasks` заодно лениво возвращает в очередь задачи с протухшей арендой: молча
        // умерший агент превращается в снова заполняемые стопы без единого таймера.
        return this.queue.listTasks().flatMap((record) => {
            const binding = bindings.get(record.id);
            return binding === undefined ? [] : [{ record, binding }];
        });
    }

    /**
     * Язык генерации, которая ставит план: тот, что уехал в её промпт. Рестарт сервера его не
     * теряет — записи в хранилище нет только у БД, где генерации ещё не было.
     */
    private skeletonLocale(): Locale {
        return this.store.generationLocale() ?? this.resolveLocale(undefined);
    }

    /** Лестница языка генерации: запрос вкладки → настройки → подсказка агента → русский. */
    private resolveLocale(requested: Locale | undefined): Locale {
        const status = this.registry.status();
        return resolveGenerationLocale({
            requested,
            setting: this.settings?.read().generationLocale,
            agentLang: status.kind === 'never' ? undefined : status.lang,
        });
    }

    /** Патч итерации потерян — причина на языке маршрута, которого это касается. */
    private lostDiffMessage(diffId: HostId): string {
        const snapshot = this.store.read().snapshot;
        const locale = snapshot === null ? this.skeletonLocale() : snapshotLocale(snapshot);
        return routeStrings(locale).lostDiff(diffId);
    }

    /** Дифф итерации: из памяти процесса, иначе из локального хранилища патчей. */
    private diffOf(diffId: HostId): PrDiff | null {
        for (const candidate of [this.generation, this.activeDiff]) {
            if (candidate?.diffId === diffId) {
                return candidate;
            }
        }
        return this.iterations?.get(diffId)?.diff ?? null;
    }

    /**
     * Делает дифф итерации доступным синхронно. Промах лечится ровно одним способом: спросить
     * у хоста активную итерацию — вдруг спрашивают про неё, а патча ещё нет в хранилище
     * (накопленная БД, в которой патчей итераций ещё нет). Прошлую итерацию целиком хост не отдаёт (`getDiff` принимает только
     * срез), поэтому дальше остаётся честный отказ.
     */
    private async ensureDiff(diffId: HostId): Promise<PrDiff> {
        const known = this.diffOf(diffId);
        if (known !== null) {
            return known;
        }

        await this.loadDiff();
        const loaded = this.diffOf(diffId);
        if (loaded === null) {
            throw new RpcFailure('host_unavailable', this.lostDiffMessage(diffId));
        }
        return loaded;
    }

    /**
     * Патча итерации снапшота нет ни в памяти, ни в хранилище. Пока активный дифф не загружен,
     * ждём прогрева — он и есть единственный шанс промах закрыть. Активный уже известен и это
     * другая итерация — значит патч потерян навсегда, и генерация останавливается с причиной:
     * иначе сверка гоняла бы прогрев по кругу, не давая дышать процессу.
     */
    private awaitOrAbandonDiff(diffId: HostId): void {
        if (this.activeDiff === null) {
            this.warmupInBackground();
            return;
        }
        this.store.fail(this.lostDiffMessage(diffId), null);
    }

/**
     * Свежий дифф активной итерации вместе с шапкой PR и списком итераций. Патч кладётся в
     * хранилище синхронно после ответа: снапшот, построенный на этой итерации, обязан остаться
     * читаемым после следующего пуша (docs/spec.md), а генерация не может стартовать раньше записи.
     *
     * На процесс не кэшируется — итерацию генерации держит `generationDiff`; параллельные
     * вызовы делят один запрос, чтобы прогрев и ручка `generate` не ходили в хост дважды.
     */
    private async loadDiff(): Promise<PrDiff> {
        const host = this.host;
        if (host === null) {
            throw new RpcFailure('no_review_host', 'Импортируйте снимок кода перед подготовкой разбора.');
        }

        // Промис держим локально: `finally` внутри обнуляет поле, и читать его после было бы поздно.
        const load = (this.diffLoad ??= (async () => {
            try {
                // Шапка PR — украшение payload (заголовок, автор, ветки), а список итераций нужен
                // ради меты активной: отказ любого из них маршрут не рушит.
                const [diff, meta, iterations] = await Promise.all([
                    host.getDiff(),
                    host.getPr().then(
                        (value) => value,
                        () => null,
                    ),
                    host.listIterations().then(
                        (value) => value,
                        (error: unknown): Iteration[] => {
                            process.stderr.write(
                                `sherpa-server: список итераций не получен: ${messageOf(error)}\n`,
                            );
                            return [];
                        },
                    ),
                ]);
                this.meta = meta;
                this.remember(diff, iterations);
                this.activeDiff = diff;
                return diff;
            } catch (error) {
                if (error instanceof RpcFailure) {
                    throw error;
                }
                throw new RpcFailure('host_unavailable', `Хост-адаптер не отдал дифф: ${messageOf(error)}`);
            } finally {
                // Неудача не должна залипать на весь процесс, а успех — прятать следующий пуш.
                this.diffLoad = null;
            }
        })());

        return load;
    }

    /**
     * Патч активной итерации в хранилище. Мета берётся из списка хоста, а когда он её не назвал
     * (список не отдан или автор запушил между двумя запросами) — восстанавливается из самого
     * диффа: патч обязан сохраниться в любом случае, статус и время починит ближайший `sync`.
     */
    private remember(diff: PrDiff, iterations: readonly Iteration[]): void {
        const store = this.iterations;
        if (store === null) {
            return;
        }

        const listed = iterations.find((candidate) => candidate.diffId === diff.diffId);
        if (listed === undefined) {
            process.stderr.write(
                `sherpa-server: хост не назвал итерацию ${diff.diffId} — её мета восстановлена из диффа\n`,
            );
        }
        const iteration: Iteration = listed ?? {
            diffId: diff.diffId,
            baseCommit: diff.baseCommit,
            headCommit: diff.headCommit,
            createdAt: new Date().toISOString(),
            status: 'active',
        };
        try {
            store.upsert(diff, iteration);
        } catch (error) {
            process.stderr.write(
                `sherpa-server: патч итерации ${diff.diffId} не сохранён: ${messageOf(error)}\n`,
            );
        }
    }
}

/**
 * Язык снапшота: `provenance.locale` проставляется приёмкой скелета, а `null` несут снапшоты
 * старого формата — они русские.
 */
function snapshotLocale(snapshot: RouteSnapshot): Locale {
    return snapshot.provenance.locale ?? 'ru';
}

function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/** Сервер ещё не получил дифф: проверять результат нечем, модели остаётся повторить вызов. */
const DIFF_NOT_READY =
    'The server has not loaded the diff of this pull request yet and cannot validate the result. ' +
    'Wait a few seconds and call `complete` again with the same result.';

/** Задача осталась от отменённой или перезапущенной генерации: класть её результат некуда. */
const STALE_GENERATION =
    'The route generation this task belongs to is no longer running: it was restarted or cancelled. ' +
    'Call `worker next` and work on the task it gives you.';

/** Статус стопа по состоянию задачи, которая его заполняет; пометки — на языке снапшота. */
function stopStatusOf(task: TaskRecord, strings: RouteStrings): RouteStopStatusUpdate {
    switch (task.status) {
        case 'queued':
            return { status: 'queued' };
        case 'leased':
            return { status: 'filling' };
        case 'cancelled':
            return { status: 'failed', note: strings.stopFillCancelled };
        case 'failed':
            return { status: 'failed', note: strings.stopFillFailed(task.failReason) };
        default:
            // Задача закрыта успешно, а слот пуст: модель сдала результат без этого стопа.
            return { status: 'failed', note: strings.stopMissingInResult };
    }
}

/**
 * Причина провала генерации для красной карточки (docs/spec.md) — одно предложение
 * на языке маршрута.
 */
function skeletonFailureMessage(task: TaskRecord, strings: RouteStrings): string {
    return strings.skeletonFailed((task.failReason ?? '').trim());
}

function provenanceOf(status: WorkerStatus, locale: Locale): RouteProvenance {
    if (status.kind === 'never') {
        return { harness: null, model: null, locale };
    }
    return { harness: status.harness ?? null, model: status.model ?? null, locale };
}

function partialReceipt(part: { accepted: string[]; errors: { path: string; errors: string[] }[] }): TaskCompleteResponse {
    return part.errors.length === 0 ? { kind: 'accepted', message: 'Checkpoint saved. Continue with the next task.' }
        : { kind: 'partial', message: `Checkpoint saved; accepted files: ${part.accepted.join(', ')}. Corrections needed: ${JSON.stringify(part.errors)}. Continue with the next task.`, accepted: part.accepted, errors: part.errors };
}

/** Ошибки без адреса в инвентаре остаются в квитанции, но не создают фиктивную задачу файла. */
function storedFileOutcome(part: { accepted: string[]; errors: { path: string; errors: string[] }[] }, diff: PrDiff) {
    const known = new Set(diff.files.map((file) => file.path));
    const errors = new Map<string, string[]>();
    for (const item of part.errors) if (known.has(item.path)) errors.set(item.path, [...(errors.get(item.path) ?? []), ...item.errors]);
    return { accepted: part.accepted, errors: [...errors].map(([path, messages]) => ({ path, errors: messages })) };
}

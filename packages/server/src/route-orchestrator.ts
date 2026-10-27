import { randomUUID } from 'node:crypto';
import { FlowCoordinator } from './flow-coordinator.js';

import type {
    HostId,
    Iteration,
    Locale,
    PrDiff,
    PrMeta,
    ReviewHost,
    ReviewSource,
    RouteCarriedZeroReason,
    RouteProvenance,
    RouteSnapshot,
    Thread,
    UiRouteFillStopResponse,
    UiRouteGenerateResponse,
    WorkerStatus,
} from '@sherpa/protocol';

import { validateStorySkeleton, validateStorySection } from './story.js';
import { RpcFailure } from './errors.js';
import { resolveGenerationLocale } from './generation-locale.js';
import type { IterationStore } from './iteration-store.js';
import type { IterationMap } from './iterations/index.js';
import { buildIterationMap, identityMap } from './iterations/index.js';
import type { ProgressStore } from './progress-store.js';
import type { EnqueueInput, TaskQueue, TaskRecord, TaskResultAcceptance } from './queue.js';
import { RoutePayloadWriter } from './route-payload.js';
import type { RouteRegenerationContext } from './route-regeneration.js';
import type {
    RouteStopStatusUpdate,
    RouteStore,
    RouteTaskBinding,
    SnapshotAcceptance,
} from './route-store.js';
import type { RouteStrings } from './route/index.js';
import { routeStrings, validateSection, validateSkeleton } from './route/index.js';
import type { SettingsStore } from './settings-store.js';
import type { SharedPayloadStore } from './shared-payload.js';
import type { WorkerRegistry } from './worker-registry.js';

/**
 * Оркестрация маршрута: конечный автомат «нет маршрута → скелет → секции → готово».
 *
 * Один источник истины о том, что делать дальше, — состояние `RouteStore` рядом с состоянием
 * очереди. Переходы считаются сверкой (`reconcile`), а не запоминаются событиями: сверка
 * идемпотентна, поэтому рестарт сервера посреди генерации, смерть агента и вытеснение сессии
 * лечатся сами — ничего специального для них не кодится (docs/design/SPEC-elements.md §4.4).
 *
 * Приёмка результата подключается в очередь синхронным приёмщиком: валидация — внутри
 * транзакции `complete` (fail-closed, отказ оставляет аренду модели), запись принятого —
 * после её коммита.
 */

/** Пороги маршрута и укрупнение секций: по замеру латентности батч оставлен в одну остановку. */
export interface RouteConfig {
    /** Изменённых строк (additions + deletions) не больше — PR малый, маршрут не нужен (docs/architecture.md §7.6). */
    readonly smallPrMaxChangedLines: number;
    /** Сколько стопов плана уходит в одну задачу `route.section`. */
    readonly sectionBatchSize: number;
}

export const DEFAULT_ROUTE_CONFIG: RouteConfig = {
    smallPrMaxChangedLines: 40,
    sectionBatchSize: 1,
};

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

/** Часть `ProgressStore`, которая нужна оркестратору: перенос отметок на новый снапшот. */
export type StopProgressCarry = Pick<ProgressStore, 'carryStopsInTransaction' | 'hasViewedMarks'>;

/**
 * Идущая генерация: её итерация и всё, что нужно перенести прогресс на её снапшот.
 * Карта строится заранее (интердифф — сетевой вызов), потому что приёмщик результата синхронен.
 */
interface GenerationContext {
    readonly diff: PrDiff;
    /** Снапшот, бывший текущим на старте генерации; null — маршрут строится впервые. */
    readonly previousSnapshotId: string | null;
    /** Отображение строк «итерация прошлого снапшота → итерация генерации»; null — интердиффа нет. */
    readonly map: IterationMap | null;
    /** Тот же срез патчами: он едет модели контекстным файлом. */
    readonly interdiff: PrDiff | null;
    /** Треды PR на старте генерации; null — прошлого снапшота нет, хост отказал или был рестарт. */
    readonly threads: readonly Thread[] | null;
}

export interface RouteOrchestratorOptions {
    readonly presentation?: 'legacy' | 'story' | undefined;
    readonly store: RouteStore;
    readonly queue: TaskQueue;
    readonly registry: WorkerRegistry;
    /** Ревью-хост PR; `null` — маршрут этому серверу негде взять. */
    readonly host: ReviewSource | null;
    /** Прежний режим ревью может добавить контекст тредов отдельно. */
    readonly threads?: Pick<ReviewHost, 'getThreads'> | null;
    /** Каталог, которым единолично владеет `RoutePayloadWriter` (`routePayloadDirOf`). */
    readonly payloadDir: string;
    /** Общий контекст PR: методичка и дифф едут по стабильному пути, а не копией на задачу. */
    readonly shared: SharedPayloadStore;
    /**
     * Прогресс чтения: отметки остановок нового снапшота ставит перенос при его приёмке.
     * `null` — переносить некуда (тесты без прогресса).
     */
    readonly progress?: StopProgressCarry | null;
    /** Локальное хранилище патчей итераций; `null` — сохранять дифф генерации некуда (тесты без БД). */
    readonly iterations?: IterationStore | null;
    /**
     * Глобальные настройки UI: из них берётся язык генерации, когда его не назвал запрос.
     * `null` — настроек нет, лестница падает на подсказку агента и русский.
     */
    readonly settings?: Pick<SettingsStore, 'read'> | null;
    readonly config?: Partial<RouteConfig>;
    /** Задержка прогрева после старта; в тестах прогрев зовётся явно (`warmup`). */
    readonly warmupDelayMs?: number;
}

export class RouteOrchestrator {
    private readonly flow: FlowCoordinator;
    private readonly presentation: 'legacy' | 'story';
    private readonly store: RouteStore;
    private readonly queue: TaskQueue;
    private readonly registry: WorkerRegistry;
    private readonly host: ReviewSource | null;
    private readonly threads: Pick<ReviewHost, 'getThreads'> | null;
    private readonly payload: RoutePayloadWriter;
    private readonly progress: StopProgressCarry | null;
    private readonly iterations: IterationStore | null;
    private readonly settings: Pick<SettingsStore, 'read'> | null;
    private readonly config: RouteConfig;
    private readonly warmupDelayMs: number;

    /**
     * Контекст генерации, идущей в этом процессе: приёмщик секций синхронный, а `getDiff`
     * и интердифф — сетевые вызовы. Итерация генерации фиксируется на старте и не меняется,
     * даже если автор запушит (генерация доходит до конца, снапшот
     * рождается уже stale).
     */
    private generation: GenerationContext | null = null;
    /**
     * Последний дифф активной итерации: с него начинается следующая генерация. Диффом идущей
     * он не становится — её итерацию называет привязка задачи, а после рестарта только она.
     */
    private activeDiff: PrDiff | null = null;
    /** Идущая загрузка активного диффа: параллельные вызовы делят один запрос к хосту. */
    private diffLoad: Promise<PrDiff> | null = null;
    /** Шапка PR для payload; `null` — хост её не отдал, маршрут строится по одному диффу. */
    private meta: PrMeta | null = null;

    private unsubscribeQueue: (() => void) | null = null;
    private unsubscribeWorker: (() => void) | null = null;
    private warmupTimer: NodeJS.Timeout | null = null;

    private closed = false;
    private reconciling = false;
    private reconcileAgain = false;

    constructor(options: RouteOrchestratorOptions) {
        this.flow = new FlowCoordinator({ store: options.store, queue: options.queue, host: options.host, dir: `${options.payloadDir}-flow`, shared: options.shared, loadDiff: (id) => this.ensureDiff(id) });
        this.presentation = options.presentation ?? 'legacy';
        this.store = options.store;
        this.queue = options.queue;
        this.registry = options.registry;
        this.host = options.host;
        // Старые тесты/клиенты передают полный адаптер; объяснение никогда не берёт его треды.
        this.threads = this.presentation === 'story' ? null : options.threads ?? (options.host !== null && 'getThreads' in options.host ? options.host as ReviewSource & Pick<ReviewHost, 'getThreads'> : null);
        this.payload = new RoutePayloadWriter({ payloadDir: options.payloadDir, shared: options.shared });
        this.progress = options.progress ?? null;
        this.iterations = options.iterations ?? null;
        this.settings = options.settings ?? null;
        this.config = resolveConfig(options.config);
        this.warmupDelayMs = options.warmupDelayMs ?? WARMUP_DELAY_MS;
    }

    /** Подписки автомата и разовый прогрев. Зовётся один раз при сборке сервера. */
    start(): void {
        this.flow.start();
        if (this.presentation === 'story' && this.store.generationPresentation() === 'story' && this.store.generationTaskEpoch() !== 2) {
            const phase = this.store.read().phase;
            if (phase === 'reading' || phase === 'filling' || this.hasOpenRouteTask()) {
                this.cancelOpenRouteTasks();
                this.store.clearBindings();
                this.store.fail('Формат рассказа обновлён. Сохранённый текст доступен; повторите построение.', null);
            }
        }
        this.unsubscribeQueue = this.queue.subscribeChanges(() => {
            this.reconcile();
        });
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
        this.flow.close();
        this.closed = true;
        this.unsubscribeQueue?.();
        this.unsubscribeWorker?.();
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

        this.store.setSmallPr(this.presentation === 'legacy' && isSmallPr(diff, this.config));
        if (this.store.read().smallPr) {
            return;
        }

        // Починка прерванной генерации идёт до автопостановки: фаза `filling` без задач — это
        // рестарт сервера, а не повод строить маршрут заново.
        this.reconcile();

        const phase = this.store.read().phase;
        // `failed` лечится только кнопкой: иначе сервер бесконечно бился бы о ту же стену.
        if (phase !== 'none' || this.registry.status().kind !== 'connected' || this.hasOpenRouteTask()) {
            return;
        }

        const context = await this.generationContextFor(diff);
        // Пока считался срез, генерацию мог начать соседний прогрев или ручка: второй старт
        // отменил бы её задачу и начал план заново.
        if (this.isClosed() || this.store.read().phase !== 'none' || this.hasOpenRouteTask()) {
            return;
        }
        // Автопостановку затеял сервер: локаль ему никто не называл, работает лестница.
        this.startSkeleton(context, this.resolveLocale(undefined));
    }

    /**
     * Ручка `review/route/generate`: запуск и перезапуск генерации. Из `ready` старый маршрут
     * остаётся читаемым до приёмки нового скелета, а его прогресс переезжает на новый снапшот
     * переносом при приёмке.
     *
     * `requestedLocale` — эффективный язык вкладки, которая нажала кнопку. Без него
     * язык выбирает лестница `resolveGenerationLocale`.
     */
    async generate(requestedLocale?: Locale): Promise<UiRouteGenerateResponse['outcome']> {
        if (this.host === null) {
            throw new RpcFailure(
                'no_review_host',
                'У этого PR нет хост-адаптера: маршрут строить не по чему.',
            );
        }

        const diff = await this.loadDiff();
        this.store.setSmallPr(this.presentation === 'legacy' && isSmallPr(diff, this.config));
        if (this.store.read().smallPr) {
            return 'small_pr';
        }

        const phase = this.store.read().phase;
        if (phase === 'reading' || phase === 'filling') {
            return 'already_running';
        }

        const context = await this.generationContextFor(diff);
        // Пока считался срез, генерацию мог начать прогрев или соседний запрос ручки.
        const phaseNow = this.store.read().phase;
        if (phaseNow === 'reading' || phaseNow === 'filling') {
            return 'already_running';
        }
        this.startSkeleton(context, this.resolveLocale(requestedLocale));
        return 'started';
    }

    /**
     * Точечное дозаполнение failed-стопа через штатную фазу `filling` и сверку. Якоря резолвятся
     * против диффа итерации снапшота: PR мог уйти вперёд, но дозаполняется старый маршрут.
     */
    async fillStop(snapshotId: string, planIndex: number): Promise<UiRouteFillStopResponse['outcome']> {
        if (this.host === null) {
            throw new RpcFailure('no_review_host', 'У этого PR нет хост-адаптера: маршрут строить не по чему.');
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
        await this.ensureDiff(state.snapshot.diffId);

        // Прогресс не чистим: незаполненный стоп нельзя отметить в UI, отметки остальных живут.
        this.store.beginStopFill(planIndex);
        this.reconcile();
        return 'started';
    }

    /**
     * Какие стопы плана заполняет задача; `null` — задача не из текущей генерации.
     * Наружу это нужно диагностике и тестам: в самой задаче плановые номера едут текстом промпта.
     */
    stopsOfTask(taskId: number): number[] | null {
        return this.store.bindings().get(taskId)?.planIndexes ?? null;
    }

    /**
     * Fail-closed приёмка результата генеративной задачи (зовётся очередью внутри транзакции
     * `complete`). Чужие типы задач возвращают `null` — приёмка `echo` не меняется.
     */
    acceptResult(task: TaskRecord, result: string): TaskResultAcceptance | null {
        if (task.type === 'route.diagram') return this.flow.acceptResult(task, result);
        if (task.type === 'route.skeleton') {
            return this.acceptSkeleton(task, result);
        }
        if (task.type === 'route.section') {
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
        const validation = this.store.generationPresentation() === 'story' ? validateStorySkeleton(result, diff, locale) : validateSkeleton(result, locale);
        if (!validation.ok) {
            return { kind: 'rejected', errors: validation.errors };
        }

        const skeleton = validation.value;
        const provenance = provenanceOf(this.registry.status(), locale);
        return {
            kind: 'accepted',
            onCommitted: () => {
                const previous = this.store.current();
                const snapshotId = randomUUID();
                // Перенос отметок здесь не считается: якорей у стопов ещё нет, а `carried` с нулём
                // прочитался бы баннером как «0 из 7». Числа появляются при заморозке (`markReady`).
                this.store.acceptSkeleton({
                    skeleton,
                    presentation: this.store.generationPresentation(),
                    diff,
                    provenance,
                    snapshotId,
                    previousSnapshotId: previous?.snapshotId ?? null,
                });
                // Кап генерации привязан к снапшоту, а не к задаче: id снапшота есть только здесь.
                this.store.setGenerationCap(snapshotId, this.payload.generationCap({ diff, meta: this.meta }));
                this.reconcile();
            },
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

        const generation = this.acceptanceContext(diff, snapshot.previousSnapshotId);
        // Секция говорит на языке скелета: снапшот целиком одноязычен.
        const locale = snapshotLocale(snapshot);
        const validation = snapshot.presentation === 'story'
            ? validateStorySection(result, binding.planIndexes, diff, locale, snapshot.stops, snapshot.storyContractVersion)
            : validateSection(result, snapshot.stops, binding.planIndexes, diff, {
            locale,
            map: generation.map,
            knownThreadIds: new Set((generation.threads ?? []).map((thread) => thread.id)),
        });
        if (!validation.ok) {
            return { kind: 'rejected', errors: validation.errors };
        }

        const fillings = validation.value;
        const provenance = provenanceOf(this.registry.status(), locale);
        return {
            kind: 'accepted',
            onCommitted: () => {
                this.store.applyFillings(fillings, provenance);
                this.reconcile();
            },
        };
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
        this.cancelOrphanRouteTasks();

        const state = this.store.read();
        if (state.phase === 'reading') {
            this.reconcileSkeleton();
            return;
        }
        if (state.phase !== 'filling' || state.snapshot === null) {
            // `none`/`failed`/`ready` — автомат стоит: его двигает только ручка `generate`.
            return;
        }

        const snapshot = state.snapshot;
        const strings = routeStrings(snapshotLocale(snapshot));
        const tasks = this.routeTasks();
        const sectionOf = new Map<number, TaskRecord>();
        for (const { record, binding } of tasks) {
            if (binding.kind !== 'section') {
                continue;
            }
            for (const planIndex of binding.planIndexes) {
                sectionOf.set(planIndex, record);
            }
        }

        const updates = new Map<number, RouteStopStatusUpdate>();
        const pending: number[] = [];
        for (const stop of snapshot.stops) {
            if (stop.tier === 'other' || stop.status === 'ready' || stop.status === 'failed') {
                continue;
            }

            const task = sectionOf.get(stop.planIndex);
            if (task === undefined) {
                pending.push(stop.planIndex);
                updates.set(stop.planIndex, { status: 'queued' });
                continue;
            }
            updates.set(stop.planIndex, stopStatusOf(task, strings));
        }
        this.store.setStopStatuses(updates);

        if (pending.length > 0) {
            this.enqueueSections(pending);
            return;
        }
        // Незакрытых секционных задач не осталось — снапшот можно замораживать
        // (провал отдельной секции фазу не роняет, стоп остаётся с `status: 'failed'`).
        const stops = this.store.read().snapshot?.stops ?? [];
        if (!stops.some((stop) => stop.status === 'queued' || stop.status === 'filling')) {
            if (snapshot.presentation === 'story' && stops.some((stop) => stop.status === 'failed')) {
                this.store.fail('Рассказ не завершён. Повторите построение.', null);
            } else {
                this.markReadyCarryingProgress();
            }
        }
    }

    /**
     * Заморозка снапшота вместе с переносом отметок остановок: якоря появляются только
     * с заполненными секциями, поэтому перенос считается здесь, а не на приёмке скелета.
     */
    private markReadyCarryingProgress(): void {
        const snapshot = this.store.read().snapshot;
        if (snapshot?.presentation === 'story') { this.store.markReady(); return; }
        const previousId = snapshot?.previousSnapshotId ?? null;
        const previous = previousId === null ? null : this.store.getSnapshot(previousId);
        if (snapshot === null || previous === null || this.progress === null) {
            this.store.markReady();
            return;
        }

        const diff = this.diffOf(snapshot.diffId);
        const map = diff === null ? null : this.acceptanceContext(diff, previousId).map;
        this.store.markReady((ready) => this.carryProgressInto(ready, previous, map));
    }

    /**
     * Контекст приёмки: карта, подготовленная стартом генерации, а после рестарта — из кэша
     * срезов. Пара «прошлый снапшот → итерация генерации» обязана совпасть, иначе карта чужая.
     */
    private acceptanceContext(diff: PrDiff, previousSnapshotId: string | null): GenerationContext {
        const prepared = this.generation;
        if (
            prepared !== null &&
            prepared.diff.diffId === diff.diffId &&
            prepared.previousSnapshotId === previousSnapshotId
        ) {
            return prepared;
        }
        // Контекст генерации потерян вместе с процессом: прошлый снапшот берётся по id, потому
        // что текущим к этому моменту может быть уже новый.
        return this.cachedContextFor(
            diff,
            previousSnapshotId === null ? null : this.store.getSnapshot(previousSnapshotId),
        );
    }

    /**
     * Перенос прогресса на снапшот внутри транзакции его записи. `carried` считает переносом
     * отмеченные остановки против остановок с якорями (баннер второго захода, docs/design/README.md §9):
     * синтетическое «Прочее» и незаполненные стопы перенос накрыть не может — им не место
     * в знаменателе. При нулевом переносе туда же едет его причина.
     */
    private carryProgressInto(
        snapshot: RouteSnapshot,
        previous: RouteSnapshot | null,
        map: IterationMap | null,
    ): SnapshotAcceptance {
        const progress = this.progress;
        const total = snapshot.stops.filter((stop) => stop.anchors.length > 0).length;
        if (previous === null || progress === null) {
            // Первый снапшот PR: переносить не от чего.
            return { carried: null };
        }

        const diff = this.diffOf(snapshot.diffId);
        if (map === null || diff === null) {
            process.stderr.write(
                `sherpa-server: перенос отметок невозможен: нет интердиффа ${previous.diffId}→${snapshot.diffId}\n`,
            );
            const keptBefore = snapshot.carried?.kept ?? 0;
            // Отсутствие среза виновато только там, где было что переносить.
            const zeroReason = zeroCarryReason(keptBefore, progress, previous.diffId, 'no_interdiff');
            return { carried: { kept: keptBefore, total, zeroReason } };
        }

        const carried = progress.carryStopsInTransaction({
            snapshotId: snapshot.snapshotId,
            diffId: snapshot.diffId,
            stops: snapshot.stops,
            diff,
        });
        // Отметки могли переехать в несколько приёмов (заморозка, дозаполнение стопа).
        const kept = (snapshot.carried?.kept ?? 0) + carried.kept;
        const zeroReason = zeroCarryReason(kept, progress, previous.diffId, 'no_overlap');
        return {
            carried: { kept, total, zeroReason },
            afterCommit: () => {
                carried.afterCommit();
                process.stderr.write(
                    `sherpa-server: снапшот ${snapshot.snapshotId}: перенесено ${String(kept)} из ` +
                        `${String(total)} остановок с ${previous.snapshotId}` +
                        `${zeroCarryNote(zeroReason)}\n`,
                );
            },
        };
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
    private startSkeleton(context: GenerationContext, locale: Locale): void {
        this.generation = context;
        // Язык — в хранилище, а не в поле: задачу скелета может принять уже следующий процесс.
        this.cancelOpenRouteTasks();
        this.store.clearBindings();
        this.store.beginSkeleton({ locale, presentation: this.presentation });
        // Payload прошлой генерации больше никому не нужен: её задачи только что отменены.
        // Контекст перегенерации пишется здесь один раз — он общий для скелета и всех секций.
        this.payload.beginGeneration(this.regenerationOf(context));
        this.startSkeletonTask();
    }

    /**
     * Контекст генерации: карта строк от итерации текущего снапшота к итерации новой генерации.
     * Считается заранее — интердифф это сетевой вызов, а приёмка результата синхронна.
     * Срез не добыт — генерация всё равно идёт, только отметки остановок не перенесутся.
     */
    private async generationContextFor(diff: PrDiff): Promise<GenerationContext> {
        const previous = this.store.current();
        if (this.presentation === 'story') return { diff, previousSnapshotId: previous?.snapshotId ?? null, map: null, interdiff: null, threads: null };
        if (previous === null) {
            return { diff, previousSnapshotId: null, map: null, interdiff: null, threads: null };
        }

        // Треды нужны только перегенерации: они объясняют, почему автор тронул стоп. Запрос идёт
        // рядом со срезом, а не после него: генерация ждёт обоих, и складывать задержки незачем.
        const threads = this.loadThreads();
        const base = async (): Promise<Pick<GenerationContext, 'diff' | 'previousSnapshotId' | 'threads'>> => ({
            diff,
            previousSnapshotId: previous.snapshotId,
            threads: await threads,
        });
        if (previous.diffId === diff.diffId) {
            // Перегенерация на той же итерации: строки не двигались.
            return { ...(await base()), map: identityMap(), interdiff: null };
        }

        const host = this.host;
        const iterations = this.iterations;
        if (host === null || iterations === null) {
            return { ...(await base()), map: null, interdiff: null };
        }
        try {
            const interdiff = await iterations.getInterdiff(previous.diffId, diff.diffId, () =>
                host.getDiff({ base: previous.diffId, head: diff.diffId }),
            );
            return {
                ...(await base()),
                interdiff,
                map: buildIterationMap({
                    interdiff,
                    fromBaseCommit: previous.baseCommit,
                    toBaseCommit: diff.baseCommit,
                }),
            };
        } catch (error) {
            process.stderr.write(
                `sherpa-server: срез ${previous.diffId}→${diff.diffId} не получен: ${messageOf(error)}\n`,
            );
            return { ...(await base()), map: null, interdiff: null };
        }
    }

    /** Треды PR для контекста перегенерации; отказ хоста генерацию не рушит — файла просто не будет. */
    private async loadThreads(): Promise<Thread[] | null> {
        const host = this.threads;
        if (host === null) {
            return null;
        }
        try {
            return await host.getThreads();
        } catch (error) {
            process.stderr.write(
                `sherpa-server: треды для контекста перегенерации не получены: ${messageOf(error)}\n`,
            );
            return null;
        }
    }

    /**
     * Контекст генерации без похода в хост: карта берётся из кэша срезов, иначе её нет.
     * Прошлый снапшот называет вызывающий — он не всегда текущий.
     */
    private cachedContextFor(diff: PrDiff, previous: RouteSnapshot | null): GenerationContext {
        if (previous === null) {
            return { diff, previousSnapshotId: null, map: null, interdiff: null, threads: null };
        }
        if (previous.diffId === diff.diffId) {
            return {
                diff,
                previousSnapshotId: previous.snapshotId,
                map: identityMap(),
                interdiff: null,
                threads: null,
            };
        }

        if (this.store.generationPresentation() === 'story') return { diff, previousSnapshotId: previous.snapshotId, map: null, interdiff: null, threads: null };
        const interdiff = this.iterations?.peekInterdiff(previous.diffId, diff.diffId) ?? null;
        return {
            diff,
            previousSnapshotId: previous.snapshotId,
            interdiff,
            // Треды сетевые: восстановленный контекст живёт без них, ссылки модели на них
            // приёмка вырежет.
            threads: null,
            map:
                interdiff === null
                    ? null
                    : buildIterationMap({
                          interdiff,
                          fromBaseCommit: previous.baseCommit,
                          toBaseCommit: diff.baseCommit,
                      }),
        };
    }

    /**
     * Контекст перегенерации для payload: прошлый снапшот и всё, чем задача объясняет пуш.
     * null — прошлого маршрута нет, и задача собирается как при первой генерации.
     */
    private regenerationOf(context: GenerationContext | null): RouteRegenerationContext | null {
        if (this.store.generationPresentation() === 'story') return null;
        const previousId = context?.previousSnapshotId ?? null;
        const previous = previousId === null ? null : this.store.getSnapshot(previousId);
        if (context === null || previous === null) {
            return null;
        }
        return {
            previous,
            interdiff: context.interdiff,
            map: context.map,
            threads: context.threads,
        };
    }

    private startSkeletonTask(): void {
        // Перепостановка после рестарта начинает план заново и берёт активную итерацию: какой
        // была прежняя, знала привязка её задачи, а её к этому моменту уже нет.
        const diff = this.generation?.diff ?? this.activeDiff;
        if (diff === null) {
            // Рестарт сервера застал фазу генерации: собирать payload не из чего, и постановка
            // ждёт диффа — прогрев доведёт её сам, его хвост зовёт сверку заново.
            this.warmupInBackground();
            return;
        }
        // Рестарт сервера: контекст генерации потерян вместе с процессом, карта остаётся только
        // та, что успела осесть в кэше срезов.
        this.generation ??= this.cachedContextFor(diff, this.store.current());
        this.enqueueRouteTask(
            'skeleton',
            diff.diffId,
            [],
            this.payload.skeletonTask({
                diff,
                meta: this.meta,
                locale: this.skeletonLocale(),
                presentation: this.store.generationPresentation(),
                regeneration: this.regenerationOf(this.generation),
            }),
        );
    }

    /**
     * Постановка секций — в порядке плана: спор за диапазон между результатами выигрывает
     * сдавшийся первым (инвариант `planOccupancy` валидатора), поэтому очередь обязана
     * предлагать стопы по возрастанию плановых номеров.
     */
    private enqueueSections(planIndexes: readonly number[]): void {
        const snapshot = this.store.read().snapshot;
        if (snapshot === null) {
            return;
        }
        const diff = this.diffOf(snapshot.diffId);
        if (diff === null) {
            this.awaitOrAbandonDiff(snapshot.diffId);
            return;
        }

        const intents = this.store.stopIntents();
        const context = {
            diff,
            meta: this.meta,
            // Секции продолжают скелет: их язык — язык снапшота, а не текущий выбор вкладки.
            locale: snapshotLocale(snapshot),
            presentation: snapshot.presentation,
            introduction: snapshot.summary,
            introductionEvidence: snapshot.summaryEvidence,
            regeneration: this.regenerationOf(this.acceptanceContext(diff, snapshot.previousSnapshotId)),
        };
        const ordered = [...planIndexes].sort((left, right) => left - right);
        const batchSize = snapshot.presentation === 'story' ? ordered.length : this.config.sectionBatchSize;
        for (let from = 0; from < ordered.length; from += batchSize) {
            const batch = ordered.slice(from, from + batchSize);
            const input = this.payload.sectionTask(context, batch, snapshot.stops, intents);
            this.enqueueRouteTask('section', snapshot.diffId, batch, input);
        }
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
    ): void {
        const outer = this.reconciling;
        this.reconciling = true;
        try {
            const record = this.queue.enqueue(input);
            this.store.bindTask(record.id, kind, diffId, planIndexes);
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
            setting: this.settings?.read().locale,
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
        for (const candidate of [this.generation?.diff ?? null, this.activeDiff]) {
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
     * читаемым после следующего пуша (docs/product.md §4a), а генерация не может стартовать раньше записи.
     *
     * На процесс не кэшируется — итерацию генерации держит `generationDiff`; параллельные
     * вызовы делят один запрос, чтобы прогрев и ручка `generate` не ходили в хост дважды.
     */
    private async loadDiff(): Promise<PrDiff> {
        const host = this.host;
        if (host === null) {
            throw new RpcFailure('no_review_host', 'У этого PR нет хост-адаптера: маршрут строить не по чему.');
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

/**
 * Порог маршрута (docs/architecture.md §7.6): крошечный PR читается целиком, маршрут для него — накладной расход.
 * Меряется только объёмом правки по всем файлам: один файл на пятьсот строк тоже требует маршрута.
 */
export function isSmallPr(diff: PrDiff, config: RouteConfig): boolean {
    const changedLines = diff.files.reduce((total, file) => total + file.additions + file.deletions, 0);
    return changedLines <= config.smallPrMaxChangedLines;
}

function resolveConfig(overrides: Partial<RouteConfig> | undefined): RouteConfig {
    const config = { ...DEFAULT_ROUTE_CONFIG, ...overrides };
    // Нулевой батч — опечатка в конфиге, а не «ставить нечего»: постановка секций зациклилась бы.
    return { ...config, sectionBatchSize: Math.max(1, Math.trunc(config.sectionBatchSize)) };
}

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
 * Почему перенос отметок дал ноль. Само «перенесено 0 из 8» читается как «всё изменилось», а
 * причин две и они разные: ревьюер на прошлой итерации ничего не отмечал — или отмечал, но
 * целиком просмотренной ни одна остановка не осталась.
 *
 * Спрашивается итерация-источник, а не приёмник: перенос мог не довезти ни строчки (интердифф
 * задел все диапазоны, консервативный режим, перегенерация на той же итерации), и «отметок
 * не было» стало бы неправдой в лицо ревьюеру, который их ставил.
 */
function zeroCarryReason(
    kept: number,
    progress: StopProgressCarry,
    sourceDiffId: HostId,
    whenMarked: RouteCarriedZeroReason,
): RouteCarriedZeroReason | null {
    if (kept > 0) {
        return null;
    }
    return progress.hasViewedMarks(sourceDiffId) ? whenMarked : 'no_marks';
}

/** Та же причина словами — хвост строки переноса в stderr. */
function zeroCarryNote(reason: RouteCarriedZeroReason | null): string {
    switch (reason) {
        case null:
            return '';
        case 'no_marks':
            return ' — отметок просмотра на прошлой итерации не было';
        case 'no_overlap':
            return ' — отметки прошлой итерации не покрыли целиком ни одной остановки';
        case 'no_interdiff':
            return ' — интердиффа между итерациями нет';
    }
}

/**
 * Причина провала генерации для красной карточки (docs/design/README.md §12) — одно предложение
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

import { createHash } from 'node:crypto';

import type {
    ExplanationSnapshot,
    FlowState,
    HostId,
    Locale,
    PrDiff,
    RouteCarried,
    RouteProvenance,
    RouteSnapshot,
    RouteStop,
    RouteStopStatus,
    UiGenerationCap,
    UiRouteState,
} from '@sherpa/protocol';
import { localeSchema, routeSnapshotSchema, uiGenerationCapSchema, uiRouteStateSchema } from '@sherpa/protocol';

import type { AcceptedExplanation, ExplanationFilling } from './story.js';
import { reviewProjection, storedSnapshot, restoreSnapshot } from './explanation-compat.js';

import type { SherpaDatabase, SqlRow } from './db.js';
import { transaction } from './db.js';
import type { AcceptedSkeleton, RouteStopFilling } from './route/index.js';
import { applyFilling } from './route/index.js';

/** Слушатель изменений маршрута; его забирает SSE-канал UI (`UI_ROUTE_EVENT`). */
export type RouteListener = (revision: number) => void;

/** Единственная строка `route_state`: состояние генерации у PR одно, снапшотов много. */
const SLOT_ID = 1;

/**
 * Чем добивается `baseCommit` снапшота старого формата, когда итерации в хранилище ещё нет:
 * сравнивать по нему нечего, но врать чужим коммитом хуже, чем сказать «неизвестно».
 */
export const UNKNOWN_BASE_COMMIT = 'unknown';

/** Ключ капа генерации в `meta`: своя строка на снапшот, миграции для этого не нужно. */
function generationCapKey(snapshotId: string): string {
    return `generation_cap:${snapshotId}`;
}

/** Ключ языка последней запущенной генерации в `meta`: генерация у PR одна, ключ фиксированный. */
const GENERATION_LOCALE_KEY = 'generation_locale';

/** Длина контент-хеша в hex-символах: его показывает снапшот-селектор («snapshot 3f2a… · current»). */
const CONTENT_HASH_LENGTH = 12;

export interface RouteStoreOptions {
    readonly db: SherpaDatabase;
    /** Инжектируемые часы: `createdAt` снапшота в тестах не должен зависеть от системного времени. */
    readonly now?: () => Date;
}

/** Смена статуса незаполненного стопа; `note` дописывается в `validationNotes` один раз. */
export interface RouteStopStatusUpdate {
    readonly status: RouteStopStatus;
    readonly note?: string;
}

/** Задача генерации и стопы, которые она заполняет («Прочего» среди них не бывает). */
export interface RouteTaskBinding {
    readonly kind: 'skeleton' | 'section';
    /**
     * Итерация, из диффа которой собран payload задачи: против него приёмщик и резолвит якоря.
     * `null` — привязка старше миграции 011 (такие она стирает, так что это только защита чтения).
     */
    readonly diffId: HostId | null;
    readonly planIndexes: number[];
}

/**
 * Итог переноса прогресса на снапшот. Считается внутри транзакции его записи, поэтому
 * ревизия прогресса двигается отдельным эффектом — уже после коммита.
 */
export interface SnapshotAcceptance {
    readonly carried: RouteCarried | null;
    readonly afterCommit?: () => void;
}

/** Хук приёмки снапшота: получает подготовленный снапшот, возвращает его `carried`. */
export type SnapshotHook = (snapshot: RouteSnapshot) => SnapshotAcceptance;

/** Работа внутри транзакции записи состояния: подмена снапшота и эффект после коммита. */
interface TransactionStep {
    readonly snapshot?: RouteSnapshot;
    readonly afterCommit?: () => void;
}

export interface AcceptedSkeletonInput {
    readonly skeleton: AcceptedSkeleton | AcceptedExplanation;
    readonly presentation?: 'legacy' | 'story';
    /** Дифф, по которому строился маршрут: из него снапшот берёт коммит и итерацию. */
    readonly diff: PrDiff;
    readonly provenance: RouteProvenance;
    readonly snapshotId: string;
    /** Снапшот, бывший текущим в момент приёмки; null — маршрут строится впервые. */
    readonly previousSnapshotId: string | null;
}

interface RouteStateRow extends SqlRow {
    phase: string;
    small_pr: number | null;
    current_snapshot_id: string | null;
    failure_message: string | null;
    failure_raw_output: string | null;
    intents: string;
}

interface RouteSnapshotRow extends SqlRow {
    snapshot_id: string;
    snapshot_json: string;
}

interface RouteTaskRow extends SqlRow {
    task_id: number;
    kind: string;
    diff_id: string | null;
    plan_indexes: string;
}

// `stale` в хранилище всегда null: его считает `IterationFeed` на границе чтения (`withStale`).
const EMPTY_STATE: UiRouteState = { phase: 'none', smallPr: false, snapshot: null, failure: null, stale: null };

/**
 * Состояние маршрута PR: фаза генерации, снапшот и причина провала — истина для UI.
 *
 * Паттерн `ProgressStore`: ревизия монотонна от старта сервера и растёт только на реальном
 * изменении, подписчики узнают о нём событием `route`, а вкладка перечитывает ручку. Снапшот
 * проходит через `routeSnapshotSchema` на записи и на чтении из БД — невалидное в хранилище
 * не живёт и наружу не выходит (docs/product.md §3, принцип 3).
 *
 * Мутаторы — крупные: оркестратор считает целевое состояние целиком и применяет его одним
 * вызовом, поэтому один шаг автомата даёт ровно одно событие в канал.
 */
export class RouteStore {
    private readonly db: SherpaDatabase;
    private readonly now: () => Date;
    private readonly listeners = new Set<RouteListener>();
    private readonly txWrite: (
        state: UiRouteState,
        intents: ReadonlyMap<number, string>,
        inTransaction?: () => TransactionStep,
    ) => { state: UiRouteState; afterCommit: (() => void) | undefined };

    private state: UiRouteState;
    private intents: ReadonlyMap<number, string>;
    private revisionValue = 0;
    private closed = false;

    constructor(options: RouteStoreOptions) {
        this.db = options.db;
        this.now = options.now ?? ((): Date => new Date());
        this.txWrite = transaction(
            this.db,
            (state: UiRouteState, intents: ReadonlyMap<number, string>, inTransaction?: () => TransactionStep) => {
                // Шаг идёт до записи: подменённый им снапшот обязан лечь в хранилище той же транзакцией.
                const step = inTransaction?.() ?? {};
                const written =
                    step.snapshot === undefined
                        ? state
                        : uiRouteStateSchema.parse({ ...state, snapshot: step.snapshot });
                this.writeInTransaction(written, intents);
                return { state: written, afterCommit: step.afterCommit };
            },
        );

        const loaded = this.load();
        this.state = loaded.state;
        this.intents = loaded.intents;
    }

    get revision(): number {
        return this.revisionValue;
    }

    /** Состояние для UI; копия — потребитель волен её мутировать. */
    read(): UiRouteState {
        return structuredClone(this.state);
    }

    /** Текущий снапшот PR; null — маршрута сейчас нет (генерация не шла, сброшена или провалилась). */
    current(): RouteSnapshot | null {
        return this.state.snapshot === null ? null : structuredClone(this.state.snapshot);
    }

    /**
     * Все снапшоты PR в порядке появления. История не чистится никогда: старый снапшот —
     * единственный способ прочитать маршрут прошлой итерации (docs/product.md §7, сценарий F3).
     * Повреждённая строка пропускается с предупреждением — остальная история остаётся читаемой.
     */
    listSnapshots(): RouteSnapshot[] {
        const rows = this.db
            .prepare('SELECT snapshot_id, snapshot_json FROM route_snapshots ORDER BY created_at, rowid')
            .all() as RouteSnapshotRow[];
        return rows.flatMap((row) => {
            const snapshot = this.parseSnapshotRow(row);
            return snapshot === null ? [] : [snapshot];
        });
    }

    getSnapshot(snapshotId: string): RouteSnapshot | null {
        const row = this.db
            .prepare('SELECT snapshot_id, snapshot_json FROM route_snapshots WHERE snapshot_id = ?')
            .get(snapshotId) as RouteSnapshotRow | undefined;
        return row === undefined ? null : this.parseSnapshotRow(row);
    }

    /**
     * Черновые замыслы стопов из принятого скелета: в снапшот они не входят (контракт),
     * но постановщику секций без них не собрать промпт.
     */
    stopIntents(): Map<number, string> {
        return new Map(this.intents);
    }

    generationPresentation(): 'legacy' | 'story' {
        return this.db.prepare("SELECT value FROM meta WHERE key = 'generation_presentation'").get()?.value === 'story' ? 'story' : 'legacy';
    }

    setGenerationPresentation(presentation: 'legacy' | 'story'): void {
        this.db.prepare("INSERT INTO meta (key,value) VALUES ('generation_presentation',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(presentation);
    }

    /** Новая генерация: старый снапшот остаётся читаемым до приёмки нового плана. */
    beginSkeleton(generation?: { locale: Locale; presentation: 'legacy' | 'story' }): void {
        this.commit({ ...this.state, phase: 'reading', failure: null }, new Map(), generation === undefined ? undefined : () => {
            this.setGenerationLocale(generation.locale);
            this.setGenerationPresentation(generation.presentation);
            this.db.prepare("INSERT INTO meta(key,value) VALUES ('generation_story_contract_version',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
                .run(generation.presentation === 'story' ? '2' : '1');
            return {};
        });
    }

    /** Эпоха формата задания; прежний ключ meta сохранён для рестарта незавершённых задач. */
    generationTaskEpoch(): number {
        return this.db.prepare("SELECT value FROM meta WHERE key='generation_story_contract_version'").get()?.value === '2' ? 2 : 1;
    }

    /**
     * Скелет принят: новый снапшот и перенос прогресса на него коммитятся вместе.
     * В `route_snapshots` появляется новая строка, прежние не трогаются и не удаляются.
     *
     * `onSnapshot` считается внутри транзакции и до сериализации: его `carried` обязан лечь
     * в JSON снапшота, а не приехать вторым запросом.
     */
    acceptSkeleton(input: AcceptedSkeletonInput, onSnapshot?: SnapshotHook): void {
        const snapshot: RouteSnapshot = {
            snapshotId: input.snapshotId,
            ...(input.presentation === undefined ? {} : { presentation: input.presentation }),
            commit: input.diff.headCommit,
            baseCommit: input.diff.baseCommit,
            diffId: input.diff.diffId,
            createdAt: this.now().toISOString(),
            provenance: input.provenance,
            previousSnapshotId: input.previousSnapshotId,
            carried: null,
            summary: input.skeleton.summary,
            ...(input.skeleton.storyContractVersion === undefined ? {} : { storyContractVersion: input.skeleton.storyContractVersion }),
            ...(input.skeleton.summaryEvidence === undefined ? {} : { summaryEvidence: input.skeleton.summaryEvidence }),
            stops: input.skeleton.stops.map((stop) => 'tier' in stop ? stop : reviewProjection(stop)),
            tourOrder: input.skeleton.tourOrder,
            contentHash: null,
        };
        this.commit(
            { ...this.state, phase: 'filling', snapshot, failure: null },
            new Map(input.skeleton.intents),
            stepOf(snapshot, onSnapshot),
        );
    }

    /**
     * Принятые заполнения секции легли в плановые слоты. Провенанс пишется в стоп, только если
     * он разошёлся со снапшотным: агент сменился посреди генерации (docs/design/SPEC-elements.md §4.4).
     */
    applyFillings(fillings: readonly (RouteStopFilling | ExplanationFilling)[], provenance: RouteProvenance): void {
        const snapshot = this.state.snapshot;
        if (snapshot === null) {
            return;
        }

        const byIndex = new Map(fillings.map((filling) => [filling.planIndex, filling]));
        const stops = snapshot.stops.map((stop) => {
            const filling = byIndex.get(stop.planIndex);
            if (filling === undefined || stop.tier === 'other') {
                return stop;
            }
            return {
                ...applyFilling(stop, filling),
                provenance: sameProvenance(provenance, snapshot.provenance) ? null : provenance,
            };
        });
        this.commit({ ...this.state, snapshot: { ...snapshot, stops } });
    }

    /** Схема не участвует в готовности файлов и не блокирует основной маршрут. */
    setFlow(snapshotId: string, flow: FlowState): void {
        const snapshot = this.state.snapshot;
        if (snapshot?.snapshotId !== snapshotId) return;
        const updated = { ...snapshot, flow };
        if (updated.contentHash !== null) updated.contentHash = contentHashOf(updated);
        this.commit({ ...this.state, snapshot: updated });
    }

    /** Статусы стопов по состоянию их задач: `queued` → `filling` → `ready`/`failed`. */
    setStopStatuses(updates: ReadonlyMap<number, RouteStopStatusUpdate>): void {
        const snapshot = this.state.snapshot;
        if (snapshot === null || updates.size === 0) {
            return;
        }

        const stops = snapshot.stops.map((stop) => {
            const update = updates.get(stop.planIndex);
            if (update === undefined || stop.tier === 'other') {
                return stop;
            }
            return { ...stop, status: update.status, validationNotes: withNote(stop, update.note) };
        });
        this.commit({ ...this.state, snapshot: { ...snapshot, stops } });
    }

    /** Незавершённый стоп возвращается в штатную фазу заполнения без сброса остального маршрута. */
    beginStopFill(planIndex: number): void {
        const snapshot = this.state.snapshot;
        if (snapshot === null) {
            return;
        }

        const stops = snapshot.stops.map((stop) =>
            stop.planIndex === planIndex && stop.tier !== 'other'
                ? { ...stop, status: 'queued' as const, validationNotes: [] }
                : stop,
        );
        this.commit(
            { ...this.state, phase: 'filling', failure: null, snapshot: { ...snapshot, stops, contentHash: null } },
            this.intents,
            () => {
                this.deleteSectionBindingsFor(planIndex);
                return {};
            },
        );
    }

    /**
     * Все секции закрыты — снапшот становится неизменяемым, и только тут считается `contentHash`:
     * до этого момента хешировать нечего, содержимое ещё едет.
     *
     * Здесь же считается перенос отметок остановок: якоря есть только у заполненных стопов,
     * поэтому раньше переносить нечего (`onSnapshot` — тот же хук, что у приёмки скелета).
     */
    markReady(onSnapshot?: SnapshotHook): void {
        const snapshot = this.state.snapshot;
        if (snapshot === null) {
            return;
        }
        const ready: RouteSnapshot = { ...snapshot, contentHash: contentHashOf(snapshot) };
        this.commit(
            { ...this.state, phase: 'ready', snapshot: ready },
            this.intents,
            stepOf(ready, onSnapshot),
        );
    }

    /**
     * Провал генерации маршрута (docs/design/README.md §12): скелета нет, читалка не пострадала.
     * Причина — одно русское предложение, сырой вывод модели — для «Open raw output».
     */
    fail(message: string, rawOutput: string | null): void {
        this.commit({ ...this.state, phase: 'failed', failure: { message, rawOutput } });
    }

    /** PR ниже порога маршрута (docs/architecture.md §7.6) — считается по диффу, поэтому приезжает отдельно от фазы. */
    setSmallPr(smallPr: boolean): void {
        this.commit({ ...this.state, smallPr });
    }

    /** Отмена скелета: перестройка возвращает старый маршрут, первая генерация — пустое состояние. */
    cancelSkeleton(): void {
        if (this.state.snapshot === null) {
            this.reset();
            return;
        }
        if (this.state.snapshot.presentation === 'story' && this.state.snapshot.stops.some((stop) => stop.status !== 'ready')) {
            this.fail('Построение рассказа остановлено. Введение сохранено; повторите построение.', null);
            return;
        }
        this.commit({ ...this.state, phase: 'ready', failure: null }, new Map());
    }

    /** Генерации нет и не было: приглашение запустить скилл. */
    reset(): void {
        this.commit({ ...this.state, phase: 'none', snapshot: null, failure: null }, new Map());
    }

    /**
     * Кап генерации снапшота: какую часть диффа скелет увидел целиком. Живёт в `meta`
     * по ключу снапшота, а не в самом снапшоте: снапшот — контракт с UI, и метрика payload
     * в нём не предусмотрена. Пишется при приёмке скелета, читается при сборке состояния.
     */
    setGenerationCap(snapshotId: string, cap: UiGenerationCap): void {
        this.db
            .prepare(
                `INSERT INTO meta (key, value) VALUES (?, ?)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
            )
            .run(generationCapKey(snapshotId), JSON.stringify(cap));
    }

    /** Кап текущего снапшота; null — снапшота нет или его генерация была до появления метрики. */
    currentGenerationCap(): UiGenerationCap | null {
        const snapshotId = this.state.snapshot?.snapshotId;
        return snapshotId === undefined ? null : this.generationCap(snapshotId);
    }

    /** Кап конкретного снапшота; повреждённая запись читается как «записи нет» (принцип 3). */
    generationCap(snapshotId: string): UiGenerationCap | null {
        const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(generationCapKey(snapshotId)) as
            | { value: string }
            | undefined;
        if (row === undefined) {
            return null;
        }
        try {
            const parsed = uiGenerationCapSchema.safeParse(JSON.parse(row.value));
            return parsed.success ? parsed.data : null;
        } catch {
            return null;
        }
    }

    /**
     * Язык последней запущенной генерации. Живёт в `meta`, а не в памяти процесса: задача
     * скелета переживает рестарт сервера вместе с привязкой, и приёмка её результата обязана знать
     * язык, который реально уехал в промпт, — иначе снапшот получит чужой `provenance.locale`
     * и разноязычные секции.
     */
    setGenerationLocale(locale: Locale): void {
        this.db
            .prepare(
                `INSERT INTO meta (key, value) VALUES (?, ?)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
            )
            .run(GENERATION_LOCALE_KEY, locale);
    }

    /** Язык последней генерации; null — генерации не было или запись повреждена (принцип 3). */
    generationLocale(): Locale | null {
        const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(GENERATION_LOCALE_KEY) as
            | { value: string }
            | undefined;
        if (row === undefined) {
            return null;
        }
        const parsed = localeSchema.safeParse(row.value);
        return parsed.success ? parsed.data : null;
    }

    /** Задача генерации ↔ стопы, которые она заполняет. Состояние UI это не меняет — ревизия стоит. */
    bindTask(
        taskId: number,
        kind: RouteTaskBinding['kind'],
        diffId: HostId,
        planIndexes: readonly number[],
    ): void {
        this.db
            .prepare(
                `INSERT INTO route_tasks (task_id, kind, diff_id, plan_indexes, created_at)
                 VALUES (?, ?, ?, ?, ?)
                 ON CONFLICT(task_id) DO UPDATE SET kind = excluded.kind, diff_id = excluded.diff_id,
                    plan_indexes = excluded.plan_indexes`,
            )
            .run(taskId, kind, diffId, JSON.stringify([...planIndexes]), this.now().toISOString());
    }

    /** Привязки задач текущей генерации, в порядке постановки. */
    bindings(): Map<number, RouteTaskBinding> {
        const rows = this.db
            .prepare('SELECT task_id, kind, diff_id, plan_indexes FROM route_tasks ORDER BY task_id')
            .all() as RouteTaskRow[];
        const bindings = new Map<number, RouteTaskBinding>();
        for (const row of rows) {
            bindings.set(row.task_id, {
                kind: row.kind === 'skeleton' ? 'skeleton' : 'section',
                diffId: row.diff_id,
                planIndexes: parsePlanIndexes(row.plan_indexes),
            });
        }
        return bindings;
    }

    /**
     * Забывает задачи прежней генерации: их плановые номера совпадают с номерами нового плана,
     * и оставленная привязка выдала бы отменённую задачу за задачу свежего стопа.
     */
    clearBindings(): void {
        this.db.prepare('DELETE FROM route_tasks').run();
    }

    /** Закрытая задача прошлого заполнения не должна считаться задачей нового прохода сверки. */
    private deleteSectionBindingsFor(planIndex: number): void {
        for (const [taskId, binding] of this.bindings()) {
            if (binding.kind === 'section' && binding.planIndexes.includes(planIndex)) {
                this.db.prepare('DELETE FROM route_tasks WHERE task_id = ?').run(taskId);
            }
        }
    }

    subscribe(listener: RouteListener): () => void {
        if (this.closed) {
            return () => undefined;
        }

        this.listeners.add(listener);
        let released = false;
        return () => {
            if (released) {
                return;
            }
            released = true;
            this.listeners.delete(listener);
        };
    }

    /** Отпускает слушателей: сервер закрывается, будить некого. */
    close(): void {
        this.closed = true;
        this.listeners.clear();
    }

    /**
     * Запись состояния: сначала контракт, потом хранилище, потом ревизия и рассылка.
     * Мутатор, не изменивший ничего, молчит — будить вкладки нечем.
     */
    private commit(
        next: UiRouteState,
        intents: ReadonlyMap<number, string> = this.intents,
        inTransaction?: () => TransactionStep,
    ): void {
        const parsed = uiRouteStateSchema.parse(next);
        if (
            inTransaction === undefined &&
            JSON.stringify(parsed) === JSON.stringify(this.state) &&
            sameIntents(intents, this.intents)
        ) {
            return;
        }

        const { state, afterCommit } = this.txWrite(parsed, intents, inTransaction);
        this.state = state;
        this.intents = intents;
        this.revisionValue += 1;
        if (!this.closed) {
            for (const listener of [...this.listeners]) {
                listener(this.revisionValue);
            }
        }
        afterCommit?.();
    }

    /**
     * Текущий снапшот пишется своей строкой в `route_snapshots` (id — ключ), а `route_state`
     * держит только ссылку на него: история снапшотов PR не перезаписывается.
     */
    private writeInTransaction(state: UiRouteState, intents: ReadonlyMap<number, string>): void {
        const snapshot = state.snapshot === null ? null : routeSnapshotSchema.parse(state.snapshot);
        if (snapshot !== null) {
            this.db
                .prepare(
                    `INSERT INTO route_snapshots (
                        snapshot_id, diff_id, created_at, previous_snapshot_id, snapshot_json, content_hash
                     ) VALUES (?, ?, ?, ?, ?, ?)
                     ON CONFLICT(snapshot_id) DO UPDATE SET
                        diff_id = excluded.diff_id, created_at = excluded.created_at,
                        previous_snapshot_id = excluded.previous_snapshot_id,
                        snapshot_json = excluded.snapshot_json, content_hash = excluded.content_hash`,
                )
                .run(
                    snapshot.snapshotId,
                    snapshot.diffId,
                    snapshot.createdAt,
                    snapshot.previousSnapshotId,
                    JSON.stringify(storedSnapshot(snapshot)),
                    snapshot.contentHash,
                );
        }

        this.db
            .prepare(
                `INSERT INTO route_state (
                    id, phase, small_pr, current_snapshot_id, failure_message, failure_raw_output,
                    intents, updated_at
                 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                 ON CONFLICT(id) DO UPDATE SET
                    phase = excluded.phase, small_pr = excluded.small_pr,
                    current_snapshot_id = excluded.current_snapshot_id,
                    failure_message = excluded.failure_message,
                    failure_raw_output = excluded.failure_raw_output,
                    intents = excluded.intents, updated_at = excluded.updated_at`,
            )
            .run(
                SLOT_ID,
                state.phase,
                state.smallPr ? 1 : 0,
                snapshot?.snapshotId ?? null,
                state.failure?.message ?? null,
                state.failure?.rawOutput ?? null,
                JSON.stringify([...intents]),
                this.now().toISOString(),
            );
    }

    /**
     * Снапшот из строки хранилища. Записанный прежней версией (без `baseCommit`, `previousSnapshotId`,
     * `carried`, `stops[].change`) добивается значениями по умолчанию: иначе схема уронила бы
     * его целиком, и накопленный маршрут молча превратился бы в «маршрута нет».
     * Повреждённая строка — предупреждение и `null`: остальная история остаётся читаемой.
     */
    private parseSnapshotRow(row: RouteSnapshotRow): RouteSnapshot | null {
        try {
            return routeSnapshotSchema.parse(
                withSnapshotDefaults(restoreSnapshot(JSON.parse(row.snapshot_json) as unknown), (diffId) =>
                    this.baseCommitOf(diffId),
                ),
            );
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            process.stderr.write(
                `sherpa-server: снапшот маршрута ${row.snapshot_id} в хранилище повреждён (${message}) — пропущен\n`,
            );
            return null;
        }
    }

    /** Ревьюируемая база итерации из локального хранилища патчей; null — итерации там нет. */
    private baseCommitOf(diffId: string): string | null {
        const row = this.db.prepare('SELECT base_commit FROM iterations WHERE diff_id = ?').get(diffId) as
            | { base_commit: string }
            | undefined;
        return row?.base_commit ?? null;
    }

    /**
     * Чтение состояния при старте сервера. Повреждённая строка (ручная правка БД, откат версии)
     * трактуется как «маршрута нет»: маршрут восстановим генерацией, а падать стартом сервера
     * из-за него — дороже, чем потерять снапшот.
     */
    private load(): { state: UiRouteState; intents: ReadonlyMap<number, string> } {
        const row = this.db.prepare('SELECT * FROM route_state WHERE id = ?').get(SLOT_ID) as
            | RouteStateRow
            | undefined;
        if (row === undefined) {
            return { state: EMPTY_STATE, intents: new Map() };
        }

        try {
            const snapshot =
                row.current_snapshot_id === null ? null : this.getSnapshot(row.current_snapshot_id);
            if (row.current_snapshot_id !== null && snapshot === null) {
                // Строка текущего снапшота пропала или не читается: фаза без снапшота соврала бы
                // UI готовым маршрутом, которого нет.
                throw new Error(`снапшот ${row.current_snapshot_id} не читается`);
            }
            const state = uiRouteStateSchema.parse({
                phase: row.phase,
                smallPr: row.small_pr === 1,
                snapshot,
                failure:
                    row.failure_message === null
                        ? null
                        : { message: row.failure_message, rawOutput: row.failure_raw_output },
                // Сравнивать снапшот с активной итерацией — работа `IterationFeed`, не хранилища.
                stale: null,
            });
            return { state, intents: parseIntents(row.intents) };
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            process.stderr.write(`sherpa-server: состояние маршрута в хранилище повреждено (${message}) — сброшено\n`);
            return { state: EMPTY_STATE, intents: new Map() };
        }
    }
}

/**
 * Контент-хеш готового снапшота: sha256 по модельному содержимому (summary, план, заполнение),
 * первые 12 hex-символов — их показывает снапшот-селектор. Служебные поля
 * (id снапшота, время, провенанс, итерация) в хеш не входят: два одинаковых маршрута, собранных
 * разными сессиями, обязаны дать один хеш. Порядок полей задан здесь явно — от порядка ключей
 * в объектах хранилища он зависеть не должен.
 */
export function contentHashOf(snapshot: RouteSnapshot): string {
    if (snapshot.presentation === 'story' && snapshot.storyContractVersion !== undefined) {
        const saved = storedSnapshot(snapshot) as ExplanationSnapshot;
        const { snapshotId: _id, commit: _commit, baseCommit: _base, diffId: _diff, createdAt: _created, provenance: _provenance, previousSnapshotId: _previous, contentHash: _hash, ...content } = saved;
        return createHash('sha256').update(JSON.stringify({ ...content, stops: content.stops.map(({ provenance: _sectionProvenance, ...block }) => block) })).digest('hex').slice(0, CONTENT_HASH_LENGTH);
    }
    const payload = JSON.stringify({
        summary: snapshot.summary,
        ...(snapshot.storyContractVersion !== undefined ? { storyContractVersion: snapshot.storyContractVersion, summaryEvidence: snapshot.summaryEvidence } : {}),
        ...(snapshot.flow === undefined ? {} : { flow: snapshot.flow }),
        tourOrder: snapshot.tourOrder,
        stops: snapshot.stops.map((stop) => ({
            id: stop.id,
            planIndex: stop.planIndex,
            tier: stop.tier,
            title: stop.title,
            status: stop.status,
            paragraph: stop.paragraph,
            ...(snapshot.storyContractVersion !== undefined ? { storyEvidence: stop.storyEvidence, guidedFiles: stop.guidedFiles, example: stop.example, relatedFiles: stop.relatedFiles } : {}),
            bridge: stop.bridge,
            anchors: stop.anchors.map((anchor) => ({
                fileId: anchor.fileId,
                path: anchor.path,
                side: anchor.side,
                start: anchor.start,
                end: anchor.end,
                collapsed: anchor.collapsed,
            })),
            tests: stop.tests.map((claim) => ({
                kind: claim.kind,
                text: claim.text,
                anchor:
                    claim.anchor === null
                        ? null
                        : { fileId: claim.anchor.fileId, path: claim.anchor.path, line: claim.anchor.line },
            })),
            droppedClaims: stop.droppedClaims,
            validationNotes: stop.validationNotes,
        })),
    });
    return createHash('sha256').update(payload).digest('hex').slice(0, CONTENT_HASH_LENGTH);
}

/** Хук приёмки как шаг транзакции: `carried` въезжает в снапшот до его сериализации. */
function stepOf(snapshot: RouteSnapshot, onSnapshot?: SnapshotHook): (() => TransactionStep) | undefined {
    if (onSnapshot === undefined) {
        return undefined;
    }
    return () => {
        const acceptance = onSnapshot(snapshot);
        return {
            snapshot: { ...snapshot, carried: acceptance.carried },
            ...(acceptance.afterCommit === undefined ? {} : { afterCommit: acceptance.afterCommit }),
        };
    };
}

/**
 * Поля, которых у снапшота старого формата не было. `baseCommit` берётся из локально сохранённой итерации
 * (её мог не успеть записать никто — тогда «неизвестно»), остальное — null: переносить прогресс
 * и считать `change` от снапшота, построенного без этих данных, всё равно не от чего.
 */
function withSnapshotDefaults(raw: unknown, baseCommitOf: (diffId: string) => string | null): unknown {
    if (typeof raw !== 'object' || raw === null) {
        return raw;
    }

    const snapshot = raw as Record<string, unknown>;
    const diffId = snapshot.diffId;
    const stops = snapshot.stops;
    return {
        ...snapshot,
        baseCommit:
            snapshot.baseCommit ??
            (typeof diffId === 'string' ? baseCommitOf(diffId) : null) ??
            UNKNOWN_BASE_COMMIT,
        previousSnapshotId: snapshot.previousSnapshotId ?? null,
        carried: snapshot.carried ?? null,
        // Не массив — отдаём как есть: подстановка превратила бы повреждённую строку в пустой
        // валидный маршрут, а её обязана отбраковать схема.
        stops: Array.isArray(stops)
            ? (stops as unknown[]).map((stop) =>
                  typeof stop === 'object' && stop !== null
                      ? {
                            ...(stop as Record<string, unknown>),
                            change: (stop as Record<string, unknown>).change ?? null,
                        }
                      : stop,
              )
            : stops,
    };
}

function withNote(stop: RouteStop, note: string | undefined): string[] {
    if (note === undefined || stop.validationNotes.includes(note)) {
        return stop.validationNotes;
    }
    return [...stop.validationNotes, note];
}

function sameProvenance(left: RouteProvenance, right: RouteProvenance): boolean {
    return left.harness === right.harness && left.model === right.model;
}

function sameIntents(left: ReadonlyMap<number, string>, right: ReadonlyMap<number, string>): boolean {
    if (left.size !== right.size) {
        return false;
    }
    for (const [key, value] of left) {
        if (right.get(key) !== value) {
            return false;
        }
    }
    return true;
}

function parseIntents(raw: string): Map<number, string> {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
        throw new Error('замыслы стопов хранятся не парами [номер, текст]');
    }

    const intents = new Map<number, string>();
    for (const entry of parsed as unknown[]) {
        if (!Array.isArray(entry) || typeof entry[0] !== 'number' || typeof entry[1] !== 'string') {
            throw new Error('замыслы стопов хранятся не парами [номер, текст]');
        }
        intents.set(entry[0], entry[1]);
    }
    return intents;
}

function parsePlanIndexes(raw: string): number[] {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed) || (parsed as unknown[]).some((item) => typeof item !== 'number')) {
        throw new Error(`Список стопов задачи маршрута повреждён: ${raw}`);
    }
    return parsed as number[];
}

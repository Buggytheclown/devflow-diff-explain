import type {
    HostId,
    Iteration,
    PrDiff,
    ReviewSource,
    RouteSnapshot,
    UiRouteStale,
    UiRouteState,
} from '@sherpa/protocol';

import { RpcFailure } from './errors.js';
import type { IterationStore } from './iteration-store.js';
import type { IterationMap } from './iterations/index.js';
import { affectedStops, buildIterationMap } from './iterations/index.js';
import type { RouteStore } from './route-store.js';

    /**
 * Одна подписка сервера на итерации PR: объединённый список хоста и хранилища,
 * активная итерация и признак «маршрут устарел» для UI.
 *
 * Подписка начинается с первым SSE-клиентом и гаснет без клиентов.
 * До загрузки списка сравнивать снапшот с активной итерацией не с чем.
 */

/** Затронутые стопы одной пары «снапшот → активная итерация»; считаются интердиффом асинхронно. */
interface AffectedStops {
    readonly snapshotId: string;
    readonly headDiffId: HostId;
    /** Якоря, по которым список посчитан: приёмка секций дописывает их в тот же снапшот. */
    readonly anchorsKey: string;
    readonly stopIds: string[];
}


/** Отказ хоста в срезе: `permanent` — источник недостижим навсегда, повторять нечего. */
type CarryRefusal = 'permanent' | 'temporary';

export interface IterationFeedOptions {
    /** null — у PR нет хост-адаптера: итераций не будет никогда. */
    readonly host: ReviewSource | null;
    readonly iterations: IterationStore;
    /**
     * Текущий снапшот: от него считается `stale`, его смена пересчитывает затронутые стопы.
     * История снапшотов — последний адрес, по которому находится база забытой итерации.
     */
    readonly route: Pick<RouteStore, 'current' | 'subscribe' | 'listSnapshots'>;
    /** Куда писать отказы хоста; по умолчанию stderr. */
    readonly log?: (message: string) => void;
}

export class IterationFeed {
    private readonly host: ReviewSource | null;
    private readonly store: IterationStore;
    private readonly route: Pick<RouteStore, 'current' | 'subscribe' | 'listSnapshots'>;
    private readonly log: (message: string) => void;
    private readonly listeners = new Set<(revision: number) => void>();
    /** Идущие расчёты затронутых стопов: второй такой же не нужен. */
    private readonly pending = new Set<string>();
    /** Пары итераций, срез которых хост отверг навсегда: безнадёжный запрос не повторяется. */
    private readonly refused = new Set<string>();
    /** Карта последней пары итераций: считается один раз, читается на каждое изменение снапшота. */
    private map: { pair: string; built: Promise<IterationMap> } | null = null;
    /**
     * Идущие запросы срезов по паре итераций. Срез у Арканума стоит 2.8–3.7 с, а после пуша его
     * просят сразу двое — затронутые остановки и перенос якорей заметок; кэш стора склеит их
     * только после первого ответа, поэтому склейка на лету нужна отдельно.
     */
    private readonly interdiffs = new Map<string, Promise<PrDiff>>();
    private capabilities: Promise<boolean> | null = null;

    private list: Iteration[] = [];
    private affected: AffectedStops | null = null;
    private revisionValue = 0;
    private unwatch: (() => void) | null = null;
    private unsubscribeRoute: (() => void) | null = null;
    /** Идущая загрузка патча активной итерации: параллельные запросы одного и того же не нужны. */
    private diffLoad: { diffId: HostId; patch: Promise<PrDiff> } | null = null;
    /** Идущий разовый запрос списка: вызовы `resolveActive` делят его на всех. */
    private resolving: Promise<void> | null = null;
    private closed = false;

    constructor(options: IterationFeedOptions) {
        this.host = options.host;
        this.store = options.iterations;
        this.route = options.route;
        this.log =
            options.log ??
            ((message: string): void => {
                process.stderr.write(`sherpa-server: ${message}\n`);
            });
    }

    get revision(): number {
        return this.revisionValue;
    }

    /** Объединённый список хоста и хранилища в порядке появления; пустой — подписка ещё не стартовала. */
    iterations(): Iteration[] {
        return this.list.map((iteration) => ({ ...iteration }));
    }

    /** Итерация, которую ревьюирует PR прямо сейчас; null — список ещё не приехал или хоста нет. */
    active(): Iteration | null {
        const active = this.list.find((iteration) => iteration.status === 'active');
        return active === undefined ? null : { ...active };
    }

    /**
     * Активная итерация по требованию: ручкам записи она нужна и без открытого SSE-канала.
     * Известна — отдаётся сразу, иначе список спрашивается у хоста ровно один раз на всех
     * ждущих. Хоста нет — `null`: писать такому серверу некуда, кроме `LEGACY_DIFF_ID`.
     */
    async resolveActive(): Promise<Iteration | null> {
        const host = this.host;
        const known = this.active();
        if (host === null || known !== null || this.closed) {
            return known;
        }

        this.resolving ??= host
            .listIterations()
            .then((iterations) => {
                this.onIterations(iterations);
            })
            .catch((error: unknown) => {
                this.log(`список итераций не получен: ${messageOf(error)}`);
            })
            .finally(() => {
                this.resolving = null;
            });
        await this.resolving;
        return this.active();
    }

    /**
     * «Маршрут устарел» для снапшота. `affectedStopIds` приезжает вторым уведомлением, когда
     * досчитается интердифф: ждать его 2.8–3.7 с у Арканума ради баннера нельзя.
     */
    staleFor(snapshot: RouteSnapshot | null): UiRouteStale | null {
        const stale = staleFor(snapshot, this.list);
        if (stale === null || snapshot === null) {
            return null;
        }

        const affected = this.affected;
        const matches =
            affected !== null &&
            affected.snapshotId === snapshot.snapshotId &&
            affected.headDiffId === stale.prDiffId;
        return matches ? { ...stale, affectedStopIds: [...affected.stopIds] } : stale;
    }

    subscribe(listener: (revision: number) => void): () => void {
        if (this.closed) {
            return () => undefined;
        }

        this.listeners.add(listener);
        this.start();

        let released = false;
        return () => {
            if (released) {
                return;
            }
            released = true;
            this.listeners.delete(listener);
            if (this.listeners.size === 0) {
                this.stop();
            }
        };
    }

    /** Останавливает подписку и отпускает слушателей: сервер закрывается. */
    close(): void {
        this.closed = true;
        this.listeners.clear();
        this.stop();
    }

    private start(): void {
        if (this.host === null || this.unwatch !== null) {
            return;
        }
        this.unsubscribeRoute = this.route.subscribe(() => {
            this.refreshAffected();
        });
        this.unwatch = this.host.watchIterations((iterations) => {
            this.onIterations(iterations);
        });
    }

    private stop(): void {
        this.unwatch?.();
        this.unwatch = null;
        this.unsubscribeRoute?.();
        this.unsubscribeRoute = null;
    }

    /** Список от хоста: сводим с хранилищем, добираем патч активной итерации, пересчитываем stale. */
    private onIterations(hostIterations: Iteration[]): void {
        let merged: Iteration[];
        try {
            merged = this.store.sync(hostIterations);
        } catch (error) {
            this.log(`список итераций не сведён с хранилищем: ${messageOf(error)}`);
            return;
        }

        this.list = merged;
        const active = this.active();
        if (active !== null) {
            void this.activeDiff(active).catch((error: unknown) => {
                this.log(`патч итерации ${active.diffId} не сохранён: ${messageOf(error)}`);
            });
        }
        this.refreshAffected();
        this.notify();
    }

/**
     * Патч активной итерации обязан лежать локально: после следующего пуша снапшот,
     * построенный на ней, читается только по нему (docs/spec.md). Берётся из хранилища, а на
     * промахе — с хоста и сразу в хранилище; параллельные запросы склеиваются в один.
     */
    private activeDiff(active: Iteration): Promise<PrDiff> {
        const stored = this.store.get(active.diffId);
        if (stored !== null) {
            return Promise.resolve(stored.diff);
        }
        const host = this.host;
        if (host === null) {
            return Promise.reject(new Error(`патч итерации ${active.diffId} брать неоткуда: хоста нет`));
        }
        if (this.diffLoad?.diffId === active.diffId) {
            return this.diffLoad.patch;
        }

        const patch = host
            .getDiff()
            .then((diff) => {
                // Пока грузился патч, автор мог запушить снова, и хост отдал патч уже другой
                // итерации: ни писать его в хранилище, ни отдавать вызвавшему как патч `active`
                // нельзя — из чужого патча уехали бы чужие fileId в якоря заметок.
                if (diff.diffId !== active.diffId) {
                    throw new Error(`хост отдал патч итерации ${diff.diffId} вместо ${active.diffId}`);
                }
                if (!this.closed && this.active()?.diffId === active.diffId) {
                    this.store.upsert(diff, active);
                }
                return diff;
            })
            .catch((error: unknown) => {
                this.log(`патч итерации ${active.diffId} не сохранён: ${messageOf(error)}`);
                throw error;
            })
            .finally(() => {
                if (this.diffLoad?.diffId === active.diffId) {
                    this.diffLoad = null;
                }
            });
        this.diffLoad = { diffId: active.diffId, patch };
        return patch;
    }

    /**
     * Срез пары итераций: из кэша хранилища, а на промахе — один запрос к хосту на пару.
     * Затронутые остановки и перенос якорей заметок стартуют после пуша одновременно, и до
     * первого ответа кэш хранилища ещё пуст — второй такой же запрос ждёт первого.
     */
    private interdiff(host: ReviewSource, base: HostId, head: HostId): Promise<PrDiff> {
        const pair = `${base} ${head}`;
        const inflight = this.interdiffs.get(pair);
        if (inflight !== undefined) {
            return inflight;
        }
        const loading = this.store
            .getInterdiff(base, head, () => host.getDiff({ base, head }))
            .finally(() => {
                // Дальше срез отдаёт кэш хранилища: держать патч ещё и в памяти незачем.
                this.interdiffs.delete(pair);
            });
        this.interdiffs.set(pair, loading);
        return loading;
    }

    /** Итерация всё ещё активна, а фид жив: результат сетевого вызова ещё кому-то нужен. */
    private stillActive(diffId: HostId): boolean {
        return !this.closed && this.active()?.diffId === diffId;
    }

    /**
     * Единая политика отказа хоста для всех переносов. Окончательный отказ — источника
     * у хоста больше нет: итерацию смёл force-push (`gone`) или он сам назвал её неизвестной
     * (`bad_request`); всё остальное — временный сбой, который лечится повтором.
     *
     * Спрашивается только про отказ на срезе: сбой патча активной итерации или записи в БД про
     * источник не говорит ничего, а необратимая пометка «якорь потерян» по ним недопустима.
     */
    private carryRefusal(from: HostId, error: unknown): CarryRefusal {
        if (error instanceof RpcFailure && error.code === 'bad_request') {
            return 'permanent';
        }
        const known = this.list.find((iteration) => iteration.diffId === from);
        return known?.status === 'gone' ? 'permanent' : 'temporary';
    }

    /**
     * Затронутые стопы считаются для текущего снапшота против активной итерации. Пересчёт нужен
     * не только на смену снапшота или итерации: пуш посреди генерации застаёт стопы без якорей,
     * и настоящий список появляется, только когда их допишет приёмка секций.
     */
    private refreshAffected(): void {
        const snapshot = this.route.current();
        const active = this.active();
        if (snapshot === null || snapshot.presentation === 'story' || active === null || snapshot.diffId === active.diffId) {
            this.affected = null;
            return;
        }

        const anchorsKey = anchorsKeyOf(snapshot);
        const affected = this.affected;
        const samePair =
            affected !== null &&
            affected.snapshotId === snapshot.snapshotId &&
            affected.headDiffId === active.diffId;
        if (samePair && affected.anchorsKey === anchorsKey) {
            return;
        }
        if (!samePair) {
            // Список прошлой пары к этой не относится. Посчитанный по неполным якорям остаётся:
            // он неполон, но не врёт, и живёт до пересчёта.
            this.affected = null;
        }

        const pair = `${snapshot.diffId} ${active.diffId}`;
        const key = `${snapshot.snapshotId} ${pair} ${anchorsKey}`;
        if (this.pending.has(key) || this.refused.has(pair)) {
            return;
        }
        this.pending.add(key);
        void this.computeAffected(snapshot, active, key);
    }

    private async computeAffected(snapshot: RouteSnapshot, active: Iteration, key: string): Promise<void> {
        const host = this.host;
        const pair = `${snapshot.diffId} ${active.diffId}`;
        if (host === null) {
            this.pending.delete(key);
            return;
        }

        try {
            if (!(await this.supportsInterdiff(host))) {
                // Срезов у хоста нет вовсе: считать список нечем и не станет — как отказ навсегда.
                this.refused.add(pair);
                this.log(`затронутые остановки снапшота ${snapshot.snapshotId} не посчитаны: хост без срезов`);
                return;
            }
            let map: IterationMap;
            try {
                map = await this.iterationMap(host, snapshot, active);
            } catch (error) {
                this.refuseAffected(snapshot, pair, error);
                return;
            }
            // Пока считался срез, ревьюер мог перестроить маршрут, автор — запушить снова,
            // а приёмка секции — дописать якоря: список строится по свежему снапшоту.
            const current = this.route.current();
            if (
                this.closed ||
                current?.snapshotId !== snapshot.snapshotId ||
                this.active()?.diffId !== active.diffId
            ) {
                return;
            }
            this.affected = {
                snapshotId: current.snapshotId,
                headDiffId: active.diffId,
                anchorsKey: anchorsKeyOf(current),
                stopIds: affectedStops(current, map),
            };
            this.notify();
        } catch (error) {
            // Опрос возможностей хоста и расчёт самого списка про итерацию снапшота ничего не
            // говорят: пара не безнадёжна, пересчёт придёт со следующим событием.
            this.log(
                `затронутые остановки снапшота ${snapshot.snapshotId} не посчитаны, пересчитаем: ${messageOf(error)}`,
            );
        } finally {
            this.pending.delete(key);
        }
    }

    /**
     * Срез для затронутых остановок не приехал: баннер остаётся без списка остановок. Срез с
     * `gone`-итерацией безнадёжен, а сетевой сбой пересчитается на следующем событии — вместе с
     * парой забывается и её карта, иначе пересчёт достал бы из памяти ту же ошибку, не спросив
     * хост заново.
     */
    private refuseAffected(snapshot: RouteSnapshot, pair: string, error: unknown): void {
        const refusal = this.carryRefusal(snapshot.diffId, error);
        if (refusal === 'permanent') {
            this.refused.add(pair);
        } else if (this.map?.pair === pair) {
            this.map = null;
        }
        this.log(
            `затронутые остановки снапшота ${snapshot.snapshotId} не посчитаны` +
                `${refusal === 'temporary' ? ', пересчитаем' : ''}: ${messageOf(error)}`,
        );
    }

    /**
     * Карта переноса строк между итерацией снапшота и активной. Пара считается один раз: срез у
     * Арканума стоит 2.8–3.7 с, а пересчёт списка на каждую сданную секцию обязан быть дешёвым.
     * Пара живёт до следующего пуша, поэтому слот один, а не кэш.
     */
    private iterationMap(host: ReviewSource, snapshot: RouteSnapshot, active: Iteration): Promise<IterationMap> {
        const pair = `${snapshot.diffId} ${active.diffId}`;
        if (this.map?.pair !== pair) {
            this.map = {
                pair,
                built: this.interdiff(host, snapshot.diffId, active.diffId).then((interdiff) =>
                    buildIterationMap({
                        interdiff,
                        fromBaseCommit: snapshot.baseCommit,
                        toBaseCommit: active.baseCommit,
                    }),
                ),
            };
        }
        return this.map.built;
    }

    private supportsInterdiff(host: ReviewSource): Promise<boolean> {
        this.capabilities ??= host.getPr().then((pr) => pr.capabilities.iterations).catch((error: unknown) => {
            this.capabilities = null;
            throw error;
        });
        return this.capabilities;
    }

    private notify(): void {
        this.revisionValue += 1;
        if (this.closed) {
            return;
        }
        for (const listener of [...this.listeners]) {
            listener(this.revisionValue);
        }
    }
}

/**
 * Правило «маршрут устарел»: снапшот построен не на той итерации, которую
 * PR ревьюирует сейчас. Фаза генерации на это не влияет — приоритеты баннеров разруливает UI.
 *
 * `affectedStopIds` здесь всегда пуст: он требует интердиффа, а это сетевой вызов (`IterationFeed`).
 */
export function staleFor(snapshot: RouteSnapshot | null, iterations: readonly Iteration[]): UiRouteStale | null {
    if (snapshot === null) {
        return null;
    }
    const active = iterations.find((iteration) => iteration.status === 'active');
    if (active === undefined || active.diffId === snapshot.diffId) {
        return null;
    }

    // Итерации снапшота в списке нет (force-push смёл её и хранилище о ней не знает) — считаем
    // с начала истории; схема требует хотя бы одну новую итерацию, и она точно есть.
    const own = iterations.find((iteration) => iteration.diffId === snapshot.diffId);
    const since = own?.createdAt ?? '';
    const newer = iterations.filter(
        (iteration) => iteration.status !== 'gone' && iteration.createdAt.localeCompare(since) > 0,
    ).length;

    return {
        routeCommit: snapshot.commit,
        prCommit: active.headCommit,
        prDiffId: active.diffId,
        newIterations: Math.max(1, newer),
        affectedStopIds: [],
    };
}

/** Состояние маршрута для UI: `stale` считается на границе чтения и в хранилище не живёт. */
export function withStale(state: UiRouteState, feed: IterationFeed | null): UiRouteState {
    return { ...state, stale: feed?.staleFor(state.snapshot) ?? null };
}

/**
 * Ревизия маршрута глазами UI. `stale` не хранится в `RouteStore`, поэтому его ревизия на пуш
 * не реагирует — а UI обязан перечитать маршрут. Обе ревизии монотонны, значит монотонна и сумма.
 */
export function routeRevisionOf(store: Pick<RouteStore, 'revision'>, feed: IterationFeed | null): number {
    return store.revision + (feed?.revision ?? 0);
}

/** Отпечаток якорей снапшота: по ним и только по ним считается список затронутых стопов. */
function anchorsKeyOf(snapshot: RouteSnapshot): string {
    return snapshot.stops
        .map(
            (stop) =>
                `${stop.id}:` +
                stop.anchors
                    .map((anchor) => `${anchor.path}#${anchor.side}${String(anchor.start)}-${String(anchor.end)}`)
                    .join(','),
        )
        .join(';');
}

function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

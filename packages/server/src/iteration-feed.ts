import type { Iteration, PrDiff, CodeReader, RouteSnapshot, UiRouteStale, UiRouteState } from '@sherpa/protocol';
import type { IterationStore } from './iteration-store.js';
import type { RouteStore } from './route-store.js';

export interface IterationFeedOptions {
    readonly host: CodeReader | null;
    readonly iterations: IterationStore;
    readonly route: Pick<RouteStore, 'current' | 'subscribe' | 'listSnapshots'>;
    readonly log?: (message: string) => void;
}

/** Версии импортированных снимков. Уведомление исходит только от локального импорта. */
export class IterationFeed {
    private revisionValue = 0;
    private list: Iteration[];
    private readonly listeners = new Set<(revision: number) => void>();
    private unwatch: (() => void) | null = null;
    private closed = false;
    constructor(private readonly options: IterationFeedOptions) { this.list = options.iterations.list(); }
    get revision(): number { return this.revisionValue; }
    iterations(): Iteration[] { return this.list.map((item) => ({ ...item })); }
    active(): Iteration | null { return this.list.find((item) => item.status === 'active') ?? null; }
    async resolveActive(): Promise<Iteration | null> {
        if (!this.closed && this.options.host !== null) await this.update(await this.options.host.listIterations());
        return this.active();
    }
    staleFor(snapshot: RouteSnapshot | null): UiRouteStale | null { return staleFor(snapshot, this.list); }
    subscribe(listener: (revision: number) => void): () => void {
        if (this.closed) return () => undefined;
        this.listeners.add(listener);
        this.unwatch ??= this.options.host?.subscribeVersions((items) => { void this.update(items); }) ?? null;
        return () => {
            this.listeners.delete(listener);
            if (this.listeners.size === 0) { this.unwatch?.(); this.unwatch = null; }
        };
    }
    close(): void { this.closed = true; this.unwatch?.(); this.unwatch = null; this.listeners.clear(); }
    private isClosed(): boolean { return this.closed; }
    private async update(items: Iteration[]): Promise<void> {
        if (this.closed) return;
        this.list = this.options.iterations.sync(items);
        const active = this.active();
        // Совместимость unit fixtures. Production reader уже имеет все патчи в БД.
        if (active !== null && this.options.iterations.get(active.diffId) === null) {
            const diff: PrDiff | undefined = await this.options.host?.getDiff().catch(() => undefined);
            if (!this.isClosed() && diff?.diffId === active.diffId) this.options.iterations.upsert(diff, active);
            else this.options.log?.(`Сохранённый патч не совпадает с версией ${active.diffId}.`);
        }
        if (this.isClosed()) return;
        this.revisionValue += 1;
        for (const listener of this.listeners) listener(this.revisionValue);
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

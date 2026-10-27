import type {
    HostCapabilities,
    HostId,
    Iteration,
    PrDiff,
    ReviewSource,
    RouteSnapshot,
    UiRouteStale,
    UiRouteState,
} from '@sherpa/protocol';

import type { ChatStore } from './chat-store.js';
import { RpcFailure } from './errors.js';
import type { IterationStore } from './iteration-store.js';
import type { IterationMap } from './iterations/index.js';
import { affectedStops, buildIterationMap, opaqueMap } from './iterations/index.js';
import type { ProgressStore } from './progress-store.js';
import type { RouteStore } from './route-store.js';
import { UNKNOWN_BASE_COMMIT } from './route-store.js';

/**
 * Одна подписка сервера на итерации PR: объединённый список хоста и хранилища,
 * активная итерация и признак «маршрут устарел» для UI.
 *
 * Отдельно от `ReviewFeed`: у тредов и итераций разные потребители и разная механика —
 * итерации несут состояние (список, активная, затронутые стопы), треды только ревизию.
 *
 * Подписка ленивая, как у `ReviewFeed`: стартует с первым SSE-клиентом и гаснет без клиентов,
 * иначе поллинг Арканума крутился бы в пустоту. До старта список пуст, а `stale` — `null`:
 * без активной итерации сравнивать снапшот не с чем.
 */

/** Затронутые стопы одной пары «снапшот → активная итерация»; считаются интердиффом асинхронно. */
interface AffectedStops {
    readonly snapshotId: string;
    readonly headDiffId: HostId;
    /** Якоря, по которым список посчитан: приёмка секций дописывает их в тот же снапшот. */
    readonly anchorsKey: string;
    readonly stopIds: string[];
}

/** Всё, что фиду нужно от хранилища чата, чтобы перевезти якоря заметок на новую итерацию. */
export type NoteCarrier = Pick<ChatStore, 'adoptLegacyAnchors' | 'migrateNotes' | 'read'>;

/** Через столько повторяем перенос, если хост не отдал срез по временной причине. */
const CARRY_RETRY_MS = 30_000;

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
    /** Заметки, чьи якоря переезжают на новую итерацию; null — переносить некому. */
    readonly notes?: NoteCarrier | null;
    /** Пауза перед повтором переносов после временного отказа хоста. */
    readonly carryRetryMs?: number;
    /** Прогресс чтения: пуш переносит его на новую итерацию. `null` — переносить нечего. */
    readonly progress?: ProgressCarrier | null;
    /** Куда писать отказы хоста; по умолчанию stderr. */
    readonly log?: (message: string) => void;
}

/** Часть `ProgressStore`, которая нужна фиду: усыновление легаси и перенос на активную итерацию. */
export type ProgressCarrier = Pick<
    ProgressStore,
    'adoptLegacy' | 'latestDiffIdWithProgress' | 'carryRanges'
>;

export class IterationFeed {
    private readonly host: ReviewSource | null;
    private readonly store: IterationStore;
    private readonly route: Pick<RouteStore, 'current' | 'subscribe' | 'listSnapshots'>;
    private readonly notes: NoteCarrier | null;
    private readonly carryRetryMs: number;
    private readonly progress: ProgressCarrier | null;
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

    /**
     * Идущие переносы одной пары итераций: второй такой же не нужен. Ключ начинается с имени
     * переносчика (`notes` / `progress`) — прогресс и якоря заметок едут независимо.
     */
    private readonly carrying = new Set<string>();
    /** Источники переноса, срез с которыми хост отверг: ключ — итерация, на которую переносим. */
    private readonly refusedCarry = new Map<HostId, Set<HostId>>();
    /** Итерации, про которые уже сказано «источник не найден»: событий вотчера много, строка одна. */
    private readonly reportedNoSource = new Set<HostId>();

    private list: Iteration[] = [];
    private affected: AffectedStops | null = null;
    private revisionValue = 0;
    private unwatch: (() => void) | null = null;
    private unsubscribeRoute: (() => void) | null = null;
    /** Идущая загрузка патча активной итерации: параллельные запросы одного и того же не нужны. */
    private diffLoad: { diffId: HostId; patch: Promise<PrDiff> } | null = null;
    /** Отложенный повтор переносов после временного отказа хоста; null — повторять нечего. */
    private carryRetry: ReturnType<typeof setTimeout> | null = null;
    /** Возможности хоста: спрашиваются один раз — от них зависит, есть ли чем переносить якоря. */
    private capabilities: Promise<HostCapabilities> | null = null;
    /** Идущий разовый запрос списка: вызовы `resolveActive` делят его на всех. */
    private resolving: Promise<void> | null = null;
    private closed = false;

    constructor(options: IterationFeedOptions) {
        this.host = options.host;
        this.store = options.iterations;
        this.route = options.route;
        this.notes = options.notes ?? null;
        this.carryRetryMs = options.carryRetryMs ?? CARRY_RETRY_MS;
        this.progress = options.progress ?? null;
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
        if (this.carryRetry !== null) {
            clearTimeout(this.carryRetry);
            this.carryRetry = null;
        }
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
            // Перенос прогресса ждёт патча новой итерации: без него `fileId` не сопоставить.
            void this.activeDiff(active)
                .then(() => this.carryProgress(active))
                .catch((error: unknown) => {
                    // Перенос пишет в БД: его отказ не должен ронять процесс через unhandled rejection.
                    this.log(`прогресс не перенесён на ${active.diffId}: ${messageOf(error)}`);
                });
            // Свой патч заметки ждут сами: у переноса якорей есть повтор после отказа хоста.
            this.carryNotes(active);
        }
        this.refreshAffected();
        this.notify();
    }

    /**
     * Патч активной итерации обязан лежать локально: после следующего пуша снапшот,
     * построенный на ней, читается только по нему (docs/product.md §4a). Берётся из хранилища, а на
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
     * Якоря заметок переезжают на активную итерацию. Обычно переносить надо с одной
     * итерации, но два пуша подряд без открытого UI оставляют заметки на разных — поэтому
     * набор, а не одна пара. Заметка, уже потерявшая якорь, не мигрирует больше никогда.
     */
    private carryNotes(active: Iteration): void {
        const notes = this.notes;
        if (notes === null) {
            return;
        }

        try {
            notes.adoptLegacyAnchors(active.diffId);
        } catch (error) {
            this.log(`якоря заметок старого формата не усыновлены: ${messageOf(error)}`);
            return;
        }

        const refused = this.refusedSourcesFor(active.diffId);
        const stale = new Set(
            notes
                .read()
                .notes.filter((note) => !note.lostAnchor && note.anchor.diffId !== active.diffId)
                .map((note) => note.anchor.diffId),
        );
        for (const from of stale) {
            if (refused.has(from)) {
                continue;
            }
            const pair = `notes ${from} ${active.diffId}`;
            if (this.carrying.has(pair)) {
                continue;
            }
            this.carrying.add(pair);
            void this.carryNotesFrom(notes, from, active, pair);
        }
    }

    private async carryNotesFrom(
        notes: NoteCarrier,
        from: HostId,
        active: Iteration,
        pair: string,
    ): Promise<void> {
        try {
            const host = this.host;
            // Без срезов у хоста переносить нечем: карта пустая, заметки честно теряют якорь.
            const blind = host === null || !(await this.hostCapabilities(host)).iterations;
            const carry = blind ? { map: opaqueMap(), refusal: null } : await this.noteCarry(host, from, active);
            if (carry === null) {
                return;
            }
            // Пустой карте файлы не нужны: затронуто всё, и якорь теряется независимо от `fileId`.
            const fileIdOf = carry.refusal === null ? await this.activeFileIds(active) : (): null => null;
            // Пока считался срез, автор мог запушить снова: переносить на уже неактивную итерацию нельзя.
            if (this.closed || this.active()?.diffId !== active.diffId) {
                return;
            }
            const migration = notes.migrateNotes(from, active.diffId, carry.map, fileIdOf, active.headCommit);
            if (carry.refusal !== null) {
                // Источник отказан только после удачной записи: иначе повтора уже не будет, а
                // заметки остались бы с якорем на итерации, которой у хоста нет.
                this.refusedSourcesFor(active.diffId).add(from);
                this.log(
                    `срез ${from}→${active.diffId} хост отверг окончательно, ` +
                        `заметок без якоря ${String(migration.lost)}: ${carry.refusal}`,
                );
            }
        } catch (error) {
            // Патч активной итерации и запись в БД про источник ничего не говорят: только повтор.
            this.log(`якоря заметок итерации ${from} не перенесены, будет повтор: ${messageOf(error)}`);
            this.scheduleCarryRetry();
        } finally {
            this.carrying.delete(pair);
        }
    }

    /**
     * Карта переноса якорей с источника: `refusal` — причина окончательного отказа хоста, при
     * которой карта пустая и заметки теряют якорь. `null` вместо карты — временный отказ, повтор
     * назначен: соврать «якорь потерян» из-за сетевой ошибки нельзя, это необратимо.
     */
    private async noteCarry(
        host: ReviewSource,
        from: HostId,
        active: Iteration,
    ): Promise<{ map: IterationMap; refusal: string | null } | null> {
        try {
            return { map: await this.noteMap(host, from, active), refusal: null };
        } catch (error) {
            if (this.carryRefusal(from, error) === 'temporary') {
                this.log(`якоря заметок итерации ${from} не перенесены, будет повтор: ${messageOf(error)}`);
                this.scheduleCarryRetry();
                return null;
            }
            // Пустая карта: всё считается затронутым — ровно то же, что у хоста без срезов.
            return { map: opaqueMap(), refusal: messageOf(error) };
        }
    }

    /** Путь → `fileId` в патче активной итерации; null — файла там нет. */
    private async activeFileIds(active: Iteration): Promise<(path: string) => string | null> {
        const files = new Map((await this.activeDiff(active)).files.map((file) => [file.path, file.fileId]));
        return (path) => files.get(path) ?? null;
    }

    /**
     * Повтор переноса после временного отказа хоста — и якорей заметок, и прогресса: срез у них
     * общий, значит и отказ общий. Ждать следующего списка итераций нельзя: вотчер будит фид
     * только на новый пуш, а до тех пор заметка с якорем прошлой итерации не находит своего
     * файла в активном диффе и пропадает из кода — без баннера и без пометки в чате.
     */
    private scheduleCarryRetry(): void {
        if (this.closed || this.unwatch === null || this.carryRetry !== null) {
            return;
        }
        this.carryRetry = setTimeout(() => {
            this.carryRetry = null;
            const active = this.active();
            if (this.closed || this.unwatch === null || active === null) {
                return;
            }
            this.carryNotes(active);
            void this.activeDiff(active)
                .then(() => this.carryProgress(active))
                .catch((error: unknown) => {
                    this.log(`прогресс не перенесён на ${active.diffId}: ${messageOf(error)}`);
                });
        }, this.carryRetryMs);
        // Таймер процесс живым не держит и активностью сервера не считается (см. idle.ts).
        this.carryRetry.unref();
    }

    /**
     * Карта переноса строк для заметок. Наружу отдаёт только отказ хоста на срезе: по нему и
     * решается, повторять перенос или хоронить якоря.
     */
    private async noteMap(host: ReviewSource, from: HostId, active: Iteration): Promise<IterationMap> {
        const fromIteration =
            this.list.find((iteration) => iteration.diffId === from) ?? this.store.get(from)?.iteration ?? null;
        if (fromIteration === null) {
            // Итерации нет ни в списке, ни в хранилище: её базу не с чем сравнить.
            return opaqueMap();
        }
        const interdiff = await this.interdiff(host, from, active.diffId);
        return buildIterationMap({
            interdiff,
            fromBaseCommit: fromIteration.baseCommit,
            toBaseCommit: active.baseCommit,
        });
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

    private hostCapabilities(host: ReviewSource): Promise<HostCapabilities> {
        this.capabilities ??= host
            .getPr()
            .then((pr) => pr.capabilities)
            .catch((error: unknown) => {
                this.capabilities = null;
                throw error;
            });
        return this.capabilities;
    }

    /**
     * Прогресс переезжает на активную итерацию: сначала усыновляются
     * записи без итерации, потом переносятся диапазоны и файловые отметки самой поздней
     * итерации, у которой они есть.
     *
     * Пара переносится один раз и навсегда (`progress_carries`), поэтому повторный список
     * хоста ничего не дублирует.
     */
    private async carryProgress(active: Iteration): Promise<void> {
        const progress = this.progress;
        const host = this.host;
        if (progress === null || host === null || this.closed) {
            return;
        }

        progress.adoptLegacy(active.diffId);
        const refused = this.refusedSourcesFor(active.diffId);
        for (;;) {
            const from = progress.latestDiffIdWithProgress(active.diffId, [...refused]);
            if (from === null) {
                if (!this.reportedNoSource.has(active.diffId)) {
                    this.reportedNoSource.add(active.diffId);
                    this.log(
                        `перенос прогресса на ${active.diffId}: источник не найден — ` +
                            'прогресса на других итерациях нет',
                    );
                }
                return;
            }
            if (!(await this.progressSlices(host, active))) {
                return;
            }

            const pair = `progress ${from} ${active.diffId}`;
            if (this.carrying.has(pair)) {
                return;
            }
            this.carrying.add(pair);
            try {
                const slice = await this.interdiff(host, from, active.diffId).then(
                    (interdiff) => ({ interdiff }),
                    (error: unknown) => {
                        const refusal = this.carryRefusal(from, error);
                        this.log(
                            `срез ${from}→${active.diffId} не получен` +
                                `${refusal === 'temporary' ? ', будет повтор' : ' и не будет'}: ${messageOf(error)}`,
                        );
                        return { refusal };
                    },
                );
                if ('refusal' in slice) {
                    if (slice.refusal === 'temporary') {
                        // Сетевой сбой не повод понижать источник: у более ранней итерации
                        // прогресс старее, и подменять им свежий молча нельзя.
                        this.scheduleCarryRetry();
                        return;
                    }
                    // Источника не существует (обычно его смёл force-push): берём следующего
                    // кандидата — прогресс есть и у более ранних итераций.
                    refused.add(from);
                    continue;
                }
                const interdiff = slice.interdiff;
                if (!this.stillActive(active.diffId)) {
                    // Пока считался срез, автор запушил снова: перенос поедет на новую активную.
                    return;
                }

                const fromBaseCommit = this.baseCommitOf(from);
                const result = progress.carryRanges(
                    from,
                    active.diffId,
                    buildIterationMap({ interdiff, fromBaseCommit, toBaseCommit: active.baseCommit }),
                );
                if (fromBaseCommit === null && !result.skipped) {
                    this.log(
                        `перенос прогресса ${from} → ${active.diffId}: база итерации ${from} неизвестна, ` +
                            'диапазоны старой стороны не переносятся',
                    );
                }
                return;
            } finally {
                this.carrying.delete(pair);
            }
        }
    }

    /**
     * База итерации: список хоста, сохранённый патч, снапшот маршрута, построенный на ней.
     * `null` — неизвестна: подставить базу активной итерации значило бы построить заведомо
     * кривую карту строк и молча перенести по ней старую сторону.
     */
    private baseCommitOf(diffId: HostId): string | null {
        const known =
            this.list.find((iteration) => iteration.diffId === diffId)?.baseCommit ??
            this.store.get(diffId)?.iteration.baseCommit;
        if (known !== undefined) {
            return known;
        }
        // Снапшот старого формата базы в себе не несёт, и `RouteStore` подставляет в неё
        // заглушку. Принять её за коммит — то же самое, что взять базу наугад.
        const stored = this.route.listSnapshots().findLast((snapshot) => snapshot.diffId === diffId);
        const base = stored?.baseCommit;
        return base === undefined || base === UNKNOWN_BASE_COMMIT ? null : base;
    }

    /**
     * Есть ли чем переносить прогресс. Хост без срезов отвергнет любую пару, и перебирать
     * источники незачем; неудачный опрос возможностей — про хост, а не про источник: повтор.
     */
    private async progressSlices(host: ReviewSource, active: Iteration): Promise<boolean> {
        try {
            const { iterations } = await this.hostCapabilities(host);
            if (!iterations) {
                this.log(`прогресс не перенесён на ${active.diffId}: хост без срезов`);
            }
            return iterations;
        } catch (error) {
            this.log(`прогресс не перенесён на ${active.diffId}, будет повтор: ${messageOf(error)}`);
            this.scheduleCarryRetry();
            return false;
        }
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

    /** Источники, срез с которыми хост отверг навсегда для этой активной итерации. */
    private refusedSourcesFor(toDiffId: HostId): Set<HostId> {
        const known = this.refusedCarry.get(toDiffId);
        if (known !== undefined) {
            return known;
        }
        const empty = new Set<HostId>();
        this.refusedCarry.set(toDiffId, empty);
        return empty;
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
            if (!(await this.hostCapabilities(host)).iterations) {
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

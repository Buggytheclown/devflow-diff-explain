import type {
    HostId,
    PrDiff,
    RouteAnchor,
    UiFileProgress,
    UiSeenRange,
    UiStopProgress,
    UiStopSeenRange,
} from '@sherpa/protocol';

import type { SherpaDatabase, SqlRow } from './db.js';
import { transaction } from './db.js';
import type { IterationStore } from './iteration-store.js';
import type { IterationMap } from './iterations/index.js';
import { LEGACY_DIFF_ID } from './iterations/index.js';
import type { ChangedFile } from './route/diff-index.js';
import { indexDiff } from './route/diff-index.js';
import type { LineRange } from './route/ranges.js';

/** Слушатель изменений прогресса; его забирает SSE-канал UI (`UI_PROGRESS_EVENT`). */
export type ProgressListener = (revision: number) => void;

export interface ProgressStoreOptions {
    readonly db: SherpaDatabase;
    /** Патчи итераций: по ним перенос сопоставляет `fileId` двух итераций через `path`. */
    readonly iterations?: Pick<IterationStore, 'get'> | null;
    /** Инжектируемые часы: тестам удобно проверять `updated_at` без реального времени. */
    readonly now?: () => Date;
    /** Куда писать счётчики переноса; по умолчанию stderr. */
    readonly log?: (message: string) => void;
}

/** Итог переноса диапазонов между итерациями. `skipped` — в хранилище ничего не записано. */
export interface CarryResult {
    readonly ranges: number;
    readonly files: number;
    readonly skipped: boolean;
    /** Сколько диапазонов лежало на источнике: против них и считается результат. */
    readonly sourceRanges: number;
    /** Диапазоны, чей `fileId` не привёлся к пути ни одним слоем резолвера: сбой сопоставления. */
    readonly unmappedRanges: number;
    /** Диапазоны, чей путь известен, но такого файла в целевой итерации нет: правка автора. */
    readonly missingRanges: number;
    /** Диапазоны источника, которых коснулся интердифф: перенеслись частично или никак. */
    readonly touchedRanges: number;
}

/** Что переносит отметки остановок нового снапшота (`carryStopsInTransaction`). */
export interface StopCarryInput {
    readonly snapshotId: string;
    /** Итерация снапшота: под ней лежат перенесённые диапазоны и файловые отметки. */
    readonly diffId: HostId;
    readonly stops: readonly StopAnchors[];
    /** Дифф итерации снапшота: из него берутся изменённые строки и `fileId` по пути якоря. */
    readonly diff: PrDiff;
}

export interface StopAnchors {
    readonly id: string;
    readonly anchors: readonly RouteAnchor[];
}

/** Итог переноса отметок остановок; эффект ревизии — только после коммита общей транзакции. */
export interface StopCarryResult {
    readonly kept: number;
    readonly afterCommit: () => void;
}

interface ProgressRow extends SqlRow {
    file_id: string;
    viewed: number;
}

interface RangeRow extends SqlRow {
    file_id: string;
    side: string;
    start_line: number;
    end_line: number;
}

/** Та же строка с путём файла: колонка заполнена у записей 0.5.x и пуста у всех прежних. */
interface PathedRangeRow extends RangeRow {
    path: string | null;
}

interface PathedProgressRow extends ProgressRow {
    path: string | null;
}

/** Та же строка с автором отметки: null — перенос или чтение файла, иначе id остановки. */
interface SourcedRangeRow extends RangeRow {
    source_stop_id: string | null;
}

interface StopRow extends SqlRow {
    stop_id: string;
    viewed: number;
}

/** Та же строка с пометкой «остановка уже учтена переносом на этот снапшот». */
interface CarriedStopRow extends StopRow {
    carried: number;
}

interface SourceStopRow extends SqlRow {
    source_stop_id: string;
}

interface DiffIdRow extends SqlRow {
    diff_id: string;
}

interface CountRow extends SqlRow {
    count: number;
}

/** JSON-блоб снапшота маршрута или якоря заметки: разбирается вручную, без схемы протокола. */
interface JsonRow extends SqlRow {
    json: string;
}

/** Оба якоря заметки: текущий и тот, с которым её создали (миграция `014-notes-anchors`). */
interface NoteAnchorRow extends SqlRow {
    anchor: string;
    origin_anchor: string | null;
}

/** Всё, что переносу нужно от чужого якоря: соответствие непрозрачного `fileId` пути. */
interface AnchorPath {
    readonly fileId: string;
    readonly path: string;
}

/** Куда запись источника ложится в целевой итерации (`carryRangesInTransaction`). */
type Resolution =
    | { readonly kind: 'mapped'; readonly path: string; readonly fileId: string }
    | { readonly kind: 'unmapped' }
    | { readonly kind: 'missing' };

/** Диапазон в координатах одной стороны файла итерации. */
interface SeenRange {
    readonly fileId: string;
    readonly side: 'old' | 'new';
    readonly start: number;
    readonly end: number;
}

/**
 * Прогресс чтения PR (docs/architecture.md §3): истина — SQLite этого PR,
 * а не хост и не память вкладки.
 *
 * Запись по файлу существует только после явного действия ревьюера (`viewed: true` — пин
 * `read` навсегда, `viewed: false` — снятие пина); отсутствие записи трактует UI. Seen-диапазоны
 * приносят отметки остановок и карточек файлов в них: их считает UI от своей модели диффа,
 * сервер хранит их с привязкой к стопу и не интерпретирует.
 *
 * Всё измерено итерацией: файлы и диапазоны ключуются `diffId`, отметки остановок —
 * снапшотом. Какая итерация «активная», знают ручки, а не стор: он получает её аргументом.
 * После пуша прогресс переезжает на новую итерацию `carryRanges`, а отметки остановок нового
 * снапшота ставит `carryStopsInTransaction` внутри приёмки маршрута.
 *
 * Ревизия монотонна от старта сервера (семантика `ReviewFeed.revision`): выросла против виденной —
 * вкладке пора перечитать ручку. Идемпотентная запись ревизию не двигает: будить остальные вкладки
 * нечем.
 */
export class ProgressStore {
    private readonly db: SherpaDatabase;
    private readonly iterations: Pick<IterationStore, 'get'> | null;
    private readonly now: () => Date;
    private readonly log: (message: string) => void;
    private readonly listeners = new Set<ProgressListener>();
    private readonly txSetViewed: (
        diffId: HostId,
        fileId: string,
        viewed: boolean,
        snapshotId: string | null,
    ) => boolean;
    private readonly txSetStopViewed: (
        snapshotId: string,
        diffId: HostId,
        stopId: string,
        viewed: boolean,
        ranges: readonly UiStopSeenRange[],
    ) => boolean;
    private readonly txSetStopFileViewed: (
        snapshotId: string,
        diffId: HostId,
        stopId: string,
        fileId: string,
        viewed: boolean,
        ranges: readonly UiSeenRange[],
    ) => boolean;
    private readonly txAdoptLegacy: (diffId: HostId) => boolean;
    private readonly txCarryRanges: (from: HostId, to: HostId, map: IterationMap) => CarryResult;

    /** Последняя разобранная карта путей итерации: разбор патча дорог, а сам патч неизменен. */
    private pathCache: { diffId: HostId; paths: ReadonlyMap<string, string> } | null = null;
    private revisionValue = 0;
    private closed = false;

    constructor(options: ProgressStoreOptions) {
        this.db = options.db;
        this.iterations = options.iterations ?? null;
        this.now = options.now ?? ((): Date => new Date());
        this.log =
            options.log ??
            ((message: string): void => {
                process.stderr.write(`sherpa-server: ${message}\n`);
            });
        this.txSetViewed = transaction(
            this.db,
            (diffId: HostId, fileId: string, viewed: boolean, snapshotId: string | null) =>
                this.setViewedInTransaction(diffId, fileId, viewed, snapshotId),
        );
        this.txSetStopViewed = transaction(
            this.db,
            (
                snapshotId: string,
                diffId: HostId,
                stopId: string,
                viewed: boolean,
                ranges: readonly UiStopSeenRange[],
            ) => this.setStopViewedInTransaction(snapshotId, diffId, stopId, viewed, ranges),
        );
        this.txSetStopFileViewed = transaction(
            this.db,
            (
                snapshotId: string,
                diffId: HostId,
                stopId: string,
                fileId: string,
                viewed: boolean,
                ranges: readonly UiSeenRange[],
            ) => this.setStopFileViewedInTransaction(snapshotId, diffId, stopId, fileId, viewed, ranges),
        );
        this.txAdoptLegacy = transaction(this.db, (diffId: HostId) => this.adoptLegacyInTransaction(diffId));
        this.txCarryRanges = transaction(this.db, (from: HostId, to: HostId, map: IterationMap) =>
            this.carryRangesInTransaction(from, to, map),
        );
    }

    get revision(): number {
        return this.revisionValue;
    }

    /**
     * Прогресс одной итерации. Файл, у которого есть только диапазоны, приезжает
     * с `viewed: null`: решения ревьюера нет, поэтому UI применит умолчания и учтёт диапазоны
     * при необходимости.
     */
    read(diffId: HostId): UiFileProgress[] {
        const ranges = new Map<string, UiSeenRange[]>();
        const rangeRows = this.db
            .prepare(
                `SELECT file_id, side, start_line, end_line FROM file_seen_ranges
                  WHERE diff_id = ? ORDER BY rowid`,
            )
            .all(diffId) as RangeRow[];
        for (const row of rangeRows) {
            const list = ranges.get(row.file_id) ?? [];
            list.push({ side: sideOf(row.side), start: row.start_line, end: row.end_line });
            ranges.set(row.file_id, list);
        }

        const rows = this.db
            .prepare('SELECT file_id, viewed FROM file_progress WHERE diff_id = ?')
            .all(diffId) as ProgressRow[];
        const files: UiFileProgress[] = rows.map((row) => ({
            fileId: row.file_id,
            viewed: row.viewed === 1,
            seenRanges: ranges.get(row.file_id) ?? [],
        }));

        const marked = new Set(files.map((file) => file.fileId));
        for (const [fileId, seenRanges] of ranges) {
            if (!marked.has(fileId)) {
                files.push({ fileId, viewed: null, seenRanges });
            }
        }
        return files;
    }

    /** Отметки остановок снапшота; отсутствие записи UI трактует как «не просмотрена». */
    readStops(snapshotId: string): UiStopProgress[] {
        const rows = this.db
            .prepare('SELECT stop_id, viewed FROM stop_progress WHERE snapshot_id = ? ORDER BY stop_id')
            .all(snapshotId) as StopRow[];
        return rows.map((row) => ({ stopId: row.stop_id, viewed: row.viewed === 1 }));
    }

    /**
     * Явная отметка ревьюера. Снятие файла также снимает все остановки, чьи диапазоны его
     * задевали: связка хранится здесь и должна работать вне вью маршрута. Снапшот называет
     * вызывающий — отметки остановок ключуются им; `null` — маршрута нет, снимать нечего.
     */
    setFileViewed(diffId: HostId, fileId: string, viewed: boolean, snapshotId: string | null = null): number {
        return this.bumped(this.txSetViewed(diffId, fileId, viewed, snapshotId));
    }

    /**
     * Отметка остановки и её seen-диапазоны одной транзакцией.
     * Диапазоны считает UI; сервер их не интерпретирует, а только держит привязку к стопу —
     * снятие отметки удаляет ровно их. При `viewed: false` присланные диапазоны игнорируются.
     */
    setStopViewed(
        snapshotId: string,
        diffId: HostId,
        stopId: string,
        viewed: boolean,
        ranges: readonly UiStopSeenRange[],
    ): number {
        return this.bumped(this.txSetStopViewed(snapshotId, diffId, stopId, viewed, ranges));
    }

    /**
     * Отметка файла внутри остановки: диапазоны карточки с привязкой к стопу, без пина файла.
     * Снятие удаляет диапазоны этого стопа по файлу и снимает отметку стопа, если она стояла;
     * записи стопа, которой не было, не создаёт — перенос счёл бы стоп решённым ревьюером.
     */
    setStopFileViewed(
        snapshotId: string,
        diffId: HostId,
        stopId: string,
        fileId: string,
        viewed: boolean,
        ranges: readonly UiSeenRange[],
    ): number {
        return this.bumped(this.txSetStopFileViewed(snapshotId, diffId, stopId, fileId, viewed, ranges));
    }

    /**
     * Прогресс, записанный без итерации (накопленная БД прежней версии или сервер, живший без хоста), переезжает
     * на активную. Идемпотентно: при конфликте побеждает запись активной итерации.
     */
    adoptLegacy(activeDiffId: HostId): number {
        if (activeDiffId === LEGACY_DIFF_ID) {
            return this.revisionValue;
        }
        return this.bumped(this.txAdoptLegacy(activeDiffId));
    }

    /**
     * Итерация, с которой имеет смысл переносить прогресс: самая свежая из тех, на которых есть
     * хоть одна запись, кроме `exclude`, `skip` и `LEGACY_DIFF_ID`. `null` — переносить нечего.
     *
     * Кандидаты берутся из самих записей прогресса, а не из `iterations`: строка там появляется
     * только у итерации, которая была активной при живом 0.4.x (`IterationStore.upsert`), и
     * прогресс, записанный сервером 0.3.x, источником бы не стал никогда. Свежесть,
     * когда строки нет, читается по снапшотам маршрута этой итерации, а на худой конец —
     * по времени последней файловой отметки.
     *
     * Исчезнувшая после force-push итерация тоже годится в источники — её прогресс самый свежий,
     * и терять его нельзя. Срез против неё умеет не всякий хост; отказавшего вызывающий
     * спрашивает заново, передав отвергнутый источник в `skip`.
     */
    latestDiffIdWithProgress(exclude: HostId, skip: readonly HostId[] = []): HostId | null {
        const skipped = skip.length === 0 ? '' : `AND d.diff_id NOT IN (${skip.map(() => '?').join(', ')})`;
        const row = this.db
            .prepare(
                `SELECT d.diff_id FROM (
                        SELECT diff_id FROM file_seen_ranges
                        UNION
                        SELECT diff_id FROM file_progress
                    ) d
                  WHERE d.diff_id <> ? AND d.diff_id <> ? ${skipped}
                  ORDER BY COALESCE(
                        (SELECT i.created_at FROM iterations i WHERE i.diff_id = d.diff_id),
                        (SELECT MAX(s.created_at) FROM route_snapshots s WHERE s.diff_id = d.diff_id),
                        (SELECT MAX(p.updated_at) FROM file_progress p WHERE p.diff_id = d.diff_id)
                    ) DESC, d.diff_id DESC
                  LIMIT 1`,
            )
            .get(exclude, LEGACY_DIFF_ID, ...skip) as DiffIdRow | undefined;
        return row?.diff_id ?? null;
    }

    /**
     * Есть ли на итерации хоть одна отметка просмотра — диапазон или файловый пин. Отвечает на
     * вопрос «перенесено 0 остановок — ревьюер ничего не отмечал или отмечал, но не целиком?».
     * Спрашивать надо про итерацию-источник: на приёмнике отметки могли и не появиться,
     * хотя переносить было что.
     */
    hasViewedMarks(diffId: HostId): boolean {
        const row = this.db
            .prepare(
                `SELECT EXISTS(SELECT 1 FROM file_seen_ranges WHERE diff_id = ?)
                     OR EXISTS(SELECT 1 FROM file_progress WHERE diff_id = ? AND viewed = 1) AS count`,
            )
            .get(diffId, diffId) as CountRow | undefined;
        return (row?.count ?? 0) > 0;
    }

    /**
     * Перенос seen-диапазонов и файловых отметок с итерации на итерацию.
     * Файлы сопоставляются по `path`, строки — отображением `map`: затронутые интердиффом
     * не переносятся вовсе.
     *
     * Пара переносится ровно один раз (`progress_carries`): пересчёт вернул бы отметку, которую
     * ревьюер уже снял. Патча целевой итерации в хранилище нет — перенос не состоялся
     * и повторится на следующем событии.
     */
    carryRanges(fromDiffId: HostId, toDiffId: HostId, map: IterationMap): CarryResult {
        const result = this.txCarryRanges(fromDiffId, toDiffId, map);
        if (!result.skipped) {
            this.bumped(result.ranges > 0 || result.files > 0);
            this.log(`перенос прогресса ${fromDiffId} → ${toDiffId}: ${carrySummary(result)}`);
        }
        return result;
    }

    /**
     * Отметки остановок нового снапшота — внутри уже открытой транзакции его приёмки
     * (серверная копия `stopCoveredByProgress` из UI). Остановка считается просмотренной,
     * когда каждый её изменённый кусок накрыт seen-диапазонами итерации снапшота либо файловым
     * пином; куски такой остановки записываются как её собственные seen-диапазоны, чтобы снятие
     * файла снимало и перенесённую отметку.
     *
     * Остановка, о которой в этом снапшоте уже есть запись, не переписывается: решение ревьюера
     * перенос не переигрывает. В `kept` она попадает, только если накрыта чужими диапазонами:
     * пока снапшот заполнялся, вкладка успевала отметить накрытую переносом остановку сама, и
     * число в баннере не должно зависеть от того, кто написал строку первым. Собственные куски
     * решённой остановки при этой проверке не в счёт — иначе «перенесено N» вобрало бы
     * прочитанное руками в новой итерации.
     *
     * `kept` — сколько остановок засчитано этим проходом: заморозка повторяется при
     * дозаполнении стопа, а вызывающий складывает проходы. Учтённая остановка помечена
     * в `stop_progress.carried` и следующим проходом не считается снова.
     */
    carryStopsInTransaction(input: StopCarryInput): StopCarryResult {
        const index = indexDiff(input.diff);
        const decided = new Map(
            (
                this.db
                    .prepare('SELECT stop_id, viewed, carried FROM stop_progress WHERE snapshot_id = ?')
                    .all(input.snapshotId) as CarriedStopRow[]
            ).map((row) => [row.stop_id, { viewed: row.viewed === 1, carried: row.carried === 1 }]),
        );
        const rows = this.seenRangesOf(input.diffId);
        const covered = mergeRanges(rows);
        const pinned = new Set(
            (
                this.db
                    .prepare('SELECT file_id FROM file_progress WHERE diff_id = ? AND viewed = 1')
                    .all(input.diffId) as ProgressRow[]
            ).map((row) => row.file_id),
        );

        let kept = 0;
        for (const stop of input.stops) {
            const required = requiredRanges(stop.anchors, index);
            if (required.length === 0) {
                continue;
            }
            const already = decided.get(stop.id);
            if (already?.carried === true) {
                continue;
            }
            if (already !== undefined) {
                const others = mergeRanges(rows.filter((row) => row.source_stop_id !== stop.id));
                if (already.viewed && coversAll(required, others, pinned)) {
                    this.markStopCarried(input.snapshotId, stop.id);
                    kept += 1;
                }
                continue;
            }
            if (!coversAll(required, covered, pinned)) {
                continue;
            }
            this.writeCarriedStop(input.snapshotId, input.diffId, stop.id, required);
            kept += 1;
        }

        return {
            kept,
            afterCommit: () => {
                this.bumped(kept > 0);
            },
        };
    }

    subscribe(listener: ProgressListener): () => void {
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

    /** Ревизия растёт и будит вкладки только на реальном изменении хранилища. */
    private bumped(changed: boolean): number {
        if (!changed) {
            return this.revisionValue;
        }

        this.revisionValue += 1;
        if (!this.closed) {
            for (const listener of [...this.listeners]) {
                listener(this.revisionValue);
            }
        }
        return this.revisionValue;
    }

    /** `false` — в хранилище ничего не изменилось: повторная отметка тем же значением. */
    private setViewedInTransaction(
        diffId: HostId,
        fileId: string,
        viewed: boolean,
        snapshotId: string | null,
    ): boolean {
        // Снятие пина обнуляет весь просмотр файла: и диапазоны остановок, и перенесённые.
        const sourceStops = viewed
            ? []
            : (this.db
                  .prepare(
                      `SELECT DISTINCT source_stop_id FROM file_seen_ranges
                       WHERE diff_id = ? AND file_id = ? AND source_stop_id IS NOT NULL`,
                  )
                  .all(diffId, fileId) as SourceStopRow[]);
        const existing = this.db
            .prepare('SELECT viewed FROM file_progress WHERE diff_id = ? AND file_id = ?')
            .get(diffId, fileId) as ProgressRow | undefined;
        const fileChanged = existing === undefined || (existing.viewed === 1) !== viewed;
        const updatedAt = this.now().toISOString();

        if (fileChanged) {
            this.db
                .prepare(
                    `INSERT INTO file_progress (diff_id, file_id, viewed, updated_at, path)
                     VALUES (?, ?, ?, ?, ?)
                     ON CONFLICT(diff_id, file_id) DO UPDATE SET
                        viewed = excluded.viewed, updated_at = excluded.updated_at,
                        path = COALESCE(excluded.path, file_progress.path)`,
                )
                .run(diffId, fileId, viewed ? 1 : 0, updatedAt, this.pathsOf(diffId).get(fileId) ?? null);
        }

        let rangesDropped = false;
        if (!viewed) {
            const removed = this.db
                .prepare('DELETE FROM file_seen_ranges WHERE diff_id = ? AND file_id = ?')
                .run(diffId, fileId);
            rangesDropped = removed.changes > 0;
        }
        for (const row of sourceStops) {
            // Остановка держится и на других файлах: её отметка снята — её диапазоны уходят целиком.
            this.db
                .prepare('DELETE FROM file_seen_ranges WHERE diff_id = ? AND source_stop_id = ?')
                .run(diffId, row.source_stop_id);
            if (snapshotId !== null) {
                this.db
                    .prepare(
                        `INSERT INTO stop_progress (snapshot_id, stop_id, viewed, updated_at)
                         VALUES (?, ?, 0, ?)
                         ON CONFLICT(snapshot_id, stop_id) DO UPDATE SET
                            viewed = 0, updated_at = excluded.updated_at`,
                    )
                    .run(snapshotId, row.source_stop_id, updatedAt);
            }
        }
        return fileChanged || rangesDropped || sourceStops.length > 0;
    }

    /**
     * `false` — та же отметка с тем же набором диапазонов: будить вкладки нечем. Сравниваются
     * канонизованные наборы, поэтому порядок и дубли в запросе на ревизию не влияют.
     */
    private setStopViewedInTransaction(
        snapshotId: string,
        diffId: HostId,
        stopId: string,
        viewed: boolean,
        ranges: readonly UiStopSeenRange[],
    ): boolean {
        const next = viewed ? canonicalRanges(ranges) : [];
        const existing = this.db
            .prepare('SELECT stop_id, viewed FROM stop_progress WHERE snapshot_id = ? AND stop_id = ?')
            .get(snapshotId, stopId) as StopRow | undefined;
        const currentRows = this.db
            .prepare(
                `SELECT file_id, side, start_line, end_line FROM file_seen_ranges
                  WHERE diff_id = ? AND source_stop_id = ?`,
            )
            .all(diffId, stopId) as RangeRow[];
        const current = canonicalRanges(
            currentRows.map((row) => ({
                fileId: row.file_id,
                side: sideOf(row.side),
                start: row.start_line,
                end: row.end_line,
            })),
        );
        if (existing !== undefined && (existing.viewed === 1) === viewed && sameRanges(current, next)) {
            return false;
        }

        this.db
            .prepare('DELETE FROM file_seen_ranges WHERE diff_id = ? AND source_stop_id = ?')
            .run(diffId, stopId);
        const paths = this.pathsOf(diffId);
        const insert = this.db.prepare(
            `INSERT INTO file_seen_ranges (
                diff_id, file_id, side, start_line, end_line, source_stop_id, path
             ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        );
        for (const range of next) {
            insert.run(
                diffId,
                range.fileId,
                range.side,
                range.start,
                range.end,
                stopId,
                paths.get(range.fileId) ?? null,
            );
        }
        this.db
            .prepare(
                `INSERT INTO stop_progress (snapshot_id, stop_id, viewed, updated_at) VALUES (?, ?, ?, ?)
                 ON CONFLICT(snapshot_id, stop_id) DO UPDATE SET
                    viewed = excluded.viewed, updated_at = excluded.updated_at`,
            )
            .run(snapshotId, stopId, viewed ? 1 : 0, this.now().toISOString());
        return true;
    }

    /** `false` — те же диапазоны или снимать нечего: будить вкладки нечем. */
    private setStopFileViewedInTransaction(
        snapshotId: string,
        diffId: HostId,
        stopId: string,
        fileId: string,
        viewed: boolean,
        ranges: readonly UiSeenRange[],
    ): boolean {
        const currentRows = this.db
            .prepare(
                `SELECT file_id, side, start_line, end_line FROM file_seen_ranges
                  WHERE diff_id = ? AND file_id = ? AND source_stop_id = ?`,
            )
            .all(diffId, fileId, stopId) as RangeRow[];
        const current = canonicalRanges(
            currentRows.map((row) => ({
                fileId,
                side: sideOf(row.side),
                start: row.start_line,
                end: row.end_line,
            })),
        );

        if (!viewed) {
            this.db
                .prepare('DELETE FROM file_seen_ranges WHERE diff_id = ? AND file_id = ? AND source_stop_id = ?')
                .run(diffId, fileId, stopId);
            const unmarked = this.db
                .prepare(
                    `UPDATE stop_progress SET viewed = 0, updated_at = ?
                      WHERE snapshot_id = ? AND stop_id = ? AND viewed = 1`,
                )
                .run(this.now().toISOString(), snapshotId, stopId);
            return current.length > 0 || unmarked.changes > 0;
        }

        const next = canonicalRanges(ranges.map((range) => ({ ...range, fileId })));
        if (sameRanges(current, next)) {
            return false;
        }
        this.db
            .prepare('DELETE FROM file_seen_ranges WHERE diff_id = ? AND file_id = ? AND source_stop_id = ?')
            .run(diffId, fileId, stopId);
        const insert = this.db.prepare(
            `INSERT INTO file_seen_ranges (
                diff_id, file_id, side, start_line, end_line, source_stop_id, path
             ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        );
        const path = this.pathsOf(diffId).get(fileId) ?? null;
        for (const range of next) {
            insert.run(diffId, fileId, range.side, range.start, range.end, stopId, path);
        }
        return true;
    }

    private adoptLegacyInTransaction(activeDiffId: HostId): boolean {
        const files = this.db
            .prepare(
                `INSERT OR IGNORE INTO file_progress (diff_id, file_id, viewed, updated_at, path)
                 SELECT ?, file_id, viewed, updated_at, path FROM file_progress WHERE diff_id = ?`,
            )
            .run(activeDiffId, LEGACY_DIFF_ID);
        const droppedFiles = this.db
            .prepare('DELETE FROM file_progress WHERE diff_id = ?')
            .run(LEGACY_DIFF_ID);
        // У диапазонов ключа нет — дубли отсеиваются сравнением строк.
        this.db
            .prepare(
                `DELETE FROM file_seen_ranges
                  WHERE diff_id = ?
                    AND EXISTS (
                        SELECT 1 FROM file_seen_ranges other
                         WHERE other.diff_id = ?
                           AND other.file_id = file_seen_ranges.file_id
                           AND other.side = file_seen_ranges.side
                           AND other.start_line = file_seen_ranges.start_line
                           AND other.end_line = file_seen_ranges.end_line
                    )`,
            )
            .run(LEGACY_DIFF_ID, activeDiffId);
        const ranges = this.db
            .prepare('UPDATE file_seen_ranges SET diff_id = ? WHERE diff_id = ?')
            .run(activeDiffId, LEGACY_DIFF_ID);
        return files.changes > 0 || droppedFiles.changes > 0 || ranges.changes > 0;
    }

    private carryRangesInTransaction(fromDiffId: HostId, toDiffId: HostId, map: IterationMap): CarryResult {
        const done = this.db
            .prepare('SELECT 1 AS ok FROM progress_carries WHERE from_diff_id = ? AND to_diff_id = ?')
            .get(fromDiffId, toDiffId);
        if (done !== undefined) {
            // Пара уже переносилась — это норма, а не сбой: событий вотчера много, а перенос
            // один, и повтор вернул бы отметку, которую ревьюер успел снять. Молча и без лога.
            return skippedCarry();
        }

        const to = this.iterations?.get(toDiffId) ?? null;
        if (to === null) {
            // Цель — активная итерация, её патч сервер сохраняет сам: сюда попадаем, только пока
            // он ещё грузится. Патч источника переносу не нужен — путь даёт лестница резолвера.
            this.log(`перенос прогресса ${fromDiffId} → ${toDiffId} отложен: патч итерации не сохранён`);
            return skippedCarry();
        }

        const pathOf = this.sourcePaths(fromDiffId);
        const idOfPath = new Map<string, string>();
        for (const file of to.diff.files) {
            // Первый файл с таким путём выигрывает — как в `indexDiff`.
            if (!idOfPath.has(file.path)) {
                idOfPath.set(file.path, file.fileId);
            }
        }
        /**
         * Куда записи источника ложатся в целевой итерации. Два способа не лечь различаются:
         * `unmapped` — резолвер не знает пути этого `fileId` и сопоставление сломано,
         * `missing` — путь известен, но файла в новой итерации нет, и это обычная правка автора.
         */
        const targetOf = (fileId: string, path: string | null): Resolution => {
            const known = path ?? pathOf.get(fileId) ?? null;
            if (known === null) {
                return { kind: 'unmapped' };
            }
            const target = idOfPath.get(known);
            return target === undefined ? { kind: 'missing' } : { kind: 'mapped', path: known, fileId: target };
        };

        const insert = this.db.prepare(
            `INSERT INTO file_seen_ranges (
                diff_id, file_id, side, start_line, end_line, source_stop_id, carried_from, path
             ) VALUES (?, ?, ?, ?, ?, NULL, ?, ?)`,
        );
        const written = new Set<string>();
        let unmappedRanges = 0;
        let missingRanges = 0;
        let touchedRanges = 0;
        const rangeRows = this.db
            .prepare(
                `SELECT file_id, side, start_line, end_line, path FROM file_seen_ranges
                  WHERE diff_id = ? ORDER BY rowid`,
            )
            .all(fromDiffId) as PathedRangeRow[];
        for (const row of rangeRows) {
            const target = targetOf(row.file_id, row.path);
            if (target.kind !== 'mapped') {
                unmappedRanges += target.kind === 'unmapped' ? 1 : 0;
                missingRanges += target.kind === 'missing' ? 1 : 0;
                continue;
            }
            const side = sideOf(row.side);
            const mapped = map.mapRange(target.path, side, { start: row.start_line, end: row.end_line });
            touchedRanges += mapped.touched.length > 0 ? 1 : 0;
            for (const range of mapped.carried) {
                const key = `${target.fileId} ${side} ${String(range.start)} ${String(range.end)}`;
                if (written.has(key)) {
                    continue;
                }
                written.add(key);
                insert.run(toDiffId, target.fileId, side, range.start, range.end, fromDiffId, target.path);
            }
        }

        let files = 0;
        const fileRows = this.db
            .prepare('SELECT file_id, viewed, path FROM file_progress WHERE diff_id = ?')
            .all(fromDiffId) as PathedProgressRow[];
        for (const row of fileRows) {
            const target = targetOf(row.file_id, row.path);
            if (target.kind !== 'mapped') {
                continue;
            }
            // Пин `read` держится только на неизменившемся файле; снятие пина — воля ревьюера,
            // и она переносится всегда.
            if (row.viewed === 1 && map.fileStatus(target.path) !== 'unchanged') {
                continue;
            }
            const inserted = this.db
                .prepare(
                    `INSERT OR IGNORE INTO file_progress (diff_id, file_id, viewed, updated_at, path)
                     VALUES (?, ?, ?, ?, ?)`,
                )
                .run(toDiffId, target.fileId, row.viewed, this.now().toISOString(), target.path);
            files += inserted.changes > 0 ? 1 : 0;
        }

        this.db
            .prepare(
                'INSERT INTO progress_carries (from_diff_id, to_diff_id, carried_at) VALUES (?, ?, ?)',
            )
            .run(fromDiffId, toDiffId, this.now().toISOString());
        return {
            ranges: written.size,
            files,
            skipped: false,
            sourceRanges: rangeRows.length,
            unmappedRanges,
            missingRanges,
            touchedRanges,
        };
    }

    /**
     * Лестница «`fileId` итерации-источника → путь». `fileId` у Арканума непрозрачен, и
     * сопоставить записи двух итераций можно только через путь. Слои: сохранённый патч
     * итерации, а под ним — якоря, оставшиеся от неё в снапшотах маршрута и заметках чата.
     * Патча у итерации, записанной сервером 0.3.x, нет и взять его неоткуда, так что
     * якоря здесь не запасной вариант, а единственный.
     *
     * Собственная колонка `path` записи (0.5.x и новее) точнее любого слоя и спрашивается
     * раньше — в этой карте она не участвует.
     */
    private sourcePaths(diffId: HostId): ReadonlyMap<string, string> {
        const paths = new Map<string, string>();
        for (const anchor of this.anchorsOf(diffId)) {
            if (!paths.has(anchor.fileId)) {
                paths.set(anchor.fileId, anchor.path);
            }
        }
        for (const file of this.iterations?.get(diffId)?.diff.files ?? []) {
            paths.set(file.fileId, file.path);
        }
        return paths;
    }

    /**
     * Якоря итерации из снапшотов маршрута и заметок чата: у них есть и `fileId`, и `path`.
     *
     * У заметки спрашиваются обе колонки. `anchor` переезжает на новую итерацию переносом
     * заметок, который идёт параллельно этому (`IterationFeed.onIterations`): успей он первым —
     * якорей источника в `anchor` уже не будет. `origin_anchor` держит итерацию, на которой
     * заметку создали, и переносом не переписывается.
     */
    private anchorsOf(diffId: HostId): AnchorPath[] {
        const snapshots = this.db
            .prepare('SELECT snapshot_json AS json FROM route_snapshots WHERE diff_id = ? ORDER BY rowid')
            .all(diffId) as JsonRow[];
        const notes = this.db
            .prepare('SELECT anchor, origin_anchor FROM agent_notes')
            .all() as NoteAnchorRow[];
        return snapshots
            .flatMap((row) => snapshotAnchors(row.json))
            .concat(
                notes.flatMap((row) =>
                    [row.anchor, row.origin_anchor].flatMap((json) =>
                        json === null ? [] : noteAnchors(json, diffId),
                    ),
                ),
            );
    }

    /**
     * `fileId → path` в патче итерации: им подписываются новые записи прогресса, чтобы
     * следующий перенос не зависел от сохранности патча. Разбор патча дорог, а сам патч
     * итерации неизменен — последний разобранный держится в памяти.
     */
    private pathsOf(diffId: HostId): ReadonlyMap<string, string> {
        if (this.pathCache?.diffId === diffId) {
            return this.pathCache.paths;
        }
        const stored = this.iterations?.get(diffId) ?? null;
        if (stored === null) {
            // Патч ещё не доехал: путь запишется как NULL, а запоминать нечего — он появится.
            return new Map();
        }
        const paths = new Map(stored.diff.files.map((file) => [file.fileId, file.path]));
        this.pathCache = { diffId, paths };
        return paths;
    }

    /** Просмотренные диапазоны итерации в порядке слияния; `source_stop_id` — чья это отметка. */
    private seenRangesOf(diffId: HostId): SourcedRangeRow[] {
        return this.db
            .prepare(
                `SELECT file_id, side, start_line, end_line, source_stop_id FROM file_seen_ranges
                  WHERE diff_id = ? ORDER BY file_id, side, start_line`,
            )
            .all(diffId) as SourcedRangeRow[];
    }

    /** Отметка остановки, признанной перенесённой, вместе с её кусками — как у ручной отметки. */
    private writeCarriedStop(
        snapshotId: string,
        diffId: HostId,
        stopId: string,
        required: readonly SeenRange[],
    ): void {
        this.db
            .prepare('DELETE FROM file_seen_ranges WHERE diff_id = ? AND source_stop_id = ?')
            .run(diffId, stopId);
        const dropCarried = this.db.prepare(
            `DELETE FROM file_seen_ranges
              WHERE diff_id = ? AND file_id = ? AND side = ? AND start_line = ? AND end_line = ?
                AND source_stop_id IS NULL`,
        );
        const paths = this.pathsOf(diffId);
        const insert = this.db.prepare(
            `INSERT INTO file_seen_ranges (
                diff_id, file_id, side, start_line, end_line, source_stop_id, path
             ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        );
        for (const range of required) {
            // Тот же кусок уже лежит перенесённым: он переходит под стоп, а не задваивается.
            dropCarried.run(diffId, range.fileId, range.side, range.start, range.end);
            insert.run(
                diffId,
                range.fileId,
                range.side,
                range.start,
                range.end,
                stopId,
                paths.get(range.fileId) ?? null,
            );
        }
        this.db
            .prepare(
                `INSERT INTO stop_progress (snapshot_id, stop_id, viewed, carried, updated_at)
                 VALUES (?, ?, 1, 1, ?)
                 ON CONFLICT(snapshot_id, stop_id) DO UPDATE SET
                    viewed = 1, carried = 1, updated_at = excluded.updated_at`,
            )
            .run(snapshotId, stopId, this.now().toISOString());
    }

    /** Пометка «учтено переносом» на чужой отметке: диапазоны и решение ревьюера остаются как есть. */
    private markStopCarried(snapshotId: string, stopId: string): void {
        this.db
            .prepare('UPDATE stop_progress SET carried = 1 WHERE snapshot_id = ? AND stop_id = ?')
            .run(snapshotId, stopId);
    }
}

/** Перенос не состоялся: в хранилище ничего не записано и считать нечего. */
function skippedCarry(): CarryResult {
    return {
        ranges: 0,
        files: 0,
        skipped: true,
        sourceRanges: 0,
        unmappedRanges: 0,
        missingRanges: 0,
        touchedRanges: 0,
    };
}

/**
 * Итог переноса словами. Ноль диапазонов сам по себе ничего не объясняет, поэтому к нему
 * всегда идут причины: сколько записей было у источника, сколько не привелось к пути, у
 * скольких файл в новой итерации не нашёлся и сколько задел интердифф.
 */
function carrySummary(result: CarryResult): string {
    const counters: readonly (readonly [string, number])[] = [
        ['без пути', result.unmappedRanges],
        ['нет в новой итерации', result.missingRanges],
        ['затронуты интердиффом', result.touchedRanges],
    ];
    const words = (pairs: readonly (readonly [string, number])[]): string =>
        pairs.map(([name, count]) => `${name}: ${String(count)}`).join(', ');
    if (result.ranges === 0 && result.files === 0) {
        // У пустого результата причины перечисляются все, включая нулевые: ноль напротив
        // каждой — это и есть ответ «ни одна из известных причин не сработала».
        return `перенесено 0 диапазонов из ${String(result.sourceRanges)} (${words(counters)})`;
    }
    const reasons = counters.filter(([, count]) => count > 0);
    const tail = reasons.length === 0 ? '' : ` (${words(reasons)})`;
    return `диапазонов ${String(result.ranges)}, файлов ${String(result.files)}${tail}`;
}

/** Якоря стопов снапшота маршрута; блоб читается как есть — от него нужны `fileId` и `path`. */
function snapshotAnchors(json: string): AnchorPath[] {
    const snapshot = parseJson(json);
    return arrayOf(isRecord(snapshot) ? snapshot.stops : null)
        .flatMap((stop) => arrayOf(isRecord(stop) ? stop.anchors : null))
        .flatMap((anchor) => {
            const parsed = anchorPath(anchor);
            return parsed === null ? [] : [parsed];
        });
}

function arrayOf(value: unknown): unknown[] {
    return Array.isArray(value) ? (value as unknown[]) : [];
}

/** Якорь заметки чата, если он указывает на нужную итерацию; пусто — чужой или повреждённый. */
function noteAnchors(json: string, diffId: HostId): AnchorPath[] {
    const anchor = parseJson(json);
    if (!isRecord(anchor) || anchor.diffId !== diffId) {
        return [];
    }
    const parsed = anchorPath(anchor);
    return parsed === null ? [] : [parsed];
}

function anchorPath(value: unknown): AnchorPath | null {
    if (!isRecord(value)) {
        return null;
    }
    const { fileId, path } = value;
    return typeof fileId === 'string' && fileId !== '' && typeof path === 'string' && path !== ''
        ? { fileId, path }
        : null;
}

/** Повреждённый блоб — не повод ронять перенос: такой якорь просто не участвует в карте. */
function parseJson(json: string): unknown {
    try {
        return JSON.parse(json) as unknown;
    } catch {
        return null;
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

/**
 * Изменённые строки диффа внутри якорей остановки — ровно те, что отмечает просмотренными UI
 * (`coveredChangedRanges`: added живут в `new`, removed — в `old`). Тем же правилом живёт перенос
 * отметок (`requiredRanges`); наружу оно выставлено для тестов, которые изображают отметку ревьюера.
 */
export function requiredSeenRanges(anchors: readonly RouteAnchor[], diff: PrDiff): UiStopSeenRange[] {
    return requiredRanges(anchors, indexDiff(diff));
}

function requiredRanges(anchors: readonly RouteAnchor[], index: ReadonlyMap<string, ChangedFile>): SeenRange[] {
    const lines = new Map<string, { fileId: string; side: 'old' | 'new'; numbers: number[] }>();
    for (const anchor of anchors) {
        const file = index.get(anchor.path);
        if (file === undefined) {
            continue;
        }
        const key = `${file.fileId} ${anchor.side}`;
        const bucket = lines.get(key) ?? { fileId: file.fileId, side: anchor.side, numbers: [] };
        for (const line of anchor.side === 'old' ? file.old : file.new) {
            if (line >= anchor.start && line <= anchor.end) {
                bucket.numbers.push(line);
            }
        }
        lines.set(key, bucket);
    }

    const ranges: SeenRange[] = [];
    for (const bucket of lines.values()) {
        const sorted = [...new Set(bucket.numbers)].sort((left, right) => left - right);
        for (const line of sorted) {
            const last = ranges.at(-1);
            if (last?.fileId === bucket.fileId && last.side === bucket.side && line === last.end + 1) {
                ranges[ranges.length - 1] = { ...last, end: line };
                continue;
            }
            ranges.push({ fileId: bucket.fileId, side: bucket.side, start: line, end: line });
        }
    }
    return ranges;
}

/** Диапазоны по файлам и сторонам, слитые в непрерывные куски; строки упорядочены запросом. */
function mergeRanges(rows: readonly SourcedRangeRow[]): Map<string, LineRange[]> {
    const covered = new Map<string, LineRange[]>();
    for (const row of rows) {
        const key = `${row.file_id} ${sideOf(row.side)}`;
        const spans = covered.get(key) ?? [];
        const last = spans.at(-1);
        if (last !== undefined && row.start_line <= last.end + 1) {
            spans[spans.length - 1] = { start: last.start, end: Math.max(last.end, row.end_line) };
        } else {
            spans.push({ start: row.start_line, end: row.end_line });
        }
        covered.set(key, spans);
    }
    return covered;
}

/** Каждый требуемый кусок внутри одного слитого просмотренного либо накрыт файловым пином. */
function coversAll(
    required: readonly SeenRange[],
    covered: ReadonlyMap<string, LineRange[]>,
    pinned: ReadonlySet<string>,
): boolean {
    return required.every((range) => {
        if (pinned.has(range.fileId)) {
            return true;
        }
        const spans = covered.get(`${range.fileId} ${range.side}`) ?? [];
        return spans.some((span) => span.start <= range.start && span.end >= range.end);
    });
}

function sideOf(value: string): 'old' | 'new' {
    return value === 'old' ? 'old' : 'new';
}

/** Диапазоны в сравнимом виде: без дублей и в одном порядке. */
function canonicalRanges(ranges: readonly UiStopSeenRange[]): UiStopSeenRange[] {
    const unique = new Map<string, UiStopSeenRange>();
    for (const range of ranges) {
        unique.set(`${range.fileId} ${range.side} ${String(range.start)} ${String(range.end)}`, range);
    }
    return [...unique.entries()].sort((left, right) => left[0].localeCompare(right[0])).map(([, range]) => range);
}

function sameRanges(left: readonly UiStopSeenRange[], right: readonly UiStopSeenRange[]): boolean {
    return (
        left.length === right.length &&
        left.every((range, index) => {
            const other = right[index];
            return (
                other?.fileId === range.fileId &&
                other.side === range.side &&
                other.start === range.start &&
                other.end === range.end
            );
        })
    );
}

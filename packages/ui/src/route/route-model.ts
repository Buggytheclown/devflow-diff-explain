import type {
    AgentNote,
    FileDiff,
    RouteAnchor,
    RouteSnapshot,
    RouteStop,
    RouteTier,
    Thread,
    UiStopSeenRange,
} from '@sherpa/protocol';

import type { DiffFileModel } from '../diff/model.js';
import { noteCommentPosition } from '../notes/note-draft.js';
import { changedLinesOf } from '../progress/read-state.js';
import type { RoutePreset } from '../session/session-store.js';
import { threadAtLines } from '../threads/model.js';
import type { IterationLayout } from '../threads/model.js';
import type { ComposerSnapshot } from '../threads/store.js';
import type { AnchorSpan } from './anchor-clip.js';
import { otherStopVisible } from './other-stop.js';
import {
    ANCHOR_CONTEXT,
    anchorSpans,
    clipModelToAnchors,
    coveredChangedLines,
    coveredChangedRanges,
    droppedWhitespaceLines,
    spanLines,
    uncoveredRanges,
    uncoveredReadRanges,
} from './anchor-clip.js';

/**
 * Модель вью маршрута (docs/design/README.md §1–2): что и в каком порядке рисовать, сколько строк объяснено
 * и что осталось «Прочему». Чистый модуль — ни React, ни сети: на входе снапшот маршрута,
 * файлы диффа и уже разобранные модели, на выходе — готовый к рендеру порядок.
 *
 * Инвариант контракта (`protocol/route.ts`): в снапшоте только модельное. Чипы файлов,
 * счётчики, доли покрытия и содержимое «Прочего» считаются здесь — по якорям и по модели
 * диффа, правилом `changedLinesOf` (add→new, del→old).
 */

/** Доля непокрытого, выше которой «Прочее» поднимается над low-стопами (docs/design/SPEC-elements.md §4.3). */
export const PROMOTE_THRESHOLD = 0.4;

/** Номера неизменённых строк по сторонам диффа. */
export interface ContextLines {
    readonly old: ReadonlySet<number>;
    readonly new: ReadonlySet<number>;
}

export interface RouteFileGroup {
    readonly file: FileDiff;
    readonly fileId: string;
    readonly path: string;
    readonly name: string;
    readonly dir: string;
    /** Якоря остановки на этот файл, которые рисуются сразу. */
    readonly anchors: readonly RouteAnchor[];
    /** Якоря с директивой `collapsed`: рисуются строкой-сводкой (принцип 3 — со счётчиком). */
    readonly collapsedAnchors: readonly RouteAnchor[];
    /**
     * Неизменённые строки контекста, которые карточка рисует по краям своих диапазонов.
     * Комментарий на такой строке принадлежит этой записи маршрута — иначе он не показался бы
     * нигде. Каждая строка достаётся ровно одной записи: разбор идёт по порядку плана.
     */
    readonly contextLines: ContextLines;
    /** Ханков в срезе карточки — по ним считается ленивый рендер (docs/design/SPEC-elements.md §2.9). */
    readonly hunks: number;
    /** Изменённых строк файла, покрытых остановкой: добавленные и удалённые. */
    readonly additions: number;
    readonly deletions: number;
    /** Изменённых строк под свёрнутыми якорями. */
    readonly collapsedLines: number;
    /**
     * Изменённые строки файла, покрытые якорями остановки, — диапазонами. Их отметка
     * «просмотрено» пишет в прогресс; свёрнутые якоря входят сюда наравне с
     * показанными: остановка их объясняет и печатает их числа строкой-сводкой.
     *
     * Плюс пробельные строки файла, которых не заберёт «Прочее» (`orphanWhitespace`): в счётчики
     * остановки они не идут, но без них прогресс чтения файла не дошёл бы до конца.
     */
    readonly seenRanges: readonly AnchorSpan[];
    /** Остановка покрывает все изменённые строки файла. */
    readonly whole: boolean;
}

export interface RouteStopView {
    readonly stop: RouteStop;
    /** План-фиксированный номер: `01`. Порядок рендера на него не влияет (docs/design/SPEC-elements.md §8 п.4). */
    readonly planLabel: string;
    readonly files: readonly RouteFileGroup[];
    readonly changedLines: number;
    /** Пути якорей, которые не нашли в текущем диффе ни файла, ни изменённых строк. */
    readonly unresolvedPaths: readonly string[];
    /**
     * Пути якорей, попавших в конфликтные файлы: строки на месте, но файл вне покрытия
     * маршрута (docs/design/SPEC-elements.md §4.1). Это не дрейф — перегенерация тут ничего не изменит.
     */
    readonly conflictPaths: readonly string[];
    /** Якоря есть, но ни один не резолвится в дифф — дрейф якорей (docs/design/SPEC-elements.md §2.9). */
    readonly drift: boolean;
    /** Якорей нет вовсе: заполнения не было или оно ничего не разметило. */
    readonly empty: boolean;
    /**
     * Часть файлов остановки ещё разбирается — её числа и seen-диапазоны не окончательные.
     * Файлы, разбор которых сорвался, сюда не входят: сами собой они не досчитаются.
     */
    readonly pending: boolean;
    /**
     * У части файлов остановки разбор сорвался: их изменённые строки в seen-диапазоны не попадут,
     * пока ревьюер не повторит разбор. Отметка «просмотрено» на такой остановке записала бы
     * неполный набор и молча оставила эти файлы непрочитанными.
     */
    readonly parseFailed: boolean;
}

export interface RouteUncoveredFile {
    readonly file: FileDiff;
    readonly fileId: string;
    readonly path: string;
    readonly name: string;
    readonly dir: string;
    /** Синтетические якоря: непокрытые диапазоны изменённых строк. */
    readonly anchors: readonly AnchorSpan[];
    /**
     * Диапазоны отметки «просмотрено»: то же непокрытое, но с пробельными строками, которые
     * правило пробельных вывело из статистики. Прогресс чтения считает изменённые строки
     * патча целиком, и «Прочее» обязано закрывать файл до конца.
     */
    readonly seenRanges: readonly AnchorSpan[];
    /** Контекст вокруг непокрытых диапазонов, не разобранный остановками. */
    readonly contextLines: ContextLines;
    readonly lines: number;
}

export interface RouteOtherView {
    readonly stop: RouteStop;
    readonly planLabel: string;
    readonly files: readonly RouteUncoveredFile[];
    readonly lines: number;
    /** Файлов с конфликтом: они вне покрытия, но сказать о них «Прочее» обязано (docs/design/SPEC-elements.md §4.1). */
    readonly conflictFiles: number;
}

export interface RouteTotals {
    readonly changed: number;
    readonly covered: number;
    readonly uncovered: number;
    readonly byTier: Readonly<Record<RouteTier, number>>;
    /** Файлы диффа без разобранной модели: пока их больше нуля, непокрытое неизвестно. */
    readonly pendingFiles: number;
    /**
     * Файлы, разбор которых сорвался: их строки в непокрытое не попали. Сами собой они
     * не досчитаются — нужен повтор, поэтому число видно ревьюеру, а не только счётчику.
     */
    readonly failedFiles: number;
    /** Файлы с конфликтом: в `changed` и `uncovered` их строк нет вовсе (docs/design/SPEC-elements.md §4.1). */
    readonly conflictFiles: number;
}

export type RouteEntry =
    | { readonly kind: 'stop'; readonly view: RouteStopView }
    | { readonly kind: 'other'; readonly view: RouteOtherView };

export interface RouteModel {
    /**
     * Порядок рендера. Триаж: high → medium → [поднятое «Прочее»] → low → «Прочее».
     * Полный тур: `tourOrder` снапшота как есть.
     */
    readonly entries: readonly RouteEntry[];
    readonly totals: RouteTotals;
    /**
     * Непокрытого больше порога (docs/design/SPEC-elements.md §4.3): в триаже «Прочее» поднято над
     * low-стопами, в туре порядок остаётся строго по `tourOrder` — подъём помогает триажу и на тур
     * не распространяется. Баннер «стоит
     * перегенерировать» поднимается по этому флагу в обоих пресетах: он про качество маршрута,
     * а не про порядок карточек.
     */
    readonly promoted: boolean;
    /**
     * Слотов маршрута — знаменатель «01 / 7» и счётчика тулбара. Считается по `entries`, а не
     * по снапшоту: «Прочее» рисуется не всегда (`otherStopVisible`), и номер карточки, счётчик
     * просмотренного и гардрейл обязаны говорить об одном и том же наборе.
     */
    readonly stopCount: number;
}

export interface RouteModelInput {
    readonly snapshot: RouteSnapshot;
    readonly files: readonly FileDiff[];
    readonly models: ReadonlyMap<string, DiffFileModel>;
    /** Файлы, разбор которых сорвался: модели у них не будет, пока ревьюер не попросит повтор. */
    readonly failed?: ReadonlySet<string>;
    /** Пресет сессии (docs/design/SPEC-elements.md §2.5); влияет только на порядок записей. */
    readonly preset?: RoutePreset;
}

export function buildRouteModel({
    snapshot,
    files: allFiles,
    models,
    failed = EMPTY_FAILED,
    preset = 'triage',
}: RouteModelInput): RouteModel {
    // Конфликтные файлы выходят из математики покрытия целиком (docs/design/SPEC-elements.md §4.1): их строки не
    // считаются ни изменёнными, ни непокрытыми, и полоса покрытия их не рисует. Про сам факт
    // конфликта говорит отдельная строка «Прочего».
    const files = allFiles.filter((file) => file.changeType !== 'conflict');
    // Агент видит конфликтные файлы с патчами и штатно ставит на них якоря. Такой якорь
    // не дрейф: его нужно отличать от пути, которого в диффе нет вовсе.
    const conflicts = new Set(
        allFiles.filter((file) => file.changeType === 'conflict').map((file) => file.fileId),
    );
    const conflictFiles = conflicts.size;
    const byId = new Map(files.map((file) => [file.fileId, file]));
    const planned = snapshot.stops.filter((stop) => stop.tier !== 'other');
    const otherStop = snapshot.stops.find((stop) => stop.tier === 'other') ?? null;

    // Якоря всех остановок разом: непокрытое — то, чего не касается ни одна из них, а каждая
    // остановка по этой же карте узнаёт, какие диапазоны файла принадлежат соседям.
    const claimed = new Map<string, AnchorSpan[]>();
    for (const stop of snapshot.stops) {
        for (const anchor of stop.anchors) {
            const spans = claimed.get(anchor.fileId) ?? [];
            spans.push({ side: anchor.side, start: anchor.start, end: anchor.end });
            claimed.set(anchor.fileId, spans);
        }
    }

    // Контекст, уже отданный какой-то остановке: строка достаётся первой по плану, чтобы один
    // комментарий не всплыл сразу в двух записях маршрута.
    const takenContext = new Map<string, ContextLines>();
    const orphans = orphanWhitespace(planned, files, models, claimed);
    const views = planned.map((stop) =>
        stopView(stop, byId, conflicts, models, failed, claimed, takenContext, orphans),
    );
    const byTier: Record<RouteTier, number> = { high: 0, medium: 0, low: 0, other: 0 };
    for (const view of views) {
        byTier[view.stop.tier] += view.changedLines;
    }

    let changed = 0;
    let covered = 0;
    let pendingFiles = 0;
    let failedFiles = 0;
    const uncoveredFiles: RouteUncoveredFile[] = [];
    for (const file of files) {
        const model = models.get(file.fileId) ?? null;
        if (model === null) {
            changed += file.additions + file.deletions;
            if (failed.has(file.fileId)) {
                failedFiles += 1;
            } else {
                pendingFiles += 1;
            }
            continue;
        }
        const spans = claimed.get(file.fileId) ?? [];
        const total = changedLineCount(model, file, spans);
        const fileCovered = coveredChangedLines(model, spans);
        changed += total;
        covered += fileCovered.additions + fileCovered.deletions;

        const ranges = uncoveredRanges(model, spans);
        const lines = spanLines(ranges);
        if (lines > 0) {
            uncoveredFiles.push({
                ...names(file),
                file,
                anchors: ranges,
                seenRanges: uncoveredReadRanges(model, spans),
                contextLines: claimContext(takenContext, file.fileId, ranges, spans),
                lines,
            });
        }
    }

    const uncovered = uncoveredFiles.reduce((total, file) => total + file.lines, 0);
    byTier.other = uncovered;
    const totals: RouteTotals = { changed, covered, uncovered, byTier, pendingFiles, failedFiles, conflictFiles };

    // Пока дифф разбирается, непокрытое ещё не посчитано, и «Прочего» нет: иначе на маршруте,
    // где модель разместила всё, оно мелькало бы до конца разбора.
    const otherVisible = otherStopVisible(snapshot, { uncovered: pendingFiles > 0 ? null : uncovered, conflictFiles });
    const other: RouteOtherView | null =
        otherStop === null || !otherVisible
            ? null
            : {
                  stop: otherStop,
                  planLabel: planLabel(otherStop.planIndex),
                  files: uncoveredFiles,
                  lines: uncovered,
                  conflictFiles,
              };
    // Видимое «Прочее» — значит, маршрут достроен: на недостроенном непокрытое — незанятые слоты плана.
    const promoted = other !== null && changed > 0 && uncovered / changed > PROMOTE_THRESHOLD;
    const entries =
        preset === 'tour'
            ? inTourOrder(order(views, other, false), snapshot.tourOrder)
            : order(views, other, promoted);

    return { entries, totals, promoted, stopCount: entries.length };
}

/**
 * Непокрытых изменённых строк маршрута — то же число, что `totals.uncovered` модели маршрута;
 * `null`, пока хоть один файл не разобран и не провален.
 */
export function routeUncoveredLines(input: RouteModelInput): number | null {
    const failed = input.failed ?? EMPTY_FAILED;
    const pending = input.files.some(
        (file) => file.changeType !== 'conflict' && !input.models.has(file.fileId) && !failed.has(file.fileId),
    );
    return pending ? null : buildRouteModel(input).totals.uncovered;
}

/** Числа записи маршрута ещё не окончательные: часть её файлов не разобрана. */
export function entryPending(entry: RouteEntry, totals: RouteTotals): boolean {
    return entry.kind === 'stop' ? entry.view.pending : totals.pendingFiles > 0;
}

/**
 * У записи маршрута есть файлы с сорвавшимся разбором: их диапазоны посчитать не из чего.
 * Отметка «просмотрено» ушла бы на сервер без них — файлы остались бы непрочитанными молча,
 * поэтому отмечать такую запись нельзя, пока разбор не повторили.
 */
export function entryParseFailed(entry: RouteEntry, totals: RouteTotals): boolean {
    return entry.kind === 'stop' ? entry.view.parseFailed : totals.failedFiles > 0;
}

/**
 * Остановка ещё не заполнена агентом (или её заполнение провалилось): диапазонов у неё нет,
 * отмечать нечего. «Прочее» синтетическое — оно готово всегда.
 */
export function entryUnfilled(entry: RouteEntry): boolean {
    return entry.kind === 'stop' && entry.view.stop.status !== 'ready';
}

/**
 * Порядок рендера. Триаж задан массивом `stops` снапшота; «Прочее» уходит в конец, а при
 * подъёме встаёт перед первым low-стопом. Номера остановок при этом не двигаются.
 */
function order(
    views: readonly RouteStopView[],
    other: RouteOtherView | null,
    promoted: boolean,
): readonly RouteEntry[] {
    const entries: RouteEntry[] = views.map((view) => ({ kind: 'stop', view }));
    if (other === null) {
        return entries;
    }
    const otherEntry: RouteEntry = { kind: 'other', view: other };
    if (!promoted) {
        return [...entries, otherEntry];
    }
    const firstLow = entries.findIndex((entry) => entry.kind === 'stop' && entry.view.stop.tier === 'low');
    if (firstLow < 0) {
        return [...entries, otherEntry];
    }
    return [...entries.slice(0, firstLow), otherEntry, ...entries.slice(firstLow)];
}

/**
 * Порядок полного тура (docs/design/SPEC-elements.md §2.5): записи идут ровно так, как их перечислил `tourOrder`
 * снапшота, включая место «Прочего». Снапшот прошёл валидатор (`tourOrder` — перестановка
 * всех стопов), но вью fail-closed: неизвестный id пропускается, повтор берётся один раз,
 * а стопы, которых в `tourOrder` не оказалось, уходят в хвост в план-порядке — карточка
 * не должна исчезнуть из-за кривого поля.
 */
function inTourOrder(entries: readonly RouteEntry[], ids: readonly string[]): readonly RouteEntry[] {
    const byId = new Map(entries.map((entry) => [entry.view.stop.id, entry]));
    const ordered: RouteEntry[] = [];
    for (const id of ids) {
        const entry = byId.get(id);
        if (entry !== undefined) {
            byId.delete(id);
            ordered.push(entry);
        }
    }
    return [...ordered, ...entries.filter((entry) => byId.has(entry.view.stop.id))];
}

function stopView(
    stop: RouteStop,
    byId: ReadonlyMap<string, FileDiff>,
    conflicts: ReadonlySet<string>,
    models: ReadonlyMap<string, DiffFileModel>,
    failed: ReadonlySet<string>,
    claimed: ReadonlyMap<string, readonly AnchorSpan[]>,
    takenContext: Map<string, ContextLines>,
    orphans: ReadonlyMap<string, readonly AnchorSpan[]>,
): RouteStopView {
    const groups = new Map<string, { shown: RouteAnchor[]; collapsed: RouteAnchor[] }>();
    const unresolved: string[] = [];
    const conflictPaths: string[] = [];
    const markUnresolved = (path: string): void => {
        if (!unresolved.includes(path)) {
            unresolved.push(path);
        }
    };
    for (const anchor of stop.anchors) {
        // Файл в конфликте: строки на месте, но карточки не будет — файл вне покрытия.
        if (conflicts.has(anchor.fileId)) {
            if (!conflictPaths.includes(anchor.path)) {
                conflictPaths.push(anchor.path);
            }
            continue;
        }
        if (!byId.has(anchor.fileId)) {
            markUnresolved(anchor.path);
            continue;
        }
        const group = groups.get(anchor.fileId) ?? { shown: [], collapsed: [] };
        (anchor.collapsed ? group.collapsed : group.shown).push(anchor);
        groups.set(anchor.fileId, group);
    }

    let changedLines = 0;
    let pending = false;
    let parseFailed = false;
    const files: RouteFileGroup[] = [];
    for (const [fileId, group] of groups) {
        const file = byId.get(fileId);
        if (file === undefined) {
            continue;
        }
        const model = models.get(fileId) ?? null;
        pending ||= model === null && !failed.has(fileId);
        parseFailed ||= model === null && failed.has(fileId);
        const own = anchorSpans([...group.shown, ...group.collapsed]);
        const shown = coveredChangedLines(model, anchorSpans(group.shown));
        const collapsed = coveredChangedLines(model, anchorSpans(group.collapsed));
        const additions = shown.additions + collapsed.additions;
        const deletions = shown.deletions + collapsed.deletions;
        // Файл в диффе есть, а изменённых строк под якорями не осталось: дифф уехал из-под
        // снапшота. Пустая карточка про это не сказала бы — файл уходит в нотис (docs/design/SPEC-elements.md §2.9).
        if (model !== null && model.content.kind === 'text' && additions + deletions === 0) {
            markUnresolved(file.path);
            continue;
        }
        changedLines += additions + deletions;
        files.push({
            ...names(file),
            file,
            anchors: group.shown,
            collapsedAnchors: group.collapsed,
            contextLines: claimContext(takenContext, fileId, own, claimed.get(fileId) ?? []),
            hunks: model === null ? 0 : clipModelToAnchors(model, anchorSpans(group.shown)).hunks,
            additions,
            deletions,
            collapsedLines: collapsed.additions + collapsed.deletions,
            seenRanges: [...coveredChangedRanges(model, own), ...(orphans.get(fileId) ?? EMPTY_SPANS)],
            whole: model !== null && additions + deletions >= changedLineCount(model, file, claimed.get(fileId) ?? []),
        });
    }

    return {
        stop,
        planLabel: planLabel(stop.planIndex),
        files,
        changedLines,
        unresolvedPaths: unresolved,
        conflictPaths,
        // Остановка целиком ушла в конфликтные файлы — это не дрейф: строки на месте,
        // и перегенерация маршрута их не вернёт.
        drift: stop.anchors.length > 0 && files.length === 0 && conflictPaths.length === 0,
        empty: stop.anchors.length === 0,
        pending,
        parseFailed,
    };
}

/**
 * Пробельные строки вне якорей, которых «Прочее» не заберёт: текстового непокрытого в файле
 * не осталось, значит файла в «Прочем» не будет вовсе. Прогресс чтения считает изменённые строки
 * патча целиком (`read-state`), поэтому такие строки дочитывают остановки, которые этот файл
 * объясняют, — иначе файл с пустой строкой между блоками разных остановок не закрылся бы
 * маршрутом никогда.
 *
 * Файл, которого не касается ни одна остановка (все его изменённые строки пробельные), в маршрут
 * не попадает вовсе: закрыть его можно только отметкой самого файла.
 */
function orphanWhitespace(
    planned: readonly RouteStop[],
    files: readonly FileDiff[],
    models: ReadonlyMap<string, DiffFileModel>,
    claimed: ReadonlyMap<string, readonly AnchorSpan[]>,
): ReadonlyMap<string, readonly AnchorSpan[]> {
    const placed = new Set(planned.flatMap((stop) => stop.anchors.map((anchor) => anchor.fileId)));
    const orphans = new Map<string, readonly AnchorSpan[]>();
    for (const file of files) {
        const model = models.get(file.fileId) ?? null;
        if (model === null || !placed.has(file.fileId)) {
            continue;
        }
        const spans = claimed.get(file.fileId) ?? EMPTY_SPANS;
        // Текстовое непокрытое есть — файл попадёт в «Прочее», и его seen-диапазоны накроют
        // пробельные строки заодно.
        if (uncoveredRanges(model, spans).length > 0) {
            continue;
        }
        const rest = uncoveredReadRanges(model, spans);
        if (rest.length > 0) {
            orphans.set(file.fileId, rest);
        }
    }
    return orphans;
}

/**
 * Контекст записи маршрута: до `ANCHOR_CONTEXT` неизменённых строк по краям её диапазонов.
 * Из него вычитается всё, что заявлено якорями (чужая строка — чужой комментарий) и всё, что
 * уже забрала предыдущая запись. `taken` пополняется на месте: порядок разбора — порядок плана.
 */
function claimContext(
    taken: Map<string, ContextLines>,
    fileId: string,
    own: readonly AnchorSpan[],
    allClaimed: readonly AnchorSpan[],
): ContextLines {
    const mine: { old: Set<number>; new: Set<number> } = { old: new Set(), new: new Set() };
    const already = taken.get(fileId) ?? EMPTY_CONTEXT;
    for (const span of own) {
        for (let offset = 1; offset <= ANCHOR_CONTEXT; offset += 1) {
            for (const line of [span.start - offset, span.end + offset]) {
                if (line < 1 || already[span.side].has(line) || covered(allClaimed, span.side, line)) {
                    continue;
                }
                mine[span.side].add(line);
            }
        }
    }

    taken.set(fileId, {
        old: new Set([...already.old, ...mine.old]),
        new: new Set([...already.new, ...mine.new]),
    });
    return mine;
}

function covered(spans: readonly AnchorSpan[], side: 'old' | 'new', line: number): boolean {
    return spans.some((span) => span.side === side && line >= span.start && line <= span.end);
}

/** Позиция комментария задевает хотя бы одну строку контекста записи. */
function touchesContext(lines: ContextLines, side: 'old' | 'new', start: number, end: number): boolean {
    for (const line of lines[side]) {
        if (line >= start && line <= end) {
            return true;
        }
    }
    return false;
}

function intersects(spans: readonly AnchorSpan[], side: 'old' | 'new', start: number, end: number): boolean {
    return spans.some((span) => span.side === side && start <= span.end && end >= span.start);
}

const EMPTY_CONTEXT: ContextLines = { old: new Set(), new: new Set() };
const EMPTY_SPANS: readonly AnchorSpan[] = [];

/**
 * Изменённых строк файла — каноническим правилом `changedLinesOf` (add→new, del→old). Модели
 * ещё нет — счётчики патча.
 *
 * Из числа вычитаются пустые и пробельные строки вне якорей:
 * `uncoveredRanges` их не отдаёт, и без той же поправки в знаменателе покрытое плюс
 * непокрытое не сошлось бы с изменённым.
 */
function changedLineCount(model: DiffFileModel | null, file: FileDiff, anchors: readonly AnchorSpan[]): number {
    const changed = changedLinesOf(model);
    if (changed === undefined) {
        return file.additions + file.deletions;
    }
    return changed.old.size + changed.new.size - droppedWhitespaceLines(model, anchors);
}

function names(file: FileDiff): { fileId: string; path: string; name: string; dir: string } {
    const cut = file.path.lastIndexOf('/');
    return {
        fileId: file.fileId,
        path: file.path,
        name: cut === -1 ? file.path : file.path.slice(cut + 1),
        dir: cut === -1 ? '' : file.path.slice(0, cut),
    };
}

/** Номер плана как в дизайне: `01`, `07`. */
export function planLabel(planIndex: number): string {
    return String(planIndex).padStart(2, '0');
}

/**
 * Принадлежит ли позиция комментария диапазонам остановки. Сначала свои якоря, затем — их
 * контекст: карточка рисует несколько неизменённых строк по краям диапазона, и комментарий
 * на такой строке иначе не показался бы ни в одной записи маршрута. Контекст, который заявила
 * соседняя остановка, остаётся ей — один тред не должен всплывать дважды.
 */
function groupOwnsPosition(group: RouteFileGroup, position: { side: 'old' | 'new'; line: number; size: number }): boolean {
    const last = position.line + Math.max(position.size, 1) - 1;
    return (
        intersects(anchorSpans([...group.anchors, ...group.collapsedAnchors]), position.side, position.line, last) ||
        touchesContext(group.contextLines, position.side, position.line, last)
    );
}

/**
 * Треды, относящиеся к диапазонам остановки: с позицией — если строка попала в якоря или в их
 * контекст, без позиции (устаревший или приколотый к другой итерации) — только если остановка
 * объясняет файл целиком. Иначе один и тот же тред всплывал бы в каждой остановке, которая
 * трогает этот файл.
 */
export function threadsForGroup(
    group: RouteFileGroup,
    byFile: ReadonlyMap<string, readonly Thread[]>,
    iteration: IterationLayout | null = null,
): readonly Thread[] {
    const threads = byFile.get(group.fileId) ?? [];
    if (threads.length === 0) {
        return threads;
    }
    return threads.filter((thread) => {
        const position = thread.anchor?.position ?? null;
        if (position === null || !threadAtLines(thread, iteration)) {
            return group.whole;
        }
        return groupOwnsPosition(group, position);
    });
}

/** Заметка попадает только в одну карточку маршрута по тому же правилу владения, что тред. */
export function notesForGroup(
    group: RouteFileGroup,
    byFile: ReadonlyMap<string, readonly AgentNote[]>,
): readonly AgentNote[] {
    const notes = byFile.get(group.fileId) ?? [];
    return notes.filter((note) => groupOwnsPosition(group, noteCommentPosition(note.anchor)));
}

/**
 * Композеры — тем же правилом, что треды: один и тот же черновик, попавший в две записи
 * маршрута, дал бы две textarea на одну запись стора.
 */
export function composersForGroup(
    group: RouteFileGroup,
    byFile: ReadonlyMap<string, readonly ComposerSnapshot[]>,
): readonly ComposerSnapshot[] {
    const composers = byFile.get(group.fileId) ?? [];
    if (composers.length === 0) {
        return composers;
    }
    return composers.filter((composer) => {
        const position = composer.anchor?.position ?? null;
        return position === null ? group.whole : groupOwnsPosition(group, position);
    });
}

/**
 * Seen-диапазоны отметки «просмотрено» на записи маршрута (docs/architecture.md §7.1).
 * Для обычной остановки это изменённые строки её файлов, покрытые её якорями; для «Прочего» —
 * непокрытые диапазоны. Считает их UI: у сервера модели диффа нет.
 */
export function stopSeenRanges(entry: RouteEntry): readonly UiStopSeenRange[] {
    return entryGroups(entry).flatMap((group) =>
        group.seenRanges.map((span) => ({
            fileId: group.fileId,
            side: span.side,
            start: span.start,
            end: span.end,
        })),
    );
}

/** Комментарии остановки (docs/design/README.md §1: счётчик в левой колонке). */
export function countStopComments(
    view: RouteStopView,
    byFile: ReadonlyMap<string, readonly Thread[]>,
    iteration: IterationLayout | null = null,
): number {
    return view.files.reduce((total, group) => total + threadsForGroup(group, byFile, iteration).length, 0);
}

/** Карточки файлов записи маршрута: у «Прочего» — его непокрытые файлы. */
export function entryGroups(entry: RouteEntry): readonly RouteFileGroup[] {
    return entry.kind === 'stop' ? entry.view.files : entry.view.files.map((file) => uncoveredAsGroup(file));
}

/** Файл «Прочего» как обычная группа файлов остановки: те же карточки, те же треды. */
export function uncoveredAsGroup(file: RouteUncoveredFile): RouteFileGroup {
    const anchors: RouteAnchor[] = file.anchors.map((span) => ({
        fileId: file.fileId,
        path: file.path,
        side: span.side,
        start: span.start,
        end: span.end,
        collapsed: false,
    }));
    const additions = file.anchors
        .filter((span) => span.side === 'new')
        .reduce((total, span) => total + (span.end - span.start + 1), 0);
    return {
        file: file.file,
        fileId: file.fileId,
        path: file.path,
        name: file.name,
        dir: file.dir,
        anchors,
        collapsedAnchors: [],
        contextLines: file.contextLines,
        // Непокрытые диапазоны уже склеены по соседним строкам: каждый рисуется своим куском.
        hunks: anchors.length,
        additions,
        deletions: file.lines - additions,
        collapsedLines: 0,
        seenRanges: file.seenRanges,
        whole: spanLines(file.seenRanges) >= file.file.additions + file.file.deletions,
    };
}

/**
 * Ленивый рендер остановки считается по ханкам, а не по файлам (docs/design/SPEC-elements.md §2.9): «stop with more
 * than 20 hunks lazy-renders beyond the first 5». Порог не пройден — остановка рисуется целиком
 * даже за экраном, иначе прокрутка догоняла бы дорисовку на ровном месте.
 */
export const LAZY_HUNK_THRESHOLD = 20;
const LAZY_HUNKS = 5;

/** Карточки, которые рисуются до того, как остановка побывала на экране. */
export function lazyCards(files: readonly RouteFileGroup[]): readonly RouteFileGroup[] {
    const total = files.reduce((sum, group) => sum + group.hunks, 0);
    if (total <= LAZY_HUNK_THRESHOLD) {
        return files;
    }
    const head: RouteFileGroup[] = [];
    let hunks = 0;
    for (const group of files) {
        // Первая карточка рисуется всегда: одна карточка на 30 ханков всё равно должна быть видна.
        if (head.length > 0 && hunks >= LAZY_HUNKS) {
            break;
        }
        head.push(group);
        hunks += group.hunks;
    }
    return head;
}

/**
 * Состояние остановки, от которого зависит, можно ли снять её колонку диффа с DOM.
 * Маршрут не виртуализируется целиком: секция остаётся на месте вместе с повествованием,
 * чипами и тоглом отметки — уходит только правая колонка, а её место держит плейсхолдер
 * измеренной высоты.
 */
export interface StopDiffMountState {
    /** Остановка ещё в пределах дальней границы гистерезиса `useNearViewport`. */
    readonly nearViewport: boolean;
    /** Последняя измеренная высота колонки; `null` — ни разу не мерили, подменять нечем. */
    readonly measuredHeight: number | null;
    /** Первая остановка маршрута: точка входа ревьюера и якорь тура. */
    readonly first: boolean;
    /**
     * Колонка рисует карточки файлов. Скелетон незаполненного слота, дрейф якорей, «ханков нет»
     * и свёрнутая сводка — одна строка: снимать там нечего, а скелетоны плана ещё и считает e2e.
     */
    readonly rendersCards: boolean;
    /** Остановка мигает после прыжка или является целью незакончившегося прыжка. */
    readonly jumping: boolean;
    /** В файле остановки живёт выделение, открытый композер или фокус строки. */
    readonly busy: boolean;
}

/**
 * Можно ли снять колонку диффа остановки с DOM. Исключения не про экономию, а про то, что
 * размонтирование теряет: локальное состояние перемычек, инстанс редактора комментария,
 * фокус строки и якоря `data-file` для навигации «после Просмотрено».
 */
export function canUnmountStopDiff(state: StopDiffMountState): boolean {
    return (
        !state.nearViewport &&
        state.measuredHeight !== null &&
        !state.first &&
        state.rendersCards &&
        !state.jumping &&
        !state.busy
    );
}

/**
 * Стоп классифицирован относительно прошлого захода — только такие проходят фильтр
 * «что нового» (docs/design/README.md §9). Синтетическое «Прочее» классификации не имеет и уходит вместе
 * с неизменившимися стопами.
 */
export function entryChanged(entry: RouteEntry): boolean {
    return entry.kind === 'stop' && entry.view.stop.change !== null;
}

/**
 * Фильтр «что нового» недействителен, когда классифицированных стопов нет: маршрут
 * показывается целиком, чипа и записи в адресе нет.
 */
export function changeFilterAvailable(entries: readonly RouteEntry[]): boolean {
    return entries.some(entryChanged);
}

/**
 * Запись проходит фильтр «что нового». Номера остановок при этом план-фиксированные:
 * фильтр отбирает, что рисовать, а знаменатель «02 / 7» считается по полному набору записей.
 */
export function entryMatchesChangeFilter(entry: RouteEntry, active: boolean): boolean {
    return !active || entryChanged(entry);
}

/** Остановки, у которых под текущим фильтром не осталось ни одного файла, из вью уходят (docs/design/SPEC-elements.md §2.7). */
export function stopMatchesFilter(view: RouteStopView, fileIds: ReadonlySet<string> | null): boolean {
    return fileIds === null || view.files.some((group) => fileIds.has(group.fileId));
}

export function otherMatchesFilter(view: RouteOtherView, fileIds: ReadonlySet<string> | null): boolean {
    return fileIds === null || view.files.some((group) => fileIds.has(group.fileId));
}

/**
 * «Прочее» под фильтром: и заголовок, и кнопка обязаны считать ровно то, что раскроется.
 * `null` в `fileIds` — фильтра нет (или карточка удержана на экране), вид не меняется.
 */
export function filterOtherView(view: RouteOtherView, fileIds: ReadonlySet<string> | null): RouteOtherView {
    if (fileIds === null) {
        return view;
    }
    const files = view.files.filter((file) => fileIds.has(file.fileId));
    return { ...view, files, lines: files.reduce((total, file) => total + file.lines, 0) };
}

const EMPTY_FAILED: ReadonlySet<string> = new Set();

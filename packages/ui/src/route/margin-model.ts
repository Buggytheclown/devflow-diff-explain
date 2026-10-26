import type { FileDiff, RouteSnapshot } from '@sherpa/protocol';

import type { DiffFileModel } from '../diff/model.js';
import type { Translate } from '../i18n/index.js';
import { stripInlineCode } from '@sherpa/protocol/markdown';
import { changedLinesOf } from '../progress/read-state.js';
import type { AnchorSpan } from './anchor-clip.js';
import { droppedWhitespaceLines, spanLines, uncoveredRanges } from './anchor-clip.js';
import { otherStopVisible } from './other-stop.js';
import { planLabel } from './route-model.js';

/**
 * Маршрут на полях полного диффа (docs/design/README.md §10): какому файлу какая остановка, что осталось без
 * остановки вовсе и сколько таких строк. Чистый модуль — ни React, ни DOM.
 *
 * Это не `buildRouteModel`: тому нужны треды, композеры и обрезка моделей под карточки остановок,
 * здесь же хватает якорей. Карта файл→остановки считается вообще без разбора патчей, поэтому
 * бейджи дерева и карточек стоят сразу; непокрытые диапазоны — те же `uncoveredRanges` правилом
 * `changedLinesOf`, что считают «Прочее» и полосу покрытия, поэтому числа сходятся по построению.
 */

/** Остановка, объясняющая файл. Заголовок и номер — из снапшота, порядок — план. */
export interface RouteMarginStop {
    readonly stopId: string;
    readonly planLabel: string;
    readonly title: string;
}

export interface RouteMarginFile {
    readonly fileId: string;
    /** Остановки файла в план-порядке; пусто — файл не размещён ни в одной (он весь в «Прочем»). */
    readonly stops: readonly RouteMarginStop[];
    /** Изменённые строки файла без остановки — диапазонами; пусто, пока патч не разобран. */
    readonly uncovered: readonly AnchorSpan[];
    readonly uncoveredLines: number;
    /** Патч разобран: непокрытое посчитано, а не «ещё неизвестно». */
    readonly parsed: boolean;
    /** В файле есть изменённые строки: без них он не «вне маршрута», размещать нечего. */
    readonly changed: boolean;
}

export interface RouteMarginModel {
    readonly files: ReadonlyMap<string, RouteMarginFile>;
    /** Остановка «Прочее» — цель клика по штрихованному бейджу; null — её не видно (`otherStopVisible`). */
    readonly otherStopId: string | null;
    readonly uncoveredLines: number;
    readonly uncoveredFiles: number;
    /** Файлы без разобранного патча: пока их больше нуля, непокрытое посчитано не всё. */
    readonly pendingFiles: number;
    /** Файлы, разбор которых сорвался: их строки в счёт не вошли и сами собой не войдут. */
    readonly failedFiles: number;
}

export interface RouteMarginInput {
    readonly snapshot: RouteSnapshot;
    readonly files: readonly FileDiff[];
    readonly models: ReadonlyMap<string, DiffFileModel>;
    readonly failed?: ReadonlySet<string>;
}

export function buildRouteMargin({ snapshot, files, models, failed = EMPTY_FAILED }: RouteMarginInput): RouteMarginModel {
    // «Прочее» в карту не входит: его содержимое и есть «не размещено», и бейдж остановки на нём
    // означал бы обратное.
    const planned = [...snapshot.stops]
        .filter((stop) => stop.tier !== 'other')
        .sort((left, right) => left.planIndex - right.planIndex);

    const stopsByFile = new Map<string, RouteMarginStop[]>();
    const claimed = new Map<string, AnchorSpan[]>();
    for (const stop of planned) {
        const view: RouteMarginStop = { stopId: stop.id, planLabel: planLabel(stop.planIndex), title: stop.title };
        for (const anchor of stop.anchors) {
            const stops = stopsByFile.get(anchor.fileId) ?? [];
            // Несколько якорей одной остановки на файл — одна запись: бейдж считает остановки.
            if (stops.at(-1)?.stopId !== stop.id) {
                stops.push(view);
            }
            stopsByFile.set(anchor.fileId, stops);

            const spans = claimed.get(anchor.fileId) ?? [];
            spans.push({ side: anchor.side, start: anchor.start, end: anchor.end });
            claimed.set(anchor.fileId, spans);
        }
    }

    const byFile = new Map<string, RouteMarginFile>();
    let uncoveredLines = 0;
    let uncoveredFiles = 0;
    let pendingFiles = 0;
    let failedFiles = 0;
    let conflictFiles = 0;
    for (const file of files) {
        conflictFiles += file.changeType === 'conflict' ? 1 : 0;
        const model = models.get(file.fileId) ?? null;
        if (model === null) {
            if (failed.has(file.fileId)) {
                failedFiles += 1;
            } else {
                pendingFiles += 1;
            }
        }
        const spans = claimed.get(file.fileId) ?? EMPTY_SPANS;
        const uncovered = model === null ? EMPTY_SPANS : uncoveredRanges(model, spans);
        const lines = spanLines(uncovered);
        uncoveredLines += lines;
        uncoveredFiles += lines > 0 ? 1 : 0;
        byFile.set(file.fileId, {
            fileId: file.fileId,
            stops: stopsByFile.get(file.fileId) ?? EMPTY_STOPS,
            uncovered,
            uncoveredLines: lines,
            parsed: model !== null,
            changed: changedLineCount(model, file, spans) > 0,
        });
    }

    const other = otherStopVisible(snapshot, { uncovered: pendingFiles > 0 ? null : uncoveredLines, conflictFiles });
    return {
        files: byFile,
        otherStopId: other ? (snapshot.stops.find((stop) => stop.tier === 'other')?.id ?? null) : null,
        uncoveredLines,
        uncoveredFiles,
        pendingFiles,
        failedFiles,
    };
}

/** Бейдж у файла вообще есть: без изменённых строк размещать нечего (двоичный файл, смена режима). */
export function marginBadgeShown(file: RouteMarginFile): boolean {
    return file.stops.length > 0 || file.changed;
}

/** Куда ведёт клик по бейджу: первая остановка файла, у штриховки — «Прочее». */
export function marginTargetStopId(file: RouteMarginFile, otherStopId: string | null): string | null {
    return file.stops[0]?.stopId ?? otherStopId;
}

/**
 * Номер в метке строки дерева. Метка — 17×13 у левого края (docs/design/SPEC-theming-2026-09-12.md §6a):
 * в неё помещается только номер первой остановки, остальные перечисляет тултип. Файл без
 * остановки текста не получает вовсе — за него говорит штриховка.
 */
export function treeBadgeLabel(file: RouteMarginFile): string {
    return file.stops[0]?.planLabel ?? '';
}

/**
 * Озвучка метки в строке дерева. Метка стоит первым потомком строки, а имя строки скринридер
 * собирает из её содержимого: полный заголовок остановки читался бы раньше имени файла, по
 * которому и ходят стрелками. Поэтому метка называет себя номером, а перечень остановок
 * остаётся в тултипе. Штриховке сокращать нечего — её подпись и так короткая.
 */
export function treeBadgeAria(file: RouteMarginFile, jumps: boolean, t: Translate): string {
    const first = file.stops[0];
    return first === undefined ? marginBadgeTitle(file, jumps, t) : t('margin.badge.treeAria', first.planLabel);
}

/** Бейдж карточки (docs/design/README.md §10): «объяснено в 02 · заголовок остановки». */
export function marginBadgeLabel(file: RouteMarginFile, t: Translate): string {
    const first = file.stops[0];
    if (first === undefined) {
        return t('margin.notPlacedCard');
    }
    // Бейдж — одна строка чипа: markdown в неё не отдать, бэктики модели срезаются.
    const title = stripInlineCode(first.title);
    return file.stops.length === 1
        ? t('margin.badge.explained', first.planLabel, title)
        : t('margin.badge.explainedMore', first.planLabel, file.stops.length - 1, title);
}

/**
 * Тултип и озвучка бейджа. Файл в нескольких остановках перечисляет их все: в подписи помещается
 * только первая, а знать, куда именно уедет клик, ревьюер обязан заранее.
 */
export function marginBadgeTitle(file: RouteMarginFile, jumps: boolean, t: Translate): string {
    const first = file.stops[0];
    if (first === undefined) {
        return t(jumps ? 'margin.badge.notPlacedJump' : 'margin.badge.notPlaced');
    }
    const numbers = file.stops.map((stop) => stop.planLabel).join(', ');
    const title = stripInlineCode(first.title);
    const where =
        file.stops.length === 1
            ? t('margin.badge.title', first.planLabel, title)
            : t('margin.badge.titleMany', numbers, title);
    return jumps ? t('margin.badge.titleJump', where) : where;
}

/**
 * Подпись штрихованной полосы под последней строкой непокрытого диапазона. Старая сторона — это
 * ровно удалённые строки, и молчать об этом нельзя: номера у сторон разные.
 */
export function marginStripText(span: AnchorSpan, t: Translate): string {
    const removed = span.side === 'old';
    // Номера — как в гаттере карточки (`diff-rows`), без разрядных разделителей: полоса указывает
    // на строку, и «1 234» рядом с «1234» глазами не сопоставить.
    const range = span.start === span.end ? String(span.start) : `${String(span.start)}–${String(span.end)}`;
    if (span.start === span.end) {
        return t(removed ? 'margin.strip.lineRemoved' : 'margin.strip.line', range);
    }
    return t(removed ? 'margin.strip.linesRemoved' : 'margin.strip.lines', range);
}

/** Свод диапазонов, которым не досталось отрисованной строки (свёрнутая карточка, «только пробелы»). */
export function marginStripSummary(spans: readonly AnchorSpan[], t: Translate): string {
    return t('margin.strip.summary', spanLines(spans));
}

/**
 * Футер-нота панели файлов (docs/design/README.md §10). Числа вычисленные: пока патчи разбираются, нота честно
 * говорит, что считает, а не показывает промежуточную сумму.
 */
export function marginFooterNote(model: RouteMarginModel, t: Translate): string | null {
    if (model.pendingFiles > 0) {
        return t('margin.footer.counting');
    }
    const failed = model.failedFiles === 0 ? '' : t('margin.footer.failed', model.failedFiles);
    if (model.uncoveredLines === 0) {
        return failed === '' ? null : t('margin.footer.hatchOnly', failed);
    }
    return t('margin.footer.uncovered', model.uncoveredLines, model.uncoveredFiles, failed);
}

/**
 * Изменённых строк файла — тем же правилом `changedLinesOf`, что и везде. Модели ещё нет —
 * счётчики патча; двоичный файл и смена режима дают ноль и бейджа не получают.
 *
 * Пустые и пробельные строки вне якорей вычитаются, как и в знаменателе вью маршрута: файл,
 * у которого других изменений нет, размещать негде — штрихованный
 * бейдж «вне маршрута» повёл бы в «Прочее», где этого файла нет.
 */
function changedLineCount(model: DiffFileModel | null, file: FileDiff, anchors: readonly AnchorSpan[]): number {
    const changed = changedLinesOf(model);
    if (changed !== undefined) {
        return changed.old.size + changed.new.size - droppedWhitespaceLines(model, anchors);
    }
    return model === null ? file.additions + file.deletions : 0;
}

const EMPTY_FAILED: ReadonlySet<string> = new Set();
const EMPTY_SPANS: readonly AnchorSpan[] = [];
const EMPTY_STOPS: readonly RouteMarginStop[] = [];

import type { RouteStop, RouteTestClaim, RouteTestClaimKind } from '@sherpa/protocol';

import type { MessageKey, Translate } from '../i18n/index.js';
import type { AnchorSpan } from './anchor-clip.js';
import { anchorSpans } from './anchor-clip.js';
import type { ContextLines, RouteEntry } from './route-model.js';

/**
 * Поведенческий дайджест тестов (docs/design/README.md §2, docs/product.md §6): у остановки вместо построчного чтения
 * тест-кода — список утверждений, а сам тест-код спрятан за Show test code.
 *
 * Чистый модуль: на входе стоп снапшота, на выходе — что рисовать и какие файлы остановки
 * считаются тест-кодом. Ни React, ни диффа: тот же вход у вью и у тестов.
 *
 * Правило раскладки строк: порядок утверждений — порядок модели, и он не сортируется. Вниз
 * уезжают только `uncovered` — это футерная строка «изменённое поведение без утверждения»
 * (инверсия дайджеста), а не ещё одна категория в общем списке.
 */

export interface DigestAnchorView {
    readonly fileId: string;
    readonly path: string;
    /** Имя файла без пути: ссылка печатается как `edit-window.test.ts:41`. */
    readonly name: string;
    readonly line: number;
}

export interface DigestClaimView {
    readonly kind: RouteTestClaimKind;
    readonly text: string;
    /** `null` — якоря нет: у `uncovered` его может не быть по построению (контракт `route.ts`). */
    readonly anchor: DigestAnchorView | null;
}

export interface DigestModel {
    /** Утверждений всего — знаменатель хедера; считается по данным, а не пишется руками. */
    readonly total: number;
    /** Строки списка в порядке модели: всё, кроме `uncovered`. */
    readonly rows: readonly DigestClaimView[];
    /** Футерные строки: изменённое поведение, оставшееся без утверждения. */
    readonly footer: readonly DigestClaimView[];
    /** Сколько утверждений отбросил валидатор (docs/design/SPEC-elements.md §4.3). */
    readonly dropped: number;
    /**
     * Файлы якорей утверждений — кандидаты на скрытие. Фактически дайджест прячет только их
     * пересечение с файлами своей остановки после текущей линзы (`buildDigestTestCode`).
     * `uncovered` сюда не входит — его якорь ведёт на код без покрытия, а не на тест.
     */
    readonly testFileIds: ReadonlySet<string>;
}

/** `null` — остановка обычная: утверждений у неё нет. */
export function buildDigest(stop: RouteStop): DigestModel | null {
    if (stop.tests.length === 0) {
        return null;
    }

    const rows: DigestClaimView[] = [];
    const footer: DigestClaimView[] = [];
    const testFileIds = new Set<string>();
    for (const claim of stop.tests) {
        const view = claimView(claim);
        if (claim.kind === 'uncovered') {
            footer.push(view);
            continue;
        }
        rows.push(view);
        if (view.anchor !== null) {
            testFileIds.add(view.anchor.fileId);
        }
    }

    return { total: stop.tests.length, rows, footer, dropped: stop.droppedClaims, testFileIds };
}

export interface DigestAnchorTarget {
    readonly stopId: string;
    /**
     * Сторона гаттера, на которой строка нарисована в срезе этой записи. `null` — файл
     * на маршруте есть, а этой строки в его срезах нет: прыжок довезёт только до карточки.
     */
    readonly side: 'old' | 'new' | null;
}

export type DigestTestCodeLocation =
    | {
          readonly kind: 'anchor';
          readonly label: string;
          /** Первый разрешимый якорь: вью повторно резолвит его перед прыжком по актуальному маршруту. */
          readonly anchor: DigestAnchorView;
          readonly target: DigestAnchorTarget;
      }
    | {
          readonly kind: 'hidden-by-lens';
          readonly label: string;
          /** Первый якорь своей остановки: переход сбросит линзу и раскроет тест-код. */
          readonly anchor: DigestAnchorView;
      };

export interface DigestTestCodeModel {
    /** Файлы текущей остановки, которые тогл действительно может скрыть. */
    readonly hiddenFileIds: ReadonlySet<string>;
    /** Что показать вместо тогла, если его пересечение с файлами остановки пусто. */
    readonly location: DigestTestCodeLocation | null;
}

/**
 * Семантика тест-кода дайджеста после линзы: что реально прячется и куда вести, если прятать
 * нечего. Для ссылки учитываются только обычные утверждения; `uncovered` объясняет свой футер.
 */
export function buildDigestTestCode(
    digest: DigestModel,
    entries: readonly RouteEntry[],
    fromStopId: string,
    stopFileIds: readonly string[],
    t: Translate,
): DigestTestCodeModel {
    const hiddenFileIds = new Set(stopFileIds.filter((fileId) => digest.testFileIds.has(fileId)));
    if (hiddenFileIds.size > 0) {
        return { hiddenFileIds, location: null };
    }

    const otherEntries = entries.filter((entry) => entry.view.stop.id !== fromStopId);
    const resolved = digest.rows.flatMap((claim) => {
        if (claim.anchor === null) {
            return [];
        }
        const target = resolveAnchor(otherEntries, fromStopId, claim.anchor.fileId, claim.anchor.line);
        return target === null ? [] : [{ anchor: claim.anchor, target }];
    });
    const first = resolved[0];
    if (first === undefined) {
        const ownEntry = entries.find((entry) => entry.view.stop.id === fromStopId);
        const ownFileIds = new Set(ownEntry?.view.files.map((file) => file.fileId) ?? []);
        const anchor = digest.rows.find((claim) =>
            claim.anchor === null ? false : ownFileIds.has(claim.anchor.fileId),
        )?.anchor;
        return {
            hiddenFileIds,
            location:
                anchor === undefined || anchor === null
                    ? null
                    : { kind: 'hidden-by-lens', label: t('digest.testCode.hiddenByLens'), anchor },
        };
    }

    const targetIds = new Set(resolved.map(({ target }) => target.stopId));
    const targetEntry = entries.find((entry) => entry.view.stop.id === first.target.stopId);
    if (targetEntry === undefined) {
        return { hiddenFileIds, location: null };
    }
    const label =
        targetIds.size > 1
            ? t('digest.testCode.elsewhere')
            : targetEntry.kind === 'other'
              ? t('digest.testCode.inOther')
              : t('digest.testCode.inStop', targetEntry.view.planLabel);

    return {
        hiddenFileIds,
        location: { kind: 'anchor', label, anchor: first.anchor, target: first.target },
    };
}

/**
 * Куда ведёт якорь утверждения. Выбор идёт по строке, а не по одному лишь файлу: один и тот же
 * файл маршрут обычно режет диапазонами между несколькими остановками, и запись, где нужной
 * строки нет, — не цель. Порядок предпочтений: своя остановка со строкой (тест-код дайджеста —
 * её файлы) → любая запись со строкой по порядку рендера (якорь `uncovered` ведёт на код без
 * покрытия — его объясняет чужая остановка или «Прочее») → запись, которая хотя бы рисует файл.
 *
 * В якоре утверждения стороны нет (контракт `route.ts`), поэтому она восстанавливается из среза:
 * новая сторона выигрывает у старой — на ней живёт добавленный и оставшийся тест, старая остаётся
 * удалённому. `null` — файла на маршруте нет вовсе: ссылка тогда неактивна, и вью не делает вид,
 * что прыжок случится.
 */
export function resolveAnchor(
    entries: readonly RouteEntry[],
    fromStopId: string,
    fileId: string,
    line: number,
): DigestAnchorTarget | null {
    let onLine: DigestAnchorTarget | null = null;
    let ownFile: DigestAnchorTarget | null = null;
    let anyFile: DigestAnchorTarget | null = null;
    for (const entry of entries) {
        const drawn = drawnFile(entry, fileId);
        if (drawn === null) {
            continue;
        }
        const stopId = entry.view.stop.id;
        const side = sideOf(drawn, line);
        if (side !== null) {
            if (stopId === fromStopId) {
                return { stopId, side };
            }
            onLine ??= { stopId, side };
            continue;
        }
        if (stopId === fromStopId) {
            ownFile ??= { stopId, side: null };
        } else {
            anyFile ??= { stopId, side: null };
        }
    }
    return onLine ?? ownFile ?? anyFile;
}

/** Что запись маршрута рисует для этого файла: диапазоны якорей и неизменённые строки вокруг них. */
interface DrawnFile {
    readonly spans: readonly AnchorSpan[];
    readonly context: ContextLines;
}

/**
 * Свёрнутые якоря (`collapsedAnchors`) сюда не входят: карточка печатает их строкой-сводкой,
 * самих строк в разметке нет — прыгать в них некуда.
 */
function drawnFile(entry: RouteEntry, fileId: string): DrawnFile | null {
    if (entry.kind === 'stop') {
        const group = entry.view.files.find((candidate) => candidate.fileId === fileId);
        return group === undefined
            ? null
            : { spans: anchorSpans(group.anchors), context: group.contextLines };
    }
    const file = entry.view.files.find((candidate) => candidate.fileId === fileId);
    return file === undefined ? null : { spans: file.anchors, context: file.contextLines };
}

function sideOf(drawn: DrawnFile, line: number): 'old' | 'new' | null {
    for (const side of ['new', 'old'] as const) {
        const inSpan = drawn.spans.some(
            (span) => span.side === side && line >= span.start && line <= span.end,
        );
        if (inSpan || drawn.context[side].has(line)) {
            return side;
        }
    }
    return null;
}

/** Ключ подписи чипа категории; семантика по docs/design/README.md §2. */
export function claimLabel(kind: RouteTestClaimKind): MessageKey {
    switch (kind) {
        case 'new':
            return 'digest.kind.new';
        case 'changed':
            return 'digest.kind.changed';
        case 'weakened':
            return 'digest.kind.weakened';
        default:
            return 'digest.kind.uncovered';
    }
}

/** Ссылка на строку теста: `edit-window.test.ts:41` (docs/design/README.md §2, 11px mono). */
export function anchorLabel(anchor: DigestAnchorView): string {
    return `${anchor.name}:${String(anchor.line)}`;
}

function claimView(claim: RouteTestClaim): DigestClaimView {
    const anchor = claim.anchor;
    return {
        kind: claim.kind,
        text: claim.text,
        anchor:
            anchor === null
                ? null
                : { fileId: anchor.fileId, path: anchor.path, name: baseName(anchor.path), line: anchor.line },
    };
}

function baseName(path: string): string {
    return path.slice(path.lastIndexOf('/') + 1);
}

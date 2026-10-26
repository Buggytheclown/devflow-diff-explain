import type {
    HostId,
    Locale,
    PrDiff,
    RouteAnchor,
    RouteSectionResult,
    RouteStop,
    RouteStopChange,
    RouteTestClaim,
} from '@sherpa/protocol';
import { routeSectionResultSchema } from '@sherpa/protocol';

import type { IterationMap } from '../iterations/index.js';
import { classifyStop } from '../iterations/index.js';
import type { ChangedFile, DiffIndex } from './diff-index.js';
import { indexDiff, touchesChangedLines } from './diff-index.js';
import { paragraphMarkupErrors } from './paragraph-markup.js';
import { parseResult } from './raw-result.js';
import type { LineRange } from './ranges.js';
import { rangesOverlap, subtractRanges } from './ranges.js';
import type { RouteStrings } from './strings.js';
import { routeStrings } from './strings.js';
import type { RouteStopFilling, RouteValidation } from './types.js';
import { voiceErrors } from './voice.js';

/**
 * Приёмка результата задачи `route.section`: сырой текст → нормализованные заполнения стопов.
 *
 * Деградация двухуровневая. Мягкие правила режут отдельный элемент (якорь, утверждение дайджеста)
 * и оставляют ревьюеру пометку; жёсткие отвергают результат целиком, и модель правит его сама
 * (rpc-design §3). Жёсткие: чужой или несуществующий плановый номер, `end < start`, стоп, у
 * которого не выжил ни один якорь.
 */

type RawSectionStop = RouteSectionResult['stops'][number];
type RawAnchor = RawSectionStop['anchors'][number];
type RawClaim = NonNullable<RawSectionStop['tests']>[number];

/** Занятый диапазон: чей он, нужно для пометки «уже объяснён в стопе 02». */
interface OccupiedRange extends LineRange {
    readonly planIndex: number;
}

/** Ключ занятости — файл и сторона: диапазоны разных сторон друг с другом не спорят. */
type Occupancy = Map<string, OccupiedRange[]>;

/**
 * Контекст приёмки секции: язык генерации и то, чем сервер классифицирует стопы (M4-T7).
 * Первая генерация маршрута обходится значениями по умолчанию.
 */
export interface SectionContext {
    /**
     * Язык генерации: на нём написан результат модели (стоп-лист голоса) и пометки валидатора,
     * которые уедут в снапшот. По умолчанию русский — так выглядела генерация до M5.
     */
    readonly locale?: Locale;
    /** Отображение строк «итерация прошлого снапшота → итерация генерации»; null — классификации нет. */
    readonly map?: IterationMap | null;
    /** Треды, добытые на старте генерации: ссылки на любые другие вырезаются из текста. */
    readonly knownThreadIds?: ReadonlySet<HostId>;
}

const NO_THREADS: ReadonlySet<HostId> = new Set();

/** Сколько тредов-причин влезает в стоп (контракт `routeSectionResultSchema.changeThreadIds`). */
const MAX_CHANGE_THREADS = 20;

/** Ссылка на тред в тексте модели: `[thread:4820242]`. */
const THREAD_TOKEN = /\[thread:([^\]\s]+)\]/g;

/** Результат разбора якорей одного стопа. */
interface AnchorOutcome {
    readonly anchors: RouteAnchor[];
    readonly notes: string[];
    /** Английские причины отброшенных якорей — уедут в ошибку, если стоп остался без якорей. */
    readonly dropReasons: string[];
}

export function validateSection(
    rawText: string,
    plan: readonly RouteStop[],
    allowedPlanIndexes: readonly number[],
    diff: PrDiff,
    context: SectionContext = {},
): RouteValidation<RouteStopFilling[]> {
    const locale = context.locale ?? 'ru';
    const strings = routeStrings(locale);
    const parsed = parseResult(rawText, routeSectionResultSchema, 'section');
    if (!parsed.ok) {
        return parsed;
    }

    const index = indexDiff(diff);
    const planStops = new Map(plan.filter((stop) => stop.tier !== 'other').map((stop) => [stop.planIndex, stop]));
    const allowed = new Set(allowedPlanIndexes);
    // Порядок обработки — по плановому номеру: внутри одного результата спор за диапазон
    // выигрывает меньший номер. Между результатами правило другое, см. `planOccupancy`.
    // Позиция в выводе модели едет с элементом: пути в ошибках должны указывать на её JSON.
    const stops = parsed.value.stops
        .map((stop, sourceIndex) => ({ stop, sourceIndex }))
        .sort((left, right) => left.stop.planIndex - right.stop.planIndex);
    const filled = new Set(stops.map((entry) => entry.stop.planIndex));
    const occupancy = planOccupancy(plan, filled);

    const errors: string[] = [];
    const fillings: RouteStopFilling[] = [];
    const seen = new Set<number>();

    stops.forEach(({ stop, sourceIndex }) => {
        const at = `section.stops[${String(sourceIndex)}]`;
        if (seen.has(stop.planIndex)) {
            errors.push(
                `${at}.planIndex: stop ${String(stop.planIndex)} is filled twice in this result. Return one entry per stop.`,
            );
            return;
        }
        seen.add(stop.planIndex);

        if (!planStops.has(stop.planIndex)) {
            errors.push(
                `${at}.planIndex: ${String(stop.planIndex)} is not a stop of the route plan (plan numbers are 1..${String(planStops.size)}). Fill only the stops assigned to this task: ${listNumbers(allowedPlanIndexes)}.`,
            );
            return;
        }
        if (!allowed.has(stop.planIndex)) {
            errors.push(
                `${at}.planIndex: stop ${String(stop.planIndex)} is not assigned to this task. Fill only these stops: ${listNumbers(allowedPlanIndexes)}.`,
            );
            return;
        }

        const voice = [
            ...voiceErrors(`${at}.paragraph`, stop.paragraph, locale),
            ...voiceErrors(`${at}.bridge`, stop.bridge, locale),
            ...voiceErrors(`${at}.changeReason`, stop.changeReason, locale),
            ...(stop.tests ?? []).flatMap((claim, position) =>
                voiceErrors(`${at}.tests[${String(position)}].text`, claim.text, locale),
            ),
        ];
        if (voice.length > 0) {
            errors.push(...voice);
            return;
        }

        // Разметка описания — такая же жёсткая ветка, что и голос: словарь узкий, и урезать
        // чужую разметку молча нельзя — секция переписывается целиком.
        const markup = paragraphMarkupErrors(`${at}.paragraph`, stop.planIndex, stop.paragraph);
        if (markup.length > 0) {
            errors.push(...markup);
            return;
        }

        const rangeErrors = brokenRanges(stop.anchors, at, stop.planIndex);
        if (rangeErrors.length > 0) {
            errors.push(...rangeErrors);
            return;
        }

        const outcome = resolveAnchors(stop, index, occupancy, strings);
        if (outcome.anchors.length === 0) {
            errors.push(
                `${at}: every anchor of stop ${String(stop.planIndex)} was dropped (${outcome.dropReasons.join('; ')}). Re-anchor the stop to lines this diff actually changes and call complete again.`,
            );
            return;
        }
        occupy(occupancy, stop.planIndex, outcome.anchors);

        const digest = resolveClaims(stop.tests ?? [], index, strings);
        const change = resolveChange(stop, outcome.anchors, context, strings);
        fillings.push({
            planIndex: stop.planIndex,
            paragraph: change.paragraph,
            bridge: stop.bridge ?? null,
            anchors: outcome.anchors,
            tests: digest.claims,
            droppedClaims: digest.dropped,
            validationNotes: [...outcome.notes, ...digest.notes, ...change.notes],
            change: change.change,
        });
    });

    return errors.length > 0 ? { ok: false, errors } : { ok: true, value: fillings };
}

/** Разбор «почему изменилась остановка»: классификация сервера, причина модели и ссылки на треды. */
interface ChangeOutcome {
    readonly change: RouteStopChange | null;
    /** Абзац без ссылок на неизвестные треды: их модель писать не должна. */
    readonly paragraph: string;
    readonly notes: string[];
}

/**
 * Вид изменения (`new`/`changed`) считает сервер по резолвнутым якорям и отображению строк —
 * модель его не выбирает (решение нарезки 5). Причина остаётся только у классифицированного
 * стопа; ссылки на треды, которых сервер не добывал, вырезаются из текста.
 */
function resolveChange(
    raw: RawSectionStop,
    anchors: readonly RouteAnchor[],
    context: SectionContext,
    strings: RouteStrings,
): ChangeOutcome {
    const known = context.knownThreadIds ?? NO_THREADS;
    const notes: string[] = [];
    const unknown = new Set<HostId>();
    const paragraph = stripThreadTokens(raw.paragraph, known, unknown);
    const map = context.map ?? null;
    const kind = map === null ? null : classifyStop({ anchors: [...anchors] }, map);

    if (kind === null) {
        if (raw.changeReason !== undefined) {
            notes.push(strings.changeReasonDropped);
        }
        return { change: null, paragraph, notes: [...notes, ...unknownThreadNotes(unknown, strings)] };
    }

    const stripped = raw.changeReason === undefined ? null : stripThreadTokens(raw.changeReason, known, unknown);
    // Текст, от которого после выреза битых ссылок ничего не осталось, — не причина: UI рисует
    // блок «почему изменилась остановка» по `reason !== null` и показал бы пустой.
    const reason = stripped === '' ? null : stripped;
    const cited = raw.changeReason === undefined ? [] : threadTokensOf(raw.changeReason);
    // Ссылки берутся и без причины: `changeThreadIds` сам по себе указывает ревьюеру обсуждение.
    const threadIds: HostId[] = [];
    for (const id of [...(raw.changeThreadIds ?? []), ...cited]) {
        if (!known.has(id)) {
            unknown.add(id);
            continue;
        }
        if (!threadIds.includes(id) && threadIds.length < MAX_CHANGE_THREADS) {
            threadIds.push(id);
        }
    }

    return {
        change: { kind, reason, threadIds },
        paragraph,
        notes: [...notes, ...unknownThreadNotes(unknown, strings)],
    };
}

function unknownThreadNotes(ids: ReadonlySet<HostId>, strings: RouteStrings): string[] {
    return [...ids].map((id) => strings.unknownThread(id));
}

function threadTokensOf(text: string): HostId[] {
    return [...text.matchAll(THREAD_TOKEN)].map(([, id]) => id ?? '');
}

/**
 * Токены `[thread:<id>]` из текста вон: UI показывает ссылки на треды отдельным рядом по
 * `threadIds`, а в прозе токен вывелся бы литералом; неизвестные id ещё и ведут в никуда.
 * Шов после выреза заглаживается — двойной пробел и пробел перед знаком препинания выдают
 * вырезанный токен.
 */
function stripThreadTokens(text: string, known: ReadonlySet<HostId>, unknown: Set<HostId>): string {
    let cut = 0;
    const stripped = text.replaceAll(THREAD_TOKEN, (_token, id: string) => {
        cut += 1;
        if (!known.has(id)) {
            unknown.add(id);
        }
        return '';
    });
    return cut === 0
        ? text
        : stripped.replaceAll(/[ \t]{2,}/g, ' ').replaceAll(/[ \t]+([,.;:!?)])/g, '$1').trim();
}

/**
 * Уже принятые заполнения плана. Стопы, которые заполняет этот результат, из занятости
 * исключены: повторная сдача той же секции иначе спорила бы сама с собой.
 *
 * Правило спора между результатами — «кто занял первым, того и диапазон», независимо от
 * планового номера (SPEC §4.3: the validator keeps the first, the second shows «range moved
 * to stop 02»). Валидатор — чистая функция от уже принятого и не правит чужие заполнения,
 * поэтому отобрать диапазон у принятого стопа он не может, даже если у претендента номер
 * меньше. Практическое следствие для оркестрации (M2-T4): если для качества маршрута важен
 * приоритет по плановому номеру, секции надо принимать в порядке плана — валидатор этого
 * не гарантирует, а стопы по построению приезжают вразнобой (README §8).
 */
function planOccupancy(plan: readonly RouteStop[], refilled: ReadonlySet<number>): Occupancy {
    const occupancy: Occupancy = new Map();
    for (const stop of plan) {
        if (refilled.has(stop.planIndex)) {
            continue;
        }
        occupy(occupancy, stop.planIndex, stop.anchors);
    }
    return occupancy;
}

function occupy(occupancy: Occupancy, planIndex: number, anchors: readonly RouteAnchor[]): void {
    for (const anchor of anchors) {
        const key = occupancyKey(anchor.fileId, anchor.side);
        const list = occupancy.get(key) ?? [];
        list.push({ start: anchor.start, end: anchor.end, planIndex });
        occupancy.set(key, list);
    }
}

function occupancyKey(fileId: string, side: 'old' | 'new'): string {
    return `${fileId} ${side}`;
}

/** `end < start` схема не ловит: у неё оба поля независимы. */
function brokenRanges(anchors: readonly RawAnchor[], at: string, planIndex: number): string[] {
    return anchors.flatMap((anchor, position) =>
        anchor.end < anchor.start
            ? [
                  `${at}.anchors[${String(position)}]: stop ${String(planIndex)} has end (${String(anchor.end)}) before start (${String(anchor.start)}). An anchor is an inclusive range, so end must be >= start.`,
              ]
            : [],
    );
}

/**
 * Резолв якорей стопа: `path` → `fileId`, отсев мёртвых, вычитание чужих диапазонов.
 * Частичное пересечение с контекстом якорь сохраняет как есть: реальная модель отдаёт
 * диапазоны с контекстом, а покрытие всё равно считается пересечением с изменёнными строками.
 */
function resolveAnchors(
    stop: RawSectionStop,
    index: DiffIndex,
    occupancy: Occupancy,
    strings: RouteStrings,
): AnchorOutcome {
    const anchors: RouteAnchor[] = [];
    const notes: string[] = [];
    const dropReasons: string[] = [];

    stop.anchors.forEach((raw, position) => {
        const where = `anchor ${String(position + 1)} ("${raw.path}" ${raw.side} ${String(raw.start)}-${String(raw.end)})`;
        const file = index.get(raw.path);
        if (file === undefined) {
            notes.push(strings.anchorFileMissing(raw.path));
            dropReasons.push(`${where}: the file is not in this diff`);
            return;
        }
        if (!touchesChangedLines(file, raw.side, raw.start, raw.end)) {
            notes.push(strings.anchorNotChanged(raw.path, lineSpan(raw)));
            dropReasons.push(`${where}: it covers no line changed on the ${raw.side} side`);
            return;
        }

        const rest = surviving(raw, file, occupancy);
        if (rest.pieces.length === 0) {
            notes.push(strings.rangeTaken(raw.path, lineSpan(raw), stopLabel(rest.owner)));
            dropReasons.push(`${where}: the range is already explained by stop ${stopLabel(rest.owner)}`);
            return;
        }
        if (rest.trimmed) {
            notes.push(strings.rangeTrimmed(raw.path, lineSpan(raw), stopLabel(rest.owner)));
        }
        for (const piece of rest.pieces) {
            anchors.push({
                fileId: file.fileId,
                path: raw.path,
                side: raw.side,
                start: piece.start,
                end: piece.end,
                collapsed: raw.collapsed ?? false,
            });
        }
    });

    return { anchors, notes, dropReasons };
}

interface SurvivingRange {
    readonly pieces: LineRange[];
    /** Плановый номер стопа, забравшего диапазон первым; null — спора не было. */
    readonly owner: number | null;
    readonly trimmed: boolean;
}

/** Что осталось от якоря после вычитания чужих диапазонов той же стороны того же файла. */
function surviving(raw: RawAnchor, file: ChangedFile, occupancy: Occupancy): SurvivingRange {
    const range: LineRange = { start: raw.start, end: raw.end };
    const occupied = occupancy.get(occupancyKey(file.fileId, raw.side)) ?? [];
    const rivals = occupied.filter((busy) => rangesOverlap(range, busy));
    if (rivals.length === 0) {
        return { pieces: [range], owner: null, trimmed: false };
    }

    const owner = Math.min(...rivals.map((rival) => rival.planIndex));
    // Куски, оставшиеся без изменённых строк, — голый контекст: отдавать их стопу незачем.
    const pieces = subtractRanges(range, rivals).filter((piece) =>
        touchesChangedLines(file, raw.side, piece.start, piece.end),
    );
    return { pieces, owner, trimmed: true };
}

/** Дайджест тестов: принятые утверждения, счётчик отброшенных и пометки ревьюеру. */
interface DigestOutcome {
    readonly claims: RouteTestClaim[];
    readonly dropped: number;
    readonly notes: string[];
}

/**
 * Разбор дайджеста. `new`/`changed`/`weakened` без якоря на существующий в диффе файл
 * отбрасываются со счётчиком (SPEC §4.3); `uncovered` живёт и без якоря — «изменённое
 * поведение без покрытия» по построению некуда заякорить.
 *
 * «Тестовость» пути не проверяется: что считать тест-файлом, знает репозиторий, а не валидатор,
 * и ошибка здесь стоила бы дороже пропуска — утверждение всё равно читается ревьюером с якорем.
 */
function resolveClaims(raws: readonly RawClaim[], index: DiffIndex, strings: RouteStrings): DigestOutcome {
    const claims: RouteTestClaim[] = [];
    const missingFiles: string[] = [];
    let anchorless = 0;

    for (const raw of raws) {
        const file = raw.testPath === undefined ? undefined : index.get(raw.testPath);
        const anchor =
            raw.testPath === undefined || raw.testLine === undefined || file === undefined
                ? null
                : { fileId: file.fileId, path: raw.testPath, line: raw.testLine };

        if (raw.kind !== 'uncovered' && anchor === null) {
            if (raw.testPath !== undefined && file === undefined) {
                missingFiles.push(raw.testPath);
            } else {
                anchorless += 1;
            }
            continue;
        }
        claims.push({ kind: raw.kind, text: raw.text, anchor });
    }

    const notes = [
        ...(missingFiles.length > 0 ? [strings.claimsMissingFiles(missingFiles)] : []),
        ...(anchorless > 0 ? [strings.claimsAnchorless(anchorless)] : []),
    ];
    return { claims, dropped: missingFiles.length + anchorless, notes };
}

function lineSpan(raw: RawAnchor): string {
    return raw.start === raw.end ? String(raw.start) : `${String(raw.start)}–${String(raw.end)}`;
}

/** Плановый номер в том же виде, в каком его видит ревьюер в UI: `02`. */
function stopLabel(planIndex: number | null): string {
    return planIndex === null ? '??' : String(planIndex).padStart(2, '0');
}

function listNumbers(values: readonly number[]): string {
    return values.length === 0 ? 'none' : [...values].sort((left, right) => left - right).join(', ');
}

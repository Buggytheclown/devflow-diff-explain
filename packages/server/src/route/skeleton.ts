import type { Locale, RouteStop } from '@sherpa/protocol';
import { routeSkeletonResultSchema } from '@sherpa/protocol';

import { markupErrors } from './paragraph-markup.js';
import { parseResult } from './raw-result.js';
import { routeStrings } from './strings.js';
import type { AcceptedSkeleton, RouteValidation } from './types.js';
import { voiceErrors } from './voice.js';

/**
 * Приёмка результата задачи `route.skeleton`: сырой текст → план стопов.
 *
 * Скелет якорей не несёт, поэтому дифф здесь не нужен — семантика ограничена планом:
 * `tourOrder` обязан быть перестановкой плановых номеров 1..N, иначе полный тур не построить.
 * Id стопов и синтетическое «Прочее» назначает сервер.
 */

/** Id синтетического стопа: модель про него не знает, его добавляет сервер. */
export const OTHER_STOP_ID = 'other';

/** Заголовок синтетического стопа на языке генерации (`strings.ts`). */
export function otherStopTitle(locale: Locale): string {
    return routeStrings(locale).otherStopTitle;
}

/** Конвенция id планового стопа: `s01`..`sNN` по плановому номеру. */
export function stopId(planIndex: number): string {
    return `s${String(planIndex).padStart(2, '0')}`;
}

/**
 * `locale` — язык генерации: на нём написан результат модели (по нему выбирается стоп-лист
 * голоса) и заголовок синтетического стопа. По умолчанию русский: так же читается
 * `provenance.locale: null` у снапшотов старого формата.
 */
export function validateSkeleton(rawText: string, locale: Locale = 'ru'): RouteValidation<AcceptedSkeleton> {
    const parsed = parseResult(rawText, routeSkeletonResultSchema, 'skeleton');
    if (!parsed.ok) {
        return parsed;
    }

    const result = parsed.value;
    const tourError = tourOrderError(result.tourOrder, result.stops.length);
    // Голос проверяется только у текстов, которые читает ревьюер: `intent` едет модели секций.
    // Summary пишется словарём описания остановки, но без бюджета длины.
    const errors = [
        ...(tourError === null ? [] : [tourError]),
        ...voiceErrors('skeleton.summary', result.summary, locale),
        ...markupErrors('skeleton.summary', 'summary', result.summary),
        ...result.stops.flatMap((stop, index) =>
            voiceErrors(`skeleton.stops[${String(index)}].title`, stop.title, locale),
        ),
    ];
    if (errors.length > 0) {
        return { ok: false, errors };
    }

    const stops: RouteStop[] = result.stops.map((stop, index) => ({
        id: stopId(index + 1),
        planIndex: index + 1,
        tier: stop.tier,
        title: stop.title,
        status: 'queued',
        paragraph: null,
        bridge: null,
        anchors: [],
        tests: [],
        droppedClaims: 0,
        validationNotes: [],
        provenance: null,
        // Классификацию стопа считает приёмка секции: у плана ещё нет якорей.
        change: null,
    }));

    return {
        ok: true,
        value: {
            summary: result.summary,
            stops: [...stops, otherStop(stops.length + 1, locale)],
            tourOrder: [...result.tourOrder.map(stopId), OTHER_STOP_ID],
            intents: new Map(result.stops.map((stop, index) => [index + 1, stop.intent])),
        },
    };
}

/**
 * «Прочее»: заполнять нечего — статус `ready` сразу, якорей нет, содержимое (непокрытые
 * диапазоны) считает UI. UI прячет стоп сам, пока маршрут не достроен и при нуле
 * непокрытых строк (`docs/design/SPEC-elements.md §4.3`).
 */
function otherStop(planIndex: number, locale: Locale): RouteStop {
    return {
        id: OTHER_STOP_ID,
        planIndex,
        tier: 'other',
        title: otherStopTitle(locale),
        status: 'ready',
        paragraph: null,
        bridge: null,
        anchors: [],
        tests: [],
        droppedClaims: 0,
        validationNotes: [],
        provenance: null,
        change: null,
    };
}

/** Разбор `tourOrder` на перестановку 1..N: сообщение называет и дубли, и дыры, и выходы за план. */
function tourOrderError(tourOrder: readonly number[], planSize: number): string | null {
    const seen = new Set<number>();
    const duplicated = new Set<number>();
    const outOfRange = new Set<number>();
    for (const value of tourOrder) {
        if (value < 1 || value > planSize) {
            outOfRange.add(value);
            continue;
        }
        if (seen.has(value)) {
            duplicated.add(value);
        }
        seen.add(value);
    }
    const missing = [];
    for (let index = 1; index <= planSize; index += 1) {
        if (!seen.has(index)) {
            missing.push(index);
        }
    }
    if (duplicated.size === 0 && outOfRange.size === 0 && missing.length === 0) {
        return null;
    }

    const clauses = [
        ...(duplicated.size > 0 ? [`listed twice: ${sortedList(duplicated)}`] : []),
        ...(missing.length > 0 ? [`missing: ${missing.join(', ')}`] : []),
        ...(outOfRange.size > 0 ? [`outside the plan: ${sortedList(outOfRange)}`] : []),
    ];
    return `skeleton.tourOrder must list every plan number 1..${String(planSize)} exactly once (${clauses.join('; ')}). Reorder the numbers, do not add or drop stops.`;
}

function sortedList(values: ReadonlySet<number>): string {
    return [...values].sort((left, right) => left - right).join(', ');
}

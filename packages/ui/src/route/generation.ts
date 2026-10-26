import type { Locale, RouteProvenance, RouteSnapshot, RouteStopStatus, UiRouteState, UiTask } from '@sherpa/protocol';

import type { MessageKey, Translate } from '../i18n/index.js';
import type { ViewId } from '../session/views.js';
import type { OtherStopFacts } from './other-stop.js';
import { UNKNOWN_OTHER, visibleStops } from './other-stop.js';
import { planLabel } from './route-model.js';

/**
 * Модель генеративных состояний маршрута (docs/design/README.md §6–8, docs/design/SPEC-elements.md §3): что показывать в карточке
 * генерации Overview и в скелете вью маршрута. Чистый модуль — ни React, ни сети.
 *
 * Все числа считаются из `snapshot.stops[].status`: «N из M», сегмент-бар и план-лист обязаны
 * говорить об одном и том же наборе слотов. «3 of 7» из docs/design/README.md — иллюстрация их данных,
 * а не константа.
 */

/**
 * Что рисует вкладка «Маршрут» (docs/design/README.md §6–8 и §12, docs/design/SPEC-elements.md §4.1). Решение отделено от App:
 * фаз пять, снапшот бывает частичным, и разводка обязана быть проверяемой без сервера.
 *
 * Живой снапшот всегда выигрывает у фазы: при перестройке и её провале старый маршрут остаётся
 * рабочим. Фаза без своих данных деградирует в приглашение, а не в пустой экран.
 */
export type RouteViewKind = 'workspace' | 'reading' | 'failed' | 'small-pr' | 'invitation';

export function routeViewKind(route: UiRouteState | null): RouteViewKind {
    if (route === null) {
        return 'invitation';
    }
    if (route.snapshot !== null) {
        return 'workspace';
    }
    if (route.phase === 'reading') {
        return 'reading';
    }
    if (route.phase === 'failed' && route.failure !== null) {
        return 'failed';
    }
    return route.smallPr ? 'small-pr' : 'invitation';
}

/** Единый гард всех точек запуска генерации маршрута. */
export function routeGenerationAvailable({
    phase,
    smallPr,
    generating,
}: {
    readonly phase: UiRouteState['phase'] | null;
    readonly smallPr: boolean;
    readonly generating: boolean;
}): boolean {
    return !smallPr && !generating && (phase === 'none' || phase === 'ready' || phase === 'failed');
}

/**
 * Что рисует карточка генерации в рельсе Overview; `null` — в этой фазе ей нечего сказать
 * (маршрут не запускали, либо фаза приехала без своих данных).
 */
export type GenerationCardKind = 'failed' | 'ready' | 'filling' | 'reading' | null;

export function generationCardKind(route: UiRouteState | null): GenerationCardKind {
    if (route === null) {
        return null;
    }
    if (route.phase === 'failed' && route.failure !== null) {
        return 'failed';
    }
    if (route.phase === 'ready' && route.snapshot !== null) {
        return 'ready';
    }
    if (route.phase === 'filling' && route.snapshot !== null) {
        return 'filling';
    }
    return route.phase === 'reading' ? 'reading' : null;
}

/**
 * Есть ли на экране место, где ошибка ручки генерации встанет рядом с вызвавшим её действием.
 * Таких мест два: красная карточка вкладки маршрута и карточка генерации в рельсе Overview
 * (у готового маршрута строки под ошибку нет — там нечего повторять). Во всех прочих сочетаниях
 * вью и фазы за ошибку отвечает слот баннеров: иначе «Построить маршрут» из палитры в фазе
 * `none` проваливалось бы молча.
 */
export function routeActionErrorInPlace(view: ViewId, route: UiRouteState | null): boolean {
    if (view === 'route') {
        return routeViewKind(route) === 'failed';
    }
    if (view !== 'overview') {
        return false;
    }
    const kind = generationCardKind(route);
    return kind === 'failed' || kind === 'filling' || kind === 'reading';
}

export interface GenerationSlot {
    readonly id: string;
    /** План-фиксированный номер: `01`. */
    readonly planLabel: string;
    readonly title: string;
    readonly status: RouteStopStatus;
}

export interface GenerationProgress {
    readonly slots: readonly GenerationSlot[];
    /** Слотов, готовых к чтению. */
    readonly ready: number;
    readonly total: number;
}

/**
 * Слоты плана — только видимые остановки: пока маршрут достраивается, «Прочего» среди них нет
 * (`otherStopVisible`), и в счёт «N из M» оно не входит.
 */
export function generationProgress(snapshot: RouteSnapshot, other: OtherStopFacts = UNKNOWN_OTHER): GenerationProgress {
    const slots = visibleStops(snapshot, other).map((stop) => ({
        id: stop.id,
        planLabel: planLabel(stop.planIndex),
        title: stop.title,
        status: stop.status,
    }));
    return {
        slots,
        ready: slots.filter((slot) => slot.status === 'ready').length,
        total: slots.length,
    };
}

/** Открытые задачи генерации маршрута: их и отменяет «Отменить» (docs/design/SPEC-elements.md §3). */
export function openRouteTasks(tasks: readonly UiTask[]): readonly UiTask[] {
    return tasks.filter(
        (task) =>
            (task.type === 'route.skeleton' || task.type === 'route.section') &&
            (task.status === 'queued' || task.status === 'leased'),
    );
}

/** Порог «всё ещё работаю» из docs/design/SPEC-elements.md §3: задача идёт дольше минуты. */
export const LONG_GENERATION_MS = 60_000;

/** Самая старая открытая задача маршрута перевалила за порог. */
export function generationIsLong(tasks: readonly UiTask[], now: number): boolean {
    return openRouteTasks(tasks).some((task) => now - Date.parse(task.createdAt) >= LONG_GENERATION_MS);
}

/**
 * Язык, на котором построен маршрут. `null` в провенансе несут старые снапшоты — они русские.
 */
export function snapshotLocale(provenance: RouteProvenance): Locale {
    return provenance.locale ?? 'ru';
}

/** Имя языка маршрута в словаре UI: именительный падеж — для индикатора, предложный — для фразы. */
export function localeNameKey(locale: Locale): MessageKey {
    return locale === 'ru' ? 'route.locale.name.ru' : 'route.locale.name.en';
}

export function localeOnKey(locale: Locale): MessageKey {
    return locale === 'ru' ? 'route.locale.on.ru' : 'route.locale.on.en';
}

/**
 * Провенанс снапшота одной строкой: «claude-code · sonnet-5 · 9f3c1ab» (docs/design/README.md §6).
 * Язык добавляется, только когда он не совпадает с языком вкладки: у совпадающего сказать нечего.
 */
export function provenanceLine(snapshot: RouteSnapshot, t: Translate, uiLocale: Locale): string {
    const locale = snapshotLocale(snapshot.provenance);
    return [
        snapshot.provenance.harness,
        snapshot.provenance.model,
        snapshot.commit.slice(0, 7),
        locale === uiLocale ? null : t(localeNameKey(locale)),
    ]
        .filter((part): part is string => part !== null && part !== '')
        .join(' · ');
}

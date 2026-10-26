import type { Locale } from '@sherpa/protocol';

/**
 * Форматирование чисел, дат и числительных через `Intl`: правила склонения и разрядов живут
 * в платформе, а не в нашем коде. Словарные строки собираются из этих функций (`ru.ts`, `en.ts`),
 * поэтому здесь нет ни одного текста — только формат.
 */

const numberFormats = new Map<Locale, Intl.NumberFormat>();
const decimalFormats = new Map<Locale, Intl.NumberFormat>();
const pluralRules = new Map<Locale, Intl.PluralRules>();
const relativeFormats = new Map<Locale, Intl.RelativeTimeFormat>();
const dateTimeFormats = new Map<Locale, Intl.DateTimeFormat>();

/**
 * Разряды по правилам локали: «2 412» с неразрывным пробелом в русском (docs/design/SPEC-elements.md §2.13),
 * «2,412» в английском. ICU для `ru` отдаёт разделителем то U+00A0, то узкий U+202F —
 * приводим к одному неразрывному пробелу, иначе строка счётчика зависела бы от версии Node.
 */
export function formatCount(value: number, locale: Locale): string {
    const formatted = formatter(numberFormats, locale, () =>
        new Intl.NumberFormat(locale, { useGrouping: true }),
    ).format(value);
    return locale === 'ru' ? formatted.replaceAll(/\s/gu, '\u00a0') : formatted;
}

/**
 * Число с одним знаком после запятой по правилам локали: «12,4» в русском, «12.4» в английском.
 * Целое остаётся целым — «1 МБ», а не «1,0 МБ».
 */
export function formatDecimal(value: number, locale: Locale): string {
    return formatter(decimalFormats, locale, () =>
        new Intl.NumberFormat(locale, { useGrouping: true, maximumFractionDigits: 1 }),
    ).format(value);
}

/**
 * Словоформы числительного. `other` обязателен — это форма по умолчанию любой локали;
 * в русском она совпадает с `many` (5 файлов), в английском покрывает всё, кроме `one`.
 */
export interface PluralForms {
    readonly one: string;
    readonly few?: string;
    readonly many?: string;
    readonly other: string;
}

export function plural(value: number, forms: PluralForms, locale: Locale): string {
    const category = formatter(pluralRules, locale, () => new Intl.PluralRules(locale)).select(value);
    if (category === 'one') {
        return forms.one;
    }
    if (category === 'few') {
        return forms.few ?? forms.other;
    }
    if (category === 'many') {
        return forms.many ?? forms.other;
    }
    return forms.other;
}

/** Шаг шкалы относительного времени; `null` — меньше минуты или дата не разобралась. */
export interface RelativeSpan {
    readonly value: number;
    readonly unit: Intl.RelativeTimeFormatUnit;
}

/**
 * Шкала относительного времени меты треда: минуты → часы → дни → недели → месяцы → годы.
 * `now` инжектируется ради детерминированной галереи.
 */
export function relativeSpan(createdAt: string, now: number): RelativeSpan | null {
    const created = Date.parse(createdAt);
    if (!Number.isFinite(created)) {
        return null;
    }
    const seconds = Math.max(Math.floor((now - created) / 1000), 0);
    if (seconds < 60) {
        return null;
    }
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) {
        return { value: minutes, unit: 'minute' };
    }
    const hours = Math.floor(minutes / 60);
    if (hours < 24) {
        return { value: hours, unit: 'hour' };
    }
    const days = Math.floor(hours / 24);
    if (days < 7) {
        return { value: days, unit: 'day' };
    }
    if (days < 30) {
        return { value: Math.floor(days / 7), unit: 'week' };
    }
    if (days < 365) {
        return { value: Math.floor(days / 30), unit: 'month' };
    }
    return { value: Math.floor(days / 365), unit: 'year' };
}

/** Готовая фраза для шага шкалы: «6 ч назад», «6 hr. ago», «вчера». */
export function formatRelativeSpan(span: RelativeSpan, locale: Locale): string {
    // `numeric: 'auto'` даёт «вчера» вместо «1 дн. назад»; `narrow` в русском теряет «назад».
    return formatter(relativeFormats, locale, () =>
        new Intl.RelativeTimeFormat(locale, { numeric: 'auto', style: 'short' }),
    ).format(-span.value, span.unit);
}

/** Абсолютная дата со временем: для мест, где относительное время слишком грубое. */
export function formatDateTime(iso: string, locale: Locale): string {
    const parsed = Date.parse(iso);
    if (!Number.isFinite(parsed)) {
        return iso;
    }
    return formatter(dateTimeFormats, locale, () =>
        new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }),
    ).format(parsed);
}

/** Коммит в подписи — 7 hex (docs/design/README.md §13); полный уезжает в `title`. */
export function shortCommit(commit: string): string {
    return commit.slice(0, 7);
}

/** Форматтеры `Intl` дороги в создании — по одному на локаль на всю страницу. */
function formatter<T>(cache: Map<Locale, T>, locale: Locale, create: () => T): T {
    const cached = cache.get(locale);
    if (cached !== undefined) {
        return cached;
    }
    const created = create();
    cache.set(locale, created);
    return created;
}

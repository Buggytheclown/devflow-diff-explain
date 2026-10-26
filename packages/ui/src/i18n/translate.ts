import type { Locale, LocaleSetting } from '@sherpa/protocol';

import { en } from './en.js';
import { formatRelativeSpan, relativeSpan } from './format.js';
import type { Dictionary, MessageKey } from './ru.js';
import { ru } from './ru.js';

/** Параметры ключа: у строковой записи их нет, у функции — её же аргументы. */
type MessageArgs<K extends MessageKey> = Dictionary[K] extends (...args: infer A) => string ? A : [];

/** Перевод по ключу словаря; лишний, недостающий или чужой аргумент — ошибка компиляции. */
export type Translate = <K extends MessageKey>(key: K, ...args: MessageArgs<K>) => string;

/**
 * Лестница выбора языка: явный выбор в настройках → подсказка агента
 * (`uiState.worker.lang`) → первый язык браузера, где всё начинающееся с `ru` даёт русский,
 * а остальное английский. `auto` = «агент, потом браузер».
 */
export function resolveLocale(
    setting: LocaleSetting,
    agentLang: Locale | undefined,
    languages: readonly string[],
): Locale {
    if (setting !== 'auto') {
        return setting;
    }
    if (agentLang !== undefined) {
        return agentLang;
    }
    return (languages[0] ?? '').toLowerCase().startsWith('ru') ? 'ru' : 'en';
}

/**
 * Язык для кода вне дерева React — `api.ts`, стор состояния, модель прочитанности. Держит его
 * `LocaleProvider`; до первого рендера и в тестах без провайдера остаётся русский.
 */
let activeLocale: Locale = 'ru';

export function setActiveLocale(locale: Locale): void {
    activeLocale = locale;
}

/** Перевод там, где хуков нет. В компонентах — `useT`. */
export function activeT(): Translate {
    return createT(activeLocale);
}

const translators = new Map<Locale, Translate>();

/** Функция перевода на локаль. Экземпляр на локаль один — его можно класть в зависимости хуков. */
export function createT(locale: Locale): Translate {
    const cached = translators.get(locale);
    if (cached !== undefined) {
        return cached;
    }
    const dictionary: Dictionary = locale === 'ru' ? ru : en;
    const translate = ((key: MessageKey, ...args: unknown[]): string => {
        const message = dictionary[key];
        return typeof message === 'function' ? (message as (...rest: unknown[]) => string)(...args) : message;
    }) as Translate;
    translators.set(locale, translate);
    return translate;
}

/**
 * Перевод ключа, известного только в рантайме, — подписи и следствия команд из реестра
 * шорткатов. Аргумент проверен там, где команда объявлена; здесь типов уже нет.
 */
export function translateKey(t: Translate, key: MessageKey, arg?: string | number): string {
    const translate = t as unknown as (key: MessageKey, ...args: (string | number)[]) => string;
    return arg === undefined ? translate(key) : translate(key, arg);
}

/** Короткое относительное время: «6 ч назад», «6 hr. ago», «вчера»; до минуты — «только что». */
export function relativeTime(createdAt: string, now: number, locale: Locale): string {
    const span = relativeSpan(createdAt, now);
    return span === null ? createT(locale)('time.justNow') : formatRelativeSpan(span, locale);
}

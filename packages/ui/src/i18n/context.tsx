import type { Locale } from '@sherpa/protocol';
import type { ReactNode } from 'react';
import { createContext, useContext, useEffect, useMemo } from 'react';

import { useUiSettings } from '../settings/context.tsx';
import type { PluralForms } from './format.js';
import { formatCount, plural } from './format.js';
import type { Translate } from './translate.js';
import { createT, relativeTime, resolveLocale, setActiveLocale } from './translate.js';

/**
 * Язык интерфейса — производная от настройки `locale` (`auto | ru | en`) и подсказки агента,
 * поэтому провайдер стоит внутри `SettingsProvider`. Вне провайдера (галерея, тесты
 * компонентов) — русский: дерево обязано рисоваться без настроек и без сети.
 */

const LocaleContext = createContext<Locale>('ru');

/**
 * Подсказка агента хранится рядом с языком: командам палитры нужно не только «сейчас русский»,
 * но и от кого он — от агента или от браузера.
 */
const AgentLangContext = createContext<Locale | undefined>(undefined);

export function LocaleProvider({
    locale,
    agentLang,
    children,
}: {
    locale?: Locale;
    /** `uiState.worker.lang`: подписка на стор — в `main.tsx`, чтобы не тащить его в галерею. */
    agentLang?: Locale | undefined;
    children: ReactNode;
}) {
    const setting = useUiSettings().locale;
    // Явная локаль — для галереи: там настроек нет, а показать нужно обе.
    const resolved = locale ?? resolveLocale(setting, agentLang, browserLanguages());
    // Не в эффекте: эффекты детей бегут раньше родительского, а первые запросы к серверу уходят
    // именно из них — их сообщения об ошибках должны быть уже на нужном языке.
    setActiveLocale(resolved);

    useEffect(() => {
        document.documentElement.lang = resolved;
    }, [resolved]);

    return (
        <AgentLangContext value={agentLang}>
            <LocaleContext value={resolved}>{children}</LocaleContext>
        </AgentLangContext>
    );
}

export function useLocale(): Locale {
    return useContext(LocaleContext);
}

/** Подсказка агента о языке; `undefined` — агент её не дал или сервер о ней ещё не знает. */
export function useAgentLang(): Locale | undefined {
    return useContext(AgentLangContext);
}

export function useT(): Translate {
    return createT(useLocale());
}

/** Форматирование с локалью из контекста: компоненты не таскают её руками. */
export interface Formatters {
    readonly count: (value: number) => string;
    readonly plural: (value: number, forms: PluralForms) => string;
    readonly relativeTime: (createdAt: string, now: number) => string;
}

export function useFormat(): Formatters {
    const locale = useLocale();
    return useMemo(
        () => ({
            count: (value: number) => formatCount(value, locale),
            plural: (value: number, forms: PluralForms) => plural(value, forms, locale),
            relativeTime: (createdAt: string, now: number) => relativeTime(createdAt, now, locale),
        }),
        [locale],
    );
}

/** Языки браузера для `auto`; в среде без `navigator` (серверный рендер тестов) их просто нет. */
function browserLanguages(): readonly string[] {
    if (typeof navigator === 'undefined') {
        return [];
    }
    return navigator.languages.length > 0 ? navigator.languages : [navigator.language];
}

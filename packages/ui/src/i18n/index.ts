/**
 * Локализация UI: свой словарь без библиотеки. Русский словарь —
 * источник истины по составу ключей, английский объявлен его типом; форматирование чисел,
 * числительных и относительного времени идёт через `Intl`, а не через самописные правила.
 *
 * Точка входа одна: компоненты берут `useT`/`useFormat`, чистые модели — `Translate` аргументом
 * (или возвращают `MessageKey`), а код вне дерева React — `activeT`.
 *
 * Полнота перевода проверяется тестом `no-cyrillic.test.ts`: кириллицы вне комментариев
 * в `packages/ui/src` быть не должно.
 */

export type { Formatters } from './context.tsx';
export { LocaleProvider, useAgentLang, useFormat, useLocale, useT } from './context.tsx';
export type { PluralForms, RelativeSpan } from './format.js';
export { formatCount, formatDateTime, formatRelativeSpan, plural, relativeSpan, shortCommit } from './format.js';
export type { Dictionary, MessageKey } from './ru.js';
export { ru } from './ru.js';
export { en } from './en.js';
export type { Translate } from './translate.js';
export { activeT, createT, relativeTime, resolveLocale, setActiveLocale, translateKey } from './translate.js';

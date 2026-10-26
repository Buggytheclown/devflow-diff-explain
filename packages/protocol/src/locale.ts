import { z } from 'zod';

/**
 * Языки Шерпы: один словарь на UI и один требуемый язык ответа
 * у генерации. Всё, что не `ru`, разрешается в `en` — третьего языка нет.
 */
export const localeSchema = z.enum(['ru', 'en']);
export type Locale = z.infer<typeof localeSchema>;

/**
 * Выбор языка в настройках: `auto` — по `navigator.languages` браузера (первый `ru*` → `ru`,
 * иначе `en`), явный `ru`/`en` перебивает браузер.
 */
export const localeSettingSchema = z.enum(['auto', ...localeSchema.options]);
export type LocaleSetting = z.infer<typeof localeSettingSchema>;

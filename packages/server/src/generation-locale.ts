import type { Locale, LocaleSetting } from '@sherpa/protocol';

/**
 * Язык генерации: на нём модель пишет маршрут и ответы чата, он же
 * едет в `provenance.locale` снапшота и в серверные строки, которые ревьюер видит рядом с ними.
 *
 * Лестница повторяет лестницу языка UI, но с одним отличием: UI знает язык браузера, а сервер
 * нет — вместо браузера у него русский. Поэтому вкладка присылает свою эффективную локаль
 * запросом, а лестница ниже работает там, где спросить некого: автопостановка скелета прогревом
 * и старый клиент без поля.
 */
export function resolveGenerationLocale(input: {
    /** Локаль, названная запросом UI; `undefined` — генерацию затеял сам сервер. */
    readonly requested?: Locale | undefined;
    /** `settings.locale`; `auto` — выбора не было, решает подсказка агента. */
    readonly setting?: LocaleSetting | undefined;
    /** `worker.lang`: на каком языке пользователь общается с агентом. */
    readonly agentLang?: Locale | undefined;
}): Locale {
    if (input.requested !== undefined) {
        return input.requested;
    }
    if (input.setting !== undefined && input.setting !== 'auto') {
        return input.setting;
    }
    return input.agentLang ?? 'ru';
}

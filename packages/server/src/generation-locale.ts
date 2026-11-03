import type { Locale, LocaleSetting } from '@sherpa/protocol';

/** Язык ответа выбирается независимо от фиксированного русского UI: запрос, настройка, агент, ru. */
export function resolveGenerationLocale(input: {
    /** Локаль, названная запросом UI; `undefined` — генерацию затеял сам сервер. */
    readonly requested?: Locale | undefined;
    /** `settings.generationLocale`; `auto` — выбора не было, решает подсказка агента. */
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

import type { Locale, LocaleSetting } from '@sherpa/protocol';

import { useUiSettings, useUiSettingsStore } from '../settings/context.tsx';
import { useShortcut } from '../shortcuts/context.tsx';
import { useAgentLang, useLocale } from './context.tsx';
import type { MessageKey } from './ru.js';

/**
 * Смена языка — команды палитры в группе «Шерпа»: отдельного поповера настроек в дизайне нет,
 * а язык меняется редко. Выбор уезжает в глобальные настройки (`PATCH /api/ui/settings`),
 * и UI перерисовывается на новом языке без перезагрузки.
 */

/**
 * Подпись «сейчас: …» для текущего выбора: при `auto` она называет и язык, и ступень лестницы,
 * с которой он взят — от агента или от браузера.
 */
export function currentLocaleKey(setting: LocaleSetting, locale: Locale, agentLang: Locale | undefined): MessageKey {
    if (setting !== 'auto') {
        return setting === 'ru' ? 'shortcut.locale.now.ru' : 'shortcut.locale.now.en';
    }
    if (agentLang !== undefined) {
        return locale === 'ru' ? 'shortcut.locale.now.agentRu' : 'shortcut.locale.now.agentEn';
    }
    return locale === 'ru' ? 'shortcut.locale.now.browserRu' : 'shortcut.locale.now.browserEn';
}

/** Три команды выбора языка; активный вариант в палитру не попадает — он ничего бы не менял. */
export function useLocaleCommands(): void {
    const settings = useUiSettingsStore();
    const setting = useUiSettings().locale;
    const locale = useLocale();
    const agentLang = useAgentLang();
    const consequence = currentLocaleKey(setting, locale, agentLang);

    useShortcut({
        id: 'locale.ru',
        keys: [],
        group: 'palette.group.sherpa',
        label: 'shortcut.locale.ru',
        scope: 'global',
        section: 'navigation',
        consequence,
        when: () => setting !== 'ru',
        action: () => {
            settings.update({ locale: 'ru' });
        },
    });
    useShortcut({
        id: 'locale.en',
        keys: [],
        group: 'palette.group.sherpa',
        label: 'shortcut.locale.en',
        scope: 'global',
        section: 'navigation',
        consequence,
        when: () => setting !== 'en',
        action: () => {
            settings.update({ locale: 'en' });
        },
    });
    useShortcut({
        id: 'locale.auto',
        keys: [],
        group: 'palette.group.sherpa',
        label: 'shortcut.locale.auto',
        scope: 'global',
        section: 'navigation',
        consequence,
        when: () => setting !== 'auto',
        action: () => {
            settings.update({ locale: 'auto' });
        },
    });
}

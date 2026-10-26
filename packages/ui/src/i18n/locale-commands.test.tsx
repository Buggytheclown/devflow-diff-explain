// @vitest-environment jsdom
import type { Locale, UiSettings, UiSettingsPatch } from '@sherpa/protocol';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SettingsProvider } from '../settings/context.tsx';
import { createUiSettingsStore, DEFAULT_UI_SETTINGS } from '../settings/settings-store.js';
import { ShortcutsProvider } from '../shortcuts/context.tsx';
import type { Shortcut } from '../shortcuts/registry.js';
import { createShortcutRegistry } from '../shortcuts/registry.js';
import { LocaleProvider, useT } from './context.tsx';
import { useLocaleCommands } from './locale-commands.js';

/**
 * Язык переключается командой палитры и применяется без перезагрузки: выбор уезжает в настройки,
 * а провайдер локали перерисовывает дерево на новом словаре.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mounted: (() => void)[] = [];

afterEach(() => {
    for (const unmount of mounted.splice(0)) {
        unmount();
    }
});

function Probe() {
    useLocaleCommands();
    const t = useT();
    return <span data-testid="probe">{t('topbar.search')}</span>;
}

function mount(send: (patch: UiSettingsPatch) => Promise<UiSettings>, agentLang?: Locale) {
    const registry = createShortcutRegistry();
    const settings = createUiSettingsStore({ send });
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);

    // Подсказка агента приезжает по SSE — в тесте это смена пропса на смонтированном дереве.
    const render = (lang: Locale | undefined): void => {
        act(() => {
            root.render(
                <ShortcutsProvider registry={registry}>
                    <SettingsProvider store={settings}>
                        <LocaleProvider agentLang={lang}>
                            <Probe />
                        </LocaleProvider>
                    </SettingsProvider>
                </ShortcutsProvider>,
            );
        });
    };
    render(agentLang);
    mounted.push(() => {
        act(() => {
            root.unmount();
        });
        host.remove();
    });

    const command = (id: string): Shortcut => {
        const found = registry.list().find((shortcut) => shortcut.id === id);
        if (found === undefined) {
            throw new Error(`команда ${id} не зарегистрирована`);
        }
        return found;
    };
    return { host, registry, settings, command, render };
}

describe('команды выбора языка', () => {
    it('меняют язык на лету и уезжают в настройки', async () => {
        const send = vi.fn((_patch: UiSettingsPatch) => Promise.resolve(DEFAULT_UI_SETTINGS));
        const { host, settings, command } = mount(send);

        // `auto` по умолчанию, а браузер jsdom — английский.
        expect(host.textContent).toBe('Search');
        expect(document.documentElement.lang).toBe('en');

        act(() => {
            command('locale.ru').action();
        });

        expect(host.textContent).toBe('Поиск');
        expect(settings.getSnapshot().locale).toBe('ru');
        // Запись в настройки выстроена в цепочку промисов — она уходит следующим тиком.
        await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 0));
        });
        expect(send).toHaveBeenCalledWith({ locale: 'ru' });
        expect(document.documentElement.lang).toBe('ru');

        act(() => {
            command('locale.en').action();
        });

        expect(host.textContent).toBe('Search');
    });

    it('прячут активный выбор и называют текущий язык в следствии', () => {
        const send = vi.fn((_patch: UiSettingsPatch) => Promise.resolve(DEFAULT_UI_SETTINGS));
        const { command } = mount(send);

        // По умолчанию выбран `auto`, агент молчит, браузер в jsdom — английский.
        expect(command('locale.auto').when?.()).toBe(false);
        expect(command('locale.ru').when?.()).toBe(true);
        expect(command('locale.ru').consequence).toBe('shortcut.locale.now.browserEn');
        expect(command('locale.ru').group).toBe('palette.group.sherpa');

        act(() => {
            command('locale.ru').action();
        });

        expect(command('locale.ru').when?.()).toBe(false);
        expect(command('locale.auto').consequence).toBe('shortcut.locale.now.ru');
    });

    it('при auto язык берётся от агента, и следствие называет источник', () => {
        const send = vi.fn((_patch: UiSettingsPatch) => Promise.resolve(DEFAULT_UI_SETTINGS));
        const { host, command, render } = mount(send, 'ru');

        // Браузер в jsdom английский — подсказка агента его перебила.
        expect(host.textContent).toBe('Поиск');
        expect(command('locale.en').consequence).toBe('shortcut.locale.now.agentRu');

        // Агент сменил язык общения — UI переезжает без перезагрузки.
        render('en');
        expect(host.textContent).toBe('Search');
        expect(command('locale.ru').consequence).toBe('shortcut.locale.now.agentEn');

        // Явный выбор главнее подсказки.
        act(() => {
            command('locale.ru').action();
        });
        expect(host.textContent).toBe('Поиск');
        expect(command('locale.auto').consequence).toBe('shortcut.locale.now.ru');
    });
});

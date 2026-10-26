// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SettingsProvider } from './context.tsx';
import { DocumentSettingsSync, readDocumentAppearance } from './document-settings.tsx';
import type { UiSettingsStore } from './settings-store.js';
import { createUiSettingsStore, DEFAULT_UI_SETTINGS } from './settings-store.js';

describe('атрибуты документа по настройкам', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
        document.documentElement.removeAttribute('data-theme');
        document.documentElement.removeAttribute('data-textsize');
    });

    it('auto следует за системной темой без перемонтирования', () => {
        const system = stubSystemTheme('dark');
        const unmount = mount(createUiSettingsStore({ loaded: true }));

        expect(themeAttribute()).toBe('dark');
        act(() => {
            system.switchTo('light');
        });
        expect(themeAttribute()).toBe('light');

        unmount();
        expect(themeAttribute()).toBeNull();
    });

    it('явная тема системную не слушает', () => {
        const system = stubSystemTheme('dark');
        const unmount = mount(createUiSettingsStore({ loaded: true, initial: { theme: 'light' } }));

        expect(themeAttribute()).toBe('light');
        act(() => {
            system.switchTo('light');
        });
        expect(themeAttribute()).toBe('light');

        unmount();
    });

    it('размер текста едет своим атрибутом', () => {
        stubSystemTheme('dark');
        const settings = createUiSettingsStore({ loaded: true });
        const unmount = mount(settings);

        expect(document.documentElement.getAttribute('data-textsize')).toBe('m');
        act(() => {
            settings.update({ textSize: 'l' });
        });
        expect(document.documentElement.getAttribute('data-textsize')).toBe('l');

        unmount();
        expect(document.documentElement.getAttribute('data-textsize')).toBeNull();
    });

    it('Arcanum следует за Auto и сохраняется при явной смене темы', () => {
        const system = stubSystemTheme('light');
        const settings = createUiSettingsStore({ loaded: true, initial: { arcanum: true } });
        const unmount = mount(settings);
        expect(themeAttribute()).toBe('arcanum-light');
        act(() => { system.switchTo('dark'); });
        expect(themeAttribute()).toBe('arcanum-dark');
        act(() => { settings.update({ theme: 'light' }); });
        expect(themeAttribute()).toBe('arcanum-light');
        act(() => { system.switchTo('light'); });
        act(() => { system.switchTo('dark'); });
        expect(themeAttribute()).toBe('arcanum-light');
        act(() => { settings.update({ arcanum: false }); });
        expect(themeAttribute()).toBe('light');
        unmount();
    });

    it.each(['dark', 'light'] as const)('первый HTML Arcanum %s задаёт оформление до GET', (theme) => {
        document.documentElement.setAttribute('data-theme', `arcanum-${theme}`);
        document.documentElement.setAttribute('data-textsize', 'l');
        expect(readDocumentAppearance(document.documentElement)).toEqual({ theme, arcanum: true, textSize: 'l' });
    });

    it('выбор Arcanum применяется до GET и переживает поздний ответ', () => {
        document.documentElement.setAttribute('data-theme', 'light');
        stubSystemTheme('light');
        const settings = createUiSettingsStore({ initial: readDocumentAppearance(document.documentElement) });
        const unmount = mount(settings);
        act(() => { settings.update({ arcanum: true }); });
        expect(themeAttribute()).toBe('arcanum-light');
        act(() => { settings.applyLoaded({ ...DEFAULT_UI_SETTINGS, theme: 'auto', arcanum: false }); });
        expect(themeAttribute()).toBe('arcanum-light');
        expect(settings.getSnapshot()).toMatchObject({ theme: 'auto', arcanum: true });
        unmount();
    });

    it('серверный первый кадр Arcanum не перекрашивается до загрузки настройки', () => {
        document.documentElement.setAttribute('data-theme', 'arcanum-dark');
        stubSystemTheme('light');
        const settings = createUiSettingsStore({ initial: readDocumentAppearance(document.documentElement) });
        const unmount = mount(settings);

        expect(themeAttribute()).toBe('arcanum-dark');
        act(() => {
            settings.applyLoaded({ ...DEFAULT_UI_SETTINGS, theme: 'dark', arcanum: true });
        });
        expect(themeAttribute()).toBe('arcanum-dark');
        unmount();
    });

    it('до ответа сервера атрибуты остаются серверными', () => {
        // Так выглядит документ, отданный сервером при `theme: light`, `textSize: l`.
        document.documentElement.setAttribute('data-theme', 'light');
        document.documentElement.setAttribute('data-textsize', 'l');
        stubSystemTheme('dark');
        // Стор без ответа ручки берёт оформление из первого HTML.
        const settings = createUiSettingsStore({ initial: readDocumentAppearance(document.documentElement) });
        const unmount = mount(settings);

        expect(themeAttribute()).toBe('light');
        expect(document.documentElement.getAttribute('data-textsize')).toBe('l');

        act(() => {
            settings.applyLoaded({ ...DEFAULT_UI_SETTINGS, theme: 'light', textSize: 'l' });
        });
        expect(themeAttribute()).toBe('light');
        expect(document.documentElement.getAttribute('data-textsize')).toBe('l');

        unmount();
    });

    it('ответ сервера с другой темой перекрашивает документ', () => {
        document.documentElement.setAttribute('data-theme', 'light');
        stubSystemTheme('dark');
        const settings = createUiSettingsStore({ initial: readDocumentAppearance(document.documentElement) });
        const unmount = mount(settings);

        act(() => {
            settings.applyLoaded({ ...DEFAULT_UI_SETTINGS, theme: 'dark' });
        });
        expect(themeAttribute()).toBe('dark');

        unmount();
    });
});

function themeAttribute(): string | null {
    return document.documentElement.getAttribute('data-theme');
}

function mount(store: UiSettingsStore): () => void {
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    act(() => {
        root.render(
            <SettingsProvider store={store}>
                <DocumentSettingsSync />
            </SettingsProvider>,
        );
    });
    return () => {
        act(() => {
            root.unmount();
        });
        host.remove();
    };
}

/** jsdom медиазапросы не считает — системную тему и её смену задаём вручную. */
function stubSystemTheme(initial: 'dark' | 'light') {
    const listeners = new Set<() => void>();
    let matches = initial === 'dark';
    vi.stubGlobal('matchMedia', (media: string) => ({
        media,
        get matches() {
            return matches;
        },
        addEventListener: (_event: string, listener: () => void) => {
            listeners.add(listener);
        },
        removeEventListener: (_event: string, listener: () => void) => {
            listeners.delete(listener);
        },
    }));
    return {
        switchTo: (next: 'dark' | 'light') => {
            matches = next === 'dark';
            for (const listener of [...listeners]) {
                listener();
            }
        },
    };
}

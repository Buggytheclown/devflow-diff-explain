// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';

import { Gallery, parseGalleryArcanum, parseGalleryTheme } from './gallery.tsx';
import { GALLERY_STATES } from './states.tsx';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mounted: (() => void)[] = [];
afterEach(() => {
    for (const unmount of mounted.splice(0)) {
        unmount();
    }
    history.replaceState(null, '', '/');
});

describe('тема галереи', () => {
    it('адрес различает три режима темы и независимый флаг Arcanum', () => {
        for (const theme of ['auto', 'dark', 'light'] as const) {
            expect(parseGalleryTheme(theme)).toBe(theme);
        }
        expect(parseGalleryTheme(null)).toBe('dark');
        expect(parseGalleryTheme('unknown')).toBe('dark');
        expect(parseGalleryArcanum('1')).toBe(true);
        expect(parseGalleryArcanum('0')).toBe(false);
        expect(parseGalleryArcanum(null)).toBe(false);
        expect(parseGalleryArcanum('unknown')).toBe(false);
    });

    it('переключает Arcanum независимо от темы и сохраняет оба выбора в адресе', () => {
        const host = mount(<Gallery initialId="settings-menu-open" />);
        const toggle = host.querySelector<HTMLButtonElement>('.gallery__stage-title [role="switch"]');
        const themes = host.querySelectorAll<HTMLButtonElement>('.gallery__themes[role="group"] button');
        expect(toggle).not.toBeNull();
        expect(themes).toHaveLength(3);
        act(() => {
            toggle?.click();
        });

        expect(document.documentElement.dataset.theme).toBe('arcanum-dark');
        expect(toggle?.getAttribute('aria-checked')).toBe('true');
        expect(new URLSearchParams(location.hash.slice(1)).get('theme')).toBe('dark');
        expect(new URLSearchParams(location.hash.slice(1)).get('arcanum')).toBe('1');

        const light = [...themes].find((button) => button.textContent === 'light');
        act(() => { light?.click(); });
        expect(document.documentElement.dataset.theme).toBe('arcanum-light');
        expect(light?.getAttribute('aria-pressed')).toBe('true');
        expect(toggle?.getAttribute('aria-checked')).toBe('true');
        expect(new URLSearchParams(location.hash.slice(1)).get('theme')).toBe('light');
        expect(new URLSearchParams(location.hash.slice(1)).get('arcanum')).toBe('1');

        act(() => { toggle?.click(); });
        expect(document.documentElement.dataset.theme).toBe('light');
        expect(light?.getAttribute('aria-pressed')).toBe('true');
        expect(new URLSearchParams(location.hash.slice(1)).get('arcanum')).toBe('0');
    });

    it.each([
        ['dark', 'Тёмная'],
        ['light', 'Светлая'],
    ] as const)('у Arcanum %s есть карточка с выбранным режимом и включённым флагом', (theme, label) => {
        const state = GALLERY_STATES.find((candidate) => candidate.id === `settings-menu-open-arcanum-${theme}`);
        expect(state).toBeDefined();
        const host = mount(state?.render());
        const themed = host.querySelector(`[data-theme="arcanum-${theme}"]`);
        expect(themed).not.toBeNull();
        const selected = [...(themed?.querySelectorAll('button[aria-pressed="true"]') ?? [])];
        expect(selected.some((button) => button.textContent === label)).toBe(true);
        const toggle = themed?.querySelector<HTMLButtonElement>('[role="switch"][aria-label="Стиль Arcanum"]');
        expect(toggle?.getAttribute('aria-checked')).toBe('true');
        act(() => { toggle?.click(); });
        expect(toggle?.getAttribute('aria-checked')).toBe('false');
        expect(themed?.getAttribute('data-theme')).toBe(theme);
    });

    it('светлая карточка остаётся без Arcanum при включённом стиле стенда', () => {
        const host = mount(<Gallery initialId="settings-menu-open-light" initialArcanum />);
        expect(document.documentElement.dataset.theme).toBe('arcanum-dark');
        const themed = host.querySelector('.gallery-themed');
        expect(themed?.getAttribute('data-theme')).toBe('light');
        expect(themed?.querySelector('[role="switch"][aria-label="Стиль Arcanum"]')?.getAttribute('aria-checked')).toBe('false');
    });
});

function mount(node: React.ReactNode): HTMLElement {
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    act(() => {
        root.render(node);
    });
    mounted.push(() => {
        act(() => {
            root.unmount();
        });
        host.remove();
    });
    return host;
}

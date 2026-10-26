// @vitest-environment jsdom
import { fixtureIteration } from '@sherpa/fixtures';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createDiffViewStore } from '../diff-view/store.js';
import { buildFileFilters, selectFilter } from '../filters/lens-filters.js';
import { createT } from '../i18n/index.js';
import { ShortcutsProvider } from '../shortcuts/context.tsx';
import { attachShortcuts, createShortcutRegistry } from '../shortcuts/registry.js';
import { SettingsProvider } from '../settings/context.tsx';
import type { UiSettingsStore } from '../settings/settings-store.js';
import { createUiSettingsStore } from '../settings/settings-store.js';
import { createThreadStore } from '../threads/store.js';
import { FilterSelect } from './filter-select.tsx';
import { ReviewActionBar } from './review-action-bar.tsx';
import { SettingsMenu } from './settings-menu.tsx';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const t = createT('ru');
const EDGE = fixtureIteration('edge');
const FILES = EDGE.diff.files.filter((file) => !file.generated);
const FILTERS = buildFileFilters({ files: FILES, ownership: EDGE.ownership, extra: [], t });

/** Панель действий рядом с меню: её меню Ship — второй поповер, с которым меню обязано разойтись. */
const MEDIUM = fixtureIteration('medium');
const MEDIUM_FILE_IDS = new Set(MEDIUM.diff.files.map((file) => file.fileId));
const COMPOSER_TRANSPORT = {
    save: () => Promise.reject(new Error('в этом тесте комментарии не отправляются')),
    update: () => Promise.reject(new Error('в этом тесте комментарии не отправляются')),
    delete: () => Promise.reject(new Error('в этом тесте комментарии не отправляются')),
};

const mounted: (() => void)[] = [];

afterEach(() => {
    for (const unmount of mounted.splice(0)) {
        unmount();
    }
});

interface Harness {
    readonly host: HTMLElement;
    readonly settings: UiSettingsStore;
    readonly onOpenCommands: ReturnType<typeof vi.fn>;
    readonly onReplayTour: ReturnType<typeof vi.fn>;
    readonly pressEscape: () => void;
}

function mount({ agentConnected = true }: { agentConnected?: boolean } = {}): Harness {
    const host = document.createElement('div');
    document.body.append(host);
    const settings = createUiSettingsStore({ loaded: true });
    const onOpenCommands = vi.fn();
    const onReplayTour = vi.fn();
    // Esc меню живёт на лестнице реестра: без провайдера закрывать его нечем.
    const registry = createShortcutRegistry();
    const detach = attachShortcuts(window, registry);
    const root = createRoot(host);

    act(() => {
        root.render(
            <ShortcutsProvider registry={registry}>
                <SettingsProvider store={settings}>
                    <FilterSelect filters={FILTERS} active={selectFilter(FILTERS, 'all')} onSelect={() => undefined} />
                    <ReviewActionBar
                        pr={MEDIUM.pr}
                        reviewHost="fixture"
                        diff={MEDIUM.diff}
                        diffStore={createDiffViewStore({ files: MEDIUM.diff.files })}
                        threadStore={createThreadStore(MEDIUM.threads, MEDIUM_FILE_IDS)}
                        connection="online"
                        hostName="FixtureHost"
                        composerTransport={COMPOSER_TRANSPORT}
                        onPublish={() => Promise.reject(new Error('в этом тесте вердикт не публикуется'))}
                        onComplete={() => undefined}
                        route={null}
                    />
                    <SettingsMenu
                        agentConnected={agentConnected}
                        onOpenCommands={onOpenCommands}
                        onReplayTour={onReplayTour}
                    />
                </SettingsProvider>
            </ShortcutsProvider>,
        );
    });
    mounted.push(() => {
        act(() => {
            root.unmount();
        });
        detach();
        host.remove();
    });

    return {
        host,
        settings,
        onOpenCommands,
        onReplayTour,
        pressEscape: () => {
            act(() => {
                window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
            });
        },
    };
}

/** Нажатие мышью целиком: сначала mousedown (по нему закрываются чужие меню), потом клик. */
function press(element: HTMLElement): void {
    act(() => {
        element.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
        element.click();
    });
}

function trigger(host: HTMLElement): HTMLButtonElement {
    const found = host.querySelector<HTMLButtonElement>('.settings-menu__trigger');
    if (found === null) {
        throw new Error('у меню настроек нет триггера');
    }
    return found;
}

function panel(host: HTMLElement): HTMLElement | null {
    return host.querySelector<HTMLElement>('.settings-menu__panel');
}

/** Триггер соседнего поповера: без него проверять взаимное закрытие не на чем. */
function button(host: HTMLElement, selector: string, what: string): HTMLButtonElement {
    const found = host.querySelector<HTMLButtonElement>(selector);
    if (found === null) {
        throw new Error(`на стенде нет: ${what}`);
    }
    return found;
}

/** Кнопка сегмента по подписи — сегменты соседних настроек подписаны по-разному. */
function segment(host: HTMLElement, label: string): HTMLButtonElement {
    const found = [...host.querySelectorAll<HTMLButtonElement>('.settings-menu__segment')].find(
        (button) => button.textContent.trim() === label,
    );
    if (found === undefined) {
        throw new Error(`в меню настроек нет сегмента «${label}»`);
    }
    return found;
}

function action(host: HTMLElement, label: string): HTMLButtonElement {
    const found = [...host.querySelectorAll<HTMLButtonElement>('.settings-menu__action')].find((button) =>
        button.textContent.includes(label),
    );
    if (found === undefined) {
        throw new Error(`в меню настроек нет пункта «${label}»`);
    }
    return found;
}

describe('меню настроек', () => {
    it('триггер открывает и закрывает панель', () => {
        const { host } = mount();

        expect(panel(host)).toBeNull();
        expect(trigger(host).getAttribute('aria-expanded')).toBe('false');

        press(trigger(host));
        expect(panel(host)).not.toBeNull();
        expect(trigger(host).getAttribute('aria-expanded')).toBe('true');

        press(trigger(host));
        expect(panel(host)).toBeNull();
    });

    it('Esc закрывает меню и возвращает фокус на триггер', () => {
        const { host, pressEscape } = mount();
        press(trigger(host));

        pressEscape();

        expect(panel(host)).toBeNull();
        expect(document.activeElement).toBe(trigger(host));
    });

    it('клик снаружи закрывает меню', () => {
        const { host } = mount();
        press(trigger(host));

        act(() => {
            document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
        });

        expect(panel(host)).toBeNull();
    });
});

describe('меню настроек рядом с другими поповерами', () => {
    it('открытие меню закрывает селект фильтра, и наоборот', () => {
        const { host } = mount();
        const filterButton = button(host, '.filter-select__button', 'селект фильтра');

        press(filterButton);
        expect(host.querySelector('.filter-select__menu')).not.toBeNull();

        press(trigger(host));
        expect(host.querySelector('.filter-select__menu')).toBeNull();
        expect(panel(host)).not.toBeNull();

        press(filterButton);
        expect(panel(host)).toBeNull();
        expect(host.querySelector('.filter-select__menu')).not.toBeNull();
    });

    it('открытие меню закрывает меню Ship, и наоборот', () => {
        const { host } = mount();
        const shipCaret = button(host, '.review-action-bar__ship-caret', 'каретка меню Ship');

        press(shipCaret);
        expect(host.querySelector('.review-action-menu')).not.toBeNull();

        press(trigger(host));
        expect(host.querySelector('.review-action-menu')).toBeNull();
        expect(panel(host)).not.toBeNull();

        press(shipCaret);
        expect(panel(host)).toBeNull();
        expect(host.querySelector('.review-action-menu')).not.toBeNull();
    });
});

describe('настройки из меню', () => {
    it('Arcanum переключается отдельно от трёх вариантов темы', () => {
        const { host, settings } = mount();
        press(trigger(host));
        const themes = host.querySelector('[role="group"][aria-label="Тема"]');
        expect(themes?.querySelectorAll('button')).toHaveLength(3);
        const arcanum = button(host, '[role="switch"][aria-label="Стиль Arcanum"]', 'Arcanum');
        expect(arcanum.getAttribute('aria-checked')).toBe('false');

        press(arcanum);
        expect(settings.getSnapshot()).toMatchObject({ theme: 'auto', arcanum: true });
        expect(arcanum.getAttribute('aria-checked')).toBe('true');
        for (const theme of ['light', 'dark'] as const) {
            press(segment(host, t(`settings.theme.${theme}`)));
            expect(settings.getSnapshot()).toMatchObject({ theme, arcanum: true });
        }
        press(arcanum);
        expect(settings.getSnapshot()).toMatchObject({ theme: 'dark', arcanum: false });
        expect(arcanum.getAttribute('aria-checked')).toBe('false');
        expect(panel(host)).not.toBeNull();
    });

    it('сегменты пишут выбор в стор настроек', () => {
        const { host, settings } = mount();
        press(trigger(host));

        press(segment(host, t('settings.theme.light')));
        expect(settings.getSnapshot().theme).toBe('light');

        press(segment(host, 'EN'));
        expect(settings.getSnapshot().locale).toBe('en');

        press(segment(host, 'L'));
        expect(settings.getSnapshot().textSize).toBe('l');

        // Выбор применяется на месте: меню остаётся открытым, и три настройки меняются подряд.
        expect(panel(host)).not.toBeNull();
        expect(segment(host, 'L').getAttribute('aria-pressed')).toBe('true');
        expect(segment(host, 'M').getAttribute('aria-pressed')).toBe('false');
    });

    it('повтор онбординга сбрасывает флаг тура и перезапускает проход', () => {
        const { host, settings, onReplayTour } = mount();
        settings.update({ onboarding: { completedAt: '2026-09-01T10:00:00.000Z', step: 5 } });
        press(trigger(host));

        press(action(host, t('settings.replay')));

        expect(settings.getSnapshot().onboarding).toEqual({ completedAt: null, step: 0 });
        expect(onReplayTour).toHaveBeenCalledTimes(1);
        expect(panel(host)).toBeNull();
    });

    it('строка команд закрывает меню и открывает палитру', () => {
        const { host, onOpenCommands } = mount();
        press(trigger(host));

        press(action(host, t('settings.commands')));

        expect(onOpenCommands).toHaveBeenCalledTimes(1);
        expect(panel(host)).toBeNull();
    });

    it('число шагов онбординга считает текущий проход: восемь с агентом, семь без него', () => {
        const withAgent = mount();
        press(trigger(withAgent.host));
        expect(action(withAgent.host, t('settings.replay')).textContent).toContain(t('settings.steps', 8));

        const offline = mount({ agentConnected: false });
        press(trigger(offline.host));
        expect(action(offline.host, t('settings.replay')).textContent).toContain(t('settings.steps', 7));
    });
});

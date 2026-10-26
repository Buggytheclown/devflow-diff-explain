// @vitest-environment jsdom
import { act, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';

import { SettingsProvider } from '../settings/context.tsx';
import type { UiSettingsStore } from '../settings/settings-store.js';
import { createUiSettingsStore, DEFAULT_UI_SETTINGS } from '../settings/settings-store.js';
import { canonicalIndex } from './tour-model.js';
import type { TourRunState } from './tour-store.js';
import { useTourActive, useTourRun } from './tour-store.js';

/**
 * Старт тура и его персист. Оба решения принимаются по глобальным настройкам, и оба ошибаются
 * молча: тур на умолчаниях перетирает пройденный на сервере, а номер шага из прохода другой
 * длины возвращает не туда.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mounted: (() => void)[] = [];

afterEach(() => {
    for (const unmount of mounted.splice(0)) {
        unmount();
    }
});

/** Что хуки отдали в последнем рендере: публикуется эффектом, а не присваиванием на рендере. */
const probe: { active: boolean; run: TourRunState | null } = { active: false, run: null };

function ActiveProbe() {
    const active = useTourActive(true);
    useEffect(() => {
        probe.active = active;
    });
    return null;
}

function RunProbe({ agentConnected }: { agentConnected: boolean }) {
    const run = useTourRun({ agentConnected, onOpenChat: NOOP, onCloseChat: NOOP });
    useEffect(() => {
        probe.run = run;
    });
    return null;
}

const NOOP = (): void => undefined;

function mount(settings: UiSettingsStore, node: React.ReactNode): () => void {
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    act(() => {
        root.render(<SettingsProvider store={settings}>{node}</SettingsProvider>);
    });
    const unmount = (): void => {
        act(() => {
            root.unmount();
        });
        host.remove();
    };
    mounted.push(unmount);
    return unmount;
}

/** Проход тура: `steps` шагов вперёд. */
function forward(steps: number): void {
    for (let step = 0; step < steps; step += 1) {
        act(() => {
            probe.run?.next();
        });
    }
}

describe('старт тура', () => {
    it('ждёт настоящие настройки: на умолчаниях тур не показывается', () => {
        const settings = createUiSettingsStore();
        mount(settings, <ActiveProbe />);

        // Рендер стартует по таймауту загрузки, и `completedAt` здесь ничей.
        expect(settings.getSnapshot().onboarding.completedAt).toBeNull();
        expect(probe.active).toBe(false);

        act(() => {
            settings.applyLoaded({ ...DEFAULT_UI_SETTINGS });
        });
        expect(probe.active).toBe(true);
    });

    it('пройденный тур ответом сервера не воскресает', () => {
        const settings = createUiSettingsStore();
        mount(settings, <ActiveProbe />);

        act(() => {
            settings.applyLoaded({
                ...DEFAULT_UI_SETTINGS,
                onboarding: { completedAt: '2026-09-01T10:00:00.000Z', step: 0 },
            });
        });
        expect(probe.active).toBe(false);
    });
});

describe('персист прохода', () => {
    it('пишет канонический номер шага, а не номер в проходе без агента', () => {
        const settings = createUiSettingsStore();
        settings.applyLoaded({ ...DEFAULT_UI_SETTINGS });
        const unmount = mount(settings, <RunProbe agentConnected={false} />);

        forward(5);

        expect(probe.run?.step.id).toBe('fulldiff');
        // В проходе без агента шаг шестой, а на диске — его канонический номер.
        expect(probe.run?.index).toBe(5);
        expect(settings.getSnapshot().onboarding.step).toBe(canonicalIndex('fulldiff'));

        // Новый заход, агент на месте: тот же номер обязан вернуть тот же шаг.
        unmount();
        mount(settings, <RunProbe agentConnected />);

        expect(probe.run?.step.id).toBe('fulldiff');
        expect(probe.run?.index).toBe(6);
        expect(probe.run?.steps).toHaveLength(8);
    });

    it('оставленный шаг про чат без агента отдаёт следующий доступный', () => {
        const settings = createUiSettingsStore();
        settings.applyLoaded({
            ...DEFAULT_UI_SETTINGS,
            onboarding: { completedAt: null, step: canonicalIndex('chat') },
        });
        mount(settings, <RunProbe agentConnected={false} />);

        expect(probe.run?.step.id).toBe('fulldiff');
    });

    it('«Пропустить» закрывает тур навсегда', () => {
        const settings = createUiSettingsStore();
        settings.applyLoaded({ ...DEFAULT_UI_SETTINGS });
        mount(settings, <RunProbe agentConnected={false} />);

        act(() => {
            probe.run?.skip();
        });

        expect(settings.getSnapshot().onboarding.completedAt).not.toBeNull();
    });
});

// @vitest-environment jsdom
import type { UiUpdate } from '@sherpa/protocol';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SettingsProvider } from '../settings/context.tsx';
import { createUiSettingsStore } from '../settings/settings-store.js';
import type { UiSettingsStore } from '../settings/settings-store.js';
import { useUpdateToast } from './update-state.js';
import { UpdateToast } from './update-toast.tsx';

/**
 * Поведение тоста обновления: пауза перед появлением, «Позже» до перезагрузки вкладки,
 * «Не напоминать» в глобальных настройках и Esc при фокусе внутри тоста.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const UPDATE: UiUpdate = {
    current: '0.4.0',
    latest: '0.5.0',
    releasedAt: '2026-09-01T09:00:00.000Z',
    whatsNew: 'Тост обновления и читшит.',
    install: { kind: 'arc-checkout', dir: '/Users/x/arcadia', command: "cd '/Users/x/arcadia' && arc pull" },
};

const COPY: UiUpdate = {
    ...UPDATE,
    install: { kind: 'copy', dir: '/opt/sherpa/skill', command: null },
};

const mounted: (() => void)[] = [];

afterEach(() => {
    for (const unmount of mounted.splice(0)) {
        unmount();
    }
    vi.useRealTimers();
});

/** Приложение в миниатюре: снапшот сервера сверху, тост и его состояние — внутри. */
function Harness({ update }: { update: UiUpdate | null }) {
    const toast = useUpdateToast(update);
    return (
        <>
            {toast.visible && update !== null ? (
                <UpdateToast update={update} onLater={toast.later} onDismissVersion={toast.dismissVersion} />
            ) : null}
            <button type="button" className="version" onClick={toast.reopen}>
                0.4.0
            </button>
        </>
    );
}

function mount(update: UiUpdate | null, settings?: UiSettingsStore): HTMLElement {
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    const harness = <Harness update={update} />;
    act(() => {
        root.render(
            settings === undefined ? harness : <SettingsProvider store={settings}>{harness}</SettingsProvider>,
        );
    });
    mounted.push(() => {
        act(() => {
            root.unmount();
        });
        host.remove();
    });
    return host;
}

function toastOf(host: HTMLElement): HTMLElement | null {
    return host.querySelector<HTMLElement>('.update-toast');
}

function click(host: HTMLElement, selector: string): void {
    const element = host.querySelector<HTMLElement>(selector);
    if (element === null) {
        throw new Error(`в тосте нет ${selector}`);
    }
    act(() => {
        element.click();
    });
}

describe('тост обновления', () => {
    it('появляется через полторы секунды после прихода обновления', () => {
        vi.useFakeTimers();
        const host = mount(UPDATE);

        expect(toastOf(host)).toBeNull();
        act(() => {
            vi.advanceTimersByTime(1499);
        });
        expect(toastOf(host)).toBeNull();

        act(() => {
            vi.advanceTimersByTime(1);
        });
        expect(toastOf(host)?.getAttribute('role')).toBe('status');
        expect(toastOf(host)?.textContent).toContain('Шерпа 0.5.0 доступна');
        expect(toastOf(host)?.textContent).toContain('у вас 0.4.0');
    });

    it('без обновления таймер не заводится вовсе', () => {
        vi.useFakeTimers();
        const host = mount(null);

        act(() => {
            vi.advanceTimersByTime(5000);
        });

        expect(toastOf(host)).toBeNull();
    });

    it('«Позже» прячет тост, клик по версии возвращает его', () => {
        vi.useFakeTimers();
        const host = mount(UPDATE);
        act(() => {
            vi.advanceTimersByTime(1500);
        });

        click(host, '.update-toast__close');
        expect(toastOf(host)).toBeNull();

        click(host, '.version');
        expect(toastOf(host)).not.toBeNull();
    });

    it('Esc при фокусе внутри тоста работает как «Позже»', () => {
        vi.useFakeTimers();
        const host = mount(UPDATE);
        act(() => {
            vi.advanceTimersByTime(1500);
        });

        // Фокус снаружи: Esc принадлежит другим слоям, тост его не забирает.
        act(() => {
            document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
        });
        expect(toastOf(host)).not.toBeNull();

        host.querySelector<HTMLButtonElement>('.update-toast__how')?.focus();
        act(() => {
            document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
        });
        expect(toastOf(host)).toBeNull();
    });

    it('«Не напоминать» уносит версию в глобальные настройки', async () => {
        vi.useFakeTimers();
        const patches: unknown[] = [];
        const settings = createUiSettingsStore({
            send: (patch) => {
                patches.push(patch);
                return Promise.reject(new Error('запись здесь не проверяется'));
            },
        });
        const host = mount(UPDATE, settings);
        act(() => {
            vi.advanceTimersByTime(1500);
        });

        click(host, '.update-toast__dismiss');
        // Записи выстроены в цепочку промисов — им нужен прокрут микрозадач.
        await act(async () => {
            await Promise.resolve();
        });

        expect(patches).toEqual([{ updates: { dismissedVersion: '0.5.0' } }]);
        expect(settings.getSnapshot().updates).toEqual({ dismissedVersion: '0.5.0' });
    });

    it('«Как обновить» у чекаута показывает команду, у копии — каталог и README', () => {
        vi.useFakeTimers();
        const checkout = mount(UPDATE);
        act(() => {
            vi.advanceTimersByTime(1500);
        });
        click(checkout, '.update-toast__how');

        expect(checkout.querySelector<HTMLInputElement>('.command-box__command')?.value).toBe(
            "cd '/Users/x/arcadia' && arc pull",
        );

        const copy = mount(COPY);
        act(() => {
            vi.advanceTimersByTime(1500);
        });
        click(copy, '.update-toast__how');

        expect(copy.querySelector('.command-box')).toBeNull();
        expect(copy.querySelector('.update-toast__copy-dir')?.textContent).toContain('/opt/sherpa/skill');
        expect(copy.querySelector<HTMLAnchorElement>('.update-toast__readme')?.href).toContain('/junk/alice/sherpa/README.md');
    });

    it('без «что нового» тело не рендерится', () => {
        vi.useFakeTimers();
        const host = mount({ ...UPDATE, whatsNew: null });
        act(() => {
            vi.advanceTimersByTime(1500);
        });

        expect(host.querySelector('.update-toast__body')).toBeNull();
    });
});

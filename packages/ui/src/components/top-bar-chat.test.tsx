// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AgentPillView } from './agent-pill-view.js';
import { AgentPill } from './top-bar.tsx';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mounted: (() => void)[] = [];

afterEach(() => {
    for (const unmount of mounted.splice(0)) {
        unmount();
    }
});

function clickPill(view: AgentPillView, onToggleChat = vi.fn()) {
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    act(() => {
        root.render(
            <AgentPill
                view={view}
                reconnectCommand="/sherpa fixture-medium"
                onToggleChat={onToggleChat}
            />,
        );
    });
    mounted.push(() => {
        act(() => {
            root.unmount();
        });
        host.remove();
    });
    act(() => {
        host.querySelector<HTMLButtonElement>('.agent-pill')?.click();
    });
    return { host, onToggleChat };
}

function view(tone: AgentPillView['tone']): AgentPillView {
    return {
        tone,
        workerKind: tone === 'disconnected' ? 'disconnected' : 'connected',
        label: 'Агент',
        title: 'claude-code · opus-5',
    };
}

describe('клик по индикатору агента', () => {
    it('подключённый агент тоглит чат без цели прокрутки', () => {
        const { onToggleChat } = clickPill(view('connected'));

        expect(onToggleChat).toHaveBeenCalledWith(null);
    });

    it('работающий агент открывает чат у баннера очереди', () => {
        const { onToggleChat } = clickPill(view('working'));

        expect(onToggleChat).toHaveBeenCalledWith('queue');
    });

    it('провал открывает чат у ошибки', () => {
        const { onToggleChat } = clickPill(view('failed'));

        expect(onToggleChat).toHaveBeenCalledWith('error');
    });

    it('отключённый агент оставляет reconnect-поповер и не тоглит чат', () => {
        const { host, onToggleChat } = clickPill(view('disconnected'));

        expect(onToggleChat).not.toHaveBeenCalled();
        expect(host.querySelector<HTMLInputElement>('.command-box__command')?.value).toBe('/sherpa fixture-medium');
    });
});

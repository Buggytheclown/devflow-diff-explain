import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { CHAT_PANEL_STATES } from './chat-panel-states.tsx';

describe('галерея панели чата', () => {
    it('регистрирует и рендерит 5 состояний панели и историю', () => {
        expect(CHAT_PANEL_STATES.map((state) => state.id)).toEqual([
            'chat-empty',
            'chat-queued',
            'chat-answering',
            'chat-failed',
            'chat-disconnected',
            'chat-history',
        ]);

        for (const state of CHAT_PANEL_STATES) {
            expect(() => renderToStaticMarkup(<>{state.render()}</>)).not.toThrow();
        }
    });
});

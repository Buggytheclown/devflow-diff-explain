import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { AGENT_NOTE_STATES } from './agent-notes-states.tsx';

describe('галерея заметок агента', () => {
    it('регистрирует и рендерит заметку, стопку и оба состояния сводки', () => {
        expect(AGENT_NOTE_STATES.map((state) => state.id)).toEqual([
            'agent-note-collapsed',
            'agent-note-expanded',
            'agent-note-stack',
            'agent-note-stack-summary',
            'agent-note-stack-open',
        ]);

        for (const state of AGENT_NOTE_STATES) {
            expect(() => renderToStaticMarkup(<>{state.render()}</>)).not.toThrow();
        }
    });
});

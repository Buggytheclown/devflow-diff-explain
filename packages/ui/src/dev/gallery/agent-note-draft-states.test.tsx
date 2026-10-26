import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { AGENT_NOTE_DRAFT_STATES } from './agent-note-draft-states.tsx';

describe('галерея черновика заметки', () => {
    it('регистрирует и рендерит черновик комментария из заметки', () => {
        expect(AGENT_NOTE_DRAFT_STATES.map((state) => state.id)).toEqual(['agent-note-draft']);

        for (const state of AGENT_NOTE_DRAFT_STATES) {
            const markup = renderToStaticMarkup(<>{state.render()}</>);
            expect(markup).toContain('Процитировано из ответа агента:');
            expect(markup).toContain('data-note="41"');
        }
    });
});

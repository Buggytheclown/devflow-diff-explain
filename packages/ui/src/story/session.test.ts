import { expect, it, vi } from 'vitest';
import { createStorySession } from './session.js';

it('смена экрана и чат независимы; одинаковые действия не создают уведомлений и записей', () => {
    const persist = vi.fn(); const listener = vi.fn(); const session = createStorySession('route', persist);
    const stop = session.subscribe(listener);
    session.setChatOpen(true); session.setView('diff'); session.setView('diff');
    expect(session.getSnapshot()).toEqual({ view: 'diff', chatOpen: true });
    expect(persist.mock.calls).toEqual([['diff']]); expect(listener).toHaveBeenCalledTimes(2);
    stop(); session.setChatOpen(false); expect(listener).toHaveBeenCalledTimes(2);
});

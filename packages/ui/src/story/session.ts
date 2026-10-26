export type StoryView = 'route' | 'diff';
interface StorySessionState { view: StoryView; chatOpen: boolean }
export interface StorySession {
    subscribe: (listener: () => void) => () => void;
    getSnapshot: () => StorySessionState;
    setView: (view: StoryView) => void;
    setChatOpen: (open: boolean) => void;
}

/** Сессия рассказа содержит только экран и состояние чата; положение кода хранится отдельно. */
export function createStorySession(initial: StoryView, persist: (view: StoryView) => void): StorySession {
    let state: StorySessionState = { view: initial, chatOpen: false };
    const listeners = new Set<() => void>();
    const update = (next: StorySessionState) => {
        if (next.view === state.view && next.chatOpen === state.chatOpen) return;
        if (next.view !== state.view) persist(next.view);
        state = next;
        for (const listener of listeners) listener();
    };
    return { subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; }, getSnapshot: () => state,
        setView: (view) => { update({ ...state, view }); }, setChatOpen: (chatOpen) => { update({ ...state, chatOpen }); } };
}

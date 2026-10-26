import type { ThreadStore } from './store.js';

interface BeforeUnloadTarget {
    readonly addEventListener: (type: 'beforeunload', listener: (event: BeforeUnloadEvent) => void) => void;
    readonly removeEventListener: (type: 'beforeunload', listener: (event: BeforeUnloadEvent) => void) => void;
}

/** Предупреждает об уходе, пока композер держит несохранённый текст или запись в полёте. */
export function attachComposerBeforeUnload(store: ThreadStore, target: BeforeUnloadTarget = window): () => void {
    let attached = false;
    const handleBeforeUnload = (event: BeforeUnloadEvent): void => {
        event.preventDefault();
        // Старые браузеры показывают диалог только при записи deprecated-поля.
        // eslint-disable-next-line @typescript-eslint/no-deprecated
        event.returnValue = '';
    };
    const sync = (): void => {
        const pending = store.getComposerGuardSnapshot().pending;
        if (pending === attached) {
            return;
        }
        attached = pending;
        if (attached) {
            target.addEventListener('beforeunload', handleBeforeUnload);
        } else {
            target.removeEventListener('beforeunload', handleBeforeUnload);
        }
    };
    const unsubscribe = store.subscribeComposerGuard(sync);
    sync();
    return () => {
        unsubscribe();
        if (attached) {
            target.removeEventListener('beforeunload', handleBeforeUnload);
        }
    };
}

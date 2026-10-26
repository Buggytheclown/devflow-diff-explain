// @vitest-environment jsdom
import type { AgentNote, ChatAnchor, FileDiff } from '@sherpa/protocol';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';

import { parseFileDiff } from '../diff/parse.js';
import { createSessionStore } from '../session/session-store.js';
import { useCardNotes } from './card-notes.tsx';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const FILE: FileDiff = {
    fileId: 'file-1',
    path: 'src/cache.ts',
    oldPath: null,
    changeType: 'modify',
    binary: false,
    additions: 3,
    deletions: 1,
    generated: false,
    viewed: false,
    blameUrl: null,
    hostFileUrl: null,
    image: null,
    patch: [
        '@@ -40,3 +40,5 @@',
        ' const cached = readCache(key);',
        '-return cached;',
        '+if (cached !== null) {',
        '+    return cached;',
        '+}',
        ' return load(key);',
        '',
    ].join('\n'),
};
const MODEL = parseFileDiff(FILE);

function note(id: number, start = 41, end = 43, text = 'Первая строка\n\nВторая строка'): AgentNote {
    const anchor: ChatAnchor = { diffId: 'iter-1', fileId: FILE.fileId, path: FILE.path, side: 'new', start, end };
    return {
        id,
        exchangeId: id,
        anchor,
        text,
        lostAnchor: false,
        origin: { commit: 'abcdef1', anchor },
        createdAt: `2026-09-01T10:0${String(id)}:00.000Z`,
    };
}

const cleanups: (() => void)[] = [];
afterEach(() => {
    for (const cleanup of cleanups.splice(0)) {
        cleanup();
    }
});

const turnedIntoDraft: number[] = [];

function mount(initialNotes: readonly AgentNote[]) {
    turnedIntoDraft.length = 0;
    const session = createSessionStore({ initial: { view: 'diff', filter: 'all' } });
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);

    function State({ notes }: { readonly notes: readonly AgentNote[] }) {
        const layout = useCardNotes({
            model: MODEL,
            rowsShown: true,
            notes,
            placement: 'nearest',
            session,
            actions: {
                onOpenInChat: () => undefined,
                onTurnIntoDraft: (note) => {
                    turnedIntoDraft.push(note.id);
                },
                onDelete: () => Promise.resolve(),
            },
        });
        return <>{layout.renderAfterLine('new', 43)}</>;
    }

    const render = (notes: readonly AgentNote[]): void => {
        act(() => {
            root.render(<State notes={notes} />);
        });
    };
    render(initialNotes);
    cleanups.push(() => {
        act(() => {
            root.unmount();
        });
        host.remove();
    });
    return { host, session, render };
}

describe('карточка заметки', () => {
    it('показывает однострочное превью и раскрывает markdown с четырьмя действиями', () => {
        const { host } = mount([note(1)]);

        expect(host.textContent).toContain('◆Заметка агента·Первая строка·3 строки');
        act(() => {
            host.querySelector<HTMLButtonElement>('[data-note="1"]')?.click();
        });

        expect(host.textContent).toContain('Заметка агента · спрошено у строк 41–43');
        expect(host.textContent).toContain('ответ модели · не публикуется в PR');
        const actions = [...host.querySelectorAll<HTMLButtonElement>('.agent-note__actions button')].map(
            (button) => button.textContent,
        );
        expect(actions).toEqual(['Открыть в чате', 'В черновик комментария', 'Свернуть', 'Удалить']);

        act(() => {
            host.querySelectorAll<HTMLButtonElement>('.agent-note__actions button')[1]?.click();
        });
        expect(turnedIntoDraft).toEqual([1]);
        // Заметка после превращения остаётся на месте и не меняется.
        expect(host.querySelectorAll('[data-note="1"]')).toHaveLength(1);
        expect(host.textContent).toContain('ответ модели · не публикуется в PR');
    });

    it('у заметки без якоря черновик комментария недоступен, остальные действия работают', () => {
        const lost = { ...note(1), lostAnchor: true };
        const { host } = mount([lost]);
        act(() => {
            host.querySelector<HTMLButtonElement>('[data-note="1"]')?.click();
        });

        const actions = [...host.querySelectorAll<HTMLButtonElement>('.agent-note__actions button')];
        const draft = actions[1];
        expect(draft?.disabled).toBe(true);
        expect(draft?.title).toBe('якорь потерян — комментарий не к чему привязать');
        expect(actions.filter((button) => button.disabled)).toHaveLength(1);

        act(() => {
            draft?.click();
        });
        expect(turnedIntoDraft).toEqual([]);
    });

    it('четыре пересекающиеся заметки сначала показывает одной сводной строкой', () => {
        const notes = [note(1), note(2, 42, 43), note(3, 43, 43), note(4, 41, 43)];
        const { host } = mount(notes);

        const summary = host.querySelector<HTMLButtonElement>('.agent-note-stack-summary');
        expect(summary?.textContent).toContain('4 заметки здесь');
        expect(host.querySelectorAll('[data-note]')).toHaveLength(0);

        act(() => {
            summary?.click();
        });
        expect(host.querySelectorAll('[data-note]')).toHaveLength(4);
    });

    it('сворачивает раскрытые заметки стопки и не теряет раскрытие при изменении состава', () => {
        const notes = [note(1), note(2, 42, 43), note(3, 43, 43), note(4, 41, 43), note(5, 42, 43)];
        const { host, render, session } = mount(notes);

        act(() => {
            host.querySelector<HTMLButtonElement>('.agent-note-stack-summary')?.click();
        });
        act(() => {
            host.querySelector<HTMLButtonElement>('[data-note="1"]')?.click();
        });
        expect(host.querySelectorAll('[data-note]')).toHaveLength(5);
        expect(session.getSnapshot().notesExpanded).toContain('1');

        render(notes.filter((item) => item.id !== 2));
        expect(host.querySelectorAll('[data-note]')).toHaveLength(4);

        act(() => {
            host.querySelector<HTMLButtonElement>('.agent-note-stack__collapse')?.click();
        });
        expect(host.querySelectorAll('[data-note]')).toHaveLength(0);
        expect(host.querySelector('.agent-note-stack-summary')?.textContent).toContain('4 заметки здесь');
        expect(session.getSnapshot().notesExpanded).not.toContain('1');
    });
});

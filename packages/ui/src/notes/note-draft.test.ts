import type { AgentNote, ChatAnchor } from '@sherpa/protocol';
import { describe, expect, it } from 'vitest';

import { parseFileDiff } from '../diff/parse.js';
import { createThreadStore } from '../threads/store.js';
import { openNewComposer } from '../threads/thread-list.tsx';
import { commentPosition } from '../views/full-diff.tsx';
import { createT } from '../i18n/index.js';
import { noteCommentPosition, noteComposerAnchor, noteComposerKey, noteDraftText } from './note-draft.js';

const t = createT('ru');

const MODEL = parseFileDiff({
    fileId: 'f1',
    path: 'app.ts',
    oldPath: null,
    changeType: 'modify',
    binary: false,
    patch: [
        '@@ -100,4 +120,5 @@',
        ' context-before',
        '-old-101',
        '-old-102',
        '+new-121',
        '+new-122',
        '+new-123',
        ' context-after',
    ].join('\n'),
});

function note(text: string, start = 41, end = 43, side: 'old' | 'new' = 'new'): AgentNote {
    const anchor: ChatAnchor = { diffId: 'iter-1', fileId: 'f1', path: 'app.ts', side, start, end };
    return {
        id: 1,
        exchangeId: 1,
        anchor,
        text,
        lostAnchor: false,
        origin: { commit: 'abcdef1', anchor },
        createdAt: '2026-09-01T10:00:00.000Z',
    };
}

describe('текст черновика из заметки', () => {
    it('однострочную заметку цитирует одной строкой под атрибуцией', () => {
        expect(noteDraftText(note('Кеш возвращается сразу.'), t)).toBe(
            ['Процитировано из ответа агента:', '', '> Кеш возвращается сразу.'].join('\n'),
        );
    });

    it('пустые строки внутри текста цитирует пустой цитатой', () => {
        expect(noteDraftText(note('Первая строка\n\nПосле пустой\n- пункт'), t)).toBe(
            [
                'Процитировано из ответа агента:',
                '',
                '> Первая строка',
                '>',
                '> После пустой',
                '> - пункт',
            ].join('\n'),
        );
    });

    it('обрезает хвостовые пустые строки заметки', () => {
        expect(noteDraftText(note('Единственная строка\n\n   \n\n'), t)).toBe(
            ['Процитировано из ответа агента:', '', '> Единственная строка'].join('\n'),
        );
    });
});

describe('позиция черновика от якоря заметки', () => {
    it('многострочный диапазон новой стороны совпадает с выделением тех же строк', () => {
        const selection = { fileId: 'f1', anchor: 'a121', focus: 'a123' };

        expect(noteCommentPosition(note('t', 121, 123).anchor)).toEqual(
            commentPosition(selection, MODEL, 'f1', 'new', 121),
        );
    });

    it('многострочный диапазон старой стороны совпадает с выделением тех же строк', () => {
        const selection = { fileId: 'f1', anchor: 'd101', focus: 'd102' };

        expect(noteCommentPosition(note('t', 101, 102, 'old').anchor)).toEqual(
            commentPosition(selection, MODEL, 'f1', 'old', 101),
        );
    });

    it('одна строка даёт size 1 — как клик карандашом без выделения', () => {
        expect(noteCommentPosition(note('t', 122, 122).anchor)).toEqual(
            commentPosition(null, MODEL, 'f1', 'new', 122),
        );
        expect(noteCommentPosition(note('t', 122, 122).anchor)).toEqual({ side: 'new', line: 122, size: 1 });
    });

    it('ключ и якорь композера строятся от первой строки диапазона', () => {
        expect(noteComposerKey(note('t', 121, 123).anchor)).toBe('new:f1:new:121');
        expect(noteComposerAnchor(note('t', 121, 123).anchor)).toEqual({
            fileId: 'f1',
            path: 'app.ts',
            position: { side: 'new', line: 121, size: 3 },
        });
    });
});

describe('посев текста в композер', () => {
    const anchor = noteComposerAnchor(note('t', 121, 123).anchor);
    const key = noteComposerKey(note('t', 121, 123).anchor);

    it('открывает новый композер с цитатой', () => {
        const store = createThreadStore([], new Set(['f1']));
        openNewComposer(store, key, anchor, true, 'цитата');

        expect(store.getComposer(key)?.text).toBe('цитата');
        expect(store.getComposer(key)?.anchor).toEqual(anchor);
    });

    it('не затирает набранный ревьюером текст', () => {
        const store = createThreadStore([], new Set(['f1']));
        openNewComposer(store, key, anchor, true);
        store.updateComposer(key, { text: 'своё замечание' });

        openNewComposer(store, key, anchor, true, 'цитата');

        expect(store.getComposer(key)?.text).toBe('своё замечание');
    });

    it('засевает уже открытый пустой композер и переносит его на диапазон заметки', () => {
        const store = createThreadStore([], new Set(['f1']));
        // Карандаш по одной строке 121 даёт тот же ключ, что заметка на 121–123.
        const pencilAnchor = { fileId: 'f1', path: 'app.ts', position: { side: 'new', line: 121, size: 1 } } as const;
        openNewComposer(store, key, pencilAnchor, true);

        openNewComposer(store, key, anchor, true, 'цитата');

        expect(store.getComposer(key)?.text).toBe('цитата');
        expect(store.getComposer(key)?.anchor).toEqual(anchor);
    });

    it('не переносит якорь у композера с набранным текстом', () => {
        const store = createThreadStore([], new Set(['f1']));
        const pencilAnchor = { fileId: 'f1', path: 'app.ts', position: { side: 'new', line: 121, size: 1 } } as const;
        openNewComposer(store, key, pencilAnchor, true);
        store.updateComposer(key, { text: 'своё замечание' });

        openNewComposer(store, key, anchor, true, 'цитата');

        expect(store.getComposer(key)?.anchor).toEqual(pencilAnchor);
    });
});

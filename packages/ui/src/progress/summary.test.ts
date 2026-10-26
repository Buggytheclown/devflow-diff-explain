import { fixtureIteration } from '@sherpa/fixtures';
import type { Comment, Thread } from '@sherpa/protocol';
import { describe, expect, it } from 'vitest';

import type { FileReadState } from './read-state.js';
import { commentBodies, countDraftComments, countPublishedReplies, reviewProgressSummary } from './summary.js';

function state(seen: number, total: number, read = false): FileReadState {
    return {
        state: read ? 'read' : seen === 0 ? 'unread' : 'partial',
        seen,
        total,
        pinned: read,
        generatedDefault: false,
    };
}

function comment(id: string, draft: boolean, replies: Comment[] = []): Comment {
    return {
        id,
        author: { login: 'alice', displayName: 'Alice Ingram', bot: false, avatarUrl: null },
        body: `текст ${id}`,
        draft,
        issue: null,
        resolved: null,
        createdAt: '2026-08-25T10:00:00.000Z',
        editedAt: null,
        replies,
    };
}

function threads(): Thread[] {
    return [
        {
            id: 'thread-1',
            anchor: null,
            resolved: false,
            resolvedBy: null,
            outdated: false,
        pinnedTo: null,
            root: comment('root', true, [comment('reply', true, [comment('deep', false)])]),
        },
    ];
}

describe('агрегаты прогресса ревью', () => {
    it('считает просмотренные файлы и строки из эффективных read-state', () => {
        const files = fixtureIteration('medium').diff.files;
        const first = files[0];
        const second = files[1];
        if (first === undefined || second === undefined) {
            throw new Error('в small-фикстуре нужны два файла');
        }
        const firstTotal = first.additions + first.deletions;
        const secondTotal = second.additions + second.deletions;
        const readState = new Map<string, FileReadState>([
            [first.fileId, state(firstTotal, firstTotal, true)],
            [second.fileId, state(Math.min(2, secondTotal), secondTotal)],
        ]);

        expect(reviewProgressSummary(files, readState)).toEqual({
            filesSeen: 1,
            filesTotal: files.length,
            linesSeen: firstTotal + Math.min(2, secondTotal),
            linesTotal: files.reduce((total, file) => total + file.additions + file.deletions, 0),
            percentSeen: Math.floor(
                ((firstTotal + Math.min(2, secondTotal)) /
                    files.reduce((total, file) => total + file.additions + file.deletions, 0)) *
                    100,
            ),
        });
    });

    it('конфликтный файл вне знаменателя: его не прочитать в Шерпе (docs/design/SPEC-elements.md §4.1)', () => {
        const files = fixtureIteration('edge').diff.files;
        const conflict = files.find((file) => file.changeType === 'conflict');
        if (conflict === undefined) {
            throw new Error('в edge-фикстуре нужен файл с конфликтом');
        }

        const summary = reviewProgressSummary(files, new Map());
        const withoutConflicts = files.filter((file) => file.changeType !== 'conflict');

        expect(summary.filesTotal).toBe(withoutConflicts.length);
        expect(summary.filesTotal).toBe(files.length - 1);
        expect(summary.linesTotal).toBe(
            withoutConflicts.reduce((total, file) => total + file.additions + file.deletions, 0),
        );
        // Отметка «просмотрено» на конфликте ничего не двигает: его нет ни в одном из чисел.
        const marked = new Map([
            [conflict.fileId, state(conflict.additions + conflict.deletions, conflict.additions + conflict.deletions, true)],
        ]);
        expect(reviewProgressSummary(files, marked)).toEqual(summary);
    });

    it('пустой дифф считается просмотренным на 100%', () => {
        expect(reviewProgressSummary([], new Map())).toEqual({
            filesSeen: 0,
            filesTotal: 0,
            linesSeen: 0,
            linesTotal: 0,
            percentSeen: 100,
        });
    });
});

describe('селекторы комментариев публикации', () => {
    it('рекурсивно считает черновики и опубликованные ответы', () => {
        const source = threads();

        expect(countDraftComments(source)).toBe(2);
        expect(countPublishedReplies(source, ['root', 'reply', 'deep'])).toBe(2);
        expect(commentBodies(source)).toEqual(
            new Map([
                ['root', 'текст root'],
                ['reply', 'текст reply'],
                ['deep', 'текст deep'],
            ]),
        );
    });
});

import type { FileContent, FileDiff } from '@sherpa/protocol';
import { describe, expect, it } from 'vitest';

import { toParseRequest } from '../diff/model.js';
import { parseFileDiff } from '../diff/parse.js';
import { expandFileContext, expandGap, gapKeyOf } from '../diff-view/expand.js';
import { lineSideInDiff, searchDiff } from './diff-search.js';

function file(patch: string | null): FileDiff {
    return {
        fileId: 'f-one',
        path: 'src/one.ts',
        oldPath: null,
        changeType: 'modify',
        binary: false,
        generated: false,
        additions: 2,
        deletions: 1,
        patch,
        viewed: null,
        blameUrl: null,
        hostFileUrl: null,
        image: null,
    };
}

const PATCH = [
    'diff --git a/src/one.ts b/src/one.ts',
    '--- a/src/one.ts',
    '+++ b/src/one.ts',
    '@@ -10,3 +20,3 @@ export function run()',
    ' const orderId = request.id;',
    '-dropOldCache(orderId);',
    '+dropNewCache(orderId);',
    ' return orderId;',
].join('\n');

describe('searchDiff', () => {
    it('считает стороны и номера строк из заголовка ханка', () => {
        const result = searchDiff([file(PATCH)], 'cache');

        expect(result).toEqual({
            truncated: false,
            matches: [
                expect.objectContaining({ side: 'old', line: 11, text: 'dropOldCache(orderId);' }),
                expect.objectContaining({ side: 'new', line: 21, text: 'dropNewCache(orderId);' }),
            ],
        });
    });

    it('контекстную строку адресует по новой стороне', () => {
        const [match] = searchDiff([file(PATCH)], 'request.id').matches;
        expect(match).toMatchObject({ side: 'new', line: 20, text: 'const orderId = request.id;' });
    });

    it('считает голую пустую строку контекстом, как канонический парсер', () => {
        const malformed = ['@@ -10,4 +20,4 @@', ' first', '', '-oldTarget', '+newTarget'].join('\n');

        expect(searchDiff([file(malformed)], 'target').matches).toEqual([
            expect.objectContaining({ side: 'old', line: 12, text: 'oldTarget' }),
            expect.objectContaining({ side: 'new', line: 22, text: 'newTarget' }),
        ]);
    });

    it('считает неизвестный префикс контекстом, как канонический парсер', () => {
        const malformed = ['@@ -10,4 +20,4 @@', ' first', '?broken', '-oldTarget', '+newTarget'].join('\n');

        expect(searchDiff([file(malformed)], 'target').matches).toEqual([
            expect.objectContaining({ side: 'old', line: 12, text: 'oldTarget' }),
            expect.objectContaining({ side: 'new', line: 22, text: 'newTarget' }),
        ]);
    });

    it('выбирает реальную сторону строки и предпочитает новую для контекста', () => {
        const deleted = { ...file(['@@ -40,1 +40,0 @@', '-gone'].join('\n')), changeType: 'delete' as const };
        const context = file(['@@ -40,1 +50,1 @@', ' same'].join('\n'));

        expect(lineSideInDiff(deleted, 40)).toBe('old');
        expect(lineSideInDiff(deleted, 41)).toBeNull();
        expect(lineSideInDiff(context, 50)).toBe('new');
    });

    it('находит догруженную контекстную строку, которой нет в патче', () => {
        const target = file(['@@ -3,1 +3,1 @@', '-old', '+new'].join('\n'));
        const source = parseFileDiff(toParseRequest(target));
        const gap = source.content.kind === 'text' ? source.content.blocks.find((block) => block.kind === 'gap') : undefined;
        if (gap?.kind !== 'gap') {
            throw new Error('в модели нет ведущего пропуска');
        }
        const content: FileContent = { oldText: 'needle from context\nline-2\nold', newText: 'needle from context\nline-2\nnew' };
        const expansion = expandGap(new Map(), gapKeyOf(gap), 'up');
        const shown = expandFileContext(source, content, expansion);

        expect(searchDiff([target], 'needle', 50, new Map([[target.fileId, shown]])).matches).toEqual([
            expect.objectContaining({ side: 'new', line: 1, text: 'needle from context' }),
        ]);
    });

    it('не матчится по заголовкам @@ и служебным строкам патча', () => {
        expect(searchDiff([file(PATCH)], 'export function').matches).toEqual([]);
        expect(searchDiff([file(PATCH)], 'diff --git').matches).toEqual([]);
    });

    it('честно сообщает о капе', () => {
        const many = ['@@ -1,4 +1,4 @@', ' hit', '+hit', '-hit', ' hit'].join('\n');
        const result = searchDiff([file(many)], 'hit', 2);

        expect(result.matches).toHaveLength(2);
        expect(result.truncated).toBe(true);
    });

    it('null-патч и пустой запрос не дают результатов', () => {
        expect(searchDiff([file(null)], 'x')).toEqual({ matches: [], truncated: false });
        expect(searchDiff([file(PATCH)], ' ')).toEqual({ matches: [], truncated: false });
    });
});

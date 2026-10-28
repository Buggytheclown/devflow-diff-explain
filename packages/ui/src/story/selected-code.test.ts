import { fixtureIteration } from '@sherpa/fixtures';
import { uiChatAskAnchorSchema } from '@sherpa/protocol';
import { expect, it } from 'vitest';
import { parseFileDiff } from '../diff/parse.js';
import { toParseRequest } from '../diff/model.js';
import { selectedCode, withCodeQuote } from './selected-code.js';

const file = fixtureIteration('medium').diff.files[0];
if (file === undefined) throw new Error('Missing fixture');
const anchor = { diffId: 'iteration', fileId: file.fileId, path: file.path, side: 'new' as const, start: 1, end: 3 };
const parse = (patch: string) => parseFileDiff(toParseRequest({ ...file, patch }));

it('берёт весь диапазон правильной стороны, без номеров и префиксов патча', () => {
    const model = parse('@@ -1,3 +1,3 @@\n before\n-old value\n+new value\n after\n');
    expect(selectedCode(model, anchor)).toBe('before\nnew value\nafter');
    expect(selectedCode(model, { ...anchor, side: 'old' })).toBe('before\nold value\nafter');
    expect(withCodeQuote(anchor, selectedCode(model, anchor)).selectedText).toBe('before\nnew value\nafter');
});

it('не склеивает видимые строки через скрытый промежуток', () => {
    const model = parse('@@ -1 +1 @@\n one\n@@ -3 +3 @@\n three\n');
    expect(selectedCode(model, anchor)).toBeNull();
    expect(withCodeQuote(anchor, null).selectedText).toBeUndefined();
});

it('длинное превью остаётся полным, а якорь соблюдает лимит цитаты протокола', () => {
    const code = 'x'.repeat(5000);
    const model = parse(`@@ -1 +1 @@\n-${code}\n+${code}\n`);
    const range = { ...anchor, end: 1 };
    expect(selectedCode(model, range)).toBe(code);
    const quoted = withCodeQuote(range, code);
    expect(quoted.selectedText).toBeUndefined();
    expect(uiChatAskAnchorSchema.parse(quoted)).toEqual(range);
});

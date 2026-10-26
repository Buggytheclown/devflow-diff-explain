import { describe, expect, it } from 'vitest';

import { editMarkdown } from './composer-markdown.js';

const PLACEHOLDERS = { text: 'текст', code: 'код' };

describe('Markdown-тулбар композера', () => {
    it('ставит список на отдельную строку при каретке внутри текста', () => {
        expect(editMarkdown('смотри тут дальше', 10, 10, 'list', PLACEHOLDERS)).toEqual({
            text: 'смотри тут\n- текст\n дальше',
            selectionStart: 11,
            selectionEnd: 18,
        });
    });

    it('превращает каждую выделенную строку в пункт списка', () => {
        expect(editMarkdown('до\nпервый\nвторой\nпосле', 3, 16, 'list', PLACEHOLDERS)).toEqual({
            text: 'до\n- первый\n- второй\nпосле',
            selectionStart: 3,
            selectionEnd: 20,
        });
    });
});

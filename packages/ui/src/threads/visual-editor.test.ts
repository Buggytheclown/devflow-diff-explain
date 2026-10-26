// @vitest-environment jsdom
import { schema } from 'prosemirror-markdown';
import { EditorState, Selection } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { describe, expect, it, vi } from 'vitest';

import {
    createEditorState,
    markdownInputRules,
    parseClipboardMarkdown,
    parseMarkdown,
    serializeMarkdownDocument,
} from './visual-editor.js';

/** Круговой прогон: markdown → документ ProseMirror → markdown. */
function roundTrip(markdown: string): string {
    return serializeMarkdownDocument(parseMarkdown(markdown));
}

const CASES = [
    ['жирный', '**важно**', '**важно**'],
    ['курсив', '*осторожно*', '*осторожно*'],
    ['инлайн-код', 'проверить `isDirty` здесь', 'проверить `isDirty` здесь'],
    ['блок кода', '```\nconst value = 1;\n```', '```\nconst value = 1;\n```'],
    // prosemirror-markdown канонизирует маркер ненумерованного списка, структура не меняется.
    ['список', '- первый\n- второй', '* первый\n* второй'],
    ['ссылка', '[документация](https://example.com/docs)', '[документация](https://example.com/docs)'],
    ['список с инлайн-кодом', '- вызвать `retry()`\n- проверить `status`', '* вызвать `retry()`\n* проверить `status`'],
    ['ссылка внутри жирного', '**см. [контракт](https://example.com/spec)**', '**см. [контракт](https://example.com/spec)**'],
    ['многострочный блок кода', '```\nconst first = 1;\nconst second = 2;\n```', '```\nconst first = 1;\nconst second = 2;\n```'],
    ['одиночный перенос внутри абзаца', 'первая строка\nвторая строка', 'первая строка\nвторая строка'],
    ['квадратные скобки без ссылки', 'см. [TODO] в коде', 'см. [TODO] в коде'],
    ['звёздочка без форматирования', '2*3', '2*3'],
    ['тильда без форматирования', 'версия ~2', 'версия ~2'],
    ['непарный обратный апостроф', 'обычный ` апостроф', 'обычный ` апостроф'],
    ['обратный слеш без escape-последовательности', 'path\\to', 'path\\to'],
] as const;

describe('markdown round-trip визуального редактора', () => {
    it.each(CASES)('%s', (_title, markdown, expected) => {
        expect(roundTrip(markdown)).toBe(expected);
    });

    it('разбирает вставленный plain text как markdown и не добавляет обратные слеши', () => {
        const slice = parseClipboardMarkdown('проверить **bold** и `code`');
        const doc = schema.topNodeType.create(null, slice.content);

        expect(doc.firstChild?.child(1).marks[0]?.type.name).toBe('strong');
        expect(doc.firstChild?.child(3).marks[0]?.type.name).toBe('code');
        expect(serializeMarkdownDocument(doc)).toBe('проверить **bold** и `code`');
    });

    it.each([
        ['**bold**', 'strong'],
        ['*italic*', 'em'],
        ['`code`', 'code'],
    ])('превращает набранное %s в mark %s', (input, markName) => {
        const host = document.createElement('div');
        const view = new EditorView(host, {
            state: EditorState.create({ schema, plugins: [markdownInputRules()] }),
        });

        type(view, input);

        expect(view.state.doc.textContent).toBe(input.replace(/^\*\*|\*\*$|^\*|\*$|^`|`$/g, ''));
        expect(view.state.doc.firstChild?.firstChild?.marks[0]?.type.name).toBe(markName);
        view.destroy();
    });
});

/** Набор текста по одному символу — как в браузере, через handleTextInput правил ввода. */
function type(view: EditorView, input: string): void {
    for (const character of input) {
        const { from, to } = view.state.selection;
        const handled = view.someProp('handleTextInput', (handler) =>
            handler(view, from, to, character, () => view.state.tr.insertText(character, from, to)),
        );
        if (!handled) {
            view.dispatch(view.state.tr.insertText(character, from, to));
        }
    }
}

function press(view: EditorView, key: string, modifiers: KeyboardEventInit = {}): boolean {
    const event = new KeyboardEvent('keydown', { key, ...modifiers });
    return view.someProp('handleKeyDown', (handler) => handler(view, event)) ?? false;
}

/** Редактор с полным набором плагинов — правила ввода и хоткеи вместе, как в композере. */
function mountEditor(markdown = '') {
    const onSave = vi.fn();
    const onCancel = vi.fn();
    const options = {
        markdown,
        disabled: false,
        ariaLabel: 'комментарий',
        placeholders: { text: 'текст', code: 'код' },
        onChange: () => undefined,
        onSave,
        onCancel,
    };
    const view = new EditorView(document.createElement('div'), { state: createEditorState(markdown, options) });
    view.dispatch(view.state.tr.setSelection(Selection.atEnd(view.state.doc)));
    return { view, onSave, onCancel };
}

describe('блочные правила ввода и хоткеи визуального редактора', () => {
    it('«- » превращает строку в пункт списка', () => {
        const { view } = mountEditor();

        type(view, '- пункт');

        expect(view.state.doc.firstChild?.type.name).toBe('bullet_list');
        expect(serializeMarkdownDocument(view.state.doc)).toBe('* пункт');
        view.destroy();
    });

    it('«1. » превращает строку в нумерованный список', () => {
        const { view } = mountEditor();

        type(view, '1. пункт');

        expect(view.state.doc.firstChild?.type.name).toBe('ordered_list');
        expect(serializeMarkdownDocument(view.state.doc)).toBe('1. пункт');
        view.destroy();
    });

    it('``` превращает абзац в блок кода', () => {
        const { view } = mountEditor();

        type(view, '```');
        type(view, 'const value = 1;');

        expect(view.state.doc.firstChild?.type.name).toBe('code_block');
        expect(serializeMarkdownDocument(view.state.doc)).toBe('```\nconst value = 1;\n```');
        view.destroy();
    });

    it('Backspace сразу после «- » возвращает литерал', () => {
        const { view } = mountEditor();

        type(view, '- ');
        expect(view.state.doc.firstChild?.type.name).toBe('bullet_list');

        expect(press(view, 'Backspace')).toBe(true);

        expect(view.state.doc.firstChild?.type.name).toBe('paragraph');
        expect(view.state.doc.textContent).toBe('- ');
        view.destroy();
    });

    it('Enter в пункте создаёт следующий пункт', () => {
        const { view } = mountEditor();

        type(view, '- первый');
        expect(press(view, 'Enter')).toBe(true);
        type(view, 'второй');

        expect(view.state.doc.firstChild?.childCount).toBe(2);
        expect(serializeMarkdownDocument(view.state.doc)).toBe('* первый\n* второй');
        view.destroy();
    });

    it('Enter в пустом пункте выходит из списка', () => {
        const { view } = mountEditor();

        type(view, '- первый');
        press(view, 'Enter');
        expect(press(view, 'Enter')).toBe(true);
        type(view, 'абзац');

        expect(view.state.doc.childCount).toBe(2);
        expect(view.state.doc.lastChild?.type.name).toBe('paragraph');
        expect(serializeMarkdownDocument(view.state.doc)).toBe('* первый\n\nабзац');
        view.destroy();
    });

    it('Tab вкладывает пункт, Shift-Tab возвращает обратно', () => {
        const { view } = mountEditor();

        type(view, '- первый');
        press(view, 'Enter');
        expect(press(view, 'Tab')).toBe(true);
        type(view, 'вложенный');

        expect(serializeMarkdownDocument(view.state.doc)).toBe('* первый\n  * вложенный');

        expect(press(view, 'Tab', { shiftKey: true })).toBe(true);
        expect(serializeMarkdownDocument(view.state.doc)).toBe('* первый\n* вложенный');
        view.destroy();
    });

    it('Shift-Enter выходит из блока кода в новый абзац', () => {
        const { view } = mountEditor();

        type(view, '```');
        type(view, 'const value = 1;');
        expect(press(view, 'Enter', { shiftKey: true })).toBe(true);
        type(view, 'после кода');

        expect(view.state.doc.lastChild?.type.name).toBe('paragraph');
        expect(serializeMarkdownDocument(view.state.doc)).toBe('```\nconst value = 1;\n```\n\nпосле кода');
        view.destroy();
    });

    it('Shift-Enter в абзаце делает мягкий перенос внутри того же абзаца', () => {
        const { view } = mountEditor();

        type(view, 'первая');
        expect(press(view, 'Enter', { shiftKey: true })).toBe(true);
        type(view, 'вторая');

        expect(view.state.doc.childCount).toBe(1);
        expect(serializeMarkdownDocument(view.state.doc)).toBe('первая\nвторая');
        view.destroy();
    });

    it('Enter в блоке кода внутри пункта переносит строку, а не создаёт пункт', () => {
        const { view } = mountEditor('* пункт\n\n  ```\n  code\n  ```');

        expect(press(view, 'Enter')).toBe(true);
        type(view, 'ещё');

        expect(view.state.doc.childCount).toBe(1);
        expect(serializeMarkdownDocument(view.state.doc)).toBe('* пункт\n\n  ```\n  code\n  ещё\n  ```');
        view.destroy();
    });

    it('⌘⏎ по-прежнему сохраняет, а Esc отменяет', () => {
        const { view, onSave, onCancel } = mountEditor();

        type(view, '- пункт');
        expect(press(view, 'Enter', { ctrlKey: true })).toBe(true);
        expect(press(view, 'Escape')).toBe(true);

        expect(onSave).toHaveBeenCalledTimes(1);
        expect(onCancel).toHaveBeenCalledTimes(1);
        expect(view.state.doc.firstChild?.type.name).toBe('bullet_list');
        view.destroy();
    });
});

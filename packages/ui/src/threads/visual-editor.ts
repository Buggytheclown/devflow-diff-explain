import {
    baseKeymap,
    chainCommands,
    exitCode,
    newlineInCode,
    setBlockType,
    toggleMark,
} from 'prosemirror-commands';
import { history, redo, undo } from 'prosemirror-history';
import {
    InputRule,
    inputRules,
    textblockTypeInputRule,
    undoInputRule,
    wrappingInputRule,
} from 'prosemirror-inputrules';
import { keymap } from 'prosemirror-keymap';
import {
    defaultMarkdownParser,
    defaultMarkdownSerializer,
    MarkdownParser,
    MarkdownSerializer,
    schema,
} from 'prosemirror-markdown';
import { Slice } from 'prosemirror-model';
import type { MarkType, Node as ProseMirrorNode, NodeType } from 'prosemirror-model';
import { liftListItem, sinkListItem, splitListItem, wrapInList } from 'prosemirror-schema-list';
import { EditorState, TextSelection } from 'prosemirror-state';
import type { Command, Transaction } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';

import type { ComposerTool, EditorPlaceholders } from './composer-markdown.js';

export interface VisualEditorOptions {
    readonly markdown: string;
    /** Тексты-заглушки тулбара: команды вставляют их, когда выделения нет. */
    readonly placeholders: EditorPlaceholders;
    readonly disabled: boolean;
    readonly ariaLabel: string;
    readonly onChange: (markdown: string) => void;
    readonly onSave: () => void;
    readonly onCancel: () => void;
}

export interface VisualEditorHandle {
    readonly setMarkdown: (markdown: string) => void;
    readonly setDisabled: (disabled: boolean) => void;
    readonly format: (tool: ComposerTool) => void;
    readonly focus: () => void;
    readonly destroy: () => void;
}

const markdownParser = new MarkdownParser(schema, defaultMarkdownParser.tokenizer, {
    ...defaultMarkdownParser.tokens,
    softbreak: { node: 'hard_break' },
});

const markdownSerializer = new MarkdownSerializer(
    {
        ...defaultMarkdownSerializer.nodes,
        hard_break: (state, _node, parent, index) => {
            if (index + 1 < parent.childCount) {
                state.write('\n');
            }
        },
        text: (state, node, parent, index) => {
            const defaultEscape = state.esc.bind(state);
            state.esc = (text, startOfLine = false) => {
                if (node.marks.length > 0 || !parsesAsPlainText(text)) {
                    return defaultEscape(text, startOfLine);
                }
                return startOfLine ? escapeBlockStart(text) : text;
            };
            try {
                defaultMarkdownSerializer.nodes.text?.(state, node, parent, index);
            } finally {
                state.esc = defaultEscape;
            }
        },
    },
    defaultMarkdownSerializer.marks,
);

/** Списки из редактора сериализуются без пустых строк между пунктами. */
const TIGHT_LIST = { tight: true };

export function parseMarkdown(markdown: string) {
    return markdownParser.parse(markdown);
}

export function parseClipboardMarkdown(markdown: string): Slice {
    return Slice.maxOpen(parseMarkdown(markdown).content);
}

/** Разметка, набранная как markdown, превращается в марки и блоки прямо при вводе. */
export function markdownInputRules() {
    return inputRules({
        rules: [
            markInputRule(/\*\*([^*\n]+)\*\*$/, schema.marks.strong, 1),
            markInputRule(/(^|[^*])\*([^*\n]+)\*$/, schema.marks.em, 2, 1),
            markInputRule(/`([^`\n]+)`$/, schema.marks.code, 1),
            wrappingInputRule(/^\s*([-+*])\s$/, schema.nodes.bullet_list, TIGHT_LIST),
            wrappingInputRule(
                /^(\d+)\.\s$/,
                schema.nodes.ordered_list,
                (match) => ({ ...TIGHT_LIST, order: numberOf(match[1], 1) }),
                (match, node) => node.childCount + listOrder(node) === numberOf(match[1], 1),
            ),
            textblockTypeInputRule(/^```$/, schema.nodes.code_block),
        ],
    });
}

export function serializeMarkdownDocument(doc: ProseMirrorNode): string {
    return markdownSerializer.serialize(doc);
}

function parsesAsPlainText(markdown: string): boolean {
    const tokens = markdownParser.tokenizer.parseInline(markdown, {});
    const children = tokens.flatMap((token) => token.children ?? []);
    return children.every((token) => token.type === 'text') && children.map((token) => token.content).join('') === markdown;
}

function escapeBlockStart(text: string): string {
    return text
        .replace(/^(\+[ ]|[-*>])/, '\\$&')
        .replace(/^(\s*)(#{1,6})(\s|$)/, '$1\\$2$3')
        .replace(/^(\s*\d+)\.\s/, '$1\\. ');
}

/** Монтирует ProseMirror; модуль загружается только при выборе визуальной раскладки. */
export function createVisualEditor(element: HTMLElement, options: VisualEditorOptions): VisualEditorHandle {
    element.replaceChildren();
    let disabled = options.disabled;
    let lastMarkdown = options.markdown;

    const view = new EditorView(element, {
        state: createEditorState(options.markdown, options),
        dispatchTransaction: (transaction: Transaction) => {
            const nextState = view.state.apply(transaction);
            view.updateState(nextState);
            if (!transaction.docChanged) {
                return;
            }
            lastMarkdown = serializeMarkdownDocument(nextState.doc);
            options.onChange(lastMarkdown);
        },
        editable: () => !disabled,
        attributes: {
            class: 'thread-composer__prosemirror',
            role: 'textbox',
            'aria-label': options.ariaLabel,
            'aria-multiline': 'true',
        },
        clipboardTextParser: parseClipboardMarkdown,
        handleKeyDown: (_view, event) => {
            if (isComposerShortcut(event) || isComposerInputKey(event.key)) {
                event.stopPropagation();
            }
            return false;
        },
    });

    const apply = (command: Command): void => {
        command(view.state, view.dispatch, view);
        view.focus();
    };

    return {
        setMarkdown: (markdown) => {
            if (markdown === lastMarkdown) {
                return;
            }
            lastMarkdown = markdown;
            view.updateState(createEditorState(markdown, options));
        },
        setDisabled: (value) => {
            disabled = value;
            view.setProps({ editable: () => !disabled });
        },
        format: (tool) => {
            apply(commandFor(tool, options.placeholders));
        },
        focus: () => {
            view.focus();
        },
        destroy: () => {
            view.destroy();
        },
    };
}

/** Состояние редактора: правила ввода, хоткеи композера и работа со списками поверх baseKeymap. */
export function createEditorState(markdown: string, options: VisualEditorOptions): EditorState {
    const enter = enterCommand();
    return EditorState.create({
        schema,
        doc: parseMarkdown(markdown),
        plugins: [
            history(),
            markdownInputRules(),
            keymap({
                'Mod-b': formatMark(schema.marks.strong, options.placeholders.text),
                'Mod-i': formatMark(schema.marks.em, options.placeholders.text),
                'Mod-k': linkCommand(options.placeholders.text),
                'Mod-Enter': () => {
                    options.onSave();
                    return true;
                },
                Escape: () => {
                    options.onCancel();
                    return true;
                },
                'Mod-z': undo,
                'Shift-Mod-z': redo,
                Backspace: undoInputRule,
                Enter: enter,
                'Shift-Enter': chainCommands(exitCode, insertHardBreak()),
                Tab: sinkListItem(schema.nodes.list_item),
                'Shift-Tab': liftListItem(schema.nodes.list_item),
            }),
            keymap(baseKeymap),
        ],
    });
}

function markInputRule(
    pattern: RegExp,
    mark: MarkType,
    contentIndex: number,
    prefixIndex?: number,
): InputRule {
    return new InputRule(
        pattern,
        (state, match, start, end) => {
            const content = match[contentIndex];
            if (content === undefined) {
                return null;
            }
            const prefix = prefixIndex === undefined ? '' : (match[prefixIndex] ?? '');
            const from = start + prefix.length;
            return state.tr
                .delete(from, end)
                .insertText(content, from)
                .addMark(from, from + content.length, mark.create())
                .removeStoredMark(mark);
        },
        { inCodeMark: false },
    );
}

function commandFor(tool: ComposerTool, placeholders: EditorPlaceholders): Command {
    switch (tool) {
        case 'bold':
            return formatMark(schema.marks.strong, placeholders.text);
        case 'italic':
            return formatMark(schema.marks.em, placeholders.text);
        case 'link':
            return linkCommand(placeholders.text);
        case 'code':
            return formatMark(schema.marks.code, placeholders.code);
        case 'codeblock':
            return blockCommand(schema.nodes.code_block, placeholders.code);
        case 'list':
            return listCommand(placeholders.text);
    }
}

function formatMark(mark: MarkType, fallback: string): Command {
    return (state, dispatch) => {
        if (!state.selection.empty) {
            return toggleMark(mark)(state, dispatch);
        }
        if (dispatch === undefined) {
            return true;
        }
        const from = state.selection.from;
        const transaction = state.tr.insertText(fallback).addMark(from, from + fallback.length, mark.create());
        dispatch(transaction.setSelection(TextSelection.create(transaction.doc, from, from + fallback.length)));
        return true;
    };
}

function linkCommand(placeholder: string): Command {
    const link = schema.marks.link;
    return (state, dispatch) => {
        const { from, to, empty } = state.selection;
        if (dispatch === undefined) {
            return true;
        }
        let transaction = state.tr;
        let end = to;
        if (empty) {
            transaction = transaction.insertText(placeholder);
            end = from + placeholder.length;
        }
        transaction = transaction.addMark(from, end, link.create({ href: 'https://', title: null }));
        dispatch(transaction.setSelection(TextSelection.create(transaction.doc, from, end)));
        return true;
    };
}

function blockCommand(node: NodeType, fallback: string): Command {
    return (state, dispatch, view) => {
        let nextState = state;
        if (state.selection.empty && dispatch !== undefined) {
            const from = state.selection.from;
            const transaction = state.tr.insertText(fallback);
            dispatch(transaction.setSelection(TextSelection.create(transaction.doc, from, from + fallback.length)));
            nextState = view?.state ?? state.apply(transaction);
        }
        return setBlockType(node)(nextState, dispatch);
    };
}

/** Тумблер списка в тулбаре: внутри списка снимает пункт, иначе оборачивает выделение. */
function listCommand(placeholder: string): Command {
    const list = schema.nodes.bullet_list;
    return (state, dispatch, view) => {
        if (isInsideList(state)) {
            return liftListItem(schema.nodes.list_item)(state, dispatch, view);
        }
        let nextState = state;
        if (state.selection.empty && dispatch !== undefined) {
            const from = state.selection.from;
            const transaction = state.tr.insertText(placeholder);
            dispatch(
                transaction.setSelection(
                    TextSelection.create(transaction.doc, from, from + placeholder.length),
                ),
            );
            nextState = view?.state ?? state.apply(transaction);
        }
        return wrapInList(list, TIGHT_LIST)(nextState, dispatch);
    };
}

/**
 * Enter делит пункт списка, а в пустом пункте выходит из списка; вне списка пасует в baseKeymap.
 * newlineInCode первым: в блоке кода внутри пункта Enter — перенос строки, а не новый пункт.
 */
function enterCommand(): Command {
    return chainCommands(newlineInCode, splitListItem(schema.nodes.list_item), liftEmptyListItem());
}

/** Shift-Enter вне блока кода — мягкий перенос: hard_break сериализуется одиночным \n. */
function insertHardBreak(): Command {
    return (state, dispatch) => {
        dispatch?.(state.tr.replaceSelectionWith(schema.nodes.hard_break.create()).scrollIntoView());
        return true;
    };
}

/** splitListItem в пустом пункте верхнего уровня пасует — поднимаем пункт сами. */
function liftEmptyListItem(): Command {
    const lift = liftListItem(schema.nodes.list_item);
    return (state, dispatch, view) => {
        const { $from, empty } = state.selection;
        if (!empty || $from.depth < 2 || $from.parent.content.size > 0) {
            return false;
        }
        if ($from.node(-1).type !== schema.nodes.list_item) {
            return false;
        }
        return lift(state, dispatch, view);
    };
}

function isInsideList(state: EditorState): boolean {
    const { $from } = state.selection;
    for (let depth = $from.depth; depth > 0; depth -= 1) {
        if ($from.node(depth).type === schema.nodes.list_item) {
            return true;
        }
    }
    return false;
}

function listOrder(node: ProseMirrorNode): number {
    const order: unknown = node.attrs.order;
    return typeof order === 'number' ? order : 1;
}

function numberOf(value: string | undefined, fallback: number): number {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
}

function isComposerInputKey(key: string): boolean {
    return key.length === 1;
}

function isComposerShortcut(event: KeyboardEvent): boolean {
    if (event.key === 'Escape') {
        return true;
    }
    if (!(event.metaKey || event.ctrlKey)) {
        return false;
    }
    return ['b', 'i', 'k', 'Enter'].includes(event.key);
}

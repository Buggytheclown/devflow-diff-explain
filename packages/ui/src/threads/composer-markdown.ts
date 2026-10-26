export type ComposerLayout = 'visual' | 'markdown';
export type ComposerTool = 'bold' | 'italic' | 'link' | 'code' | 'codeblock' | 'list';

/** Заглушки, которыми тулбар заполняет пустое выделение: язык интерфейса, не разметка. */
export interface EditorPlaceholders {
    readonly text: string;
    readonly code: string;
}

export interface MarkdownEdit {
    readonly text: string;
    readonly selectionStart: number;
    readonly selectionEnd: number;
}

/** Применяет команду тулбара к исходному markdown и возвращает новое выделение. */
export function editMarkdown(
    text: string,
    selectionStart: number,
    selectionEnd: number,
    tool: ComposerTool,
    placeholders: EditorPlaceholders,
): MarkdownEdit {
    const selected = text.slice(selectionStart, selectionEnd);
    const replace = (before: string, fallback: string, after = before): MarkdownEdit => {
        const body = selected || fallback;
        const inserted = `${before}${body}${after}`;
        return {
            text: `${text.slice(0, selectionStart)}${inserted}${text.slice(selectionEnd)}`,
            selectionStart: selectionStart + before.length,
            selectionEnd: selectionStart + before.length + body.length,
        };
    };

    switch (tool) {
        case 'bold':
            return replace('**', placeholders.text);
        case 'italic':
            return replace('*', placeholders.text);
        case 'link': {
            const label = selected || placeholders.text;
            const inserted = `[${label}](https://)`;
            return {
                text: `${text.slice(0, selectionStart)}${inserted}${text.slice(selectionEnd)}`,
                selectionStart: selectionStart + label.length + 3,
                selectionEnd: selectionStart + label.length + 11,
            };
        }
        case 'code':
            return replace('`', placeholders.code);
        case 'codeblock': {
            const body = selected || placeholders.code;
            const prefix = selectionStart > 0 && text[selectionStart - 1] !== '\n' ? '\n' : '';
            const suffix = selectionEnd < text.length && text[selectionEnd] !== '\n' ? '\n' : '';
            const inserted = `${prefix}\`\`\`\n${body}\n\`\`\`${suffix}`;
            const bodyStart = selectionStart + prefix.length + 4;
            return {
                text: `${text.slice(0, selectionStart)}${inserted}${text.slice(selectionEnd)}`,
                selectionStart: bodyStart,
                selectionEnd: bodyStart + body.length,
            };
        }
        case 'list': {
            const body = selected || placeholders.text;
            const prefix = selectionStart > 0 && text[selectionStart - 1] !== '\n' ? '\n' : '';
            const suffix = selectionEnd < text.length && text[selectionEnd] !== '\n' ? '\n' : '';
            const listed = body
                .split('\n')
                .map((line) => `- ${line}`)
                .join('\n');
            return {
                text: `${text.slice(0, selectionStart)}${prefix}${listed}${suffix}${text.slice(selectionEnd)}`,
                selectionStart: selectionStart + prefix.length,
                selectionEnd: selectionStart + prefix.length + listed.length,
            };
        }
    }
}

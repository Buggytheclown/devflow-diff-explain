// @vitest-environment jsdom
import { parseBlocks } from '@sherpa/protocol/markdown';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { DiffFileModel } from '../diff/model.js';
import { parseFileDiff } from '../diff/parse.js';
import { MarkdownReview, markdownSegments, markdownTextSelection } from './markdown-review.tsx';
import type { MarkdownReviewProps } from './markdown-review.tsx';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const TEXT = [
    '# Заголовок',
    '',
    'Первые **важные слова** здесь.',
    'Следующее предложение.',
    '',
    '- Пункт',
    '  - Вложенный',
    '',
    '| Имя | Значение |',
    '| --- | --- |',
    '| A | B |',
    '',
    '> Цитата',
    '> Продолжение',
    '',
    '```ts',
    'const x = 1;',
    '```',
].join('\n');

function model(text = TEXT, start = 1): DiffFileModel {
    const lines = text.split('\n');
    return parseFileDiff({
        fileId: 'md',
        path: 'doc.md',
        oldPath: null,
        changeType: 'add',
        binary: false,
        patch: `@@ -0,0 +${String(start)},${String(lines.length)} @@\n${lines.map((line) => '+' + line).join('\n')}`,
    });
}

function html(text = TEXT, start = 1): HTMLElement {
    const root = document.createElement('div');
    root.innerHTML = renderToStaticMarkup(
        <MarkdownReview model={model(text, start)} selection={null} focusedThreadRange={null} />,
    );
    document.body.append(root);
    return root;
}

function select(root: HTMLElement, from: number, to = from) {
    const first = root.querySelector(`[data-source-line="${String(from)}"]`);
    const last = root.querySelector(`[data-source-line="${String(to)}"]`);
    if (first === null || last === null) {
        throw new Error('нет исходной строки');
    }
    const range = document.createRange();
    range.setStart(first, 0);
    range.setEnd(last, last.childNodes.length);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    return markdownTextSelection(root, selection);
}

function mount(props: MarkdownReviewProps): { root: HTMLElement; unmount: () => void } {
    const root = document.createElement('div');
    document.body.append(root);
    const react = createRoot(root);
    act(() => {
        react.render(<MarkdownReview {...props} />);
    });
    return {
        root,
        unmount: () => {
            act(() => {
                react.unmount();
            });
        },
    };
}

afterEach(() => {
    window.getSelection()?.removeAllRanges();
    document.body.replaceChildren();
});

describe('просмотр Markdown с исходными строками', () => {
    it('сохраняет строки абзацев, вложенных списков, таблиц, цитат и кода', () => {
        const root = html();
        for (const line of [1, 3, 4, 6, 7, 9, 11, 13, 14, 17]) {
            expect(select(root, line)).toMatchObject({ start: line, end: line });
        }
        expect(select(root, 3, 4)).toMatchObject({ start: 3, end: 4 });
    });

    it('код с отступом и инлайн-код через перенос не сдвигают строки исходника', () => {
        const root = html('Текст\n\n    const a = 1;\n    const b = 2;\n\nраз `код\nпродолжение` два\nтри', 10);
        expect(select(root, 12)).toEqual({ start: 12, end: 12, text: 'const a = 1;' });
        expect(select(root, 13)).toEqual({ start: 13, end: 13, text: 'const b = 2;' });
        expect(select(root, 17)).toEqual({ start: 17, end: 17, text: 'три' });
        expect(select(root, 15, 16)).toMatchObject({ start: 15, end: 16 });
    });

    it('передаёт выбранные слова без разметки, включая обратное выделение', () => {
        const root = html();
        const node = root.querySelector('strong')?.firstChild;
        if (node === null || node === undefined) {
            throw new Error('нет жирного текста');
        }
        const selection = window.getSelection();
        selection?.setBaseAndExtent(node, 12, node, 2);
        expect(markdownTextSelection(root, selection)).toEqual({ start: 3, end: 3, text: 'жные слова' });
    });

    it('исходные строки учитывают смещение фрагмента и CRLF', () => {
        const root = html('Первая\r\n**Вторая**', 41);
        expect(select(root, 42)).toEqual({ start: 42, end: 42, text: 'Вторая' });
        expect(parseBlocks('```\nbody', 41)[0]?.source).toEqual({ start: 41, end: 42 });
    });

    it('не исполняет HTML и опасные ссылки', () => {
        const root = html('<script>alert(1)</script>\n[опасно](javascript:alert(1))');
        expect(root.querySelector('script, a')).toBeNull();
        expect(root.textContent).toContain('<script>');
    });

    it('не склеивает старую и новую стороны либо фрагменты через пропуск', () => {
        const diff = parseFileDiff({
            fileId: 'md',
            path: 'doc.md',
            oldPath: null,
            changeType: 'modify',
            binary: false,
            patch: '@@ -1,1 +1,1 @@\n-before\n+after\n@@ -10,1 +10,1 @@\n-old tail\n+new tail',
        });
        const oldTexts = markdownSegments(diff, 'old').map((segment) => segment.lines.map((line) => line.text));
        expect(oldTexts).toEqual([['before'], ['old tail']]);
        expect(markdownSegments(diff, 'new').map((segment) => segment.start)).toEqual([1, 10]);
    });

    it('рендерит обсуждения каждой строки один раз, включая пустые и служебные строки Markdown', () => {
        const after = vi.fn(() => null);
        renderToStaticMarkup(
            <MarkdownReview model={model()} selection={null} focusedThreadRange={null} renderAfterLine={after} />,
        );
        expect(after.mock.calls.map((args) => args)).toEqual(TEXT.split('\n').map((_, i) => ['new', i + 1]));
    });

    it('не дублирует комментарии между вложенным и внешним списком', () => {
        const text = '  - Первый\n    1. Вложенный\n1. Второй\n- Третий';
        expect(parseBlocks(text, 11).map((block) => block.source)).toEqual([
            { start: 11, end: 12 },
            { start: 13, end: 13 },
            { start: 14, end: 14 },
        ]);
        const after = vi.fn(() => null);
        renderToStaticMarkup(
            <MarkdownReview model={model(text, 11)} selection={null} focusedThreadRange={null} renderAfterLine={after} />,
        );
        expect(after.mock.calls).toEqual([
            ['new', 11],
            ['new', 12],
            ['new', 13],
            ['new', 14],
        ]);
    });

    it('не превращает выделение текста комментария в вопрос про документ', () => {
        const root = document.createElement('div');
        root.innerHTML =
            '<div class="markdown-review__source"><span data-source-line="1">документ</span></div><p>комментарий</p>';
        document.body.append(root);
        const paragraph = root.querySelector('p');
        if (paragraph === null) {
            throw new Error('нет абзаца');
        }
        const range = document.createRange();
        range.selectNodeContents(paragraph);
        window.getSelection()?.addRange(range);
        expect(markdownTextSelection(root, window.getSelection())).toBeNull();
    });

    it('показывает удалённый документ по старой стороне', () => {
        const diff = parseFileDiff({
            fileId: 'md',
            path: 'doc.md',
            oldPath: null,
            changeType: 'delete',
            binary: false,
            patch: '@@ -1,1 +0,0 @@\n-# Удалённый',
        });
        const view = mount({ model: diff, selection: null, focusedThreadRange: null });
        expect(view.root.querySelector('h1')?.textContent).toBe('Удалённый');
        expect(view.root.querySelector('[data-side="old"]')).not.toBeNull();
        view.unmount();
    });

    it('клик без выделения сбрасывает только выделение своей карточки', () => {
        const click = (root: HTMLElement) => {
            act(() => {
                root.querySelector('.markdown-review')?.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
            });
        };
        const clear = vi.fn();

        const empty = mount({ model: model(), selection: null, focusedThreadRange: null, onClearSelection: clear });
        click(empty.root);
        expect(clear).not.toHaveBeenCalled();
        empty.unmount();

        const own = mount({
            model: model(),
            selection: { fileId: 'md', side: 'new', anchor: 'a3', focus: 'a3' },
            focusedThreadRange: null,
            onClearSelection: clear,
        });
        click(own.root);
        expect(clear).toHaveBeenCalledTimes(1);
        own.unmount();
    });

    it('переключение сторон сбрасывает только выделение своей карточки', () => {
        const diff = parseFileDiff({
            fileId: 'md',
            path: 'doc.md',
            oldPath: null,
            changeType: 'modify',
            binary: false,
            patch: '@@ -1,1 +1,1 @@\n-before\n+after',
        });
        const switchToOld = (root: HTMLElement) => {
            const before = root.querySelector<HTMLButtonElement>('.markdown-review__toolbar button');
            if (before === null) {
                throw new Error('нет кнопки старой стороны');
            }
            act(() => {
                before.click();
            });
            expect(root.querySelector('[data-side="old"]')).not.toBeNull();
        };
        const clear = vi.fn();

        const empty = mount({ model: diff, selection: null, focusedThreadRange: null, onClearSelection: clear });
        switchToOld(empty.root);
        expect(clear).not.toHaveBeenCalled();
        empty.unmount();

        const own = mount({
            model: diff,
            selection: { fileId: 'md', side: 'new', anchor: 'a1', focus: 'a1' },
            focusedThreadRange: null,
            onClearSelection: clear,
        });
        switchToOld(own.root);
        expect(clear).toHaveBeenCalledTimes(1);
        own.unmount();
    });
});

import { parseBlocks } from '@sherpa/protocol/markdown';
import type { ReactNode } from 'react';
import { Fragment, useMemo, useRef, useState } from 'react';

import type { DiffFileModel, DiffLine } from '../diff/model.js';
import { useT } from '../i18n/index.js';
import { renderBlock } from '../markdown/markdown.tsx';
import type { LineRange, LineSelection } from './selection.js';
import { lineKey } from './selection.js';
import './markdown-review.css';

const MAX_SELECTED_TEXT = 4000;

export interface MarkdownSegment {
    readonly start: number;
    readonly lines: readonly DiffLine[];
}

export interface MarkdownReviewProps {
    readonly model: DiffFileModel;
    readonly selection: LineSelection | null;
    readonly focusedThreadRange: LineRange | null;
    readonly onSelect?: ((selection: LineSelection) => void) | undefined;
    readonly onClearSelection?: (() => void) | undefined;
    readonly renderAfterLine?: ((side: 'old' | 'new', line: number) => ReactNode) | undefined;
}

/** Не склеиваем текст через пропуски: иначе соседние фрагменты меняли бы смысл Markdown. */
export function markdownSegments(model: DiffFileModel, side: 'old' | 'new'): readonly MarkdownSegment[] {
    if (model.content.kind !== 'text') {
        return [];
    }
    const segments: { start: number; lines: DiffLine[] }[] = [];
    for (const block of model.content.blocks) {
        if (block.kind !== 'hunk') {
            continue;
        }
        for (const line of block.lines) {
            const number = side === 'old' ? line.oldLine : line.newLine;
            if (number === null) {
                continue;
            }
            const last = segments.at(-1);
            if (last !== undefined && last.start + last.lines.length === number) {
                last.lines.push(line);
            } else {
                segments.push({ start: number, lines: [line] });
            }
        }
    }
    return segments;
}

/** Нативное выделение текста переводится в тот же якорь, который использует режим кода. */
export function markdownTextSelection(
    root: HTMLElement,
    selection: Selection | null,
): { start: number; end: number; text: string } | null {
    if (selection === null || selection.isCollapsed || selection.rangeCount !== 1) {
        return null;
    }
    const range = selection.getRangeAt(0);
    if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) {
        return null;
    }
    const text = selection.toString().trim();
    if (text === '') {
        return null;
    }
    const numbers: number[] = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
        const element = node.parentElement;
        if (!range.intersectsNode(node)) {
            continue;
        }
        if (node === range.startContainer && range.startOffset === (node.textContent?.length ?? 0)) {
            continue;
        }
        if (node === range.endContainer && range.endOffset === 0) {
            continue;
        }
        // Текст обсуждений и панели не должен подмешиваться в цитату документа.
        if (element?.closest('.markdown-review__source') === null) {
            if (node.textContent?.trim() !== '') {
                return null;
            }
            continue;
        }
        const number = Number(element?.closest('[data-source-line]')?.getAttribute('data-source-line'));
        if (Number.isInteger(number) && number > 0) {
            numbers.push(number);
        }
    }
    return numbers.length === 0 ? null : { start: Math.min(...numbers), end: Math.max(...numbers), text };
}

export function MarkdownReview({
    model,
    selection,
    focusedThreadRange,
    onSelect,
    onClearSelection,
    renderAfterLine,
}: MarkdownReviewProps) {
    const t = useT();
    const root = useRef<HTMLDivElement>(null);
    const [side, setSide] = useState<'old' | 'new'>(model.changeType === 'delete' ? 'old' : 'new');
    const [tooLong, setTooLong] = useState(false);
    const segments = useMemo(() => markdownSegments(model, side), [model, side]);
    const parsed = useMemo(
        () =>
            segments.map((segment) => ({
                segment,
                blocks: parseBlocks(segment.lines.map((line) => line.text).join('\n'), segment.start),
            })),
        [segments],
    );
    const partial = model.content.kind === 'text' && model.content.blocks.some((block) => block.kind === 'gap');

    const capture = () => {
        if (root.current === null) {
            return;
        }
        const selected = markdownTextSelection(root.current, window.getSelection());
        if (selected === null) {
            setTooLong(false);
            // `selection` уже отфильтрован по файлу: клик мимо текста не трогает выделение в других карточках.
            if (selection !== null) {
                onClearSelection?.();
            }
            return;
        }
        if (selected.text.length > MAX_SELECTED_TEXT) {
            setTooLong(true);
            onClearSelection?.();
            return;
        }
        setTooLong(false);
        const lines = segments.flatMap((segment) => segment.lines);
        const at = (number: number) => lines.find((line) => (side === 'old' ? line.oldLine : line.newLine) === number);
        const first = at(selected.start);
        const last = at(selected.end);
        const anchor = first === undefined ? null : lineKey(first);
        const focus = last === undefined ? null : lineKey(last);
        if (anchor !== null && focus !== null) {
            onSelect?.({ fileId: model.fileId, side, anchor, focus, selectedText: selected.text });
        }
    };
    const switchSide = (next: 'old' | 'new') => {
        if (selection !== null) {
            onClearSelection?.();
        }
        setSide(next);
        setTooLong(false);
    };
    const extras = (start: number, end: number) =>
        Array.from({ length: Math.max(0, end - start + 1) }, (_, i) => (
            <Fragment key={start + i}>{renderAfterLine?.(side, start + i)}</Fragment>
        ));

    return (
        <div className="markdown-review" ref={root} onMouseUp={capture}>
            <div className="markdown-review__toolbar ctl-tabs" role="group" aria-label={t('markdown.preview')}>
                {model.changeType === 'add' ? null : (
                    <button
                        type="button"
                        className={`ctl ctl--tab${side === 'old' ? ' is-active' : ''}`}
                        aria-pressed={side === 'old'}
                        onClick={() => {
                            switchSide('old');
                        }}
                    >
                        {t('markdown.before')}
                    </button>
                )}
                {model.changeType === 'delete' ? null : (
                    <button
                        type="button"
                        className={`ctl ctl--tab${side === 'new' ? ' is-active' : ''}`}
                        aria-pressed={side === 'new'}
                        onClick={() => {
                            switchSide('new');
                        }}
                    >
                        {t('markdown.after')}
                    </button>
                )}
            </div>
            {partial ? <p className="file-card__notice">{t('markdown.fragment')}</p> : null}
            {tooLong ? (
                <p role="status" className="file-card__notice">
                    {t('markdown.tooLong')}
                </p>
            ) : null}
            {segments.length === 0 ? <p className="file-card__notice">{t('markdown.empty')}</p> : null}
            {parsed.map(({ segment, blocks }) => {
                let previousEnd = segment.start - 1;
                return (
                    <section className="markdown-review__segment" key={segment.start}>
                        {blocks.map((block, index) => {
                            const start = block.source?.start ?? segment.start;
                            const end = block.source?.end ?? start;
                            const before = extras(previousEnd + 1, start - 1);
                            previousEnd = end;
                            const lines = segment.lines.slice(start - segment.start, end - segment.start + 1);
                            const active =
                                selection?.side === side &&
                                lines.some(
                                    (line) => lineKey(line) === selection.anchor || lineKey(line) === selection.focus,
                                );
                            const focused =
                                focusedThreadRange?.side === side &&
                                focusedThreadRange.line <= end &&
                                focusedThreadRange.line + focusedThreadRange.size > start;
                            const className =
                                'markdown-review__block' +
                                (active ? ' is-selected' : '') +
                                (focused ? ' is-thread-focused' : '');
                            return (
                                <Fragment key={index}>
                                    {before}
                                    <div className={className}>
                                        {lines.map((line) => (
                                            <span
                                                key={lineKey(line)}
                                                data-key={lineKey(line)}
                                                data-side={side}
                                                className="markdown-review__anchor"
                                            />
                                        ))}
                                        <div className="markdown-review__source">{renderBlock(block, index)}</div>
                                    </div>
                                    {extras(start, end)}
                                </Fragment>
                            );
                        })}
                        {extras(previousEnd + 1, segment.start + segment.lines.length - 1)}
                    </section>
                );
            })}
        </div>
    );
}

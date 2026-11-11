import type { CodeLocation, FileDiff, GuidedAnnotation, UiChatAskAnchor } from '@sherpa/protocol';
import type { ReactNode } from 'react';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

import { parseExplanationBlocks } from '@sherpa/protocol/markdown';
import { renderBlock } from '../markdown/markdown.tsx';
import { downloadFileOriginal, fetchBlob, fetchFileContent } from '../api.js';
import type { DiffFileModel } from '../diff/model.js';
import { DiffRows } from '../diff-view/diff-rows.tsx';
import { expandFileContext } from '../diff-view/expand.js';
import { ImageBody } from '../diff-view/image-card.tsx';
import { lineKey, lineKeyNumbers } from '../diff-view/selection.js';
import { useLocale } from '../i18n/index.js';
import { storyCopy } from '../i18n/story.js';
import type { StoryData } from './data.js';
import { selectedCode, withCodeQuote } from './selected-code.js';
import { useLineRange } from './line-range.js';
import { FileGlyph } from './file-glyph.js';

const changeMarks = { add: 'A', modify: 'M', delete: 'D', move: 'R', copy: 'C', conflict: '!' } as const;

export function ReadFile({ file, diffId, data, token, originals = false, navigation, anchor = null, onSelect, onLayout, onMediaLayout, annotations = [], onAttach, description }: {
    onAttach?: (() => void) | undefined; description?: ReactNode;
    file: FileDiff; diffId: string; data: StoryData; token: string;
    originals?: boolean;
    annotations?: readonly GuidedAnnotation[] | undefined;
    navigation?: CodeLocation | undefined; anchor?: UiChatAskAnchor | null; onSelect: (anchor: UiChatAskAnchor, text: string | null) => void; onLayout: () => void; onMediaLayout?: (() => void) | undefined;
}) {
    const t = storyCopy[useLocale()];
    const [saved, setSaved] = useState(() => ({ diffId, fileId: file.fileId, model: data.file(diffId, file.fileId).model }));
    const model = saved.diffId === diffId && saved.fileId === file.fileId ? saved.model : data.file(diffId, file.fileId).model;
    const selected = data.file(diffId, file.fileId).highlight ?? (anchor?.diffId === diffId && anchor.fileId === file.fileId ? anchor : null);
    const ranges = useLineRange(selected);
    const [failure, setFailure] = useState<{ diffId: string; fileId: string; message: string; retry: 'read' | 'expand' | null } | null>(null);
    const error = failure?.diffId === diffId && failure.fileId === file.fileId ? failure : null;
    const request = useRef(0);
    useLayoutEffect(() => () => { request.current += 1; }, [data, diffId, file.fileId]);
    const [attempt, setAttempt] = useState(0);
    const loadBlob = useCallback((id: string) => fetchBlob(token, id), [token]);
    const mounted = useRef(false);
    useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
    const layout = useRef(onLayout); useLayoutEffect(() => { layout.current = onLayout; });
    const selection = model === null || selected === null ? null : selectionForRange(model, selected);
    const publish = useCallback((next: DiffFileModel, id: number): boolean => {
        if (!mounted.current || request.current !== id) return false;
        layout.current();
        data.updateFile(diffId, file.fileId, { model: next });
        setSaved({ diffId, fileId: file.fileId, model: next });
        setFailure(null);
        return true;
    }, [data, diffId, file.fileId]);
    const expand = useCallback(async (): Promise<void> => {
        const id = ++request.current;
        try {
            const base = await (data.file(diffId, file.fileId).model ?? data.parse(diffId, file));
            if (!publish(base, id)) return;
            const content = await fetchFileContent(token, file.fileId, diffId);
            if (content === null && base.content.kind === 'text' && base.content.blocks.some((block) => block.kind === 'gap')) throw new Error(t.unavailable);
            publish(expandFileContext(base, content), id);
        } catch (reason) {
            if (mounted.current && request.current === id) {
                layout.current(); setFailure({ diffId, fileId: file.fileId, message: String(reason), retry: 'expand' });
            }
        }
    }, [data, diffId, file, publish, token, t.unavailable]);
    useEffect(() => {
        const id = ++request.current;
        void (async () => {
            try {
                const base = await (data.file(diffId, file.fileId).model ?? data.parse(diffId, file));
                if (!publish(base, id)) return;
                if (navigation !== undefined && selectionForRange(base, navigation) === null) {
                    if (base.content.kind !== 'text') throw new Error(t.unavailable);
                    const content = await fetchFileContent(token, file.fileId, diffId);
                    const next = expandFileContext(base, content);
                    if (selectionForRange(next, navigation) === null) throw new Error(t.unavailable);
                    publish(next, id);
                }
            } catch (reason) {
                if (mounted.current && request.current === id) {
                    layout.current(); setFailure({ diffId, fileId: file.fileId, message: String(reason), retry: 'read' });
                }
            }
        })();
        return () => { request.current += 1; };
    }, [data, diffId, file, navigation, token, attempt, t.unavailable, publish]);
    const select = (range: Pick<CodeLocation, 'side' | 'start' | 'end'>): void => {
        const next = { diffId, fileId: file.fileId, path: range.side === 'old' ? file.oldPath ?? file.path : file.path, ...range };
        const text = model === null ? null : selectedCode(model, next);
        data.updateFile(diffId, file.fileId, { highlight: null });
        onSelect(withCodeQuote(next, text), text);
    };
    const selectLine = (target: EventTarget, extend: boolean): boolean => {
        const element = target instanceof Element ? target : null;
        const numbers = lineKeyNumbers(element?.closest<HTMLElement>('[data-key]')?.dataset.key ?? '');
        if (numbers === null) return false;
        const oldGutter = element?.closest('.diff-row__gutter:not(.diff-row__gutter--code)') != null;
        const newGutter = element?.closest('.diff-row__gutter--code') != null;
        const side = numbers.new === null || (numbers.old !== null && (oldGutter || (!newGutter && extend && selected?.side === 'old'))) ? 'old' : 'new';
        const line = numbers[side];
        if (line === null) return false;
        select(ranges.choose(side, line, extend));
        return true;
    };
    const directory = file.path.slice(0, Math.max(0, file.path.lastIndexOf('/') + 1));
    return <div className="story-code file-card" data-change={file.changeType} onLoadCapture={onMediaLayout} data-reading="file" data-reading-file={file.fileId} data-file-path={file.path} data-file-old-path={file.oldPath ?? file.path}>
        <header tabIndex={-1} data-reading-focus={`file:${file.fileId}`}><span className="story-file-status" data-change={file.changeType} title={t.changeTypes[file.changeType]} aria-label={t.changeTypes[file.changeType]}>{changeMarks[file.changeType]}</span><FileGlyph /><code title={file.path}><span className="story-file-directory"><bdi>{file.oldPath != null && file.oldPath !== file.path ? `${file.oldPath} → ` : ''}{directory}</bdi></span><span className="story-file-basename">{file.path.split('/').at(-1)}</span></code><span className="story-file-stats"><span className="story-file-added">+{file.additions}</span><span className="story-file-deleted">−{file.deletions}</span></span>
            {onAttach === undefined ? null : <button className="ctl" onClick={onAttach}>{t.attachFile}</button>}
            {originals ? (['old', 'new'] as const).filter((side) => file.changeType !== (side === 'old' ? 'add' : 'delete')).map((side) => <button className="ctl" key={side} title={`${t.downloadOriginal}: ${side === 'old' ? t.before : t.after}`} onClick={() => {
                const id = request.current;
                void downloadFileOriginal(token, diffId, file.fileId, side, (side === 'old' ? file.oldPath ?? file.path : file.path).split('/').at(-1) ?? 'file').catch((reason: unknown) => { if (mounted.current && request.current === id) setFailure({ diffId, fileId: file.fileId, message: String(reason), retry: null }); });
            }}>↓ {side === 'old' ? t.before : t.after}</button>) : null}
            {!file.binary ? <button className="ctl ctl--toolbar-icon story-file-expand" aria-label={t.expand} title={t.expand} onClick={() => { void expand(); }}><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5" /></svg></button> : null}
        </header>
        {description === undefined ? null : <div className="story-file-description">{description}</div>}
        {error === null ? null : <p role="alert">{error.message} {error.retry === null ? null : <button className="ctl" onClick={() => { if (error.retry === 'expand') void expand(); else setAttempt((n) => n + 1); }}>{t.retrySource}</button>}</p>}
        <div onMouseDownCapture={(event) => {
            if (event.button !== 0 || !event.shiftKey || !selectLine(event.target, true)) return;
            // До focus: иначе фокус новой строки перезапишет первую границу диапазона.
            event.preventDefault();
            window.getSelection()?.removeAllRanges();
        }} onClick={(event) => {
            // Клик по уже сфокусированной строке тоже начинает новое выделение.
            if (event.button === 0 && !event.shiftKey && window.getSelection()?.isCollapsed !== false) selectLine(event.target, false);
        }} onMouseUp={(event) => {
            if (event.shiftKey) return;
            const selection = window.getSelection();
            if (selection === null || selection.isCollapsed) return;
            const element = (node: Node | null): HTMLElement | null => (node instanceof Element ? node : node?.parentElement)?.closest<HTMLElement>('[data-key]') ?? null;
            const first = lineKeyNumbers(element(selection.anchorNode)?.dataset.key ?? '');
            const last = lineKeyNumbers(element(selection.focusNode)?.dataset.key ?? '');
            if (first?.new != null && last?.new != null) select(ranges.fromText('new', first.new, last.new));
            else if (first?.old != null && last?.old != null) select(ranges.fromText('old', first.old, last.old));
        }}>
            {file.image != null ? <ImageBody file={file} image={file.image} loadBlob={loadBlob} /> : model === null ? error === null ? <p data-reading-wait>{t.loading}</p> : null
                : model.content.kind !== 'text' ? <p>{t.noPatch}</p> : <DiffRows showHunkHeaders model={model} mode="unified" selection={selection} renderAfterLine={(side, line) => annotations.filter((note) => note.side === side && note.end === line).map((note, index) => <aside className="story-inline-note" key={index} data-reading={`note:${side}:${String(line)}:${String(index)}`}><span>{side === 'old' ? '−' : '+'} {note.start}–{note.end}</span>{parseExplanationBlocks(note.text).map((part, i) => renderBlock(part, i))}</aside>)} onLineFocus={(side, line) => { select(ranges.choose(side, line)); }} />}
        </div>
    </div>;
}

export function selectionForRange(model: DiffFileModel, range: CodeLocation) {
    if (model.content.kind !== 'text') return null;
    const lines = model.content.blocks.flatMap((block) => block.kind === 'hunk' ? block.lines : [])
        .filter((line) => { const n = range.side === 'old' ? line.oldLine : line.newLine; return n !== null && n >= range.start && n <= range.end; });
    if (lines.length !== range.end - range.start + 1) return null;
    const first = lines[0]; const last = lines.at(-1);
    const anchor = first === undefined ? null : lineKey(first);
    const focus = last === undefined ? null : lineKey(last);
    return anchor === null || focus === null ? null : { fileId: model.fileId, side: range.side, anchor, focus };
}

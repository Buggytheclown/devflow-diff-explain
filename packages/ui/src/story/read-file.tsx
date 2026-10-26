import type { CodeLocation, FileDiff, GuidedAnnotation, UiChatAskAnchor } from '@sherpa/protocol';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

import { parseStopBlocks } from '@sherpa/protocol/markdown';
import { renderBlock } from '../markdown/markdown.tsx';
import { fetchBlob, fetchFileContent } from '../api.js';
import type { DiffFileModel } from '../diff/model.js';
import { DiffRows } from '../diff-view/diff-rows.tsx';
import { expandAllGaps, expandFileContext } from '../diff-view/expand.js';
import { ImageBody } from '../diff-view/image-card.tsx';
import { lineKey, lineKeyNumbers } from '../diff-view/selection.js';
import { useLocale } from '../i18n/index.js';
import { storyCopy } from '../i18n/story.js';
import type { StoryData } from './data.js';
import { SelectionBar } from './selection-bar.tsx';

export function ReadFile({ file, diffId, data, token, current, navigation, onAsk, onLayout, onMediaLayout, annotations = [] }: {
    file: FileDiff; diffId: string; data: StoryData; token: string; current: boolean;
    annotations?: readonly GuidedAnnotation[] | undefined;
    navigation?: CodeLocation | undefined; onAsk: (anchor: UiChatAskAnchor) => void; onLayout: () => void; onMediaLayout?: (() => void) | undefined;
}) {
    const t = storyCopy[useLocale()];
    const [model, setModel] = useState(() => data.file(diffId, file.fileId).model);
    const [selected, setSelected] = useState(() => data.file(diffId, file.fileId).selected);
    const [error, setError] = useState<string | null>(null);
    const [attempt, setAttempt] = useState(0);
    const loadBlob = useCallback((id: string) => fetchBlob(token, id), [token]);
    const mounted = useRef(false);
    useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
    const layout = useRef(onLayout); useLayoutEffect(() => { layout.current = onLayout; });
    const selection = model === null || selected === null ? null : selectionForRange(model, selected);
    useEffect(() => {
        let alive = true;
        const cached = data.file(diffId, file.fileId).model;
        void (cached === null ? data.parse(diffId, file) : Promise.resolve(cached)).then(async (value) => {
            let next = value;
            if (navigation !== undefined && selectionForRange(next, navigation) === null) {
                if (!current || next.content.kind !== 'text') throw new Error(t.unavailable);
                const content = await fetchFileContent(token, file.fileId, diffId);
                next = expandFileContext(next, content, expandAllGaps(next, new Map()));
                if (selectionForRange(next, navigation) === null) throw new Error(t.unavailable);
            }
            data.updateFile(diffId, file.fileId, { model: next });
            if (!alive) return;
            layout.current(); setModel(next); setError(null);
        }, (reason: unknown) => { throw reason; }).catch((reason: unknown) => {
            if (alive) { layout.current(); setError(String(reason)); }
        });
        return () => { alive = false; };
    }, [data, diffId, file, current, navigation, token, attempt, t.unavailable]);
    const pick = (range: UiChatAskAnchor | null): void => { data.updateFile(diffId, file.fileId, { selected: range }); layout.current(); setSelected(range); };
    const select = (side: 'old' | 'new', start: number, end = start): void => {
        pick({ diffId, fileId: file.fileId, path: side === 'old' ? file.oldPath ?? file.path : file.path, side, start, end });
    };
    return <div className="story-code file-card" onLoadCapture={onMediaLayout} data-reading="file">
        {selected === null ? null : <SelectionBar selected={selected} onAsk={() => { onAsk(selected); }} onClear={() => { pick(null); }} />}
        <header><code>{file.oldPath != null && file.oldPath !== file.path ? `${file.oldPath} → ` : ''}{file.path}</code><span className="story-file-stats"><span className="story-file-added">+{file.additions}</span> / <span className="story-file-deleted">−{file.deletions}</span></span>
            {current ? <button className="ctl" onClick={() => {
                void fetchFileContent(token, file.fileId, diffId).then((content) => {
                    const base = data.file(diffId, file.fileId).model;
                    if (base === null) return;
                    const expanded = expandFileContext(base, content, expandAllGaps(base, new Map()));
                    data.updateFile(diffId, file.fileId, { model: expanded });
                    if (mounted.current) { layout.current(); setModel(expanded); setError(null); }
                }, (reason: unknown) => { if (mounted.current) { layout.current(); setError(String(reason)); } });
            }}>{t.expand}</button> : null}
        </header>
        {error === null ? null : <p role="alert">{error} <button className="ctl" onClick={() => { setAttempt((n) => n + 1); }}>{t.retrySource}</button></p>}
        <div onMouseUp={() => {
            const selection = window.getSelection();
            if (selection === null || selection.isCollapsed) return;
            const element = (node: Node | null): HTMLElement | null => (node instanceof Element ? node : node?.parentElement)?.closest<HTMLElement>('[data-key]') ?? null;
            const first = lineKeyNumbers(element(selection.anchorNode)?.dataset.key ?? '');
            const last = lineKeyNumbers(element(selection.focusNode)?.dataset.key ?? '');
            if (first?.new != null && last?.new != null) select('new', Math.min(first.new, last.new), Math.max(first.new, last.new));
            else if (first?.old != null && last?.old != null) select('old', Math.min(first.old, last.old), Math.max(first.old, last.old));
        }}>
            {file.image != null ? <ImageBody file={file} image={file.image} loadBlob={loadBlob} /> : model === null ? error === null ? <p data-reading-wait>{t.loading}</p> : null
                : model.content.kind !== 'text' ? <p>{t.noPatch}</p> : <DiffRows model={model} mode="unified" content={null} selection={selection} contextAvailable={false} renderAfterLine={(side, line) => annotations.filter((note) => note.side === side && note.end === line).map((note, index) => <aside className="story-inline-note" key={index} data-reading={`note:${side}:${String(line)}:${String(index)}`}><span>{side === 'old' ? '−' : '+'} {note.start}–{note.end}</span>{parseStopBlocks(note.text).map((part, i) => renderBlock(part, i))}</aside>)} onLineFocus={(side, line) => { select(side, line); }} />}
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

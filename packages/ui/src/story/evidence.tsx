import type { CodeLocation, FileDiff, StoryEvidenceBlock, StorySource, UiChatAskAnchor } from '@sherpa/protocol';
import { useCallback, useEffect, useLayoutEffect, useId, useRef, useState } from 'react';

import { fetchBlob } from '../api.js';
import type { DiffFileModel, DiffLine } from '../diff/model.js';
import { ImageBody } from '../diff-view/image-card.tsx';
import { lineSegments } from '../diff-view/line-segments.js';
import { useLocale } from '../i18n/index.js';
import { storyCopy } from '../i18n/story.js';
import { StopMarkdown } from '../markdown/markdown.tsx';
import type { StoryData } from './data.js';
import { SelectionBar } from './selection-bar.tsx';

export function evidenceLines(model: DiffFileModel, source: Extract<StorySource, { kind: 'lines' }>): DiffLine[] | null {
    if (model.content.kind !== 'text') return null;
    const lines = model.content.blocks.flatMap((block) => block.kind === 'hunk' ? block.lines : []).filter((line) => {
        const n = source.side === 'old' ? line.oldLine : line.newLine;
        return n !== null && n >= source.start && n <= source.end;
    });
    return lines.length === source.end - source.start + 1 ? lines : null;
}

export function EvidenceDisclosure({ evidence, open, onToggle, children, legacy = false, focusId }: {
    evidence?: StoryEvidenceBlock | undefined; open: boolean; onToggle: () => void; children?: React.ReactNode; legacy?: boolean; focusId?: string;
}) {
    const t = storyCopy[useLocale()];
    const id = useId();
    const root = useRef<HTMLDivElement | null>(null);
    const button = useRef<HTMLButtonElement | null>(null);
    const hasSources = legacy || evidence?.claims.some((claim) => claim.sources.length > 0);
    if (!hasSources) return <div className="story-evidence-limit">{evidence?.claims.map((claim, index) => <p key={index}>{claim.limitation}</p>)}</div>;
    return <div className="story-evidence" ref={root}>
        <button className="ctl story-evidence-toggle" ref={button} aria-controls={id} aria-expanded={open} data-reading-focus={focusId} onClick={() => {
            if (open && root.current?.contains(document.activeElement)) button.current?.focus({ preventScroll: true });
            onToggle();
        }}>{legacy ? (open ? t.hideFragments : t.fragments) : open ? t.hideChange : t.showChange}</button>
        {open ? <div id={id} className="story-evidence-body">{children}</div> : null}
    </div>;
}

export function EvidenceSource({ source, diffId, data, token, focusId, onOpen, onAsk, onLayout, onMediaLayout }: {
    source: StorySource; diffId: string; data: StoryData; token: string; focusId: string;
    onOpen: (fileId: string, location?: CodeLocation) => void; onAsk: (anchor: UiChatAskAnchor) => void; onLayout: () => void; onMediaLayout?: (() => void) | undefined;
}) {
    const t = storyCopy[useLocale()];
    const [loaded, setLoaded] = useState<{ file: FileDiff; model: DiffFileModel } | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [attempt, setAttempt] = useState(0);
    const [selected, setSelected] = useState<UiChatAskAnchor | null>(null);
    const loadBlob = useCallback((id: string) => fetchBlob(token, id), [token]);
    const layout = useRef(onLayout); useLayoutEffect(() => { layout.current = onLayout; });
    useEffect(() => {
        let alive = true;
        void data.diff(diffId).then(async (diff) => {
            if (!alive) return null;
            const file = diff.files.find((entry) => entry.fileId === source.fileId);
            if (file === undefined) throw new Error(t.unavailable);
            return { file, model: await data.parse(diffId, file) };
        }).then((value) => {
            if (!alive || value === null) return;
            if (source.kind === 'lines' && evidenceLines(value.model, source) === null) throw new Error(t.unavailable);
            setLoaded(value); setError(null); layout.current();
        }).catch((reason: unknown) => { if (alive) { setError(String(reason)); layout.current(); } });
        return () => { alive = false; };
    }, [data, diffId, source, attempt, t.unavailable]);
    const lines = loaded === null || source.kind !== 'lines' ? null : evidenceLines(loaded.model, source);
    return <div className="story-code story-source" onLoadCapture={onMediaLayout} data-source-side={source.kind === 'lines' ? source.side : 'file'}>
        <header><code>{source.path}{source.kind === 'lines' ? ` · ${source.side === 'old' ? t.before : t.after} · ${String(source.start)}–${String(source.end)}` : ''}</code>
            <button className="ctl" data-reading-focus={focusId} onClick={() => { onOpen(source.fileId, source.kind === 'lines' ? source : undefined); }}>{t.open} ↗</button>
        </header>
        {error !== null ? <p role="alert">{error} <button className="ctl" onClick={() => { setError(null); setAttempt((n) => n + 1); }}>{t.retrySource}</button></p>
            : loaded === null ? <p data-reading-wait>{t.loadingSource}</p> : source.kind === 'file' ? <>
                <p>{loaded.file.oldPath === null ? '' : `${loaded.file.oldPath} → `}{loaded.file.path} · {t.changeTypes[loaded.file.changeType]} · +{loaded.file.additions} / −{loaded.file.deletions}
                    {loaded.model.modeChange === null ? '' : ` · ${loaded.model.modeChange.from} → ${loaded.model.modeChange.to}`}{loaded.file.binary ? ` · ${t.binary}` : ''}</p>
                {loaded.file.image === null ? null : <ImageBody key={attempt} file={loaded.file} image={loaded.file.image} loadBlob={loadBlob} />}
            </> : lines === null ? <p role="alert">{t.unavailable}</p> : <>
                {selected === null ? null : <SelectionBar selected={selected} onAsk={() => { onAsk(selected); }} onClear={() => { setSelected(null); }} />}
                <div className="story-source-lines" onMouseUp={() => {
                    const selection = window.getSelection();
                    if (selection === null || selection.isCollapsed) return;
                    const number = (node: Node | null): number => Number((node instanceof Element ? node : node?.parentElement)?.closest<HTMLElement>('[data-source-line]')?.dataset.sourceLine);
                    const first = number(selection.anchorNode); const last = number(selection.focusNode);
                    if (first > 0 && last > 0) setSelected({ ...source, diffId, start: Math.min(first, last), end: Math.max(first, last) });
                }}>{lines.map((line) => {
                    const number = (source.side === 'old' ? line.oldLine : line.newLine) ?? 0;
                    return <div className={`story-source-line story-source-line--${line.kind}${selected !== null && number >= selected.start && number <= selected.end ? ' is-selected' : ''}`} key={number} data-source-line={number} data-reading={`${focusId}:line:${String(number)}`}>
                        <button className="ctl story-source-number" aria-label={`${source.side === 'old' ? t.before : t.after} ${String(number)}`} onClick={(event) => {
                            const start = event.shiftKey && selected !== null ? selected.start : number;
                            setSelected({ ...source, diffId, start: Math.min(start, number), end: Math.max(start, number) });
                        }}>{number}</button>
                        <code>{lineSegments(line).map((segment, index) => <span key={index} className={segment.kind === null ? undefined : `syntax-${segment.kind}`}>{segment.text}</span>)}</code>
                    </div>;
                })}</div>
            </>}
    </div>;
}

export function EvidenceClaims({ evidence, renderSource }: { evidence: StoryEvidenceBlock; renderSource: (source: StorySource, index: number) => React.ReactNode }) {
    let sourceIndex = 0;
    return <>{evidence.claims.map((claim, index) => <div className="story-claim" key={index}>
        <blockquote className="md-blocks"><StopMarkdown text={claim.quote} /></blockquote>
        {claim.limitation === null ? null : <p className="story-evidence-limit">{claim.limitation}</p>}
        {claim.sources.map((source) => renderSource(source, sourceIndex++))}
    </div>)}</>;
}

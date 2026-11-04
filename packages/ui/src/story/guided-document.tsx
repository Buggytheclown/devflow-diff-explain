import { useState, type ReactNode } from 'react';
import type { FlowCitation, RouteSnapshot, StoryEvidenceBlock, StorySource } from '@sherpa/protocol';
import { parseExplanationBlocks } from '@sherpa/protocol/markdown';
import { useLocale } from '../i18n/index.js';
import { renderBlock } from '../markdown/markdown.tsx';
import { StoryDocument } from './story-document.tsx';
import { FlowDiagram, ExplanationExample } from './flow-diagram.tsx';
import { guidedCopy } from '../i18n/story.js';
import { Skeleton } from './preparation.tsx';
import { numberedBlockTitle } from './block-title.js';
import { EvidenceClaims, EvidenceDisclosure } from './evidence.tsx';

function GuidedEvidence({ evidence, sectionId, renderSource, expanded, onToggle }: { evidence?: StoryEvidenceBlock | undefined; sectionId: string; renderSource?: ((source: StorySource, sectionId: string, index: number) => ReactNode) | undefined; expanded?: ReadonlySet<string> | undefined; onToggle?: ((sectionId: string) => void) | undefined }) {
    const [localOpen, setLocalOpen] = useState(false);
    if (evidence === undefined) return null;
    return <EvidenceDisclosure evidence={evidence} open={onToggle === undefined ? localOpen : expanded?.has(sectionId) ?? false} onToggle={() => { if (onToggle === undefined) setLocalOpen((value) => !value); else onToggle(sectionId); }} focusId={`disclosure:${sectionId}`}>
        <EvidenceClaims evidence={evidence} renderSource={(source, index) => renderSource?.(source, sectionId, index)} />
    </EvidenceDisclosure>;
}

export function GuidedDocument({ snapshot, page, onVisit, onAsk, renderFile, renderDescription, renderSource, renderDiagramSource, expanded, onToggle, onRetry, onBack, returnLabel, onRetryDiagram, connected, onDiagramFailure, activeBlock, onLayout }: {
    activeBlock?: string | undefined; snapshot: RouteSnapshot; page: string; onVisit: (page: string, remember?: boolean) => void; onAsk: (sectionId: string) => void;
    onBack?: (() => void) | undefined; returnLabel?: string | undefined;
    renderFile: (fileId: string, description: ReactNode) => ReactNode; renderDescription?: ReactNode; onRetry?: (id: string) => void;
    onRetryDiagram?: (() => void) | undefined; connected?: boolean | undefined;
    onDiagramFailure?: ((report: { viewIndex: number; missingId?: string; reason: string }) => void) | undefined; onLayout?: (() => void) | undefined;
    renderSource?: ((source: StorySource, sectionId: string, index: number) => ReactNode) | undefined;
    renderDiagramSource?: ((source: FlowCitation, index: number) => ReactNode) | undefined;
    expanded?: ReadonlySet<string> | undefined; onToggle?: ((sectionId: string) => void) | undefined;
}) {
    const t = guidedCopy[useLocale()];
    const blocks = snapshot.tourOrder.flatMap((id) => snapshot.stops.filter((stop) => stop.id === id));
    const text = (value: string, key: string) => <div className="md-blocks">{parseExplanationBlocks(value).map((part, i) => <div key={i} data-reading={`${key}:${String(i)}`}>{renderBlock(part, i)}</div>)}</div>;
    return <article className="story-guided" data-guided-page="canvas" data-active-page={page}>
        {onBack === undefined ? null : <button className="ctl story-return" onClick={onBack}>← {returnLabel}</button>}
        <div className="story-overview"><div className="story-overview-content"><h2>{t.description}</h2>{renderDescription ?? <StoryDocument snapshot={{ ...snapshot, stops: [], tourOrder: [] }} onAsk={(id) => { onAsk(id ?? 'intro'); }} {...(renderSource === undefined ? {} : { renderSource })} />}
            <FlowDiagram onLayout={onLayout} flow={snapshot.flow} onRetry={onRetryDiagram} onRenderFailure={onDiagramFailure} renderDiagramSource={renderDiagramSource} connected={connected} blocks={blocks} activeBlock={activeBlock} onVisit={onVisit} /></div>
            </div>
            <div className="story-continuous">{blocks.map((block, index) => <section key={block.id} className="story-continuous-block" data-guide-block={block.id}>
                <h2 data-guide-page={block.id} data-reading={`block:${block.id}`} tabIndex={-1} data-reading-focus={`block:${block.id}`}>{numberedBlockTitle(block.title, index)}</h2>
                {block.paragraph === null ? <Skeleton label={t.pending} /> : text(block.paragraph, block.id)}<GuidedEvidence evidence={block.storyEvidence} sectionId={block.id} renderSource={renderSource} expanded={expanded} onToggle={onToggle} /><ExplanationExample example={block.example} renderSource={(source, i) => renderSource?.(source, `example:${block.id}`, i)} />
                {block.status === 'failed' ? <p className="story-notice" role="alert">{t.failed}{onRetry === undefined ? null : <button className="ctl" onClick={() => { onRetry(block.id); }}>{t.retry}</button>}</p> : null}
                {block.guidedFiles?.map((file) => <div key={file.fileId} className="story-guided-file" data-guide-page={`file:${file.fileId}`}>
                    {renderFile(file.fileId, <>{file.explanation === null ? file.status === 'failed' ? <p role="alert">{file.failure ?? t.failed}</p> : <Skeleton label={t.pending} /> : text(file.explanation, 'description')}{file.failure != null && (file.explanation !== null || file.status !== 'failed') ? <p role="alert">{file.failure}</p> : null}<ExplanationExample example={file.example} renderSource={(source, i) => renderSource?.(source, `example:file:${file.fileId}`, i)} /></>)}
                </div>)}
                {(block.relatedFiles?.length ?? 0) === 0 ? null : <div className="story-related"><p>{t.related}</p>{block.relatedFiles?.map((entry) => <button className="ctl" key={entry.fileId} data-reading-focus={`related:${entry.fileId}`} onClick={() => { onVisit(`file:${entry.fileId}`, true); }}>{entry.path} ↗</button>)}</div>}
            </section>)}</div>
    </article>;
}

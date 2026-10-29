import type { ReactNode } from 'react';
import type { RouteSnapshot } from '@sherpa/protocol';
import { parseStopBlocks } from '@sherpa/protocol/markdown';
import { useLocale } from '../i18n/index.js';
import { renderBlock } from '../markdown/markdown.tsx';
import { StoryDocument } from './story-document.tsx';
import { FlowDiagram, ExplanationExample } from './flow-diagram.tsx';
import { guidedCopy } from '../i18n/story.js';
import { Skeleton } from './preparation.tsx';
import { numberedBlockTitle } from './block-title.js';

export function GuidedDocument({ snapshot, page, onVisit, onAsk, renderFile, renderDescription, onRetry, onBack, returnLabel, onRetryDiagram, connected, onDiagramFailure, activeBlock, onLayout }: {
    activeBlock?: string | undefined; snapshot: RouteSnapshot; page: string; onVisit: (page: string, remember?: boolean) => void; onAsk: (sectionId: string) => void;
    onBack?: (() => void) | undefined; returnLabel?: string | undefined;
    renderFile: (fileId: string, description: ReactNode) => ReactNode; renderDescription?: ReactNode; onRetry?: (id: string) => void;
    onRetryDiagram?: (() => void) | undefined; connected?: boolean | undefined;
    onDiagramFailure?: (() => void) | undefined; onLayout?: (() => void) | undefined;
}) {
    const t = guidedCopy[useLocale()];
    const blocks = snapshot.tourOrder.flatMap((id) => snapshot.stops.filter((stop) => stop.id === id));
    const text = (value: string, key: string) => <div className="md-blocks">{parseStopBlocks(value).map((part, i) => <div key={i} data-reading={`${key}:${String(i)}`}>{renderBlock(part, i)}</div>)}</div>;
    return <article className="story-guided" data-guided-page="canvas" data-active-page={page}>
        {onBack === undefined ? null : <button className="ctl story-return" onClick={onBack}>← {returnLabel}</button>}
        <div className="story-overview"><div className="story-overview-content"><h2>{t.description}</h2>{renderDescription ?? <StoryDocument snapshot={{ ...snapshot, stops: [], tourOrder: [] }} onAsk={(id) => { onAsk(id ?? 'intro'); }} hideSources />}
            <FlowDiagram onLayout={onLayout} flow={snapshot.flow} onRetry={onRetryDiagram} onRenderFailure={onDiagramFailure} connected={connected} blocks={blocks} activeBlock={activeBlock} onVisit={onVisit} /></div>
            </div>
            <div className="story-continuous">{blocks.map((block, index) => <section key={block.id} className="story-continuous-block" data-guide-block={block.id}>
                <h2 data-guide-page={block.id} data-reading={`block:${block.id}`} tabIndex={-1} data-reading-focus={`block:${block.id}`}>{numberedBlockTitle(block.title, index)}</h2>
                {block.paragraph === null ? <Skeleton label={t.pending} /> : text(block.paragraph, block.id)}<ExplanationExample example={block.example} />
                {block.status === 'failed' ? <p className="story-notice" role="alert">{t.failed}{onRetry === undefined ? null : <button className="ctl" onClick={() => { onRetry(block.id); }}>{t.retry}</button>}</p> : null}
                {block.guidedFiles?.map((file) => <div key={file.fileId} className="story-guided-file" data-guide-page={`file:${file.fileId}`}>
                    {renderFile(file.fileId, <>{file.explanation === null ? file.status === 'failed' ? <p role="alert">{file.failure ?? t.failed}</p> : <Skeleton label={t.pending} /> : text(file.explanation, 'description')}<ExplanationExample example={file.example} /></>)}
                </div>)}
                {(block.relatedFiles?.length ?? 0) === 0 ? null : <div className="story-related"><p>{t.related}</p>{block.relatedFiles?.map((entry) => <button className="ctl" key={entry.fileId} data-reading-focus={`related:${entry.fileId}`} onClick={() => { onVisit(`file:${entry.fileId}`, true); }}>{entry.path} ↗</button>)}</div>}
            </section>)}</div>
    </article>;
}

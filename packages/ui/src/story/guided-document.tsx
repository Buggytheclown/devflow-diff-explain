import type { ReactNode } from 'react';
import { useState } from 'react';
import type { RouteSnapshot } from '@sherpa/protocol';
import { parseStopBlocks } from '@sherpa/protocol/markdown';
import { useLocale } from '../i18n/index.js';
import { renderBlock } from '../markdown/markdown.tsx';
import { StoryDocument } from './story-document.tsx';
import { FlowDiagram, ExplanationExample } from './flow-diagram.tsx';
import { guidedCopy } from '../i18n/story.js';
import { Skeleton } from './preparation.tsx';

export function GuidedDocument({ snapshot, page, onVisit, onAsk, renderFile, renderDescription, onRetry, onBack, returnLabel, onRetryDiagram, connected, onDiagramFailure, onAttachFile }: {
    onAttachFile?: ((fileId: string) => void) | undefined;
    snapshot: RouteSnapshot; page: string; onVisit: (page: string, remember?: boolean) => void; onAsk: (sectionId: string) => void;
    onBack?: (() => void) | undefined; returnLabel?: string | undefined;
    renderFile: (fileId: string) => ReactNode; renderDescription?: ReactNode; onRetry?: (id: string) => void;
    onRetryDiagram?: (() => void) | undefined; connected?: boolean | undefined;
    onDiagramFailure?: (() => void) | undefined;
}) {
    const t = guidedCopy[useLocale()];
    const [activeBlock, setActiveBlock] = useState<string>();
    const blocks = snapshot.tourOrder.flatMap((id) => snapshot.stops.filter((stop) => stop.id === id));
    const block = blocks.find((stop) => stop.id === page || stop.guidedFiles?.some((file) => `file:${file.fileId}` === page));
    const file = block?.guidedFiles?.find((entry) => `file:${entry.fileId}` === page);
    const sequence = ['intro', ...blocks.flatMap((stop) => [stop.id, ...(stop.guidedFiles ?? []).map((entry) => `file:${entry.fileId}`)])];
    const index = sequence.indexOf(page);
    const nextPage = sequence[index + 1];
    const nextTitle = blocks.find((stop) => stop.id === nextPage)?.title
        ?? blocks.flatMap((stop) => stop.guidedFiles ?? []).find((entry) => `file:${entry.fileId}` === nextPage)?.path;
    const text = (value: string, key: string) => <div className="md-blocks">{parseStopBlocks(value).map((part, i) => <div key={i} data-reading={`${key}:${String(i)}`}>{renderBlock(part, i)}</div>)}</div>;
    return <article className="story-guided" data-guided-page={page}>
        {onBack === undefined ? null : <button className="ctl story-return" onClick={onBack}>← {returnLabel}</button>}
        {page === 'intro' || block === undefined ? <div className="story-overview"><div className="story-overview-content"><h2>{t.description}</h2>{renderDescription ?? <StoryDocument snapshot={{ ...snapshot, stops: [], tourOrder: [] }} onAsk={(id) => { onAsk(id ?? 'intro'); }} />}
            <FlowDiagram flow={snapshot.flow} onRetry={onRetryDiagram} onRenderFailure={onDiagramFailure} connected={connected} blocks={blocks} activeBlock={activeBlock} onVisit={onVisit} /></div>
            <aside className="story-overview-route" aria-label={t.route}><h3>{t.route}</h3><ol className="story-block-list" data-reading={`block-list:${page}`}>{blocks.map((stop, i) => <li key={stop.id} onMouseEnter={() => { setActiveBlock(stop.id); }} onMouseLeave={() => { setActiveBlock(undefined); }}><button className="ctl" onFocus={() => { setActiveBlock(stop.id); }} onBlur={() => { setActiveBlock(undefined); }} onClick={() => { onVisit(stop.id); }}><small aria-hidden="true">{i + 1}.</small>{stop.title}</button><span>{stop.guidedFiles?.length ?? 0}</span></li>)}</ol></aside></div>
            : <><nav className="story-breadcrumb" aria-label={t.block}><button className="ctl" onClick={() => { onVisit('intro'); }}>{t.description}</button><span> / </span><button className="ctl" onClick={() => { onVisit(block.id); }}>{block.title}</button></nav>
                <h2 data-reading="heading" tabIndex={-1} data-reading-focus="guide-heading">{file?.path ?? block.title}</h2>
                {file === undefined ? <>{block.paragraph === null ? <Skeleton label={t.pending} /> : text(block.paragraph, block.id)}<ExplanationExample example={block.example} />
                    <h3 className="story-file-list-title">{t.readingOrder}</h3>
                    <ol className="story-block-list story-file-list" data-reading={`block-list:${page}`}>{block.guidedFiles?.map((entry) => <li key={entry.fileId}>
                        <header><button className="ctl" title={t.openFile} data-reading-focus={`file-link:${entry.fileId}`} onClick={() => { onVisit(`file:${entry.fileId}`); }}>{entry.path}</button><span aria-hidden="true">↗</span>{onAttachFile === undefined ? null : <button className="ctl" onClick={() => { onAttachFile(entry.fileId); }}>{t.attachFile}</button>}</header>
                        {entry.explanation === null ? entry.status === 'failed' ? <p>{entry.failure ?? t.failed}</p> : <Skeleton label={t.pending} /> : text(entry.explanation, `preview:${entry.fileId}`)}
                    </li>)}</ol>
                    {(block.relatedFiles?.length ?? 0) === 0 ? null : <div className="story-related"><p>{t.related}</p>{block.relatedFiles?.map((entry) => <button className="ctl" key={entry.fileId} data-reading-focus={`related:${entry.fileId}`} onClick={() => { onVisit(`file:${entry.fileId}`, true); }}>{entry.path} ↗</button>)}</div>}
                </> : <>{file.explanation === null ? file.status === 'failed' ? <p role="alert">{file.failure ?? t.failed}</p> : <Skeleton label={t.pending} /> : text(file.explanation, `file:${file.fileId}`)}<ExplanationExample example={file.example} />
</>}
                {block.status === 'ready' ? null : <p className="story-notice" role={block.status === 'failed' ? 'alert' : 'status'}>{block.status === 'failed' ? t.failed : t.pending}{block.status === 'failed' && onRetry !== undefined ? <button className="ctl" onClick={() => { onRetry(block.id); }}>{t.retry}</button> : null}</p>}
                {file === undefined ? null : renderFile(file.fileId)}
            </>}
        <nav className="story-guide-pager" aria-label={t.next}>
            {index <= 0 ? <span /> : <button className="ctl" data-reading-focus="previous" onClick={() => { onVisit(sequence[index - 1] ?? 'intro'); }}>← {t.previous}</button>}
            {index < 0 || nextPage === undefined ? null : <div className="story-guide-next"><span>{t.nextStep}<strong>{nextTitle}</strong></span><button className="ctl ctl--primary" data-reading-focus="next" onClick={() => { onVisit(nextPage); }}>{index === 0 ? t.start : t.next} →</button></div>}
        </nav>
    </article>;
}

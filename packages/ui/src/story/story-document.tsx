import type { RouteAnchor, RouteSnapshot, StoryEvidenceBlock, StorySource } from '@sherpa/protocol';
import { parseStopBlocks } from '@sherpa/protocol/markdown';
import { useState } from 'react';

import { useLocale } from '../i18n/index.js';
import { preparationCopy } from '../i18n/story.js';
import { renderBlock } from '../markdown/markdown.tsx';
import { EvidenceClaims, EvidenceDisclosure } from './evidence.tsx';

export function StoryDocument({ snapshot, onAsk: _onAsk, renderSource, expanded, onToggle, onOpenSource }: {
    snapshot: RouteSnapshot; onAsk: (sectionId?: string) => void;
    renderSource?: (source: StorySource, sectionId: string, index: number) => React.ReactNode;
    expanded?: ReadonlySet<string> | undefined; onToggle?: (sectionId: string) => void;
    onOpenSource?: ((source: StorySource) => void) | undefined;
}) {
    const locale = useLocale();
    const pt = preparationCopy[locale];
    const [local, setLocal] = useState(new Set<string>());
    const toggle = (id: string): void => { if (onToggle !== undefined) onToggle(id); else setLocal((value) => { const next = new Set(value); if (!next.delete(id)) next.add(id); return next; }); };
    const section = (id: string, text: string, evidence: StoryEvidenceBlock | undefined, anchors: readonly RouteAnchor[], title?: string) => {
        const legacy = evidence === undefined && anchors.length > 0;
        return <section id={`section-${id}`} key={id} data-story-section={id}>
            {title === undefined ? null : <h2>{title}</h2>}
            <div className="md-blocks">{parseStopBlocks(text).map((block, index) => <div key={index} data-reading={`${id}:${String(index)}`} tabIndex={id === 'intro' && index === 0 ? -1 : undefined} data-reading-focus={id === 'intro' && index === 0 ? 'intro' : undefined}>{renderBlock(block, index)}</div>)}</div>
            {onOpenSource !== undefined ? <p className="story-source-hint">{pt.sourcesHint}</p> : null}
            {onOpenSource !== undefined && evidence !== undefined ? <details className="story-source-links" open={(expanded ?? local).has(id)}><summary onClick={(event) => { event.preventDefault(); toggle(id); }}>{pt.overviewSources}</summary>{evidence.claims.map((claim, i) => <div key={i}>{claim.limitation === null ? null : <p>{claim.limitation}</p>}{claim.sources.map((source, j) => <button className="ctl" key={j} onClick={() => { onOpenSource(source); }}>{source.path}{source.kind === 'lines' ? ` · ${source.side === 'old' ? '−' : '+'}${String(source.start)}–${String(source.end)}` : ''} ↗</button>)}</div>)}</details> : <EvidenceDisclosure evidence={evidence} open={(expanded ?? local).has(id)} onToggle={() => { toggle(id); }} legacy={legacy} focusId={`disclosure:${id}`}>
                {evidence === undefined ? anchors.map((anchor, index) => renderSource?.({ ...anchor, kind: 'lines' }, id, index)) : <EvidenceClaims evidence={evidence} renderSource={(source, index) => renderSource?.(source, id, index)} />}
            </EvidenceDisclosure>}
        </section>;
    };
    return <article className="story-document">
        {section('intro', snapshot.summary, snapshot.summaryEvidence, [])}
        {snapshot.tourOrder.map((id) => {
            const stop = snapshot.stops.find((entry) => entry.id === id);
            return stop?.paragraph == null ? null : section(id, stop.paragraph, stop.storyEvidence, stop.anchors, stop.title);
        })}
    </article>;
}

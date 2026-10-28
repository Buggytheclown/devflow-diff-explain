import { Fragment, useId } from 'react';
import type { FlowState, ReadableExample, ExplanationBlock } from '@sherpa/protocol';
import { useLocale } from '../i18n/index.js';
import { parseStopBlocks } from '@sherpa/protocol/markdown';
import { renderBlock } from '../markdown/markdown.tsx';

import { flowCopy, preparationCopy } from '../i18n/story.js';
import { Skeleton } from './preparation.tsx';
import { ArchitectureDiagram } from './architecture-diagram.tsx';


export function ExplanationExample({ example }: { example: ReadableExample | null | undefined }) {
    const t = flowCopy[useLocale()];
    if (example == null) return null;
    return <aside className="story-example" data-reading="example"><strong title={t.illustrative}>{t.example}</strong>
        <div className="md-blocks">{parseStopBlocks(example.text).map((part, i) => renderBlock(part, i))}</div>
        <details><summary>{t.exampleSources}</summary>{example.evidence.claims.map((claim, i) => <p key={i}>{claim.quote}{claim.limitation === null ? '' : ` — ${claim.limitation}`}{claim.sources.map((source, j) => <code key={j}>{source.path}{source.kind === 'lines' ? `:${String(source.start)}–${String(source.end)}` : ''}</code>)}</p>)}</details>
    </aside>;
}

/** Связанные переходы объединены в цепочку; длинный путь продолжается следующей строкой. */
export function FlowDiagram({ flow, onRetry, connected = false, blocks, activeBlock, onVisit, onRenderFailure }: { flow: FlowState | undefined; onRetry?: (() => void) | undefined; connected?: boolean | undefined;
    onRenderFailure?: (() => void) | undefined;
    blocks?: readonly Pick<ExplanationBlock, 'id' | 'title' | 'nodeIds'>[] | undefined; activeBlock?: string | undefined; onVisit?: ((id: string) => void) | undefined }) {
    const locale = useLocale();
    const t = flowCopy[locale];
    const pt = preparationCopy[locale];
    const id = useId();
    if (flow === undefined) return null;
    if (flow.status === 'pending') return <div data-reading="flow-pending"><Skeleton diagram label={t.pending} /></div>;
    if (flow.status === 'not_applicable') return <p className="story-notice">{pt.diagramNotNeeded}{flow.reason}</p>;
    if (flow.status === 'unavailable') return <div className="story-notice" data-reading="flow-unavailable"><p>{flow.reason}</p>{onRetry === undefined ? null : <><button className="ctl" disabled={!connected} onClick={onRetry}>{pt.retryDiagram}</button>{connected ? null : <small>{pt.connectToRetry}</small>}</>}</div>;
    const { diagram, contexts } = flow;
    const rows: (typeof diagram.edges)[] = [];
    for (const edge of diagram.edges) {
        const row = rows.at(-1);
        if (row !== undefined && row.length < 2 && row.at(-1)?.to === edge.from) row.push(edge);
        else rows.push([edge]);
    }
    const shown = new Set<string>();
    const node = (nodeId: string) => {
        const entry = diagram.nodes.find((item) => item.id === nodeId);
        if (entry === undefined) return null;
        if (shown.has(nodeId)) return <div className={`story-flow-reference story-flow--${entry.change}`}><span aria-hidden="true">↳ </span><span className="visually-hidden">{t.continued}: </span>{entry.label}</div>;
        shown.add(nodeId);
        return <div className={`story-flow-node story-flow--${entry.change}`}><span className="story-flow-status">{t[entry.change]}</span><strong>{entry.label}</strong></div>;
    };
    return <section className="story-flow" aria-labelledby={id} data-reading="flow">
        <h3 id={id}>{diagram.title}</h3>
        <ul className="story-flow-legend" aria-label={t.title}>{(['existing', 'added', 'modified', ...('mermaid' in diagram ? ['affected' as const] : []), 'unknown'] as const).map((change) => <li className={`story-flow--${change}`} key={change}>{t[change]}</li>)}</ul>
        {[...diagram.nodes, ...diagram.edges].some((entry) => entry.change === 'unknown' || entry.limitation !== null) ? <p className="story-flow-limit">{pt.diagramLimited}</p> : null}
        {'mermaid' in diagram ? <ArchitectureDiagram diagram={diagram} blocks={blocks} activeBlock={activeBlock} onVisit={onVisit} onRetry={onRetry} onRenderFailure={onRenderFailure} connected={connected} /> : <><div className="story-flow-graph" role="list">{rows.map((row, i) => <div className={`story-flow-edge${row.length === 2 ? ' story-flow-edge--chain' : ''}`} role="listitem" key={i}>
            {node(row[0]?.from ?? '')}{row.map((edge, j) => <Fragment key={j}><div className={`story-flow-arrow story-flow--${edge.change}`}><span>{edge.label}</span><span className="story-flow-line" aria-hidden="true">→</span><small>{t[edge.kind]} · {t[edge.change]}</small></div>{node(edge.to)}</Fragment>)}
        </div>)}</div>
        {diagram.nodes.filter((entry) => !diagram.edges.some((edge) => edge.from === entry.id || edge.to === entry.id)).map((entry) => <div key={entry.id}>{node(entry.id)}</div>)}</>}
        <details className="story-flow-sources"><summary>{t.sources}</summary>{[...diagram.nodes, ...diagram.edges].map((item, i) => <div key={i}><strong>{item.label}</strong>{item.limitation === null ? null : <p>{item.limitation}</p>}{item.sources.map((source, j) => {
            const context = source.kind === 'context' ? contexts.find((entry) => entry.id === source.id) : undefined;
            return <div key={j}>{source.kind === 'patch' ? <code>{source.path} · {source.side === 'old' ? '−' : '+'}{String(source.start)}–{String(source.end)}</code> : context === undefined ? null : <><code>{context.path}:{String(context.start)}–{String(context.end)} @ {context.revision}</code><pre>{context.text}</pre></>}</div>;
        })}</div>)}</details>
    </section>;
}

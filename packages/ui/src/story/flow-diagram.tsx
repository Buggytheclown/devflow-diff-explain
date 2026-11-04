import { Fragment, useId } from 'react';
import type { ReactNode } from 'react';
import type { FlowState, ReadableExample, ExplanationBlock, StorySource, FlowCitation } from '@sherpa/protocol';
import { useLocale } from '../i18n/index.js';
import { parseExplanationBlocks } from '@sherpa/protocol/markdown';
import { renderBlock } from '../markdown/markdown.tsx';

import { flowCopy, preparationCopy } from '../i18n/story.js';
import { Skeleton } from './preparation.tsx';
import { ArchitectureDiagram } from './architecture-diagram.tsx';


export function ExplanationExample({ example, renderSource }: { example: ReadableExample | null | undefined; renderSource?: ((source: StorySource, index: number) => ReactNode) | undefined }) {
    const t = flowCopy[useLocale()];
    if (example == null) return null;
    return <aside className="story-example" data-reading="example"><strong title={t.illustrative}>{t.example}</strong>
        <div className="md-blocks">{parseExplanationBlocks(example.text).map((part, i) => renderBlock(part, i))}</div>
        {example.evidence.claims.filter((claim) => claim.limitation !== null).map((claim, i) => <p className="story-flow-limit" key={i}>{claim.limitation}</p>)}
        <details><summary>{t.exampleSources}</summary>{example.evidence.claims.map((claim, i) => <p key={i}>{claim.quote}{claim.limitation === null ? '' : ` — ${claim.limitation}`}{claim.sources.map((source, j) => renderSource?.(source, j) ?? <code key={j}>{source.path}{source.kind === 'lines' ? `:${String(source.start)}–${String(source.end)}` : ''}</code>)}</p>)}</details>
    </aside>;
}

/** Связанные переходы объединены в цепочку; длинный путь продолжается следующей строкой. */
export function FlowDiagram({ flow, onRetry, connected = false, blocks, activeBlock, onVisit, onRenderFailure, onLayout, renderDiagramSource }: { flow: FlowState | undefined; onRetry?: (() => void) | undefined; connected?: boolean | undefined;
    onRenderFailure?: ((report: { viewIndex: number; missingId?: string; reason: string }) => void) | undefined; onLayout?: (() => void) | undefined;
    renderDiagramSource?: ((source: FlowCitation, index: number) => ReactNode) | undefined;
    blocks?: readonly Pick<ExplanationBlock, 'id' | 'title' | 'nodeIds'>[] | undefined; activeBlock?: string | undefined; onVisit?: ((id: string) => void) | undefined }) {
    const locale = useLocale();
    const t = flowCopy[locale];
    const pt = preparationCopy[locale];
    const id = useId();
    if (flow === undefined) return null;
    if (flow.status === 'pending') return <div data-reading="flow-pending"><Skeleton diagram label={t.pending} /></div>;
    if (flow.status === 'not_applicable') return <p className="story-notice">{pt.diagramNotNeeded}{flow.reason}</p>;
    if (flow.status === 'unavailable') return <div className="story-notice" data-reading="flow-unavailable"><p>{flow.reason}</p>{onRetry === undefined ? null : <><button className="ctl" disabled={!connected} onClick={onRetry}>{pt.retryDiagram}</button>{connected ? null : <small>{pt.connectToRetry}</small>}</>}</div>;
    const { diagram } = flow;
    const rows: { from: string; to: string; label: string; kind: 'data' | 'control'; change: 'existing' | 'added' | 'modified' | 'unknown'; sources: FlowCitation[]; limitation: string | null }[][] = [];
    for (const edge of 'mermaid' in diagram ? [] : diagram.edges) {
        const row = rows.at(-1);
        if (row !== undefined && row.length < 2 && row.at(-1)?.to === edge.from) row.push(edge);
        else rows.push([edge]);
    }
    const shown = new Set<string>();
    const evidence = (entry: { sources: readonly FlowCitation[]; limitation: string | null }) => <>{entry.limitation === null ? null : <small>{entry.limitation}</small>}
        {entry.sources.map((source, index) => <span key={index}>{renderDiagramSource?.(source, index) ?? (source.kind === 'patch'
            ? `${source.path}:${String(source.start)}–${String(source.end)}`
            : flow.contexts.find((context) => context.id === source.id)?.text ?? `Context ${source.id}`)}</span>)}</>;
    const node = (nodeId: string) => {
        const entry = diagram.nodes.find((item) => item.id === nodeId);
        if (entry === undefined) return null;
        if (shown.has(nodeId)) return <div className={`story-flow-reference story-flow--${entry.change}`}><span aria-hidden="true">↳ </span><span className="visually-hidden">{t.continued}: </span>{entry.label}</div>;
        shown.add(nodeId);
        return <div className={`story-flow-node story-flow--${entry.change}`}><span className="story-flow-status">{t[entry.change]}</span><strong>{entry.label}</strong>{evidence(entry)}</div>;
    };
    return <section className="story-flow" aria-labelledby={id} data-reading="flow">
        <h3 id={id}>{diagram.title}</h3>
        <ul className="story-flow-legend" aria-label={t.title}>{'mermaid' in diagram ? <li className="story-flow--context">{t.context}</li> : null}{(['existing', 'added', 'modified', ...('mermaid' in diagram ? ['affected' as const] : []), 'unknown'] as const).map((change) => <li className={`story-flow--${change}`} key={change}>{t[change]}</li>)}</ul>
        {[...diagram.nodes, ...diagram.edges].some((entry) => entry.change === 'unknown' || entry.limitation !== null) ? <p className="story-flow-limit">{pt.diagramLimited}</p> : null}
        {'mermaid' in diagram ? <ArchitectureDiagram onLayout={onLayout} diagram={diagram} blocks={blocks} activeBlock={activeBlock} onVisit={onVisit} onRetry={onRetry} onRenderFailure={onRenderFailure} renderDiagramSource={renderDiagramSource} connected={connected} /> : <><div className="story-flow-graph" role="list">{rows.map((row, i) => <div className={`story-flow-edge${row.length === 2 ? ' story-flow-edge--chain' : ''}`} role="listitem" key={i}>
            {node(row[0]?.from ?? '')}{row.map((edge, j) => <Fragment key={j}><div className={`story-flow-arrow story-flow--${edge.change}`}><span>{edge.label}</span><span className="story-flow-line" aria-hidden="true">→</span><small>{t[edge.kind]} · {t[edge.change]}</small>{evidence(edge)}</div>{node(edge.to)}</Fragment>)}
        </div>)}</div>
        {diagram.nodes.filter((entry) => !diagram.edges.some((edge) => edge.from === entry.id || edge.to === entry.id)).map((entry) => <div key={entry.id}>{node(entry.id)}</div>)}</>}

    </section>;
}

import { Fragment, useId } from 'react';
import type { FlowState, ReadableExample } from '@sherpa/protocol';
import { useLocale } from '../i18n/index.js';
import { parseStopBlocks } from '@sherpa/protocol/markdown';
import { renderBlock } from '../markdown/markdown.tsx';

import { flowCopy } from '../i18n/story.js';


export function ExplanationExample({ example }: { example: ReadableExample | null | undefined }) {
    const t = flowCopy[useLocale()];
    if (example == null) return null;
    return <aside className="story-example" data-reading="example"><strong title={t.illustrative}>{t.example}</strong>
        <div className="md-blocks">{parseStopBlocks(example.text).map((part, i) => renderBlock(part, i))}</div>
        <details><summary>{t.exampleSources}</summary>{example.evidence.claims.map((claim, i) => <p key={i}>{claim.quote}{claim.limitation === null ? '' : ` — ${claim.limitation}`}{claim.sources.map((source, j) => <code key={j}>{source.path}{source.kind === 'lines' ? `:${String(source.start)}–${String(source.end)}` : ''}</code>)}</p>)}</details>
    </aside>;
}

/** Связанные переходы объединены в цепочку; длинный путь продолжается следующей строкой. */
export function FlowDiagram({ flow }: { flow: FlowState | undefined }) {
    const t = flowCopy[useLocale()];
    const id = useId();
    if (flow === undefined) return null;
    if (flow.status === 'pending') return <p className="story-notice" role="status" data-reading="flow-pending">{t.pending}</p>;
    if (flow.status === 'unavailable') return <p className="story-notice" data-reading="flow-unavailable">{flow.reason}</p>;
    const { diagram, contexts } = flow;
    const rows: (typeof diagram.edges)[] = [];
    for (const edge of diagram.edges) {
        const row = rows.at(-1);
        if (row !== undefined && row.length < 2 && row.at(-1)?.to === edge.from) row.push(edge);
        else rows.push([edge]);
    }
    const node = (nodeId: string) => {
        const entry = diagram.nodes.find((item) => item.id === nodeId);
        return entry === undefined ? null : <div className={`story-flow-node story-flow--${entry.change}`}><span className="story-flow-status">{t[entry.change]}</span><strong>{entry.label}</strong>{entry.limitation === null ? null : <small>{entry.limitation}</small>}</div>;
    };
    return <section className="story-flow" aria-labelledby={id} data-reading="flow">
        <h3 id={id}>{diagram.title}</h3>
        <ul className="story-flow-legend" aria-label={t.title}>{(['existing', 'added', 'modified', 'unknown'] as const).map((change) => <li className={`story-flow--${change}`} key={change}>{t[change]}</li>)}</ul>
        <div className="story-flow-graph" role="list">{rows.map((row, i) => <div className={`story-flow-edge${row.length === 2 ? ' story-flow-edge--chain' : ''}`} role="listitem" key={i}>
            {node(row[0]?.from ?? '')}{row.map((edge, j) => <Fragment key={j}><div className={`story-flow-arrow story-flow--${edge.change}`}><span>{edge.label}</span><span className="story-flow-line" aria-hidden="true">→</span><small>{t[edge.kind]} · {t[edge.change]}</small>{edge.limitation === null ? null : <small>{edge.limitation}</small>}</div>{node(edge.to)}</Fragment>)}
        </div>)}</div>
        {diagram.nodes.filter((entry) => !diagram.edges.some((edge) => edge.from === entry.id || edge.to === entry.id)).map((entry) => <div key={entry.id}>{node(entry.id)}</div>)}
        <details className="story-flow-sources"><summary>{t.sources}</summary>{[...diagram.nodes, ...diagram.edges].map((item, i) => <div key={i}><strong>{item.label}</strong>{item.limitation === null ? null : <p>{item.limitation}</p>}{item.sources.map((source, j) => {
            const context = source.kind === 'context' ? contexts.find((entry) => entry.id === source.id) : undefined;
            return <div key={j}>{source.kind === 'patch' ? <code>{source.path} · {source.side === 'old' ? '−' : '+'}{String(source.start)}–{String(source.end)}</code> : context === undefined ? null : <><code>{context.path}:{String(context.start)}–{String(context.end)} @ {context.revision}</code><pre>{context.text}</pre></>}</div>;
        })}</div>)}</details>
    </section>;
}

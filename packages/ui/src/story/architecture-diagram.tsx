import { useEffect, useId, useRef, useState } from 'react';
import type { ArchitectureDiagram as Diagram, ExplanationBlock, FlowCitation } from '@sherpa/protocol';
import type { ReactNode } from 'react';
import { useLocale } from '../i18n/index.js';
import { flowCopy } from '../i18n/story.js';
import { Skeleton } from './preparation.tsx';

/** Mermaid сохраняет топологию графа; интерактивность связываем с проверенными ID сами. */
export function ArchitectureDiagram(props: Parameters<typeof ArchitectureView>[0]) {
    const diagram = props.diagram;
    const views = [{ title: diagram.title, mermaid: diagram.mermaid }, ...(diagram.views ?? [])];
    return <>{views.map((view, index) => {
        return <section key={index} aria-label={view.title}>
            {views.length > 1 ? <h3>{view.title}</h3> : null}
            <ArchitectureView {...props} viewIndex={index} diagram={{ ...diagram, ...view }} />
        </section>;
    })}</>;
}

function ArchitectureView({ diagram, viewIndex, blocks = [], activeBlock, onVisit, onRetry, connected, onRenderFailure, onLayout, renderDiagramSource }: {
    diagram: Diagram; blocks?: readonly Pick<ExplanationBlock, 'id' | 'title' | 'nodeIds'>[] | undefined;
    viewIndex?: number | undefined;
    activeBlock?: string | undefined; onVisit?: ((id: string) => void) | undefined;
    onRetry?: (() => void) | undefined; connected: boolean;
    onRenderFailure?: ((report: { viewIndex: number; missingId?: string; reason: string }) => void) | undefined; onLayout?: (() => void) | undefined;
    renderDiagramSource?: ((source: FlowCitation, index: number) => ReactNode) | undefined;
}) {
    const t = flowCopy[useLocale()];
    const root = useRef<HTMLDivElement>(null);
    const id = `architecture-${useId().replace(/[^a-zA-Z0-9]/g, '')}`;
    const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
    const [nodes, setNodes] = useState(diagram.nodes);
    const [selected, setSelected] = useState<string | null>(null);
    const [selectedEdge, setSelectedEdge] = useState<string | null>(null);
    const [rendered, setRendered] = useState(0);
    const [direction, setDirection] = useState<'TB' | 'LR'>('TB');
    const content = JSON.stringify(diagram);
    const layout = useRef(onLayout);
    useEffect(() => { layout.current = onLayout; }, [onLayout]);
    const failure = useRef(onRenderFailure);
    useEffect(() => { failure.current = onRenderFailure; }, [onRenderFailure]);
    useEffect(() => {
        const element = root.current;
        if (element === null) return;
        element.replaceChildren();
        setStatus('loading');
        const diagram = JSON.parse(content) as Diagram;
        let revision = 0;
        let closed = false;
        const draw = () => {
            const requested = ++revision;
            void renderArchitecture(id, diagram, element, direction).then((svg) => {
                if (closed || requested !== revision) return;
                const focused = element.contains(document.activeElement) ? document.activeElement?.getAttribute('data-architecture-node') : null;
                layout.current?.();
                element.replaceChildren(svg);
                const targets = new Map<string, SVGGElement>();
                // Mermaid добавляет render ID к DOM-id групп; смысловой ID остаётся из исходной схемы.
                const groupId = (target: SVGGElement) => target.getAttribute('data-id') ??
                    (target.id.startsWith(`${id}-`) ? target.id.slice(id.length + 1) : target.id);
                const groups = [...element.querySelectorAll<SVGGElement>('g.cluster')].filter((target) =>
                    diagram.nodes.some((node) => node.id === groupId(target)));
                const renderedNodes = [...element.querySelectorAll<SVGGElement>('g.node'), ...groups].map((target) => {
                    const group = target.classList.contains('cluster');
                    const id = target.getAttribute('data-id') ?? (group ? groupId(target) : /(?:^|-)flowchart-(.+)-[0-9]+$/.exec(target.id)?.[1]);
                    if (id === undefined || id === '') throw new Error('Missing Mermaid node ID');
                    targets.set(id, target);
                    const metadata = diagram.nodes.find((node) => node.id === id);
                    const label = (target.querySelector(group ? '.cluster-label' : '.nodeLabel')?.textContent ?? target.querySelector('text')?.textContent ?? id).trim();
                    return { ...(metadata ?? { id, change: 'existing' as const, sources: [], limitation: null }), label };
                });
                setNodes(renderedNodes);
                for (const node of renderedNodes) {
                    const target = targets.get(node.id);
                    if (target === undefined) throw new Error('Missing diagram node');
                    target.dataset.architectureNode = node.id;
                    target.dataset.readingFocus = `architecture-node:${node.id}`;
                    target.classList.add(`architecture-node--${diagram.nodes.some((entry) => entry.id === node.id) ? node.change : 'context'}`);
                    // Inline !important сильнее правил с ID, которые Mermaid создаёт из classDef.
                    // Цвет задаётся токенами приложения, а не оформлением, выбранным моделью.
                    paint(target, { opacity: '1' });
                    for (const shape of target.querySelectorAll<SVGElement>('rect, polygon, circle, ellipse, path, line')) {
                        if (shape.closest('g.node, g.cluster') !== target) continue;
                        paint(shape, { fill: 'var(--architecture-node-fill)', stroke: 'var(--architecture-highlight, var(--architecture-node-stroke))',
                            'stroke-width': 'var(--architecture-highlight-width, 2px)', 'stroke-dasharray': 'var(--architecture-node-dash, none)', 'fill-opacity': '1', 'stroke-opacity': '1' });
                    }
                    target.setAttribute('role', 'button'); target.setAttribute('tabindex', '0');
                    target.setAttribute('aria-label', `${node.label} · ${diagram.nodes.some((entry) => entry.id === node.id) ? t[node.change] : t.context}`);
                    const select = () => { setSelected(node.id); setSelectedEdge(null); };
                    target.addEventListener('click', (event) => { event.stopPropagation(); select(); });
                    target.addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); event.stopPropagation(); select(); } });
                    if (node.id === focused) target.focus({ preventScroll: true });
                }
                const visibleEdges = new Set<string>();
                for (const target of element.querySelectorAll<SVGElement>('.flowchart-link[id]')) {
                    const edge = diagram.edges.find((entry) => 'id' in entry && (entry.id === target.id || `${id}-${entry.id}` === target.id) && (entry.viewIndex === undefined || entry.viewIndex === viewIndex));
                    if (edge === undefined || !('id' in edge)) continue;
                    visibleEdges.add(edge.id);
                    target.classList.add(`architecture-edge--${edge.change}`);
                    paint(target, { stroke: 'var(--architecture-edge-stroke, var(--text-link-muted))', 'stroke-width': 'var(--architecture-edge-width, 2px)' });
                    target.setAttribute('role', 'button'); target.setAttribute('tabindex', '0');
                    target.setAttribute('aria-label', `${target.id} · ${t[edge.change]}`);
                    target.addEventListener('click', (event) => { event.stopPropagation(); setSelected(null); setSelectedEdge(edge.id); });
                    target.addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setSelected(null); setSelectedEdge(edge.id); } });
                }
                for (const edge of diagram.edges) if ('id' in edge && (edge.viewIndex === undefined || edge.viewIndex === viewIndex) && !visibleEdges.has(edge.id)) {
                    throw new Error(`Missing annotated diagram edge: ${edge.id}`);
                }
                setStatus('ready');
                setRendered((value) => value + 1);
            }).catch((reason: unknown) => { if (!closed && requested === revision) { console.error('Architecture diagram rendering failed', reason); layout.current?.(); element.replaceChildren(); setStatus('error');
                const message = String(reason); const missingId = /^Error: Missing annotated diagram edge: (.+)$/.exec(message)?.[1];
                failure.current?.({ viewIndex: viewIndex ?? 0, reason: message.slice(0, 500), ...(missingId === undefined ? {} : { missingId }) }); } });
        };
        draw();
        const observer = new MutationObserver(draw);
        observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'data-theme', 'data-arcanum', 'style'] });
        return () => { closed = true; revision++; observer.disconnect(); };
    }, [content, direction, id, t, viewIndex]);
    useEffect(() => {
        const ids = new Set(blocks.find((block) => block.id === activeBlock)?.nodeIds ?? (selected === null ? [] : [selected]));
        for (const node of root.current?.querySelectorAll<SVGGElement>('[data-architecture-node]') ?? []) {
            const active = ids.has(node.dataset.architectureNode ?? '');
            node.classList.toggle('is-architecture-active', active);
            node.setAttribute('aria-pressed', String(active));
        }
    }, [activeBlock, blocks, selected, rendered]);
    const chosen = nodes.find((node) => node.id === selected);
    const chosenEdge = diagram.edges.find((edge) => 'id' in edge && edge.id === selectedEdge && (edge.viewIndex === undefined || edge.viewIndex === viewIndex));
    const related = blocks.filter((block) => selected !== null && block.nodeIds?.includes(selected));
    return <div className="story-architecture" data-reading="architecture">
        <div className="story-architecture-toolbar" role="group" aria-label={t.orientation}>
            <button className="ctl" aria-pressed={direction === 'TB'} onClick={() => { setDirection('TB'); }}>{t.vertical}</button>
            <button className="ctl" aria-pressed={direction === 'LR'} onClick={() => { setDirection('LR'); }}>{t.horizontal}</button>
        </div>
        {status === 'loading' ? <Skeleton diagram label={t.pending} /> : null}
        {status === 'error' ? <p className="story-notice" role="alert">{t.renderError}{onRetry === undefined ? null : <button className="ctl" disabled={!connected} onClick={onRetry}>{t.retry}</button>}</p> : null}
        <div className="story-architecture-scroll" data-direction={direction} ref={root} aria-label={diagram.title} />
        {chosen === undefined ? null : <aside className="story-architecture-selection" aria-live="polite"><strong>{chosen.label}</strong><span>{diagram.nodes.some((node) => node.id === chosen.id) ? t[chosen.change] : t.context}</span>{chosen.limitation === null ? null : <p>{chosen.limitation}</p>}
            {chosen.sources.map((source, index) => <span key={index}>{renderDiagramSource?.(source, index) ?? (source.kind === 'patch' ? `${source.path}:${String(source.start)}–${String(source.end)}` : `Context ${source.id}`)}</span>)}
            {related.map((block) => <button className="ctl" key={block.id} data-reading-focus={`architecture-block:${block.id}`} onClick={() => { onVisit?.(block.id); }}>{block.title} →</button>)}
        </aside>}
        {chosenEdge === undefined ? null : <aside className="story-architecture-selection" aria-live="polite"><strong>{'id' in chosenEdge ? chosenEdge.id : chosenEdge.label}</strong><span>{t[chosenEdge.change]}</span>{chosenEdge.limitation === null ? null : <p>{chosenEdge.limitation}</p>}
            {chosenEdge.sources.map((source, index) => <span key={index}>{renderDiagramSource?.(source, index) ?? (source.kind === 'patch' ? `${source.path}:${String(source.start)}–${String(source.end)}` : `Context ${source.id}`)}</span>)}
        </aside>}
    </div>;
}

let drawing: Promise<unknown> = Promise.resolve();
function renderArchitecture(id: string, diagram: Diagram, element: HTMLElement, direction: 'TB' | 'LR'): Promise<SVGElement> {
    const next = drawing.catch(() => undefined).then(async () => {
        const { default: mermaid } = await import('mermaid');
        await document.fonts.ready;
        const style = getComputedStyle(element);
        const color = (name: string) => style.getPropertyValue(name).trim();
        mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', suppressErrorRendering: true,
            htmlLabels: false, theme: 'base', fontFamily: style.fontFamily,
            themeVariables: { fontSize: style.fontSize, primaryColor: color('--surface-panel'), primaryTextColor: color('--text-primary'),
                primaryBorderColor: color('--border-standard'), lineColor: color('--text-link-muted'),
                secondaryColor: color('--accent-surface'), tertiaryColor: color('--surface-panel'),
                edgeLabelBackground: color('--surface-panel'), clusterBkg: color('--surface-panel'), clusterBorder: color('--border-standard') },
            flowchart: { htmlLabels: false, useMaxWidth: false, nodeSpacing: 35, rankSpacing: 55 } });
        const source = diagram.mermaid.replace(/^(flowchart|graph)\s+(TB|TD|BT|LR|RL)\b/, `$1 ${direction}`);
        const result = await mermaid.render(id, source);
        const svg = new DOMParser().parseFromString(result.svg, 'image/svg+xml').documentElement;
        if (!(svg instanceof SVGElement)) throw new Error('Invalid diagram SVG');
        svg.setAttribute('role', 'group'); svg.setAttribute('aria-label', diagram.title);
        for (const label of svg.querySelectorAll<SVGElement>('text, tspan, .nodeLabel')) paint(label, { fill: 'var(--text-primary)', color: 'var(--text-primary)', opacity: '1', 'fill-opacity': '1' });
        for (const edge of svg.querySelectorAll<SVGElement>('.flowchart-link')) paint(edge, { stroke: 'var(--text-link-muted)', 'stroke-opacity': '1' });
        for (const marker of svg.querySelectorAll<SVGElement>('marker path, marker polygon, marker circle')) paint(marker, { fill: 'var(--text-link-muted)', stroke: 'var(--text-link-muted)' });
        for (const background of svg.querySelectorAll<SVGElement>('.labelBkg, .edgeLabel rect')) paint(background, { fill: 'var(--surface-panel)', 'background-color': 'var(--surface-panel)', opacity: '1' });
        for (const cluster of svg.querySelectorAll<SVGElement>('.cluster rect')) paint(cluster, { fill: 'var(--surface-panel-deep)', stroke: 'var(--text-link-muted)' });
        return svg;
    });
    drawing = next;
    return next;
}

function paint(element: SVGElement, properties: Record<string, string>): void {
    for (const [property, value] of Object.entries(properties)) element.style.setProperty(property, value, 'important');
}

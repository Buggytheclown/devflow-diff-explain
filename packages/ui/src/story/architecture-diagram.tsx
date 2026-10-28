import { useEffect, useId, useRef, useState } from 'react';
import type { ArchitectureDiagram as Diagram, ExplanationBlock } from '@sherpa/protocol';
import { useLocale } from '../i18n/index.js';
import { flowCopy } from '../i18n/story.js';
import { Skeleton } from './preparation.tsx';

/** Mermaid сохраняет топологию графа; интерактивность связываем с проверенными ID сами. */
export function ArchitectureDiagram({ diagram, blocks = [], activeBlock, onVisit, onRetry, connected, onRenderFailure }: {
    diagram: Diagram; blocks?: readonly Pick<ExplanationBlock, 'id' | 'title' | 'nodeIds'>[] | undefined;
    activeBlock?: string | undefined; onVisit?: ((id: string) => void) | undefined;
    onRetry?: (() => void) | undefined; connected: boolean;
    onRenderFailure?: (() => void) | undefined;
}) {
    const t = flowCopy[useLocale()];
    const root = useRef<HTMLDivElement>(null);
    const id = `architecture-${useId().replace(/[^a-zA-Z0-9]/g, '')}`;
    const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
    const [selected, setSelected] = useState<string | null>(null);
    const [rendered, setRendered] = useState(0);
    const [direction, setDirection] = useState<'TB' | 'LR'>('TB');
    const content = JSON.stringify(diagram);
    const failure = useRef(onRenderFailure);
    useEffect(() => { failure.current = onRenderFailure; }, [onRenderFailure]);
    useEffect(() => {
        const element = root.current;
        if (element === null) return;
        const diagram = JSON.parse(content) as Diagram;
        let revision = 0;
        let closed = false;
        const draw = () => {
            const requested = ++revision;
            void renderArchitecture(id, diagram, element, direction).then((svg) => {
                if (closed || requested !== revision) return;
                const focused = element.contains(document.activeElement) ? document.activeElement?.getAttribute('data-architecture-node') : null;
                element.replaceChildren(svg);
                if (element.querySelectorAll('g.node').length !== diagram.nodes.length) throw new Error('Diagram IDs do not match metadata');
                for (const node of diagram.nodes) {
                    const target = [...element.querySelectorAll<SVGGElement>('g.node')].find((entry) => entry.getAttribute('data-id') === node.id || new RegExp(`(?:^|-)flowchart-${node.id}-[0-9]+$`).test(entry.id));
                    if (target === undefined) throw new Error('Missing diagram node');
                    target.dataset.architectureNode = node.id;
                    target.dataset.readingFocus = `architecture-node:${node.id}`;
                    target.classList.add(`architecture-node--${node.change}`);
                    // Inline !important сильнее правил с ID, которые Mermaid создаёт из classDef.
                    // Цвет задаётся токенами приложения, а не оформлением, выбранным моделью.
                    paint(target, { opacity: '1' });
                    for (const shape of target.querySelectorAll<SVGElement>('rect, polygon, circle, ellipse, path, line')) {
                        paint(shape, { fill: 'var(--architecture-node-fill)', stroke: 'var(--architecture-highlight, var(--architecture-node-stroke))',
                            'stroke-width': 'var(--architecture-highlight-width, 2px)', 'stroke-dasharray': 'var(--architecture-node-dash, none)', 'fill-opacity': '1', 'stroke-opacity': '1' });
                    }
                    target.setAttribute('role', 'button'); target.setAttribute('tabindex', '0');
                    target.setAttribute('aria-label', `${node.label} · ${t[node.change]}`);
                    const select = () => { setSelected(node.id); };
                    target.addEventListener('click', select);
                    target.addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); select(); } });
                    if (node.id === focused) target.focus({ preventScroll: true });
                }
                setStatus('ready');
                setRendered((value) => value + 1);
            }).catch((reason: unknown) => { if (!closed && requested === revision) { console.error('Architecture diagram rendering failed', reason); element.replaceChildren(); setStatus('error'); failure.current?.(); } });
        };
        draw();
        const observer = new MutationObserver(draw);
        observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'data-theme', 'data-arcanum', 'style'] });
        return () => { closed = true; revision++; observer.disconnect(); };
    }, [content, direction, id, t]);
    useEffect(() => {
        const ids = new Set(blocks.find((block) => block.id === activeBlock)?.nodeIds ?? (selected === null ? [] : [selected]));
        for (const node of root.current?.querySelectorAll<SVGGElement>('[data-architecture-node]') ?? []) {
            const active = ids.has(node.dataset.architectureNode ?? '');
            node.classList.toggle('is-architecture-active', active);
            node.setAttribute('aria-pressed', String(active));
        }
    }, [activeBlock, blocks, selected, rendered]);
    const chosen = diagram.nodes.find((node) => node.id === selected);
    const related = blocks.filter((block) => selected !== null && block.nodeIds?.includes(selected));
    return <div className="story-architecture" data-reading="architecture">
        <div className="story-architecture-toolbar" role="group" aria-label={t.orientation}>
            <button className="ctl" aria-pressed={direction === 'TB'} onClick={() => { setDirection('TB'); }}>{t.vertical}</button>
            <button className="ctl" aria-pressed={direction === 'LR'} onClick={() => { setDirection('LR'); }}>{t.horizontal}</button>
        </div>
        {status === 'loading' ? <Skeleton diagram label={t.pending} /> : null}
        {status === 'error' ? <p className="story-notice" role="alert">{t.renderError}{onRetry === undefined ? null : <button className="ctl" disabled={!connected} onClick={onRetry}>{t.retry}</button>}</p> : null}
        <div className="story-architecture-scroll" data-direction={direction} ref={root} aria-label={diagram.title} />
        {chosen === undefined ? null : <aside className="story-architecture-selection" aria-live="polite"><strong>{chosen.label}</strong><span>{t[chosen.change]}</span>{chosen.limitation === null ? null : <p>{chosen.limitation}</p>}
            {related.map((block) => <button className="ctl" key={block.id} data-reading-focus={`architecture-block:${block.id}`} onClick={() => { onVisit?.(block.id); }}>{block.title} →</button>)}
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

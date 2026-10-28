import { z } from 'zod';
import { codeLocationSchema, relativeCodePathSchema } from './code-link.js';

export const flowContextRequestSchema = z.object({ path: relativeCodePathSchema, start: z.number().int().positive(), end: z.number().int().positive() }).strict()
    .refine((entry) => entry.end >= entry.start && entry.end - entry.start < 80, 'Request at most 80 ordered lines.');
export const flowContextSchema = flowContextRequestSchema.safeExtend({ id: z.string().min(1), revision: z.string().min(1), text: z.string().max(24_000) });
export const flowCitationSchema = z.union([
    codeLocationSchema.safeExtend({ kind: z.literal('patch') }).strict().refine((entry) => entry.end - entry.start < 80, 'Cite at most 80 lines.'),
    z.object({ kind: z.literal('context'), id: z.string().min(1) }).strict(),
]);
const grounded = {
    change: z.enum(['existing', 'added', 'modified', 'unknown']),
    sources: z.array(flowCitationSchema).max(4), limitation: z.string().trim().min(1).max(240).nullable(),
};
export const flowDiagramSchema = z.object({
    title: z.string().trim().min(1).max(100),
    nodes: z.array(z.object({ id: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,39}$/), label: z.string().trim().min(1).max(120), ...grounded }).strict()).min(2).max(10),
    edges: z.array(z.object({ from: z.string().min(1), to: z.string().min(1), label: z.string().trim().min(1).max(120), kind: z.enum(['data', 'control']), ...grounded }).strict()).min(1).max(14),
}).strict().superRefine((diagram, ctx) => {
    const ids = new Set(diagram.nodes.map((node) => node.id));
    if (ids.size !== diagram.nodes.length) ctx.addIssue({ code: 'custom', message: 'Use unique node IDs.' });
    const pairs = new Set<string>();
    for (const edge of diagram.edges) {
        const key = `${edge.from}:${edge.to}:${edge.kind}`;
        if (!ids.has(edge.from) || !ids.has(edge.to) || edge.from === edge.to || pairs.has(key)) ctx.addIssue({ code: 'custom', message: 'Use unique connections between existing different nodes.' });
        pairs.add(key);
    }
    for (const item of [...diagram.nodes, ...diagram.edges]) {
        if (item.change === 'unknown' ? item.limitation === null : item.sources.length === 0) ctx.addIssue({ code: 'custom', message: 'Known items need saved sources; unknown items need a local limitation.' });
    }
});
export const flowDiagramResultSchema = z.object({
    contextRequests: z.array(flowContextRequestSchema).max(4), diagram: flowDiagramSchema.nullable(), reason: z.string().trim().min(1).max(300).nullable(),
    outcome: z.enum(['not_applicable', 'unavailable']).optional(),
}).strict().refine((value) => value.contextRequests.length > 0 ? value.diagram === null : value.diagram !== null || value.reason !== null,
    'Request context first, or return a diagram, or state why it is unavailable.')
    .refine((value) => value.outcome === undefined || (value.diagram === null && value.contextRequests.length === 0 && value.reason !== null),
        'A terminal outcome needs a reason and cannot include a diagram or context requests.');
const contexts = z.array(flowContextSchema).max(8);
/** Свободная компоновка Mermaid; метаданные нужны для источников, подсветки и связи с блоками. */
export const architectureDiagramSchema = z.object({
    title: z.string().trim().min(1).max(160),
    mermaid: z.string().trim().min(1).max(40_000)
        .refine((text) => /^(?:flowchart|graph)\s+(?:TB|TD|BT|LR|RL)\b/.test(text), 'Return a Mermaid flowchart or graph.')
        .refine((text) => !/%%\{|^\s*click\s|<\s*(?:script|iframe|image|foreignObject)\b|@\s*\{[^}]*\b(?:img|icon)\s*:/im.test(text), 'Use a static flowchart without configuration, callbacks or external assets.'),
    nodes: z.array(z.object({
        id: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,79}$/), label: z.string().trim().min(1).max(160),
        change: z.enum(['existing', 'added', 'modified', 'affected', 'unknown']),
        sources: z.array(flowCitationSchema).max(4), limitation: z.string().trim().min(1).max(400).nullable(),
    }).strict()).min(1).max(120),
    edges: z.array(flowDiagramSchema.shape.edges.element).max(256).optional().default([]),
}).strict().superRefine((diagram, ctx) => {
    const ids = new Set(diagram.nodes.map((node) => node.id));
    if (ids.size !== diagram.nodes.length) ctx.addIssue({ code: 'custom', message: 'Use unique architecture node IDs.' });
    for (const node of diagram.nodes) {
        if (!new RegExp(`(^|[^a-zA-Z0-9_-])${node.id}(?=$|[^a-zA-Z0-9_-])`, 'm').test(diagram.mermaid)) ctx.addIssue({ code: 'custom', message: `Architecture node ${node.id} is missing from the flowchart.` });
        if (node.sources.length === 0 && node.limitation === null) ctx.addIssue({ code: 'custom', message: 'Architecture nodes need saved sources or an explicit evidence limitation.' });
    }
});
export type ArchitectureDiagram = z.infer<typeof architectureDiagramSchema>;
export const readyFlowSchema = z.object({ status: z.literal('ready'), diagram: z.union([architectureDiagramSchema, flowDiagramSchema]), contexts });
export const flowStateSchema = z.discriminatedUnion('status', [
    z.object({ status: z.literal('pending'), taskId: z.number().int().positive().nullable(), round: z.number().int().min(0).max(2), requests: z.array(flowContextRequestSchema).max(4), contexts, missing: z.array(z.string()).max(8) }),
    readyFlowSchema,
    z.object({ status: z.literal('unavailable'), reason: z.string().min(1).max(400) }),
    z.object({ status: z.literal('not_applicable'), reason: z.string().min(1).max(400) }),
]);
export type FlowContext = z.infer<typeof flowContextSchema>;
export type FlowDiagram = z.infer<typeof flowDiagramSchema> | ArchitectureDiagram;
export type FlowState = z.infer<typeof flowStateSchema>;
export type ReadyFlow = z.infer<typeof readyFlowSchema>;

export function flowText(flow: FlowState | undefined): string {
    if (flow?.status !== 'ready') return '';
    return [...('mermaid' in flow.diagram ? ['Architecture flowchart:', flow.diagram.mermaid] : []), 'Data flow: '+flow.diagram.title, ...flow.diagram.nodes.map((node) => `${node.id}: ${node.label} [${node.change}]${node.limitation === null ? '' : ` (${node.limitation})`}`),
        ...flow.diagram.edges.map((edge) => `${edge.from} -> ${edge.to}: ${edge.label} [${edge.kind}, ${edge.change}]${edge.limitation === null ? '' : ` (${edge.limitation})`}`)].join('\n');
}

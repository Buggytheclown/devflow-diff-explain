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
}).strict().refine((value) => value.contextRequests.length > 0 ? value.diagram === null : value.diagram !== null || value.reason !== null,
    'Request context first, or return a diagram, or state why it is unavailable.');
const contexts = z.array(flowContextSchema).max(8);
export const readyFlowSchema = z.object({ status: z.literal('ready'), diagram: flowDiagramSchema, contexts });
export const flowStateSchema = z.discriminatedUnion('status', [
    z.object({ status: z.literal('pending'), taskId: z.number().int().positive().nullable(), round: z.number().int().min(0).max(2), requests: z.array(flowContextRequestSchema).max(4), contexts, missing: z.array(z.string()).max(8) }),
    readyFlowSchema,
    z.object({ status: z.literal('unavailable'), reason: z.string().min(1).max(300) }),
]);
export type FlowContext = z.infer<typeof flowContextSchema>;
export type FlowDiagram = z.infer<typeof flowDiagramSchema>;
export type FlowState = z.infer<typeof flowStateSchema>;
export type ReadyFlow = z.infer<typeof readyFlowSchema>;

export function flowText(flow: FlowState | undefined): string {
    if (flow?.status !== 'ready') return '';
    return ['Data flow: '+flow.diagram.title, ...flow.diagram.nodes.map((node) => `${node.id}: ${node.label} [${node.change}]${node.limitation === null ? '' : ` (${node.limitation})`}`),
        ...flow.diagram.edges.map((edge) => `${edge.from} -> ${edge.to}: ${edge.label} [${edge.kind}, ${edge.change}]${edge.limitation === null ? '' : ` (${edge.limitation})`}`)].join('\n');
}

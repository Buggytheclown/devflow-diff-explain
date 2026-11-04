import { z } from 'zod';
import { relativeCodePathSchema } from './code-link.js';
import { flowStateSchema } from './flow-diagram.js';
import { hostIdSchema } from './review.js';
import { storyEvidenceBlockSchema } from './story-evidence.js';
import { checkExplanationSnapshot, guidedFileSchema, readableExampleSchema, routeCarriedSchema, routeProvenanceSchema, routeStopStatusSchema } from './route.js';

/** Порядок для понимания, без приоритетов и действий ревью. */
export const explanationBlockSchema = z.object({
    id: z.string().min(1), planIndex: z.number().int().positive(), title: z.string().min(1).max(300),
    status: routeStopStatusSchema, paragraph: z.string().nullable(),
    storyEvidence: storyEvidenceBlockSchema.optional(), guidedFiles: z.array(guidedFileSchema).optional(),
    example: readableExampleSchema.nullable().optional(),
    nodeIds: z.array(z.string().min(1)).optional(),
    relatedFiles: z.array(z.object({ fileId: hostIdSchema, path: relativeCodePathSchema })).optional(),
    validationNotes: z.array(z.string()), provenance: routeProvenanceSchema.nullable(),
});
export type ExplanationBlock = z.infer<typeof explanationBlockSchema>;

/** Собственная запись; HTTP-проекция оставлена совместимой с прежними клиентами. */
export const explanationSnapshotSchema = z.object({
    format: z.literal('explanation/1'), presentation: z.literal('story'),
    storyContractVersion: z.union([z.literal(2), z.literal(3), z.literal(4), z.literal(5), z.literal(6)]),
    snapshotId: z.string().min(1), commit: z.string().min(1), baseCommit: z.string().min(1), diffId: hostIdSchema,
    codeSnapshotId: z.string().regex(/^[a-f0-9]{64}$/).optional(),
    reviewRevision: z.number().int().positive().optional(),
    createdAt: z.iso.datetime(), provenance: routeProvenanceSchema,
    previousSnapshotId: z.string().nullable(), contentHash: z.string().nullable(),
    summary: z.string(), summaryEvidence: storyEvidenceBlockSchema.optional(), flow: flowStateSchema.optional(),
    stops: z.array(explanationBlockSchema), tourOrder: z.array(z.string().min(1)),
}).superRefine(checkExplanationSnapshot);
export type ExplanationSnapshot = z.infer<typeof explanationSnapshotSchema>;

/** Новая запись хранит один порядок блоков и пояснения независимо от их владельца. */
const canonicalBlockSchema = explanationBlockSchema.omit({ planIndex: true, guidedFiles: true }).extend({
    fileIds: z.array(hostIdSchema),
});
export const explanationCanonicalSnapshotSchema = z.object({
    format: z.literal('explanation/2'), presentation: z.literal('story'), storyContractVersion: z.literal(6),
    snapshotId: z.string().min(1), commit: z.string().min(1), baseCommit: z.string().min(1), diffId: hostIdSchema,
    codeSnapshotId: z.string().regex(/^[a-f0-9]{64}$/).optional(),
    reviewRevision: z.number().int().positive().optional(),
    createdAt: z.iso.datetime(), provenance: routeProvenanceSchema,
    previousSnapshotId: z.string().nullable(), carried: routeCarriedSchema.nullable().optional(), contentHash: z.string().nullable(),
    summary: z.string(), summaryEvidence: storyEvidenceBlockSchema, flow: flowStateSchema.optional(),
    blocks: z.array(canonicalBlockSchema), files: z.array(guidedFileSchema),
}).superRefine((value, ctx) => {
    const referenced = new Set<string>();
    const ids = new Set<string>();
    const files = new Map(value.files.map((file) => [file.fileId, file]));
    if (files.size !== value.files.length) ctx.addIssue({ code: 'custom', path: ['files'], message: 'File IDs must be unique.' });
    value.blocks.forEach((block, index) => {
        if (ids.has(block.id)) ctx.addIssue({ code: 'custom', path: ['blocks', index, 'id'], message: 'Block IDs must be unique.' });
        ids.add(block.id);
        for (const fileId of block.fileIds) {
            if (referenced.has(fileId) || !files.has(fileId)) ctx.addIssue({ code: 'custom', path: ['blocks', index, 'fileIds'], message: 'File IDs need one owner and a saved explanation.' });
            referenced.add(fileId);
        }
    });
    for (const [index, file] of value.files.entries()) if (!referenced.has(file.fileId)) ctx.addIssue({ code: 'custom', path: ['files', index], message: 'Every saved file needs one block.' });
});
export type ExplanationCanonicalSnapshot = z.infer<typeof explanationCanonicalSnapshotSchema>;

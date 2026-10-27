import { z } from 'zod';
import { relativeCodePathSchema } from './code-link.js';
import { flowStateSchema } from './flow-diagram.js';
import { hostIdSchema } from './review.js';
import { storyEvidenceBlockSchema } from './story-evidence.js';
import { checkExplanationSnapshot, guidedFileSchema, readableExampleSchema, routeProvenanceSchema, routeStopStatusSchema } from './route.js';

/** Порядок для понимания, без приоритетов и действий ревью. */
export const explanationBlockSchema = z.object({
    id: z.string().min(1), planIndex: z.number().int().positive(), title: z.string().min(1).max(300),
    status: routeStopStatusSchema, paragraph: z.string().nullable(),
    storyEvidence: storyEvidenceBlockSchema.optional(), guidedFiles: z.array(guidedFileSchema).optional(),
    example: readableExampleSchema.nullable().optional(),
    relatedFiles: z.array(z.object({ fileId: hostIdSchema, path: relativeCodePathSchema })).optional(),
    validationNotes: z.array(z.string()), provenance: routeProvenanceSchema.nullable(),
});
export type ExplanationBlock = z.infer<typeof explanationBlockSchema>;

/** Собственная запись; HTTP-проекция оставлена совместимой с прежними клиентами. */
export const explanationSnapshotSchema = z.object({
    format: z.literal('explanation/1'), presentation: z.literal('story'),
    storyContractVersion: z.union([z.literal(2), z.literal(3), z.literal(4)]),
    snapshotId: z.string().min(1), commit: z.string().min(1), baseCommit: z.string().min(1), diffId: hostIdSchema,
    createdAt: z.iso.datetime(), provenance: routeProvenanceSchema,
    previousSnapshotId: z.string().nullable(), contentHash: z.string().nullable(),
    summary: z.string(), summaryEvidence: storyEvidenceBlockSchema.optional(), flow: flowStateSchema.optional(),
    stops: z.array(explanationBlockSchema), tourOrder: z.array(z.string().min(1)),
}).superRefine(checkExplanationSnapshot);
export type ExplanationSnapshot = z.infer<typeof explanationSnapshotSchema>;

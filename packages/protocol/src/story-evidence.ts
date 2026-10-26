import { readyFlowSchema } from './flow-diagram.js';
import { z } from 'zod';

import { codeLocationSchema, relativeCodePathSchema } from './code-link.js';

const lines = codeLocationSchema.safeExtend({ kind: z.literal('lines') }).strict()
    .refine((value) => value.end - value.start < 20, 'Keep a source within 20 lines.');
const file = z.object({ kind: z.literal('file'), path: relativeCodePathSchema }).strict();
export const rawStorySourceSchema = z.union([lines, file]);
export const storySourceSchema = z.union([
    lines.safeExtend({ fileId: z.string().min(1) }), file.extend({ fileId: z.string().min(1) }),
]);

function evidence<T extends z.ZodType>(source: T) {
    return z.object({ claims: z.array(z.object({
        quote: z.string().trim().min(1).max(4000),
        sources: z.array(source).max(8),
        limitation: z.string().trim().min(1).max(4000).nullable(),
    }).strict().refine((claim) => claim.sources.length > 0 || claim.limitation !== null,
        'Provide sources or an explicit evidence limit.')).min(1).max(8) }).strict();
}
export const rawStoryEvidenceBlockSchema = evidence(rawStorySourceSchema);
export const storyEvidenceBlockSchema = evidence(storySourceSchema);
export const storyExplanationEvidenceSchema = z.object({
    contractVersion: z.union([z.literal(2), z.literal(3), z.literal(4)]),
    introduction: storyEvidenceBlockSchema,
    flow: readyFlowSchema.optional(),
    sections: z.array(z.object({ id: z.string().min(1), evidence: storyEvidenceBlockSchema }).strict()).max(41),
}).strict();

export type RawStoryEvidenceBlock = z.infer<typeof rawStoryEvidenceBlockSchema>;
export type StoryEvidenceBlock = z.infer<typeof storyEvidenceBlockSchema>;
export type StorySource = z.infer<typeof storySourceSchema>;
export type StoryExplanationEvidence = z.infer<typeof storyExplanationEvidenceSchema>;

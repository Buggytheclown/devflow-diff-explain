import { z } from 'zod';
import { codeLocationSchema } from './code-link.js';

export const savedSourceSchema = codeLocationSchema.safeExtend({
    id: z.string().regex(/^[a-f0-9]{64}$/), diffId: z.string().min(1), revision: z.string().min(1),
    text: z.string(), hash: z.string().regex(/^[a-f0-9]{64}$/),
    fullFile: z.boolean().optional(),
    origin: z.object({ url: z.url({ protocol: /^https?$/ }), capturedAt: z.iso.datetime(), scope: z.string().min(1), revision: z.string().optional() }).optional(),
}).strict();
export type SavedSource = z.infer<typeof savedSourceSchema>;
export const SAVED_SOURCE_ENDPOINT = '/api/review/source';

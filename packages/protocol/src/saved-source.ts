import { z } from 'zod';
import { codeLocationSchema } from './code-link.js';

export const savedSourceSchema = codeLocationSchema.safeExtend({
    id: z.string().regex(/^[a-f0-9]{64}$/), diffId: z.string().min(1), revision: z.string().min(1),
    text: z.string().max(256 * 1024), hash: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export type SavedSource = z.infer<typeof savedSourceSchema>;
export const SAVED_SOURCE_ENDPOINT = '/api/review/source';

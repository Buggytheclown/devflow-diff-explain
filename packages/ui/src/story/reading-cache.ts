import { z } from 'zod';
import { chatExplanationSchema, codeLocationSchema, uiChatAskAnchorSchema } from '@sherpa/protocol';

const guide = z.object({ kind: z.literal('guide'), snapshotId: z.string(), page: z.string() });
const diff = z.object({ kind: z.literal('diff'), diffId: z.string(), fileId: z.string() });
const readerSchema = z.object({
    snapshotId: z.string().nullable(), draft: z.string(),
    anchor: uiChatAskAnchorSchema.nullable().optional(), anchorText: z.string().nullable().optional(), explanation: chatExplanationSchema.optional(), contextTitle: z.string().optional(), chatOpen: z.boolean().optional(),
    navigation: z.object({ address: z.union([guide, diff]).nullable(), guide: guide.nullable(), returnTo: guide.nullable(), resume: guide.nullable(),
        location: codeLocationSchema.safeExtend({ diffId: z.string() }).nullable(), epoch: z.number().int().nonnegative() }),
});
const positionsSchema = z.array(z.tuple([z.string(), z.object({ address: z.string(), offset: z.number() })])).max(100);

/** Локальная память вкладки не содержит токена доступа; повреждённая запись игнорируется. */
export function readCache<T>(key: string, schema: z.ZodType<T>): T | undefined {
    try { const value = schema.safeParse(JSON.parse(localStorage.getItem(`devflow:${key}`) ?? 'null')); return value.success ? value.data : undefined; } catch { return undefined; }
}
export function writeCache(key: string, value: unknown): void {
    try { localStorage.setItem(`devflow:${key}`, JSON.stringify(value)); } catch { /* Недоступное хранилище не блокирует чтение. */ }
}
export const readReader = () => readCache('reader', readerSchema);
export const readPositions = () => readCache('positions', positionsSchema) ?? [];

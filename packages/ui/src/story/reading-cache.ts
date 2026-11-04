import { z } from 'zod';
import { codeLocationSchema, uiChatAskAnchorSchema } from '@sherpa/protocol';

const guide = z.object({ kind: z.literal('guide'), snapshotId: z.string(), page: z.string() });
const diff = z.object({ kind: z.literal('diff'), diffId: z.string(), fileId: z.string() });
const readerSchema = z.object({
    snapshotId: z.string().nullable(), draft: z.string(),
    anchor: uiChatAskAnchorSchema.nullable().optional(), anchorText: z.string().nullable().optional(), explanation: z.object({
        snapshotId: z.string().nullable(), revision: z.number().int().positive().optional(), diffId: z.string(), codeSnapshotId: z.string().optional(), commit: z.string(),
        sectionId: z.string().optional(), file: z.object({ fileId: z.string(), path: z.string() }).optional(),
    }).optional(), contextTitle: z.string().optional(), chatOpen: z.boolean().optional(),
    navigation: z.object({ address: z.union([guide, diff]).nullable(), guide: guide.nullable(), returnTo: guide.nullable(), resume: guide.nullable(),
        location: codeLocationSchema.safeExtend({ diffId: z.string() }).nullable(), epoch: z.number().int().nonnegative() }),
});
const positionsSchema = z.array(z.tuple([z.string(), z.object({ address: z.string(), offset: z.number() })])).max(100);

let cacheScope = 'current';
/** Память принадлежит вкладке и выбранной версии, без токена доступа в ключе. */
export function setReadingCacheScope(code: string | null, review: string | null): void {
    cacheScope = `${code ?? 'current'}:${review ?? ''}`;
}
/** Повреждённая запись игнорируется. */
export function readCache<T>(key: string, schema: z.ZodType<T>): T | undefined {
    try { const value = schema.safeParse(JSON.parse(sessionStorage.getItem(`devflow:${cacheScope}:${key}`) ?? 'null')); return value.success ? value.data : undefined; } catch { return undefined; }
}
export function writeCache(key: string, value: unknown): void {
    try { sessionStorage.setItem(`devflow:${cacheScope}:${key}`, JSON.stringify(value)); } catch { /* Недоступное хранилище не блокирует чтение. */ }
}
export const readReader = () => readCache('reader', readerSchema);
export const readPositions = () => readCache('positions', positionsSchema) ?? [];
export const readExpansions = () => readCache('expansions', z.record(z.string(), z.array(z.string()))) ?? {};

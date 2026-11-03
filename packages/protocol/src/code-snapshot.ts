import { z } from 'zod';
import { prKeySchema } from './manifest.js';
import { fileChangeTypeSchema, capturedPrSchema } from './review.js';

/** Пути внутри репозитория и экспортного каталога, никогда не команды или URL. */
export const artifactPathSchema = z.string().min(1).refine((value) =>
    !value.startsWith('/') && !value.includes('\\') && !value.includes('\0') &&
    value.split('/').every((part) => part !== '' && part !== '.' && part !== '..'), 'Expected a relative path without traversal');

export const artifactInputSchema = z.object({
    file: artifactPathSchema,
    kind: z.enum(['text', 'binary', 'symlink', 'gitlink']),
    mode: z.string().optional(),
}).strict();

export const snapshotFileInputSchema = z.object({
    fileId: z.string().min(1).optional(),
    path: artifactPathSchema,
    oldPath: artifactPathSchema.nullable().default(null),
    changeType: fileChangeTypeSchema,
    before: artifactInputSchema.nullable(),
    after: artifactInputSchema.nullable(),
    /** Отсутствующий patch строится из полных сторон, происхождение сохраняется. */
    patch: artifactPathSchema.nullable().default(null),
    generated: z.boolean().default(false),
    hostFileUrl: z.string().nullable().default(null),
}).strict();

export const sourceInputSchema = z.object({
    path: artifactPathSchema,
    revision: z.string().min(1),
    artifact: artifactInputSchema,
    /** Материал внешнего документа, сохранённый как локальный источник доказательств. */
    origin: z.object({ url: z.url({ protocol: /^https?$/ }), capturedAt: z.iso.datetime(), scope: z.string().min(1), revision: z.string().optional() }).strict().optional(),
}).strict();

/** Полный инвентарь изменений предоставляет агент своим нативным инструментом. */
export const codeSnapshotInputSchema = z.object({
    format: z.literal('code-snapshot/1'),
    project: prKeySchema.describe('Stable local project key, e.g. arcanum-16729612; letters, digits, dot, dash and underscore'),
    diffId: z.string().min(1),
    baseCommit: z.string().min(1),
    headCommit: z.string().min(1),
    capturedAt: z.iso.datetime(),
    pr: capturedPrSchema.nullable().default(null),
    files: z.array(snapshotFileInputSchema),
    sources: z.array(sourceInputSchema).default([]),
    /** Архивный импорт не переключает активную версию. */
    activate: z.boolean().default(true),
}).strict();
export type CodeSnapshotInput = z.infer<typeof codeSnapshotInputSchema>;

export const sourcesInputSchema = z.object({
    format: z.literal('code-sources/1'),
    project: prKeySchema.describe('Stable local project key, e.g. arcanum-16729612; letters, digits, dot, dash and underscore'),
    codeSnapshotId: z.string().regex(/^[a-f0-9]{64}$/),
    sources: z.array(sourceInputSchema),
}).strict();
export type SourcesInput = z.infer<typeof sourcesInputSchema>;

export const codeSnapshotReceiptSchema = z.object({
    codeSnapshotId: z.string().regex(/^[a-f0-9]{64}$/),
    diffId: z.string().min(1),
    files: z.number().int().nonnegative(),
    sources: z.number().int().nonnegative(),
});
export type CodeSnapshotReceipt = z.infer<typeof codeSnapshotReceiptSchema>;

export const artifactImportRequestSchema = z.object({ manifest: z.string().min(1) }).strict();
export const ARTIFACT_ENDPOINTS = { snapshot: '/api/snapshot/import', sources: '/api/sources/import', raw: '/api/snapshot/raw', source: '/api/snapshot/source' } as const;

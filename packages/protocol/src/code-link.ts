import { z } from 'zod';

/** Координаты ссылки; версия берётся из сохранённого вопроса, не из адреса модели. */
export const relativeCodePathSchema = z.string().min(1).max(4000).refine((value) =>
        !value.startsWith('/') && !value.includes('\\') && !Array.from(value).some((character) => character.charCodeAt(0) < 32) &&
        !value.split('/').some((part) => part === '..' || part === '.' || part === ''));
export const codeLocationSchema = z.object({
    path: relativeCodePathSchema,
    side: z.enum(['old', 'new']),
    start: z.number().int().positive().max(2_147_483_647),
    end: z.number().int().positive().max(2_147_483_647),
}).refine((value) => value.end >= value.start && value.end - value.start < 1000);
export type CodeLocation = z.infer<typeof codeLocationSchema>;

export function parseCodeLink(href: string): CodeLocation | null {
    if (!href.startsWith('#code?')) return null;
    const params = new URLSearchParams(href.slice(6));
    if ([...params.keys()].length !== 4 || ['path', 'side', 'start', 'end'].some((key) => params.getAll(key).length !== 1) ||
        !/^\d+$/.test(params.get('start') ?? '') || !/^\d+$/.test(params.get('end') ?? '')) return null;
    const parsed = codeLocationSchema.safeParse({ path: params.get('path'), side: params.get('side'),
        start: Number(params.get('start')), end: Number(params.get('end')) });
    return parsed.success ? parsed.data : null;
}

export function codeLink(location: CodeLocation): string {
    const value = codeLocationSchema.parse(location);
    return `#code?${new URLSearchParams({ path: value.path, side: value.side, start: String(value.start), end: String(value.end) }).toString()}`;
}

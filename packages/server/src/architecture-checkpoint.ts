import type { FlowState, PrDiff, RouteSnapshot, SectionAssignment } from '@sherpa/protocol';
import { allFilesResultSchema, checkpointEnvelopeSchema, explainedFileWorkerResultSchema } from '@sherpa/protocol';
import { z } from 'zod';
import { createFileValidator, validateArchitectureOverview, validateAllFiles } from './architecture-story.js';
import { rawEvidence } from './story-evidence.js';
import { parseResult } from './route/raw-result.js';
import type { RouteValidation } from './route/types.js';
import type { AcceptedExplanation, ExplanationFilling } from './story.js';

export interface ArchitectureCheckpoint { overview?: AcceptedExplanation; files: ExplanationFilling[] }

/** Внутренние claims не входят во входной контракт модели. */
export function internalEvidence(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(internalEvidence);
    if (value === null || typeof value !== 'object') return value;
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, child]) => [key,
        key === 'evidence' && child !== null && typeof child === 'object' && 'sources' in child
            ? { claims: [{ sources: child.sources, limitation: 'limitation' in child ? child.limitation : null }] }
            : internalEvidence(child)]));
}

export function readCheckpoint(raw: string) {
    const parsed = parseResult(raw, checkpointEnvelopeSchema, 'checkpoint');
    if (!parsed.ok) return parsed;
    const { files = [], ...structure } = parsed.value;
    return { ok: true as const, value: { body: parsed.value, files, structure: JSON.stringify({ ...internalEvidence(structure) as object, files: [] }) } };
}

/** Один валидатор для файлов и повтора схемы; граф и связи обновляются вместе. */
export function validateArchitectureCheckpoint(raw: string, snapshot: RouteSnapshot, diff: PrDiff,
    assignment?: SectionAssignment, previousFlow?: FlowState | null, requireFlow = false, structureOnly = false): RouteValidation<ArchitectureCheckpoint> {
    // Структурная часть уже отделена от массива файлов; пустой массив здесь допустим.
    const parsed = parseResult(raw, structureOnly ? z.object(allFilesResultSchema.shape).strict() : allFilesResultSchema, 'checkpoint');
    if (!parsed.ok) return parsed;
    const body = parsed.value;
    if (requireFlow && body.overview?.flow === undefined && body.update?.flow === undefined) {
        return { ok: false, errors: ['Return the architecture in update.flow or overview.flow, with block updates when needed.'] };
    }
    let overview: AcceptedExplanation | undefined;
    if (body.overview !== undefined || body.update !== undefined) {
        const update = body.update;
        const evidence = (block: ReturnType<typeof rawEvidence>, changed: boolean) => changed && block !== undefined
            ? { claims: block.claims.map(({ sources, limitation }) => ({ sources, limitation })) } : block;
        const flow = snapshot.flow?.status === 'pending' ? previousFlow : snapshot.flow;
        const current = { contractVersion: 6, summary: snapshot.summary,
            evidence: evidence(rawEvidence(snapshot.summaryEvidence), update?.summary !== undefined && update.evidence === undefined),
            flow: flow?.status === 'ready' ? { status: 'ready', diagram: flow.diagram } : flow,
            stops: snapshot.stops.map((block) => ({ id: block.id, title: block.title, paragraph: block.paragraph,
                evidence: rawEvidence(block.storyEvidence), nodeIds: block.nodeIds ?? [],
                files: block.guidedFiles?.map((file) => file.path) ?? [], relatedFiles: block.relatedFiles?.map((file) => file.path) ?? [] })) };
        const errors: string[] = [];
        if (update !== undefined) {
            const { blocks, removeBlocks, blockOrder, ...fields } = update;
            if (fields.stops !== undefined && (blocks !== undefined || removeBlocks !== undefined || blockOrder !== undefined)) {
                errors.push('Use stops or block operations in one update, not both.');
            }
            const byId = new Map<string, Record<string, unknown>>(current.stops.map((block) => [block.id, block]));
            const seen = new Set<string>();
            for (const block of blocks ?? []) {
                if (seen.has(block.id)) errors.push(`Duplicate block update: ${block.id}.`);
                seen.add(block.id);
                const old = byId.get(block.id);
                byId.set(block.id, { ...old, ...block,
                    ...(block.paragraph === undefined || block.evidence !== undefined ? {} : {
                        evidence: evidence(old?.evidence as ReturnType<typeof rawEvidence>, true),
                    }) });
            }
            for (const id of removeBlocks ?? []) {
                if (seen.has(id) || !byId.delete(id)) errors.push(`Unknown, duplicated or conflicting block removal: ${id}.`);
                seen.add(id);
            }
            if (blockOrder !== undefined && (new Set(blockOrder).size !== byId.size || blockOrder.length !== byId.size || blockOrder.some((id) => !byId.has(id)))) {
                errors.push('blockOrder must contain every remaining block ID exactly once.');
            }
            Object.assign(current, fields);
            if (fields.stops === undefined) current.stops = (blockOrder ?? [...byId.keys()]).map((id) => byId.get(id)) as typeof current.stops;
        }
        if (errors.length > 0) return { ok: false, errors };
        const checked = validateArchitectureOverview(JSON.stringify(body.overview ?? current), diff, snapshot.stops);
        if (!checked.ok) return checked;
        overview = checked.value;
        if (update?.flow === undefined && body.overview === undefined && snapshot.flow?.status === 'pending') overview.flow = snapshot.flow;
    }
    const files = (body.files?.length ?? 0) + body.stops.length === 0
        ? { ok: true as const, value: [] }
        : validateAllFiles(JSON.stringify(body), diff, overview?.stops ?? snapshot.stops, assignment);
    if (!files.ok) return files;
    return { ok: true, value: { ...(overview === undefined ? {} : { overview }), files: files.value } };
}

export function checkIndividualFiles(files: unknown[], diff: PrDiff, blocks: Parameters<typeof validateAllFiles>[2], assignment?: SectionAssignment) {
    const accepted: string[] = [];
    const errors: { path: string; errors: string[] }[] = [];
    const fillings: ExplanationFilling[] = [];
    const validate = createFileValidator(diff, blocks, assignment);
    const paths = files.map((file) => file !== null && typeof file === 'object' && 'path' in file && typeof file.path === 'string' ? file.path : null);
    const counts = new Map<string, number>();
    for (const path of paths) if (path !== null) counts.set(path, (counts.get(path) ?? 0) + 1);
    for (const [index, file] of files.entries()) {
        const path = file !== null && typeof file === 'object' && 'path' in file && typeof file.path === 'string' ? file.path : '[missing path]';
        if ((counts.get(path) ?? 0) > 1) {
            errors.push({ path, errors: [`files[${String(index)}].path: Return each file path once: ${path}.`] });
            continue;
        }
        const parsed = explainedFileWorkerResultSchema.safeParse(file);
        const checked = parsed.success
            ? validate(internalEvidence(parsed.data))
            : { ok: false as const, errors: parsed.error.issues.map((issue) => `files[${String(index)}]${issue.path.length === 0 ? '' : `.${issue.path.join('.')}`}: ${issue.message}`) };
        if (checked.ok) { accepted.push(path); fillings.push(checked.value); }
        else errors.push({ path, errors: checked.errors });
    }
    // Несколько файлов одного блока должны применяться одной filling, иначе Map потеряет соседей.
    const grouped = new Map<number, ExplanationFilling>();
    for (const filling of fillings) {
        const previous = grouped.get(filling.planIndex);
        grouped.set(filling.planIndex, { ...filling, guidedFiles: [...(previous?.guidedFiles ?? []), ...(filling.guidedFiles ?? [])] });
    }
    return { accepted, errors, files: [...grouped.values()] };
}

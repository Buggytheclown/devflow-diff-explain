import type { FlowState, PrDiff, RouteSnapshot, SectionAssignment } from '@sherpa/protocol';
import { allFilesResultSchema } from '@sherpa/protocol';
import { validateArchitectureOverview, validateAllFiles } from './architecture-story.js';
import { rawEvidence } from './story-evidence.js';
import { stripCodeFence, parseResult } from './route/raw-result.js';
import type { RouteValidation } from './route/types.js';
import type { AcceptedExplanation, ExplanationFilling } from './story.js';

export interface ArchitectureCheckpoint { overview?: AcceptedExplanation; files: ExplanationFilling[] }

/** Один валидатор для файлов и повтора схемы; граф и связи обновляются вместе. */
export function validateArchitectureCheckpoint(raw: string, snapshot: RouteSnapshot, diff: PrDiff,
    assignment?: SectionAssignment, previousFlow?: FlowState | null, requireFlow = false): RouteValidation<ArchitectureCheckpoint> {
    let normalized = raw;
    try {
        const value: unknown = JSON.parse(stripCodeFence(raw));
        if (typeof value === 'object' && value !== null) {
            if ('summary' in value) normalized = JSON.stringify({ contractVersion: 6, overview: value });
            else if ('flow' in value && !('contractVersion' in value)) normalized = JSON.stringify({ contractVersion: 6, update: value });
        }
    } catch { /* parseResult даёт адресную ошибку JSON. */ }
    const parsed = parseResult(normalized, allFilesResultSchema, 'checkpoint');
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
    const files = validateAllFiles(JSON.stringify(body), diff, overview?.stops ?? snapshot.stops, assignment);
    if (!files.ok) return files;
    return { ok: true, value: { ...(overview === undefined ? {} : { overview }), files: files.value } };
}

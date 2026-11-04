import type { FileDiff, PrDiff, RawStoryEvidenceBlock, StoryEvidenceBlock, StoryExplanationEvidence, RouteSnapshot } from '@sherpa/protocol';

import { flowText } from '@sherpa/protocol';

import { sourceEvidence, sourceFileEvidence } from './saved-sources.js';
import { savedPatchIndex } from './saved-patch.js';
import type { RouteValidation } from './route/types.js';

/** Индекс строится один раз на результат, независимо от числа тезисов и ссылок. */
export function storyEvidenceResolver(diff: PrDiff) {
    const index = savedPatchIndex(diff);
    return (block: RawStoryEvidenceBlock, text: string): RouteValidation<StoryEvidenceBlock> => {
        const errors: string[] = [];
        const quotes = new Set<string>();
        const claims = block.claims.map((claim) => {
            if (claim.quote !== undefined && (!text.includes(claim.quote) || quotes.has(claim.quote))) errors.push(`Quote must occur in its paragraph and be unique: ${claim.quote}`);
            if (claim.quote !== undefined) quotes.add(claim.quote);
            const sources = claim.sources.flatMap((source) => {
                if (source.kind === 'lines' && source.sourceId !== undefined) {
                    const saved = sourceEvidence(diff, source);
                    if (saved === null) { errors.push(`Unknown pinned source: ${source.sourceId}`); return []; }
                    return [{ ...source, fileId: saved.id }];
                }
                if (source.kind === 'file' && source.sourceId !== undefined) {
                    const saved = sourceFileEvidence(diff, source);
                    if (saved === null) { errors.push(`Unknown pinned full source: ${source.sourceId}`); return []; }
                    return [{ ...source, fileId: saved.id }];
                }
                const file = index.file(source.path, source.kind === 'file' ? 'new' : source.side);
                if (file === null) { errors.push(`Source file is missing or ambiguous: ${source.path}. Import the pinned source before publishing this checkpoint.`); return []; }
                if (source.kind === 'lines' && index.range(file, source) === null) {
                    errors.push(`Source ${source.path}:${String(source.start)}-${String(source.end)} is not a complete ${source.side}-side range in the saved patch. Import the full source at this pinned revision before publishing.`);
                    return [];
                }
                return [{ ...source, fileId: file.fileId }];
            });
            return { ...claim, sources };
        });
        return errors.length > 0 ? { ok: false, errors } : { ok: true, value: { claims } };
    };
}

/** Копия соответствует всему тексту вопроса и не меняется при достраивании снапшота. */
export function explanationEvidence(snapshot: RouteSnapshot, focus?: string): StoryExplanationEvidence | undefined {
    if (snapshot.storyContractVersion === undefined || snapshot.summaryEvidence === undefined) return undefined;
    return { contractVersion: snapshot.storyContractVersion, introduction: snapshot.summaryEvidence,
        ...(snapshot.flow?.status === 'ready' ? { flow: snapshot.flow } : {}),
        sections: snapshot.stops.flatMap((stop) => [
            ...(stop.paragraph === null || stop.storyEvidence === undefined ? [] : [{ id: stop.id, evidence: stop.storyEvidence }]),
            ...(stop.example == null ? [] : [{ id: `${stop.id}:example`, evidence: stop.example.evidence }]),
            ...(stop.guidedFiles ?? []).flatMap((file) => file.example == null || focus !== `file:${file.fileId}` ? [] : [{ id: `file:${file.fileId}:example`, evidence: file.example.evidence }]),
        ]) };
}

/** Код извлекается из закреплённого патча, а не из текущего чекаута или текста модели. */
export function storyEvidenceContext(evidence: StoryExplanationEvidence, diff: PrDiff | null, focus?: string, diagramAlreadyShown = false): string {
    const index = savedPatchIndex(diff);
    const sections = [...evidence.sections].sort((a, b) => Number(b.id === focus) - Number(a.id === focus));
    const blocks = focus === undefined || focus === 'intro'
        ? [{ id: 'intro', evidence: evidence.introduction }, ...sections]
        : [...sections.filter((entry) => entry.id === focus), { id: 'intro', evidence: evidence.introduction }, ...sections.filter((entry) => entry.id !== focus)];
    // Реестр локален вопросу: snapshot/revision не смешиваются между задачами.
    const seen = new Map<string, string>();
    const emit = (key: string, description: string, body: readonly string[]): string[] => {
        const previous = seen.get(key);
        if (previous !== undefined) return [`Source ${previous}: ${description}`];
        const id = `S${String(seen.size + 1)}`;
        seen.set(key, id);
        return [`Source ${id}: ${description}`, ...body];
    };
    const range = (source: { path: string; side: 'old' | 'new'; start: number; end: number; sourceId?: string | undefined }) => {
        const file = index.file(source.path, source.side, true);
        const saved = source.sourceId === undefined ? null : sourceEvidence(diff, source);
        const lines = index.range(file, source);
        const canonicalPath = file === null ? source.path : source.side === 'old' ? file.oldPath ?? file.path : file.path;
        const description = `${canonicalPath} ${source.side}:${String(source.start)}-${String(source.end)}`;
        // Неразрешённый sourceId не становится доказательством по совпадению пути.
        if (source.sourceId !== undefined && saved === null) return emit(JSON.stringify(['saved', source.sourceId, source.side, source.start, source.end]), description, [`Saved revision source: ${source.sourceId} (${source.path}); resolve using the pinned source index.`]);
        const key = JSON.stringify([canonicalPath, source.side, source.start, source.end]);
        if (saved !== null) return emit(key, description, [`Saved revision source: ${saved.id} (${saved.path})`, ...saved.text.split('\n').slice(source.start - saved.start, source.end - saved.start + 1)]);
        return lines === null ? [`[UNAVAILABLE: saved range ${description}]`] : emit(key, description,
            lines.map((line) => `${String(line.old ?? '.')} ${String(line.new ?? '.')} | ${line.raw.slice(1)}`));
    };
    const flow = evidence.flow;
    const flowContext = flow === undefined ? [] : ['# Saved architecture evidence', ...(diagramAlreadyShown ? [] : [flowText(flow)]),
        ...[...flow.diagram.nodes.map((node) => ({ ...node, owner: `Node ${node.id}` })),
        ...flow.diagram.edges.map((edge) => ({ ...edge, owner: 'id' in edge ? `Edge ${edge.id}` : `Edge ${edge.from} -> ${edge.to}: ${edge.label}` }))].flatMap((item) => [item.owner,
            ...item.sources.flatMap((source) => source.kind === 'patch' ? range(source) : [`Saved flow context: ${source.id}`])]),
        ...flow.contexts.flatMap((context) => [`Flow context ${context.id}: ${context.path} @ ${context.revision}:${String(context.start)}-${String(context.end)}`, context.text])];
    return [...flowContext, '# Saved explanation evidence', ...blocks.flatMap((block) => [`## ${block.id}`,
        ...block.evidence.claims.flatMap((claim) => [
            ...(claim.quote === undefined ? [] : [`Claim: ${claim.quote}`]),
            ...(claim.limitation === null ? [] : [`Evidence limit: ${claim.limitation}`]),
            ...claim.sources.flatMap((source) => {
                if (source.kind === 'lines') return range(source);
                if (source.sourceId !== undefined) {
                    const saved = sourceFileEvidence(diff, source);
                    return emit(`saved-file:${source.sourceId}`, source.path, saved === null
                        ? [`[UNAVAILABLE: saved full source ${source.sourceId}]`]
                        : [`Saved full revision source: ${saved.id} (${saved.path}) @ ${saved.revision}; read through the pinned source index.`]);
                }
                const file = index.byId(source.fileId);
                return file === null ? [`[UNAVAILABLE: saved source ${source.path}]`] : emit(`file:${file.fileId}`, source.path, [fileMetadata(file)]);
            }),
        ]),
    ])].join('\n');
}

function fileMetadata(file: FileDiff): string {
    return `File: ${file.path}; old path: ${file.oldPath ?? file.path}; change: ${file.changeType}; binary: ${String(file.binary)}\n${file.patch?.split('@@')[0] ?? '[No textual patch]'}`;
}

/** Служебный fileId принадлежит хранилищу, а не входному контракту модели. */
export function rawEvidence(block: StoryEvidenceBlock | undefined): RawStoryEvidenceBlock | undefined {
    return block === undefined ? undefined : { claims: block.claims.map((claim) => ({ ...claim,
        sources: claim.sources.map((source) => source.kind === 'file'
            ? { kind: 'file', path: source.path }
            : { kind: 'lines', path: source.path, side: source.side, start: source.start, end: source.end, ...(source.sourceId === undefined ? {} : { sourceId: source.sourceId }) }),
    })) };
}

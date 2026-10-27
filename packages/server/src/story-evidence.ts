import type { FileDiff, PrDiff, RawStoryEvidenceBlock, StoryEvidenceBlock, StoryExplanationEvidence, RouteSnapshot } from '@sherpa/protocol';

import { savedPatchIndex } from './saved-patch.js';
import type { RouteValidation } from './route/types.js';

/** Индекс строится один раз на результат, независимо от числа тезисов и ссылок. */
export function storyEvidenceResolver(diff: PrDiff) {
    const index = savedPatchIndex(diff);
    return (block: RawStoryEvidenceBlock, text: string): RouteValidation<StoryEvidenceBlock> => {
        const errors: string[] = [];
        const quotes = new Set<string>();
        const claims = block.claims.map((claim) => {
            if (!text.includes(claim.quote) || quotes.has(claim.quote)) errors.push(`Quote must occur in its paragraph and be unique: ${claim.quote}`);
            quotes.add(claim.quote);
            const sources = claim.sources.flatMap((source) => {
                const file = index.file(source.path, source.kind === 'file' ? 'new' : source.side);
                if (file === null) { errors.push(`Source file is missing or ambiguous: ${source.path}`); return []; }
                if (source.kind === 'lines' && index.range(file, source) === null) {
                    errors.push(`Source ${source.path}:${String(source.start)}-${String(source.end)} is not a complete ${source.side}-side range in the saved patch.`);
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
export function storyEvidenceContext(evidence: StoryExplanationEvidence, diff: PrDiff | null, focus?: string): string {
    const index = savedPatchIndex(diff);
    const sections = [...evidence.sections].sort((a, b) => Number(b.id === focus) - Number(a.id === focus));
    const blocks = focus === undefined || focus === 'intro'
        ? [{ id: 'intro', evidence: evidence.introduction }, ...sections]
        : [...sections.filter((entry) => entry.id === focus), { id: 'intro', evidence: evidence.introduction }, ...sections.filter((entry) => entry.id !== focus)];
    return [...(evidence.flow === undefined ? [] : ['# Saved data-flow context', JSON.stringify(evidence.flow), ...[...evidence.flow.diagram.nodes, ...evidence.flow.diagram.edges].flatMap((item) => item.sources.flatMap((source) => {
        if (source.kind !== 'patch') return [];
        const lines = index.range(index.file(source.path, source.side), source);
        return lines === null ? [`[UNAVAILABLE: saved flow range ${source.path}]`] : [`Flow source: ${source.path} ${source.side}:${String(source.start)}-${String(source.end)}`, ...lines.map((line) => line.raw)];
    }))]), '# Saved explanation evidence', '', ...blocks.flatMap((block) => [`## ${block.id}`, '', ...block.evidence.claims.flatMap((claim) => [
        `Claim: ${claim.quote}`, ...(claim.limitation === null ? [] : [`Evidence limit: ${claim.limitation}`]),
        ...claim.sources.flatMap((source) => {
            const file = index.byId(source.fileId);
            if (file === null) return [`[UNAVAILABLE: saved source ${source.path}]`];
            if (source.kind === 'file') return [fileMetadata(file)];
            const lines = index.range(file, source);
            if (lines === null) return [`[UNAVAILABLE: saved range ${source.path}]`];
            return [`File: ${source.path}; side: ${source.side}; lines ${String(source.start)}-${String(source.end)}`,
                ...lines.map((line) => `${String(line.old ?? '.')} ${String(line.new ?? '.')} | ${line.raw.slice(1)}`)];
        }), '',
    ])])].join('\n');
}

function fileMetadata(file: FileDiff): string {
    return `File: ${file.path}; old path: ${file.oldPath ?? file.path}; change: ${file.changeType}; binary: ${String(file.binary)}\n${file.patch?.split('@@')[0] ?? '[No textual patch]'}`;
}

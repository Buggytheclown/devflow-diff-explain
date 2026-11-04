import type { FlowDiagram, PrDiff, FlowContext } from '@sherpa/protocol';
import { sourceEvidence } from './saved-sources.js';
import { savedPatchIndex } from './saved-patch.js';

/** Проверяем существование каждой цитируемой строки и сохранённую ревизию. */
export function diagramSourceErrors(diagram: FlowDiagram, diff: PrDiff, contexts: readonly FlowContext[]): string[] {
    const errors: string[] = [];
    const index = savedPatchIndex(diff);
    for (const item of [...diagram.nodes, ...diagram.edges]) {
        for (const source of item.sources) {
            if (source.kind === 'context') {
                if (!contexts.some((entry) => entry.id === source.id && entry.revision === diff.headCommit)) errors.push(`Unknown saved context: ${source.id}`);
                continue;
            }
            if (source.sourceId !== undefined) {
                if (sourceEvidence(diff, source) === null) errors.push(`Unknown pinned source: ${source.sourceId}`);
                continue;
            }
            const lines = index.range(index.file(source.path, source.side), source);
            if (lines === null) errors.push(`Unavailable saved patch lines: ${source.path}:${String(source.start)}-${String(source.end)}`);
        }
    }
    return errors;
}

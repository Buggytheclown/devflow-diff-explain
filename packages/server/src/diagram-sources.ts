import type { FlowDiagram, PrDiff, FlowContext } from '@sherpa/protocol';
import { savedPatchIndex } from './saved-patch.js';

/** Проверяем наличие всех строк, а не только попадание концов в разные ханки. */
export function diagramSourceErrors(diagram: FlowDiagram, diff: PrDiff, contexts: readonly FlowContext[]): string[] {
    const errors: string[] = [];
    const index = savedPatchIndex(diff);
    for (const item of [...diagram.nodes, ...diagram.edges]) {
        let changed = false;
        for (const source of item.sources) {
            if (source.kind === 'context') {
                if (!contexts.some((entry) => entry.id === source.id && entry.revision === diff.headCommit)) errors.push(`Unknown saved context: ${source.id}`);
                continue;
            }
            const lines = index.range(index.file(source.path, source.side), source);
            if (lines === null) errors.push(`Unavailable saved patch lines: ${source.path}:${String(source.start)}-${String(source.end)}`);
            changed ||= lines?.some((line) => line.changed) ?? false;
        }
        if ((item.change === 'added' || item.change === 'modified') && !changed) errors.push('PR changes need supporting changed patch lines.');
    }
    return errors;
}

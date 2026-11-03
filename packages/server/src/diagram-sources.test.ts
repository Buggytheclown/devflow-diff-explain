import { it, expect } from 'vitest';
import { readableStoryFixture } from '@sherpa/fixtures';
import { diagramSourceErrors } from './diagram-sources.js';

it('проверяет полные диапазоны и требует изменённые строки для отметок PR', () => {
    const legacy = readableStoryFixture(); const graph = structuredClone(legacy.diagram);
    const changed = graph.nodes[1]; if (changed === undefined) throw new Error('Missing node');
    changed.sources = [{ kind: 'patch', path: legacy.first.path, side: 'new', start: 99999, end: 100000 }];
    expect(diagramSourceErrors(graph, legacy.diff, [])).not.toHaveLength(0);
    changed.sources = [{ kind: 'context', id: 'external' }];
    expect(diagramSourceErrors(graph, legacy.diff, [{ id: 'external', path: 'x.ts', start: 1, end: 1, text: 'saved', revision: legacy.diff.headCommit }])).toContain('PR changes need supporting changed patch lines.');
});

import { it, expect } from 'vitest';
import { readableStoryFixture } from '@sherpa/fixtures';
import { diagramSourceErrors } from './diagram-sources.js';

it('проверяет диапазон и ревизию источника, не выводя смысл из типа строки', () => {
    const legacy = readableStoryFixture(); const graph = structuredClone(legacy.diagram);
    const changed = graph.nodes[1]; if (changed === undefined) throw new Error('Missing node');
    changed.sources = [{ kind: 'patch', path: legacy.first.path, side: 'new', start: 99999, end: 100000 }];
    expect(diagramSourceErrors(graph, legacy.diff, [])).not.toHaveLength(0);
    changed.sources = [{ kind: 'context', id: 'external' }];
    expect(diagramSourceErrors(graph, legacy.diff, [{ id: 'external', path: 'x.ts', start: 1, end: 1, text: 'saved', revision: legacy.diff.headCommit }])).toEqual([]);
    expect(diagramSourceErrors(graph, legacy.diff, [{ id: 'external', path: 'x.ts', start: 1, end: 1, text: 'saved', revision: 'wrong' }])).not.toEqual([]);
});

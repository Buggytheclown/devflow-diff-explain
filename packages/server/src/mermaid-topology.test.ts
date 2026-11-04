import { expect, it } from 'vitest';
import { mermaidTopology } from './mermaid-topology.js';

it('извлекает только настоящие ID, группы и параллельные связи', () => {
    const parsed = mermaidTopology(`flowchart TB
%% ghost is a comment
subgraph G[ghost in a group label]
 A[ghost in a node label] -->|first| B
 A -->|second| B
end`);
    expect([...parsed.nodes.keys()]).toEqual(['A', 'B']);
    expect([...parsed.groups.keys()]).toEqual(['G']);
    expect(parsed.nodes.has('ghost')).toBe(false);
    expect(parsed.edges).toHaveLength(2);
    expect(new Set(parsed.edges.map((edge) => edge.id)).size).toBe(2);
});

it('каждый раз создаёт новую базу даже после синтаксической ошибки', () => {
    expect(mermaidTopology('flowchart TB\n A --> B').nodes.has('A')).toBe(true);
    expect(() => mermaidTopology('flowchart TB\n A -->')).toThrow();
    expect([...mermaidTopology('flowchart TB\n C["A"]').nodes.keys()]).toEqual(['C']);
});

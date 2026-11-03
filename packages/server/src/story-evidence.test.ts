import { rawStoryEvidenceBlockSchema, routeSnapshotSchema } from '@sherpa/protocol';
import type { PrDiff, RawStoryEvidenceBlock, RouteSnapshot } from '@sherpa/protocol';
import { expect, it } from 'vitest';

import { mediumDiff, mediumReadySnapshot } from './route/fixture-support.js';
import { contentHashOf } from './route-store.js';
import { explanationEvidence, storyEvidenceContext, storyEvidenceResolver, rawEvidence } from './story-evidence.js';

const base = mediumDiff();
const original = base.files[0];
if (original === undefined) throw new Error('Missing fixture');
const diff: PrDiff = { ...base, files: [{ ...original, fileId: 'a', path: 'src/new.ts', oldPath: 'src/old.ts', patch: '@@ -1,2 +1,2 @@\n-before()\n+after()\n shared()\n' },
    { ...original, fileId: 'b', path: 'src/notify.ts', oldPath: null, patch: '@@ -1 +1 @@\n-notifyFirst()\n+notifyAfterSave()\n' }] };
const block: RawStoryEvidenceBlock = { claims: [{ quote: 'Меняется порядок.', sources: [
    { kind: 'lines', path: 'src/old.ts', side: 'old', start: 1, end: 1 },
    { kind: 'lines', path: 'src/notify.ts', side: 'new', start: 1, end: 1 },
], limitation: null }] };

it('разрешает старое имя и разные файлы, проверяет весь диапазон, цитату и структуру', () => {
    const resolve = storyEvidenceResolver(diff);
    expect(resolve(block, 'Меняется порядок.')).toMatchObject({ ok: true, value: { claims: [{ sources: [{ fileId: 'a' }, { fileId: 'b' }] }] } });
    expect(resolve(block, 'Другая фраза.').ok).toBe(false);
    const wrong = structuredClone(block);
    const source = wrong.claims[0]?.sources[0];
    if (source?.kind !== 'lines') throw new Error('No range');
    source.end = 3;
    expect(resolve(wrong, 'Меняется порядок.').ok).toBe(false);
    source.end = 1; source.side = 'new';
    expect(resolve(wrong, 'Меняется порядок.').ok).toBe(false);
    expect(rawStoryEvidenceBlockSchema.safeParse({ claims: [{ quote: 'x', sources: [], limitation: null }] }).success).toBe(false);
    expect(rawStoryEvidenceBlockSchema.safeParse({ ...block, claimId: 'missing' }).success).toBe(false);
    const claim = block.claims[0];
    if (claim === undefined) throw new Error('No claim');
    expect(resolve({ claims: [claim, claim] }, 'Меняется порядок.').ok).toBe(false);
});

it('передаёт фактический код обеих сторон и файлов, а копия не растёт после достройки', () => {
    const accepted = storyEvidenceResolver(diff)(block, 'Меняется порядок.');
    if (!accepted.ok) throw new Error(accepted.errors.join('\n'));
    const snapshot: RouteSnapshot = { ...mediumReadySnapshot(), presentation: 'story' as const, storyContractVersion: 2 as const,
        summaryEvidence: accepted.value, stops: [] };
    const saved = explanationEvidence(snapshot);
    if (saved === undefined) throw new Error('No evidence');
    const text = storyEvidenceContext(saved, diff);
    expect(text).toContain('1 . | before()');
    expect(text).toContain('. 1 | notifyAfterSave()');
    expect(text).not.toContain('notifyFirst()');
    snapshot.stops = mediumReadySnapshot().stops.map((stop) => ({ ...stop, storyEvidence: accepted.value }));
    expect(saved.sections).toHaveLength(0);
    expect(explanationEvidence(snapshot)?.sections.length).toBeGreaterThan(0);
});

it('сохраняет чтение старого снапшота, а v2 требует основания и учитывает их в хеше', () => {
    const old = mediumReadySnapshot();
    expect(contentHashOf(routeSnapshotSchema.parse(old))).toBe(contentHashOf(old));
    expect(routeSnapshotSchema.safeParse({ ...old, presentation: 'story', storyContractVersion: 2 }).success).toBe(false);
    const accepted = storyEvidenceResolver(diff)(block, 'Меняется порядок.');
    if (!accepted.ok) throw new Error('Invalid source');
    const modern = { ...old, presentation: 'story' as const, storyContractVersion: 2 as const, summaryEvidence: accepted.value,
        stops: old.stops.map((stop) => ({ ...stop, storyEvidence: accepted.value })) };
    expect(routeSnapshotSchema.safeParse(modern).success).toBe(true);
    const claim = accepted.value.claims[0];
    if (claim === undefined) throw new Error('No claim');
    expect(contentHashOf(modern)).not.toBe(contentHashOf({ ...modern, summaryEvidence: { claims: [{ ...claim, limitation: 'Other evidence limit.' }] } }));
});

it('повтор схемы преобразует сохранённые источники во входной контракт без служебных ID', () => {
    const accepted = storyEvidenceResolver(diff)(block, 'Меняется порядок.');
    if (!accepted.ok) throw new Error('Invalid evidence');
    expect(rawStoryEvidenceBlockSchema.parse(rawEvidence(accepted.value))).toEqual(block);
    const withoutQuote = { claims: [{ sources: block.claims[0]?.sources ?? [], limitation: null }] };
    expect(storyEvidenceResolver(diff)(rawStoryEvidenceBlockSchema.parse(withoutQuote), 'Краткое объяснение.').ok).toBe(true);
});


it('выводит общий диапазон один раз, сохраняя владельцев и различая стороны', () => {
    const accepted = storyEvidenceResolver(diff)(block, 'Меняется порядок.');
    if (!accepted.ok) throw new Error('Invalid fixture');
    const evidence = {
        contractVersion: 6 as const, introduction: accepted.value, sections: [{ id: 'second', evidence: accepted.value }],
        flow: { status: 'ready' as const, contexts: [], diagram: {
            title: 'Process', mermaid: 'flowchart LR\nworker[Worker] --> out[Output]', views: [], edges: [],
            nodes: [{ id: 'worker', label: 'Worker', change: 'modified' as const, limitation: null,
                sources: [{ kind: 'patch' as const, path: 'src/old.ts', side: 'old' as const, start: 1, end: 1 }] }],
        } },
    };
    const text = storyEvidenceContext(evidence, diff);
    expect(text.match(/1 \. \| before\(\)/g)).toHaveLength(1);
    expect(text).toContain('Node worker\nSource S1: src/old.ts old:1-1');
    expect(text).toContain('## intro\nClaim: Меняется порядок.\nSource S1:');
    expect(text).toContain('## second\nClaim: Меняется порядок.\nSource S1:');
    expect(text.match(/flowchart LR/g)).toHaveLength(1);
    expect(storyEvidenceContext(evidence, diff, undefined, true)).not.toContain('flowchart LR');
    evidence.introduction.claims.push({ sources: [{ kind: 'lines', fileId: 'a', path: 'src/new.ts', side: 'new', start: 1, end: 1 }], limitation: null });
    const both = storyEvidenceContext(evidence, diff);
    expect(both).toContain('after()');
    expect(both).toContain('before()');
    expect(both.length).toBeLessThan(JSON.stringify(evidence.flow).length + 2000);
});


it('сохраняет legacy contexts, ограничения и адреса импортированных источников', () => {
    const evidence = {
        contractVersion: 2 as const, sections: [], introduction: { claims: [{ limitation: 'Not wired', sources: [
            { kind: 'lines' as const, fileId: 'saved', sourceId: 'source-1', path: 'extra.py', side: 'new' as const, start: 5, end: 6 },
        ] }] },
        flow: { status: 'ready' as const, contexts: [{ id: 'ctx', path: 'extra.py', revision: 'revision-old', start: 5, end: 6, text: 'legacy source bytes' }],
            diagram: { title: 'Legacy', nodes: [{ id: 'unknown', label: 'Unknown', change: 'unknown' as const, limitation: 'No caller', sources: [{ kind: 'context' as const, id: 'ctx' }] }], edges: [] } },
    };
    const text = storyEvidenceContext(evidence, null);
    expect(text).toContain('Saved revision source: source-1 (extra.py)');
    expect(text).toContain('Flow context ctx: extra.py @ revision-old:5-6\nlegacy source bytes');
    expect(text).toContain('No caller');
    expect(text).toContain('Evidence limit: Not wired');
});

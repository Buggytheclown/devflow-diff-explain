import { rawStoryEvidenceBlockSchema, routeSnapshotSchema } from '@sherpa/protocol';
import type { PrDiff, RawStoryEvidenceBlock, RouteSnapshot } from '@sherpa/protocol';
import { expect, it } from 'vitest';

import { mediumDiff, mediumReadySnapshot } from './route/fixture-support.js';
import { contentHashOf } from './route-store.js';
import { explanationEvidence, storyEvidenceContext, storyEvidenceResolver } from './story-evidence.js';

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

import { expect, it } from 'vitest';
import { allFilesWorkerResultSchema, checkpointEnvelopeSchema } from './route.js';

const evidence = { sources: [], limitation: 'No saved line supports this statement.' };
const overview = {
    contractVersion: 6, summary: 'Overview', evidence,
    flow: { status: 'not_applicable', reason: 'No process diagram applies.' },
    stops: [{ title: 'Block', paragraph: 'Explanation', evidence, nodeIds: [], files: ['a.ts'], relatedFiles: [] }],
};

it('выдаваемая схема и приёмочный envelope одинаково запрещают пустой update и overview вместе с update', () => {
    for (const schema of [allFilesWorkerResultSchema, checkpointEnvelopeSchema]) {
        expect(schema.safeParse({ contractVersion: 6, update: {} }).success).toBe(false);
        expect(schema.safeParse({ contractVersion: 6, overview, update: { summary: 'Correction' } }).success).toBe(false);
        expect(schema.safeParse({ contractVersion: 6, overview }).success).toBe(true);
    }
});

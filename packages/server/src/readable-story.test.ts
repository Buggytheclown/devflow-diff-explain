import { expect, it } from 'vitest';
import { readableStoryFixture } from '@sherpa/fixtures';
import { readableSectionResultSchema, readableSkeletonResultSchema, routeSnapshotSchema } from '@sherpa/protocol';
import { validateStorySection, storyGuide } from './story.js';

const fixture = readableStoryFixture();
it('принимает короткие пояснения с необязательными примерами и ограничивает общий объём', () => {
    expect(readableSkeletonResultSchema.safeParse(fixture.outline).success).toBe(true);
    expect(readableSectionResultSchema.safeParse(fixture.body).success).toBe(true);
    expect(routeSnapshotSchema.safeParse(fixture.snapshot).success).toBe(true);
    const long = { ...fixture.body, stops: fixture.body.stops.map((stop, i) => i === 0 ? { ...stop, paragraph: 'я'.repeat(400), example: { text: 'я'.repeat(260), evidence: fixture.example.evidence } } : stop) };
    expect(readableSectionResultSchema.safeParse(long).success).toBe(false);
    expect(readableSkeletonResultSchema.safeParse({ ...fixture.outline, summary: 'я'.repeat(501) }).success).toBe(false);
});
it('отклоняет выдуманный диапазон примера и подмену нового контракта старым', () => {
    const body = { ...fixture.body, stops: fixture.body.stops.map((stop, i) => ({ ...stop, files: stop.files.map((file, j) => i === 0 && j === 0 ? { ...file, example: { text: fixture.example.text, evidence: { claims: [{ quote: fixture.example.text, limitation: null, sources: [{ kind: 'lines', path: fixture.first.path, side: 'new', start: 99999, end: 99999 }] }] } } } : file) })) };
    expect(validateStorySection(JSON.stringify(body), [1, 2], fixture.diff, 'ru', fixture.snapshot.stops, 4).ok).toBe(false);
    expect(validateStorySection(JSON.stringify({ ...body, contractVersion: 3 }), [1, 2], fixture.diff, 'ru', fixture.snapshot.stops, 4).ok).toBe(false);
});
it('промпт сохраняет важные условия и не требует примеров для механических правок', () => {
    const guide = storyGuide('section', 'ru');
    expect(guide).toContain('only permits retries');
    expect(guide).toContain('not imply live integration');
    expect(guide).toContain('example: null');
    expect(guide).toContain('one or two short sentences');
});

it('не смешивает сохранённый внешний контекст с другой ревизией', () => {
    const snapshot = { ...fixture.snapshot, flow: { status: 'ready', diagram: fixture.diagram, contexts: [{ id: 'external', path: 'caller.ts', start: 1, end: 1, text: 'caller()', revision: 'another-head' }] } };
    expect(routeSnapshotSchema.safeParse(snapshot).success).toBe(false);
});

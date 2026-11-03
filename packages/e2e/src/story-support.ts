import { routeFixtures, readableStoryFixture } from '@sherpa/fixtures';
import { storyEvidenceBlockSchema, routeSnapshotSchema, rawStoryEvidenceBlockSchema } from '@sherpa/protocol';
import type { PrDiff } from '@sherpa/protocol';

const anchor = routeFixtures('medium')?.rawResults?.sections[0]?.stops[0]?.anchors[0];
if (anchor === undefined) throw new Error('Missing code fixture');
export const codeReference = anchor;
export const evidenceSource = { kind: 'lines' as const, path: anchor.path, side: anchor.side, start: anchor.start, end: Math.min(anchor.end, anchor.start + 8) };
/** Фикстура механики UI; смысл рассказов проверяется отдельно реальной генерацией в qa/. */
export const evidence = (quote: string) => ({ claims: [{ quote, sources: [evidenceSource], limitation: null }] });
const summary = 'ПР меняет порядок записи и обновления кэша.';
export const outline = { contractVersion: 2, summary, evidence: evidence(summary), stops: [
    { title: 'Запись до уведомления', intent: 'Объяснить новое поведение.' },
    { title: 'Проверка ошибок', intent: 'Объяснить, что проверено тестами.' },
] };
export const body = { contractVersion: 2, stops: [
    { planIndex: 1, paragraph: 'Сначала завершается запись. Кэш обновляется после успешного сохранения.', evidence: evidence('Кэш обновляется после успешного сохранения.') },
    { planIndex: 2, paragraph: 'Тесты проверяют успешную запись и откат при ошибке.', evidence: evidence('Тесты проверяют успешную запись и откат при ошибке.') },
] };

/** Настоящая запись прежнего v2; новые worker-задания этот формат не производят. */
export function savedStory(content: { stops: { paragraph: string; evidence: unknown }[] } = body, introduction: { summary: string; evidence: unknown; stops: { title: string }[] } = outline) {
    const fixture = readableStoryFixture();
    const normalize = (raw: unknown) => {
        const value = rawStoryEvidenceBlockSchema.parse(raw);
        return storyEvidenceBlockSchema.parse({ claims: value.claims.map((claim) => ({ ...claim,
            sources: claim.sources.map((source) => ({ ...source, fileId: fixture.diff.files.find((file) => file.path === source.path)?.fileId })),
        })) });
    };
    const { flow: _flow, ...base } = fixture.snapshot;
    return routeSnapshotSchema.parse({ ...base, snapshotId: 'saved-legacy-v2', storyContractVersion: 2,
        summary: introduction.summary, summaryEvidence: normalize(introduction.evidence),
        stops: content.stops.map((block, index) => {
            const source = fixture.snapshot.stops[index]; if (source === undefined) throw new Error('Missing block');
            const { guidedFiles: _files, nodeIds: _nodes, ...stop } = source;
            return { ...stop, title: introduction.stops[index]?.title, paragraph: block.paragraph, storyEvidence: normalize(block.evidence) };
        }) });
}

export function currentStory(diff: PrDiff) {
    const limit = { sources: [], limitation: 'Synthetic fixture for navigation, not semantic PR validation.' };
    return { outline: { contractVersion: 6, summary: outline.summary, evidence: limit,
        flow: { status: 'not_applicable', reason: 'Фикстура переходов между версиями.' },
        stops: body.stops.map((block, index) => ({ title: outline.stops[index]?.title, paragraph: block.paragraph, evidence: limit, nodeIds: [],
            files: diff.files.filter((_file, i) => index === 0 ? i < Math.ceil(diff.files.length / 2) : i >= Math.ceil(diff.files.length / 2)).map((file) => file.path), relatedFiles: [] })) },
        body: { contractVersion: 6, files: diff.files.map((file) => ({ path: file.path, explanation: 'Фикстурное пояснение изменения.' })) } };
}

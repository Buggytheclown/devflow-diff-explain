import { reviewProjection } from './explanation-compat.js';
import { describe, expect, it } from 'vitest';
import { explanationText, routeSnapshotSchema } from '@sherpa/protocol';
import { mediumDiff, mediumReadySnapshot } from './route/fixture-support.js';
import { walkPatch } from './route/diff-index.js';
import { validateStorySkeleton, validateStorySection } from './story.js';

const diff = mediumDiff();
const summary = 'Сервис обрабатывает изменение заказа.';
const evidence = (quote: string) => ({ claims: [{ quote, sources: [], limitation: 'Synthetic fixture: lifecycle and address validation only.' }] });
const paths = diff.files.map((file) => file.path).reverse();
const outline = { contractVersion: 3, summary, evidence: evidence(summary), stops: [
    { title: 'Основной путь', intent: 'Объяснить зависимости по порядку.', files: paths.slice(0, 2), relatedFiles: [paths[2]] },
    { title: 'Остальные изменения', intent: 'Объяснить остальные файлы.', files: paths.slice(2), relatedFiles: [] },
] };
function accepted() {
    const result = validateStorySkeleton(JSON.stringify(outline), diff, 'ru');
    if (!result.ok) throw new Error(result.errors.join('\n'));
    return { ...result.value, stops: result.value.stops.map(reviewProjection) };
}
function section() { return { contractVersion: 3, stops: accepted().stops.map((stop) => ({ planIndex: stop.planIndex,
    paragraph: 'Обработчик использует обновлённый контракт.', evidence: evidence('Обработчик использует обновлённый контракт.'),
    files: stop.guidedFiles?.map((file) => ({ path: file.path, explanation: 'Этот файл задаёт часть обработки заказа.', annotations: [] })),
})) }; }

describe('guided diff contract', () => {
    it('freezes explanatory order, gives every file one home and keeps cross-links', () => {
        const plan = accepted();
        expect(plan.storyContractVersion).toBe(3);
        expect(plan.stops.flatMap((stop) => stop.guidedFiles?.map((file) => file.path) ?? [])).toEqual(paths);
        expect(plan.stops[0]?.relatedFiles?.[0]?.path).toBe(paths[2]);
        expect(plan.stops.every((stop) => stop.guidedFiles?.every((file) => file.explanation === null))).toBe(true);
        const snapshot = { ...mediumReadySnapshot(), presentation: 'story', storyContractVersion: 3, summary, summaryEvidence: evidence(summary), stops: plan.stops, tourOrder: plan.tourOrder };
        expect(routeSnapshotSchema.safeParse(snapshot).success).toBe(true);
    });
    it('rejects missing, duplicated and invented primary files', () => {
        for (const files of [paths.slice(1), [...paths, paths[0]], [...paths.slice(1), 'missing.ts']]) {
            const result = validateStorySkeleton(JSON.stringify({ ...outline, stops: [{ ...outline.stops[0], files, relatedFiles: [] }] }), diff, 'ru');
            expect(result.ok).toBe(false);
        }
    });
    it('requires every assigned file in its original order, including explicit empty annotations', () => {
        const result = validateStorySection(JSON.stringify(section()), [1, 2], diff, 'ru', accepted().stops);
        expect(result.ok).toBe(true);
        const wrong = section(); wrong.stops[0]?.files?.reverse();
        expect(validateStorySection(JSON.stringify(wrong), [1, 2], diff, 'ru', accepted().stops).ok).toBe(false);
    });
    it('accepts only annotation ranges completely present in the pinned patch', () => {
        const plan = accepted(); const content = section();
        const file = content.stops.flatMap((stop) => stop.files ?? []).find((entry) => diff.files.find((source) => source.path === entry.path)?.patch != null);
        if (file === undefined) throw new Error('Missing text fixture');
        const source = diff.files.find((entry) => entry.path === file.path);
        const row = [...walkPatch(source?.patch ?? '')].find((line) => line.new !== null);
        if (row?.new == null) throw new Error('Missing patch line');
        const withNote = (start: number) => JSON.stringify({ ...content, stops: content.stops.map((stop) => ({ ...stop, files: stop.files?.map((entry) => entry === file ? { ...entry, annotations: [{ side: 'new', start, end: start, text: 'Здесь обработчик выбирает дальнейшее действие.' }] } : entry) })) });
        expect(validateStorySection(withNote(row.new), [1, 2], diff, 'ru', plan.stops).ok).toBe(true);
        expect(validateStorySection(withNote(999999), [1, 2], diff, 'ru', plan.stops).ok).toBe(false);
    });
    it('pins file and local explanations in chat without copying all file descriptions into every question', () => {
        const plan = accepted(); const file = plan.stops[0]?.guidedFiles?.[0];
        if (file === undefined) throw new Error('Missing file');
        file.explanation = 'Контракт задаёт границу обработки.';
        const snapshot = { ...mediumReadySnapshot(), stops: plan.stops, tourOrder: plan.tourOrder };
        expect(explanationText(snapshot, `file:${file.fileId}`)).toContain(file.explanation);
        expect(explanationText(snapshot)).not.toContain(file.explanation);
    });
});

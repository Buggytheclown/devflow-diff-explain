import { z } from 'zod';
import type { ExplanationBlock, ReadableExample, GuidedFile, Locale, PrDiff, StoryEvidenceBlock, SectionAssignment, FlowState } from '@sherpa/protocol';
import { overviewSkeletonResultSchema, progressiveSectionResultSchema, readableSkeletonResultSchema, readableSectionResultSchema, guidedSkeletonResultSchema, guidedSectionResultSchema, storySkeletonResultSchema, storySectionResultSchema } from '@sherpa/protocol';

import { savedPatchIndex } from './saved-patch.js';
import { storyEvidenceResolver } from './story-evidence.js';
import { markupErrors, paragraphMarkupErrors } from './route/paragraph-markup.js';
import { parseResult } from './route/raw-result.js';
import type { RouteValidation } from './route/types.js';
import { voiceErrors } from './route/voice.js';
import { validateArchitectureOverview, validateAllFiles } from './architecture-story.js';
import { stripCodeFence } from './route/raw-result.js';

/** Принятый план и заполнение не зависят от модели ревью. */
export interface AcceptedExplanation {
    summary: string; storyContractVersion: 2 | 3 | 4 | 5 | 6; summaryEvidence: StoryEvidenceBlock; flow?: FlowState;
    stops: ExplanationBlock[]; tourOrder: string[]; intents: Map<number, string>;
}
export interface ExplanationFilling {
    planIndex: number; paragraph: string | null; storyEvidence?: StoryEvidenceBlock; partial?: boolean;
    guidedFiles?: GuidedFile[]; example?: ReadableExample | null;
}
export function validateStorySkeleton(raw: string, diff: PrDiff, locale: Locale): RouteValidation<AcceptedExplanation> {
    try { if ((JSON.parse(stripCodeFence(raw)) as { contractVersion?: unknown }).contractVersion === 6) return validateArchitectureOverview(raw, diff); } catch { /* Общий разбор ниже возвращает точную ошибку JSON. */ }
    const parsed = parseResult(raw, z.union([overviewSkeletonResultSchema, readableSkeletonResultSchema, guidedSkeletonResultSchema, storySkeletonResultSchema]), 'story outline');
    if (!parsed.ok) return parsed;
    const evidence = storyEvidenceResolver(diff)(parsed.value.evidence, parsed.value.summary);
    if (!evidence.ok) return evidence;
    const outline = parsed.value;
    const errors = [
        ...voiceErrors('skeleton.summary', outline.summary, locale),
        ...markupErrors('skeleton.summary', 'summary', outline.summary),
        ...outline.stops.flatMap((stop, index) => voiceErrors(`skeleton.stops[${String(index)}].title`, stop.title, locale)),
    ];
    const owners = new Set<string>();
    const stops: ExplanationBlock[] = outline.stops.map((planned, index) => {
        const stop: ExplanationBlock = { id: `s${String(index + 1).padStart(2, '0')}`, planIndex: index + 1, title: planned.title, status: 'queued', paragraph: null, validationNotes: [], provenance: null };
        if (!('files' in planned)) return stop;
        const resolveFile = (filePath: string) => {
            const file = diff.files.find((entry) => entry.path === filePath);
            if (file === undefined) errors.push(`Unknown canonical changed-file path: ${filePath}.`);
            return file === undefined ? [] : [{ fileId: file.fileId, path: file.path }];
        };
        const files = planned.files.flatMap(resolveFile);
        for (const file of files) {
            if (owners.has(file.fileId)) errors.push(`Assign ${file.path} to exactly one block; use relatedFiles for cross-links.`);
            owners.add(file.fileId);
        }
        return { ...stop, guidedFiles: files.map((file) => ({ ...file, explanation: null, annotations: [], ...(outline.contractVersion === 5 ? { status: 'queued' as const } : {}) })),
            relatedFiles: planned.relatedFiles.flatMap(resolveFile) };
    });
    if (outline.contractVersion !== 2) for (const file of diff.files) {
        if (!owners.has(file.fileId)) errors.push(`Assign every changed file, including ${file.path}, to a primary block.`);
    }
    if (errors.length > 0) return { ok: false, errors };
    return { ok: true, value: { summary: outline.summary, storyContractVersion: outline.contractVersion, summaryEvidence: evidence.value,
        stops, tourOrder: stops.map((stop) => stop.id), intents: new Map(outline.stops.map((stop, index) => [index + 1, stop.intent])),
    } };
}

export function validateStorySection(
    raw: string, targets: readonly number[], diff: PrDiff, locale: Locale, plannedStops?: readonly ExplanationBlock[], expectedVersion?: number, assignment?: SectionAssignment,
): RouteValidation<ExplanationFilling[]> {
    if (expectedVersion === 6) return validateAllFiles(raw, diff, plannedStops ?? [], assignment);
    const parsed = parseResult(raw, z.union([progressiveSectionResultSchema, readableSectionResultSchema, guidedSectionResultSchema, storySectionResultSchema]), 'story');
    if (!parsed.ok) return parsed;
    const errors: string[] = [];
    if (expectedVersion === 5 && parsed.value.contractVersion !== 5) return { ok: false, errors: ['Return contractVersion 5 and only the assigned files.'] };
    if (expectedVersion === 4 && parsed.value.contractVersion !== 4) return { ok: false, errors: ['This explanation requires contractVersion 4, short introductions and explicit optional examples.'] };
    if (plannedStops?.some((stop) => stop.guidedFiles !== undefined) && parsed.value.contractVersion === 2) {
        return { ok: false, errors: ['This plan needs contractVersion 3 and its assigned file explanations.'] };
    }
    const returned = parsed.value.stops.map((stop) => stop.planIndex);
    if (new Set(returned).size !== returned.length || returned.length !== targets.length ||
        targets.some((target) => !returned.includes(target))) {
        errors.push(`Return every assigned section exactly once: ${targets.join(', ')}.`);
    }
    const resolve = storyEvidenceResolver(diff);
    const patch = savedPatchIndex(diff);
    const example = (value: { text: string; evidence: Parameters<typeof resolve>[0] } | null | undefined): ReadableExample | null | undefined => {
        if (value == null) return value;
        errors.push(...paragraphMarkupErrors('example', 1, value.text), ...voiceErrors('example', value.text, locale));
        const checked = resolve(value.evidence, value.text);
        if (!checked.ok) { errors.push(...checked.errors); return undefined; }
        return { text: value.text, evidence: checked.value };
    };
    const fillings = parsed.value.stops.map((stop): ExplanationFilling => {
        const at = `story.stops[${String(stop.planIndex)}]`;
        if (assignment !== undefined && assignment.introduction !== (stop.paragraph !== null)) errors.push(`${at}: Return the block introduction only when assignment.introduction is true; otherwise paragraph, evidence and example must be null.`);
        if (stop.paragraph !== null) errors.push(...paragraphMarkupErrors(`${at}.paragraph`, stop.planIndex, stop.paragraph),
            ...voiceErrors(`${at}.paragraph`, stop.paragraph, locale));
        const evidence = stop.evidence !== null && stop.paragraph !== null ? resolve(stop.evidence, stop.paragraph) : undefined;
        if (evidence !== undefined && !evidence.ok) errors.push(...evidence.errors.map((error) => `${at}: ${error}`));
        let guidedFiles: GuidedFile[] | undefined;
        if ('files' in stop) {
            const planned = plannedStops?.find((entry) => entry.planIndex === stop.planIndex)?.guidedFiles
                ?.filter((file) => assignment === undefined || assignment.files.includes(file.path));
            if (planned?.length !== stop.files.length || planned.some((file, index) => file.path !== stop.files[index]?.path)) {
                errors.push(`${at}: Return the assigned files exactly once in their accepted order.`);
            }
            guidedFiles = stop.files.flatMap((file) => {
                const source = diff.files.find((entry) => entry.path === file.path);
                if (source === undefined) { errors.push(`${at}: Unknown changed file ${file.path}.`); return []; }
                errors.push(...paragraphMarkupErrors(`${at}.${file.path}`, stop.planIndex, file.explanation), ...voiceErrors(`${at}.${file.path}`, file.explanation, locale));
                for (const note of file.annotations) {
                    if (patch.range(source, note) === null) errors.push(`${at}: Annotation range is not fully present in saved patch ${file.path}.`);
                    errors.push(...paragraphMarkupErrors(`${at}.annotation`, stop.planIndex, note.text), ...voiceErrors(`${at}.annotation`, note.text, locale));
                }
                const sample = 'example' in file ? example(file.example) : undefined;
                return [{ path: file.path, explanation: file.explanation, annotations: file.annotations, fileId: source.fileId, ...(sample === undefined ? {} : { example: sample }) }];
            });
        }
        return { ...('example' in stop && stop.paragraph !== null ? { example: example(stop.example) ?? null } : {}), ...(guidedFiles === undefined ? {} : { guidedFiles }), planIndex: stop.planIndex, paragraph: stop.paragraph,
            ...(parsed.value.contractVersion === 5 ? { partial: true } : {}),
            ...(evidence?.ok === true ? { storyEvidence: evidence.value } : {}),
        };
    });
    return errors.length === 0 ? { ok: true, value: fillings } : { ok: false, errors };
}

import { z } from 'zod';
import type { ExplanationBlock, ReadableExample, GuidedFile, Locale, PrDiff, StoryEvidenceBlock } from '@sherpa/protocol';
import { readableSkeletonResultSchema, readableSectionResultSchema, guidedSkeletonResultSchema, guidedSectionResultSchema, storySkeletonResultSchema, storySectionResultSchema } from '@sherpa/protocol';

import { walkPatch } from './route/diff-index.js';
import { storyEvidenceResolver } from './story-evidence.js';
import { explanationRules } from './explanation-rules.js';
import { markupErrors, paragraphMarkupErrors } from './route/paragraph-markup.js';
import { parseResult } from './route/raw-result.js';
import type { RouteValidation } from './route/types.js';
import { voiceErrors } from './route/voice.js';

/** Принятый план и заполнение не зависят от модели ревью. */
export interface AcceptedExplanation {
    summary: string; storyContractVersion: 2 | 3 | 4; summaryEvidence: StoryEvidenceBlock;
    stops: ExplanationBlock[]; tourOrder: string[]; intents: Map<number, string>;
}
export interface ExplanationFilling {
    planIndex: number; paragraph: string; storyEvidence?: StoryEvidenceBlock;
    guidedFiles?: GuidedFile[]; example?: ReadableExample | null;
}

export function validateStorySkeleton(raw: string, diff: PrDiff, locale: Locale): RouteValidation<AcceptedExplanation> {
    const parsed = parseResult(raw, z.union([readableSkeletonResultSchema, guidedSkeletonResultSchema, storySkeletonResultSchema]), 'story outline');
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
        return { ...stop, guidedFiles: files.map((file) => ({ ...file, explanation: null, annotations: [] })),
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
    raw: string, targets: readonly number[], diff: PrDiff, locale: Locale, plannedStops?: readonly ExplanationBlock[], expectedVersion?: number,
): RouteValidation<ExplanationFilling[]> {
    const parsed = parseResult(raw, z.union([readableSectionResultSchema, guidedSectionResultSchema, storySectionResultSchema]), 'story');
    if (!parsed.ok) return parsed;
    const errors: string[] = [];
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
    const example = (value: { text: string; evidence: Parameters<typeof resolve>[0] } | null | undefined): ReadableExample | null | undefined => {
        if (value == null) return value;
        errors.push(...paragraphMarkupErrors('example', 1, value.text), ...voiceErrors('example', value.text, locale));
        const checked = resolve(value.evidence, value.text);
        if (!checked.ok) { errors.push(...checked.errors); return undefined; }
        return { text: value.text, evidence: checked.value };
    };
    const fillings = parsed.value.stops.map((stop): ExplanationFilling => {
        const at = `story.stops[${String(stop.planIndex)}]`;
        errors.push(...paragraphMarkupErrors(`${at}.paragraph`, stop.planIndex, stop.paragraph),
            ...voiceErrors(`${at}.paragraph`, stop.paragraph, locale));
        const evidence = resolve(stop.evidence, stop.paragraph);
        if (!evidence.ok) errors.push(...evidence.errors.map((error) => `${at}: ${error}`));
        let guidedFiles: GuidedFile[] | undefined;
        if ('files' in stop) {
            const planned = plannedStops?.find((entry) => entry.planIndex === stop.planIndex)?.guidedFiles;
            if (planned?.length !== stop.files.length || planned.some((file, index) => file.path !== stop.files[index]?.path)) {
                errors.push(`${at}: Return the assigned files exactly once in their accepted order.`);
            }
            guidedFiles = stop.files.flatMap((file) => {
                const source = diff.files.find((entry) => entry.path === file.path);
                if (source === undefined) { errors.push(`${at}: Unknown changed file ${file.path}.`); return []; }
                errors.push(...paragraphMarkupErrors(`${at}.${file.path}`, stop.planIndex, file.explanation), ...voiceErrors(`${at}.${file.path}`, file.explanation, locale));
                const patch = source.patch === null ? [] : [...walkPatch(source.patch)];
                for (const note of file.annotations) {
                    const lines = patch.filter((line) => { const n = line[note.side]; return n !== null && n >= note.start && n <= note.end; });
                    if (lines.length !== note.end - note.start + 1) errors.push(`${at}: Annotation range is not fully present in saved patch ${file.path}.`);
                    errors.push(...paragraphMarkupErrors(`${at}.annotation`, stop.planIndex, note.text), ...voiceErrors(`${at}.annotation`, note.text, locale));
                }
                const sample = 'example' in file ? example(file.example) : undefined;
                return [{ path: file.path, explanation: file.explanation, annotations: file.annotations, fileId: source.fileId, ...(sample === undefined ? {} : { example: sample }) }];
            });
        }
        return { ...('example' in stop ? { example: example(stop.example) ?? null } : {}), ...(guidedFiles === undefined ? {} : { guidedFiles }), planIndex: stop.planIndex, paragraph: stop.paragraph,
            ...(evidence.ok ? { storyEvidence: evidence.value } : {}),
        };
    });
    return errors.length === 0 ? { ok: true, value: fillings } : { ok: false, errors };
}

export function storyGuide(stage: 'skeleton' | 'section', locale: Locale): string {
    return `# Explain this pull request to a colleague

Write in ${locale === 'ru' ? 'Russian' : 'English'}. Guide a colleague through the FULL PR diff.
The reader first opens a separate PR description, then meaningful blocks, then files with their complete saved patches.
First give the reader a simple scenario and the role of the changed code. Order blocks/files along the understandable path.
Introduce contracts/data when the reader needs them; do not front-load a large schema package before explaining the operation.
Description: problem, visible change, boundary of what is actually wired. Block: its role and connection to the preceding step.
File introduction: one or two short sentences about purpose and reason. Keep exact method names, enum inventories, format details and constants at important code lines.
Essential unfamiliar local terms need a short explanation; do not hide consequential conditions to simplify the story.
An example is optional: a short illustrative situation -> outcome, grounded in saved sources and preserving all conditions.
It replaces abstract explanation rather than adding another layer. Use at most one per meaningful change; avoid repeating it at block/file/annotation levels.
For mechanical exports and build entries use a short caption and example: null. Never claim an illustrative example was executed.
A retryable error only permits retries; it does not guarantee that any retry occurs. Do not imply live integration from registered executors alone.
Each changed file has exactly one primary block; relatedFiles cross-link to its primary home. Include binary/metadata-only files too.
Give every file a short explanation of what changed, why, and its role in the block and whole solution.
Within a file, add annotations ONLY to important/complex lines (side/start/end/text); [] explicitly means none needed.
Do not annotate every hunk or paraphrase obvious syntax. Never copy code into explanations.
Read the actual implementation and caller/wiring before claiming live behaviour. Distinguish implemented mechanism, wired path, and future intent.
When bounded context omits a patch, read that file from the saved patch index, which pins the same PR revision. Never infer its contents from its name.
For each independent meaningful change establish its scenario/trigger, confirmed before/after behaviour,
mechanism in code and dependencies. Adapt to the change: a new feature needs its new execution path;
a refactor needs the structural change and evidence for preserved behaviour; config needs scope and field definitions.
Do not infer that a feature was absent everywhere from one added file. Group mechanical edits without hiding independent changes.
Talk as a peer. Do not review the code or generate findings/test digests. Explain each file concisely; explain individual functions only when needed for understanding.
Use plain words, precise facts and causal connections; details are requested explicitly in chat.
No praise, emoji, rhetorical questions or filler. Read shared files once; do not audit the repository.
${explanationRules}

Return contractVersion: 4. Every introduction/paragraph has evidence.claims, each with:
- quote: an exact non-empty substring of that paragraph's Markdown, including markup, unique within its block;
- sources: minimal supporting saved-patch sources. A lines source has kind: "lines", exact path, side: "old" or "new", start/end gutter numbers (up to 20 lines).
  A file source has kind: "file" and the canonical changed-file path, for file metadata only, not unseen contents.
- limitation: null if established, otherwise the missing evidence or exact external source/revision outside the viewer.
Every claim needs sources or an explicit limitation. A limitation never licenses an unsupported assertion.
Cover all key behavioural/mechanism claims. Both sides need evidence for a before/after comparison.
Do not fabricate an empty "before" source for an addition. Code is displayed from saved sources; never reproduce it in prose.
Use a small number of claims/sources, not the schema's maximum counts. Self-check prose, evidence and introduction for consistency.

${stage === 'skeleton' ? `Return summary (at most 500 characters), its evidence and stops (title, internal intent, files: ordered canonical changed-file paths, relatedFiles: canonical cross-link paths), in explanatory dependency order. Assign every changed file exactly once.
State a concrete visible outcome in the introduction: what is now possible or different. Avoid generic announcements such as "the order/path/structure changed".
Reserve the mechanism, exact values and detailed before/after comparison for the sections.
The introduction is shown immediately with its sources, before the sections. Do not assign review priorities or a catch-all.` : `Continue the accepted introduction without repeating or rewriting it. Return all assigned stops with planIndex, paragraph, evidence, and files in the exact accepted order. Each block and file has example: null or {text (at most 260 characters), evidence (same claims format)}. Example claim quotes refer to its exact text. Each file needs path, explanation (at most 360 characters), annotations (side, start, end, text at most 840 characters).
Add a confirmed mechanism, boundary or consequence instead of restating the introduction. Even for a tiny change, avoid repeating the same facts or inventing extra detail.
Each block paragraph has at most 400 characters. A block/file introduction plus its example together have at most 620 characters; use less when possible. Do not return the old anchors field.`}

Text markup: paragraphs, inline backticks, **bold**, http(s) links and flat lists of at most four items.
No headings inside paragraph text, nested lists, code blocks or tables. Titles have their own fields.
Return JSON matching the attached schema, under 256 KB. Submit it with the printed task complete
command. The server validates it; fix named errors and resubmit. Never end silently or install tools.`;
}

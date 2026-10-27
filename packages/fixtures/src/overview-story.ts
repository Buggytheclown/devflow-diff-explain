import { readableStoryFixture } from './readable-story.js';

/** Части модели соответствуют сохранённым назначениям сервера, а не всем файлам сразу. */
export function overviewStoryFixture() {
    const base = readableStoryFixture();
    const parts = base.body.stops.flatMap((block) => {
        const chunks = [];
        for (let offset = 0; offset < block.files.length; offset += 3) chunks.push({ contractVersion: 5 as const, stops: [{ ...block,
            paragraph: offset === 0 ? block.paragraph : null, evidence: offset === 0 ? block.evidence : null, example: offset === 0 ? block.example : null,
            files: block.files.slice(offset, offset + 3),
        }] });
        return chunks;
    });
    return { ...base, outline: { ...base.outline, contractVersion: 5 as const }, parts,
        snapshot: { ...base.snapshot, storyContractVersion: 5 as const } };
}

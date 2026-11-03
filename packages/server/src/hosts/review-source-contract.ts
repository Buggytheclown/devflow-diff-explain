import type { Iteration, ReviewSource } from '@sherpa/protocol';
import { fileContentSchema, iterationSchema, prDiffSchema, prMetaSchema, IMAGE_BLOB_MAX_BYTES } from '@sherpa/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';

export interface ReviewSourceContractOptions<H extends ReviewSource> {
    readonly advance?: (host: H) => void | Promise<void>;
    readonly viewer?: string | null;
    readonly skip?: boolean;
    readonly slow?: boolean;
}
/** Полный контракт чтения для настоящих адаптеров и фикстур. */
export function describeReviewSourceContract<H extends ReviewSource>(name: string, factory: () => H | Promise<H>, options: ReviewSourceContractOptions<H> = {}): void {
    describe.skipIf(options.skip ?? false)(name, () => {
        const stops: (() => void)[] = [];
        afterEach(() => { for (const stop of stops.splice(0)) stop(); });
        const timeout = options.slow ? 60_000 : 10_000;
        it('метаданные и дифф валидны; API публикации отсутствует', async () => {
            const host = await factory();
            const meta = prMetaSchema.parse(await host.getPr());
            const diff = prDiffSchema.parse(await host.getDiff());
            expect(diff.files.map((file) => file.fileId)).toEqual([...new Set(diff.files.map((file) => file.fileId))]);
            if (options.viewer !== undefined) expect(meta.viewer?.login ?? null).toBe(options.viewer);
            for (const key of ['saveDraft', 'publishBatch', 'setThreadResolved', 'getThreads', 'watchThreads', 'ownershipLens', 'extraLenses']) expect(key in host).toBe(false);
            expect(typeof host.getFileContent === 'function').toBe(meta.capabilities.fileContent);
            expect(typeof host.getBlob === 'function').toBe(meta.capabilities.blobs);
            expect(typeof host.getSourceAtRevision === 'function').toBe(Boolean(meta.capabilities.sourceAtRevision));
        }, timeout);
        it('версии имеют ровно одну активную; подписка возвращает снимок и закрывается', async () => {
            const host = await factory();
            const listed = (await host.listIterations()).map((value) => iterationSchema.parse(value));
            expect(listed.filter((value) => value.status === 'active')).toHaveLength(1);
            expect(listed.at(-1)?.status).toBe('active');
            const seen: Iteration[][] = [];
            const stop = host.watchIterations((items) => { seen.push(items); }); stops.push(stop);
            await vi.waitFor(() => { expect(seen.length).toBeGreaterThan(0); }, { timeout: options.slow ? 20_000 : 5000 });
            stop(); const count = seen.length;
            if (options.advance !== undefined) await options.advance(host);
            await new Promise((resolve) => setTimeout(resolve, 30));
            expect(seen).toHaveLength(count);
        }, timeout);
        it('содержимое обеих сторон и байты картинок доступны без агента', async () => {
            const host = await factory();
            const diff = await host.getDiff();
            const file = diff.files.find((entry) => !entry.binary && entry.image === null);
            if (file !== undefined && host.getFileContent !== undefined) {
                const content = await host.getFileContent(file.fileId);
                if (content !== null) fileContentSchema.parse(content);
            }
            for (const entry of diff.files) if (entry.image !== null && host.getBlob !== undefined) {
                for (const side of [entry.image.before, entry.image.after]) if (side !== null) {
                    const bytes = await host.getBlob(side.blobId);
                    if (bytes !== null) expect(bytes.length).toBeLessThanOrEqual(IMAGE_BLOB_MAX_BYTES);
                }
            }
        }, timeout);
        if (options.advance !== undefined) it('новая версия меняет head; неизвестный срез отклоняется', async () => {
            const host = await factory();
            const before = await host.getDiff();
            await options.advance?.(host);
            const after = await host.getDiff();
            expect(after.diffId).not.toBe(before.diffId);
            const meta = await host.getPr();
            if (meta.capabilities.iterations) await expect(host.getDiff({ base: 'missing', head: after.diffId })).rejects.toThrow();
        }, timeout);
    });
}

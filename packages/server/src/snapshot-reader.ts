import type { FileContent, Iteration, PrDiff, CapturedPr, CodeReader } from '@sherpa/protocol';
import type { CodeSnapshots } from './code-snapshots.js';
import type { IterationStore } from './iteration-store.js';

/** Чтение локального снимка и уведомление только о явном импорте. */
export class SnapshotReader implements CodeReader {
    private readonly listeners = new Set<(iterations: Iteration[]) => void>();
    constructor(readonly snapshots: CodeSnapshots, private readonly iterations: IterationStore) {}

    getPr(): Promise<CapturedPr | null> {
        return Promise.resolve(this.snapshots.active()?.pr ?? null);
    }
    getDiff(): Promise<PrDiff> {
        const active = this.snapshots.active();
        if (active !== null) return Promise.resolve(active.diff);
        const legacy = this.iterations.list().find((iteration) => iteration.status === 'active') ?? this.iterations.list().at(-1);
        const diff = legacy === undefined ? null : this.iterations.get(legacy.diffId)?.diff;
        if (diff == null) return Promise.reject(new Error('Import a complete code snapshot before preparing an explanation.'));
        return Promise.resolve(diff);
    }
    listIterations(): Promise<Iteration[]> { return Promise.resolve(this.iterations.list()); }
    subscribeVersions(onChange: (iterations: Iteration[]) => void): () => void {
        this.listeners.add(onChange); onChange(this.iterations.list());
        return () => { this.listeners.delete(onChange); };
    }
    changed(): void {
        for (const listener of this.listeners) {
            try { listener(this.iterations.list()); }
            catch (error) { console.error('sherpa-server: ошибка подписчика снимка', error); }
        }
    }
    async getFileContent(fileId: string): Promise<FileContent | null> { return this.snapshots.file(await this.getDiff(), fileId); }
    getSourceAtRevision(_sourcePath: string, _revision: string): Promise<string | null> {
        // У локальных снимков revision (например, base/worktree) не уникален между импортами.
        // Этот контракт не передаёт code ID, поэтому чтение через активную версию было бы ложным.
        return Promise.resolve(null);
    }
    getBlob(blobId: string): Promise<Uint8Array | null> { return Promise.resolve(this.snapshots.bytes(blobId)); }
    hasRegisteredBlob(blobId: string): boolean { return this.snapshots.hasRegisteredBlob(blobId); }
}

import type { FileContent, Iteration, PrDiff, CapturedPr } from './review.js';

/** Внутренний читатель локальных снимков; реализация приложения не обращается к провайдерам. */
export interface CodeReader {
    getPr(): Promise<CapturedPr | null>;
    getDiff(): Promise<PrDiff>;
    listIterations(): Promise<Iteration[]>;
    subscribeVersions(onChange: (iterations: Iteration[]) => void): () => void;
    getFileContent?(fileId: string): Promise<FileContent | null>;
    getSourceAtRevision?(path: string, revision: string): Promise<string | null>;
    getBlob?(blobId: string): Promise<Uint8Array | null>;
}

import { createHash } from 'node:crypto';
import type { RouteSnapshot } from '@sherpa/protocol';

/** Только опубликованный смысл объяснения. Служебный прогресс не создаёт редакцию. */
export function reviewContentSignature(snapshot: RouteSnapshot): string {
    const content = {
        codeSnapshotId: snapshot.codeSnapshotId,
        diffId: snapshot.diffId,
        commit: snapshot.commit,
        summary: snapshot.summary,
        summaryEvidence: snapshot.summaryEvidence,
        flow: snapshot.flow?.status === 'ready' || snapshot.flow?.status === 'unavailable' ||
            snapshot.flow?.status === 'not_applicable' ? snapshot.flow : undefined,
        tourOrder: snapshot.tourOrder,
        stops: snapshot.stops.map(({ status: _status, guidedFiles, ...stop }) => ({
            ...stop,
            guidedFiles: guidedFiles?.map(({ status: _fileStatus, failure: _failure, ...file }) => file),
        })),
    };
    return createHash('sha256').update(JSON.stringify(content)).digest('hex');
}

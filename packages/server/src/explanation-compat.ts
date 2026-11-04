import type { RouteSnapshot } from '@sherpa/protocol';
import { explanationCanonicalSnapshotSchema, explanationSnapshotSchema, routeSnapshotSchema } from '@sherpa/protocol';

export function storedSnapshot(snapshot: RouteSnapshot): unknown {
    if (snapshot.presentation !== 'story' || snapshot.storyContractVersion === undefined) return snapshot;
    if (snapshot.storyContractVersion !== 6) return explanationSnapshotSchema.parse({ ...snapshot, format: 'explanation/1' });
    const byId = new Map(snapshot.stops.map((block) => [block.id, block]));
    if (byId.size !== snapshot.stops.length || snapshot.tourOrder.length !== byId.size
        || new Set(snapshot.tourOrder).size !== byId.size || snapshot.tourOrder.some((id) => !byId.has(id))) {
        throw new Error('The saved block order must contain every block ID exactly once.');
    }
    const ordered = snapshot.tourOrder.map((id) => {
        const block = byId.get(id);
        if (block === undefined) throw new Error(`Unknown block ID in saved order: ${id}.`);
        return block;
    });
    const files = ordered.flatMap((block) => block.guidedFiles ?? []);
    const blocks = ordered.map(({ planIndex: _planIndex, guidedFiles, ...block }) => {
        return { ...block, fileIds: (guidedFiles ?? []).map((file) => file.fileId) };
    });
    return explanationCanonicalSnapshotSchema.parse({ ...snapshot, format: 'explanation/2', blocks, files });
}

/** Старые JSON читаются как прежде; новый формат проверяется до восстановления проекции. */
export function restoreSnapshot(raw: unknown): unknown {
    if (typeof raw !== 'object' || raw === null || !('format' in raw)) return raw;
    if (raw.format === 'explanation/1') return explanationSnapshotSchema.parse(raw);
    if (raw.format !== 'explanation/2') throw new Error(`Unsupported stored explanation format: ${String(raw.format)}.`);
    const value = explanationCanonicalSnapshotSchema.parse(raw);
    const { blocks, files, ...head } = value;
    const byFileId = new Map(files.map((file) => [file.fileId, file]));
    return routeSnapshotSchema.parse({ ...head, stops: blocks.map(({ fileIds, ...block }, index) => ({
        ...block, planIndex: index + 1, guidedFiles: fileIds.map((fileId) => byFileId.get(fileId)),
    })), tourOrder: blocks.map((block) => block.id) });
}

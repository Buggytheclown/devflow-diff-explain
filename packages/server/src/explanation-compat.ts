import type { RouteSnapshot } from '@sherpa/protocol';
import { explanationSnapshotSchema } from '@sherpa/protocol';

export function storedSnapshot(snapshot: RouteSnapshot): unknown {
    return snapshot.presentation === 'story' && snapshot.storyContractVersion !== undefined
        ? explanationSnapshotSchema.parse({ ...snapshot, format: 'explanation/1' }) : snapshot;
}

/** Старые JSON читаются как прежде; новый формат проверяется до восстановления проекции. */
export function restoreSnapshot(raw: unknown): unknown {
    if (typeof raw !== 'object' || raw === null || !('format' in raw) || raw.format !== 'explanation/1') return raw;
    const value = explanationSnapshotSchema.parse(raw);
    return value;
}

import type { ExplanationBlock, RouteSnapshot, RouteStop } from '@sherpa/protocol';
import { explanationSnapshotSchema } from '@sherpa/protocol';

/** Совместимая HTTP-проекция. Эти поля не участвуют в генерации и хранении объяснения. */
export function reviewProjection(block: ExplanationBlock): RouteStop {
    return { ...block, tier: 'medium', bridge: null, anchors: [], tests: [], droppedClaims: 0, change: null };
}

export function storedSnapshot(snapshot: RouteSnapshot): unknown {
    return snapshot.presentation === 'story' && snapshot.storyContractVersion !== undefined
        ? explanationSnapshotSchema.parse({ ...snapshot, format: 'explanation/1' }) : snapshot;
}

/** Старые JSON читаются как прежде; новый формат проверяется до восстановления проекции. */
export function restoreSnapshot(raw: unknown): unknown {
    if (typeof raw !== 'object' || raw === null || !('format' in raw) || raw.format !== 'explanation/1') return raw;
    const value = explanationSnapshotSchema.parse(raw);
    return { ...value, carried: null, stops: value.stops.map(reviewProjection) };
}

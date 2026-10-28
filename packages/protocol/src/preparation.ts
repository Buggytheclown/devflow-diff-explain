import { z } from 'zod';
import type { RouteSnapshot } from './route.js';

/** Текущая подготовка отделена от снимка, который человек читает во время перестройки. */
export const generationSchema = z.object({
    id: z.string().min(1), commit: z.string().nullable(),
    snapshotId: z.string().nullable(), previousSnapshotId: z.string().nullable(),
    status: z.enum(['running', 'cancelled', 'failed']),
});
export type Generation = z.infer<typeof generationSchema>;

export function preparationProgress(route: {
    phase: string; snapshot: RouteSnapshot | null; generation?: Generation | undefined;
}) {
    const { snapshot, generation } = route;
    const ownsSnapshot = snapshot !== null && (generation === undefined ? route.phase !== 'reading' : generation.snapshotId === snapshot.snapshotId);
    const current = ownsSnapshot ? snapshot : null;
    const blocks = current?.stops ?? [];
    const files = blocks.flatMap((block) => block.guidedFiles ?? []);
    const readyBlocks = blocks.filter((block) => block.paragraph !== null).length;
    const readyFiles = files.filter((file) => file.explanation !== null && file.status !== 'failed').length;
    const diagramReady = current?.flow?.status === 'ready' || current?.flow?.status === 'not_applicable';
    const total = current === null ? null : 2 + blocks.length + files.length;
    const completed = current === null ? 0 : 1 + Number(diagramReady) + readyBlocks + readyFiles;
    const legacy = current !== null && (current.storyContractVersion ?? 0) < 5;
    const status: 'legacy' | 'cancelled' | 'partial' | 'failed' | 'ready' | 'planning' | 'preparing' | 'idle' = legacy ? 'legacy' : generation?.status === 'cancelled' ? 'cancelled'
        : generation?.status === 'failed' || (route.phase === 'failed' && current?.flow?.status !== 'pending') ? (completed > 0 ? 'partial' : 'failed')
        : total !== null && completed === total ? 'ready'
        : route.phase === 'reading' ? 'planning'
        : route.phase === 'filling' || current?.flow?.status === 'pending' ? 'preparing'
        : current === null ? 'idle' : 'partial';
    return { id: generation?.id ?? current?.snapshotId ?? null, commit: generation?.commit ?? current?.commit ?? null,
        snapshotId: current?.snapshotId ?? null, status,
        total: legacy ? null : total, completed, percent: legacy || total === null ? null : Math.floor(completed / total * 100),
        files: { ready: readyFiles, total: files.length }, blocks: { ready: readyBlocks, total: blocks.length },
        flow: current?.flow?.status ?? 'pending',
    };
}

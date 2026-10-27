import { flowDiagramResultSchema } from './flow-diagram.js';
import { z } from 'zod';

import { serverManifestSchema } from './manifest.js';
import {
    rpcErrorSchema,
    taskAckResponseSchema,
    taskCompleteRequestSchema,
    taskCompleteResponseSchema,
    taskFailRequestSchema,
    taskProgressRequestSchema,
    workerNextRequestSchema,
    workerNextResponseSchema,
    workerRegisterRequestSchema,
    workerRegisterResponseSchema,
    workerStatusSchema,
} from './messages.js';
import { reviewFeedbackResultSchema } from './review.js';
import { overviewSkeletonResultSchema, progressiveSectionResultSchema, readableSkeletonResultSchema, readableSectionResultSchema, guidedSkeletonResultSchema, guidedSectionResultSchema, routeSectionResultSchema, routeSkeletonResultSchema, routeSnapshotSchema, storySkeletonResultSchema, storySectionResultSchema } from './route.js';
import { leaseSchema, taskSchema } from './task.js';
import {
    uiCancelRequestSchema,
    uiCancelResponseSchema,
    uiEnqueueRequestSchema,
    uiEnqueueResponseSchema,
    uiStateSchema,
    uiTaskSchema,
} from './ui.js';

/**
 * JSON-схемы контракта, сгенерированные из zod (`docs/architecture.md §5`): канон — zod-схемы,
 * JSON Schema — производная для потребителей вне TS (payload генеративных задач, документация).
 */
export function generateJsonSchemas(): Record<string, unknown> {
    const sources = {
        task: taskSchema,
        lease: leaseSchema,
        workerRegisterRequest: workerRegisterRequestSchema,
        workerRegisterResponse: workerRegisterResponseSchema,
        workerStatus: workerStatusSchema,
        workerNextRequest: workerNextRequestSchema,
        workerNextResponse: workerNextResponseSchema,
        taskCompleteRequest: taskCompleteRequestSchema,
        taskCompleteResponse: taskCompleteResponseSchema,
        taskProgressRequest: taskProgressRequestSchema,
        taskFailRequest: taskFailRequestSchema,
        taskAckResponse: taskAckResponseSchema,
        rpcError: rpcErrorSchema,
        serverManifest: serverManifestSchema,
        uiTask: uiTaskSchema,
        uiState: uiStateSchema,
        uiEnqueueRequest: uiEnqueueRequestSchema,
        uiEnqueueResponse: uiEnqueueResponseSchema,
        uiCancelRequest: uiCancelRequestSchema,
        uiCancelResponse: uiCancelResponseSchema,
        routeSnapshot: routeSnapshotSchema,
        flowDiagramResult: flowDiagramResultSchema,
        readableSkeletonResult: readableSkeletonResultSchema,
        readableSectionResult: readableSectionResultSchema,
        overviewSkeletonResult: overviewSkeletonResultSchema,
        progressiveSectionResult: progressiveSectionResultSchema,
        guidedSkeletonResult: guidedSkeletonResultSchema,
        guidedSectionResult: guidedSectionResultSchema,
        storySkeletonResult: storySkeletonResultSchema,
        storySectionResult: storySectionResultSchema,
        // Схемы результатов генеративных задач — уходят файлами в payload (`docs/protocol.md §4`).
        routeSkeletonResult: routeSkeletonResultSchema,
        routeSectionResult: routeSectionResultSchema,
        reviewFeedbackResult: reviewFeedbackResultSchema,
    };

    // io: 'input' — схемы описывают, что отправитель обязан прислать.
    return Object.fromEntries(
        Object.entries(sources).map(([name, schema]) => [name, z.toJSONSchema(schema, { io: 'input' })]),
    );
}

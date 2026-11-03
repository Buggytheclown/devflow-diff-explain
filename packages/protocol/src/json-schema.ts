import { allFilesWorkerResultSchema } from './route.js';
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
import { routeSnapshotSchema } from './route.js';
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
let cached: Record<string, unknown> | null = null;
export function generateJsonSchemas(): Record<string, unknown> {
    if (cached !== null) return cached;
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
        allFilesResult: allFilesWorkerResultSchema,

    };

    // io: 'input' — схемы описывают, что отправитель обязан прислать.
    cached = Object.fromEntries(
        Object.entries(sources).map(([name, schema]) => [name, z.toJSONSchema(schema, { io: 'input', reused: 'ref' })]),
    );
    return cached;
}

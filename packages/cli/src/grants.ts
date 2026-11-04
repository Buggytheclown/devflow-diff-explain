import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import type { WorkerNextResponse } from '@sherpa/protocol';
import { taskTypeSchema } from '@sherpa/protocol';
import { z } from 'zod';

import type { ServerConnection } from './discovery.js';
import { CliError } from './errors.js';
import { assertValidPrKey } from './paths.js';

const grantSchema = z.object({ grantToken: z.uuid(), type: taskTypeSchema });
export type TaskGrant = z.infer<typeof grantSchema>;

function grantPath(sherpaDir: string, connection: ServerConnection, taskId: number, leaseRef: string): string {
    const worker = createHash('sha256').update(connection.workerId).digest('hex');
    return path.join(sherpaDir, 'prs', assertValidPrKey(connection.prKey), 'grants', worker, `${String(taskId)}-${leaseRef}.json`);
}

export function leaseRefFor(grantToken: string): string {
    return createHash('sha256').update(grantToken).digest('hex');
}

/** Сохраняем до выдачи задачи: следующий процесс CLI сможет сдать результат или повторить квитанцию. */
export async function saveTaskGrant(sherpaDir: string, connection: ServerConnection, response: Extract<WorkerNextResponse, { kind: 'task' }>): Promise<string> {
    const leaseRef = leaseRefFor(response.lease.grantToken);
    const file = grantPath(sherpaDir, connection, response.task.id, leaseRef);
    const grant: TaskGrant = { grantToken: response.lease.grantToken, type: response.task.type };
    try {
        await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
        const temp = `${file}.${String(process.pid)}.tmp`;
        await fs.writeFile(temp, JSON.stringify(grant), { mode: 0o600 });
        await fs.rename(temp, file);
        return leaseRef;
    } catch (error) {
        throw new CliError(`devflow-diff-explain: cannot retain the task lease at ${file}: ${error instanceof Error ? error.message : String(error)}.`);
    }
}

export async function loadTaskGrant(sherpaDir: string, connection: ServerConnection, taskId: number, leaseRef: string): Promise<TaskGrant> {
    if (!/^[a-f0-9]{64}$/.test(leaseRef)) throw new CliError('devflow-diff-explain: invalid --lease reference. Copy the command printed with the task.');
    const file = grantPath(sherpaDir, connection, taskId, leaseRef);
    let raw: string;
    try {
        raw = await fs.readFile(file, 'utf8');
    } catch {
        throw new CliError(`devflow-diff-explain: the lease for task sherpa/${String(taskId)} is missing. Call worker next again to receive the task and its lease.`);
    }
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { parsed = null; }
    const grant = grantSchema.safeParse(parsed);
    if (!grant.success || leaseRefFor(grant.data.grantToken) !== leaseRef) {
        throw new CliError(`devflow-diff-explain: the saved lease for task sherpa/${String(taskId)} is invalid. Call worker next again to receive the task and its lease.`);
    }
    return grant.data;
}

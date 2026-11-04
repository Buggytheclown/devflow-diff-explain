import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { WorkerNextResponse } from '@sherpa/protocol';
import { afterEach, beforeEach, expect, it } from 'vitest';

import type { ServerConnection } from './discovery.js';
import { loadTaskGrant, saveTaskGrant } from './grants.js';

let dir: string;
beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sherpa grants ')); });
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

const connection: ServerConnection = { prKey: 'arcanum-1', port: 4000, token: 'server-token', workerId: 'worker-1' };
const token1 = 'b04cbbe4-0ed0-4d9b-98e4-39f5966adcf9';
const token2 = '38beac2c-0d55-42c5-a9f1-a07417e8a799';

function issuance(grantToken: string): Extract<WorkerNextResponse, { kind: 'task' }> {
    return {
        kind: 'task',
        task: { id: 42, type: 'route.prepare', priority: 'background', attempt: 1, instructions: 'Prepare', contextFiles: [] },
        lease: { taskId: 42, grantToken, ttlSeconds: 600, expiresAt: '2026-11-04T12:00:00.000Z' },
    };
}

it('keeps each issuance immutable across re-lease and worker identities', async () => {
    const first = await saveTaskGrant(dir, connection, issuance(token1));
    await expect(loadTaskGrant(dir, connection, 42, first)).resolves.toEqual({ grantToken: token1, type: 'route.prepare' });
    const second = await saveTaskGrant(dir, connection, issuance(token2));
    expect(second).not.toBe(first);
    await expect(loadTaskGrant(dir, connection, 42, first)).resolves.toEqual({ grantToken: token1, type: 'route.prepare' });
    await expect(loadTaskGrant(dir, connection, 42, second)).resolves.toEqual({ grantToken: token2, type: 'route.prepare' });
    await expect(loadTaskGrant(dir, { ...connection, workerId: 'another-worker' }, 42, first)).rejects.toThrow('lease for task');
});
